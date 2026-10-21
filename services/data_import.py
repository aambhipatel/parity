import pandas as pd
import hashlib
import os
from services.crud import get_or_create_institution, get_or_create_account, add_transaction, check_duplicate_file, record_imported_file
from utils.logger import logger

def import_transactions_from_csv(filepath: str, custom_mapping: dict = None, default_institution="Charles Schwab", default_account="Schwab Investment Account", force_account_id=None):
    """
    Imports transactions from an investment CSV file using pandas.
    Expected mapped columns: date, amount, category
    Optional mapped columns: institution_name, account_name, description
    """
    try:
        # Note: Charles Schwab CSVs typically have a summary row at the top that changes on every download (timestamped).
        # We need to skip this row to find the true headers and ensure our hash ignores the timestamp!
        
        # Read the file to discover the true header row
        skip_rows = 0
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            for i, line in enumerate(f):
                line_lower = line.lower()
                if any(h in line_lower for h in ['date,', 'action,', 'symbol,', 'run date,', 'amount,']):
                    skip_rows = i
                    break
        
        df = pd.read_csv(filepath, skiprows=skip_rows)
        
        # Now hash the core dataframe representation which omits arbitrary file-level metadata/headers
        try:
            # We hash the deterministic string serialization of the core dataframe
            core_data_string = df.to_csv(index=False).encode('utf-8')
            file_hash = hashlib.sha256(core_data_string).hexdigest()
        except Exception as e:
            logger.error(f"Failed to hash parsed data: {e}")
            return False, f"Failed to process file for duplicate check: {e}"
            
        if check_duplicate_file(file_hash):
            return False, "Duplicate file detected. This specific transaction data has already been imported."
        
        imported_file_id = record_imported_file(file_hash, os.path.basename(filepath))

        # Standardize columns to lowercase, replacing spaces with underscores
        df.columns = [str(c).strip().lower().replace(' ', '_') for c in df.columns]
        
        # Mapping specifically tailored for Charles Schwab and Fidelity CSVs
        column_mapping = {
            'date': 'date',
            'action': 'category',  # Schwab/Fidelity uses 'Action' for things like Buy, Sell, Dividend
            'amount': 'amount',
            
            # Additional fallbacks just in case
            'run_date': 'date',
            'trade_date': 'date',
            'settlement_date': 'date',
            'transaction_date': 'date',
            'net_amount': 'amount',
            'amount_($)': 'amount',
            'price_($)': 'price',
            'transaction_type': 'category',
        }
        
        # Override with any custom mappings provided by the user
        if custom_mapping:
            for k, v in custom_mapping.items():
                column_mapping[str(k).strip().lower().replace(' ', '_')] = v
        
        df.rename(columns=lambda x: column_mapping.get(x, x), inplace=True)
        
        # Drop any duplicate columns created by mapping (e.g. Run Date and Settlement Date both becoming 'date')
        # We keep the first occurrence, which is typically the primary one.
        df = df.loc[:, ~df.columns.duplicated()].copy()
        
        # Handle Citibank specific parsing where we have debit/credit instead of amount
        if 'debit' in df.columns and 'credit' in df.columns and 'amount' not in df.columns:
            # Debit is spending (negative), Credit is payment/refund (positive)
            debit_vals = pd.to_numeric(df['debit'].astype(str).str.replace(r'[\$,]', '', regex=True), errors='coerce').fillna(0)
            credit_vals = pd.to_numeric(df['credit'].astype(str).str.replace(r'[\$,]', '', regex=True), errors='coerce').fillna(0)
            df['amount'] = credit_vals - debit_vals
            
        # Default category if not present (Citibank often lacks a Category column)
        if 'category' not in df.columns:
            df['category'] = 'Uncategorized'
            
        # Basic validation for investment CSVs
        # Only date, amount, and category (action) are strictly required for a transaction
        required_cols = {'date', 'amount', 'category'}
        if not required_cols.issubset(df.columns):
            missing = required_cols - set(df.columns)
            logger.error(f"Investment CSV is missing required columns: {missing}")
            return False, f"Missing columns: {', '.join(missing)}\nHint: Ensure your CSV has columns that map to date, amount, and category (e.g. Action/Type)."
            
        # Ensure description exists
        if 'description' not in df.columns:
            df['description'] = ""

        # Cache for account institutions to avoid querying every row
        acc_inst_cache = {}

        # Sort rows chronologically (oldest date first) so position opens are created before splits/closes
        df['_parsed_date'] = pd.to_datetime(df['date'], errors='coerce')
        df = df.sort_values(by='_parsed_date', ascending=True)

        # Process row by row
        new_count = 0
        skipped_count = 0
        for _, row in df.iterrows():
            # Skip trailing summary rows or empty rows that Schwab often leaves at the bottom
            if pd.isna(row['date']) or str(row['date']).strip() == '' or str(row['date']).lower() == 'nan':
                continue

            if force_account_id is not None:
                acc_id = force_account_id
            else:
                # 1. Ensure institution
                inst_name = str(row['institution_name']).strip() if 'institution_name' in df.columns and pd.notna(row['institution_name']) else default_institution
                inst_id = get_or_create_institution(inst_name)
                
                # 2. Ensure account
                acc_name = str(row['account_name']).strip() if 'account_name' in df.columns and pd.notna(row['account_name']) else default_account
                
                # Always default to 'investment' for this context
                acc_type = str(row['account_type']).strip().lower() if 'account_type' in df.columns and pd.notna(row['account_type']) else 'investment'
                if acc_type not in ('checking', 'savings', 'credit card', 'investment', 'loan'):
                    acc_type = 'investment'  # fallback
                
                acc_id = get_or_create_account(
                    institution_id=inst_id, 
                    name=acc_name, 
                    acc_type=acc_type
                )
            
            # Determine if this account is Fidelity Investments
            if acc_id not in acc_inst_cache:
                from models.database import get_db_connection
                with get_db_connection() as conn:
                    inst_row = conn.execute(
                        "SELECT i.name FROM institutions i JOIN accounts a ON a.institution_id = i.id WHERE a.id = ?",
                        (acc_id,)
                    ).fetchone()
                    acc_inst_cache[acc_id] = inst_row['name'] if inst_row else ""
            
            if acc_inst_cache[acc_id] == "Fidelity Investments":
                # Check symbol pattern. Non-options or non-matching symbols must be skipped
                symbol_val = str(row.get('symbol', '')).strip() if 'symbol' in df.columns and pd.notna(row.get('symbol')) else ''
                import re
                fid_pattern = re.compile(r"^-?[A-Za-z\.]+\d{6}[CPcp]\d+(?:\.\d+)?$")
                fid_custom_pattern = re.compile(r"(CALL|PUT)\s+\(([A-Z\.]+)\)\s+(.+?)\s+([A-Z]{3})\s+(\d{1,2})\s+(\d{2})\s+\$([\d\.]+)", re.IGNORECASE)
                if not fid_pattern.match(symbol_val) and not fid_custom_pattern.search(symbol_val):
                    continue

            # 3. Add transaction
            # Build an enriched description for Schwab/Fidelity
            # Parse option details early to standardize description symbols
            opt_data = None
            raw_sym = str(row.get('symbol', '')).strip() if 'symbol' in df.columns and pd.notna(row.get('symbol')) else ''
            if raw_sym:
                from services.options import parse_option_symbol
                opt_data = parse_option_symbol(raw_sym)
                
            desc_parts = []
            if opt_data:
                # Format to standard Schwab representation for front-end rendering compatibility
                from datetime import datetime as dt
                exp_dt = dt.strptime(opt_data['expiration'], "%Y-%m-%d")
                formatted_sym = f"{opt_data['underlying']} {exp_dt.strftime('%m/%d/%Y')} {opt_data['strike']:g} {opt_data['type']}"
                desc_parts.append(f"Sym: {formatted_sym}")
            elif raw_sym:
                desc_parts.append(f"Sym: {raw_sym}")

            if 'description' in df.columns and pd.notna(row['description']) and str(row['description']).strip():
                desc_parts.append(str(row['description']).strip())
            if 'quantity' in df.columns and pd.notna(row['quantity']):
                desc_parts.append(f"Qty: {row['quantity']}")
            if 'price' in df.columns and pd.notna(row['price']):
                desc_parts.append(f"Price: {row['price']}")
                
            # Schwab specific: "Fees & Comm" -> "fees_&_comm" after space-to-underscore logic
            fee_cols = [c for c in df.columns if 'fee' in c or 'comm' in c]
            for fc in fee_cols:
                if pd.notna(row[fc]) and str(row[fc]).strip():
                    val = str(row[fc]).strip()
                    if val not in ('$0.00', '0', '0.0', '0.00'):
                        desc_parts.append(f"Fees: {val}")
                
            desc = " | ".join(desc_parts)

            # Strict amount parsing to prevent NOT NULL constraint failures from NaN values
            if pd.isna(row['amount']):
                amt = 0.0
            else:
                try:
                    amt_str = str(row['amount']).replace('$', '').replace(',', '').strip()
                    if amt_str.lower() == 'nan':
                        amt = 0.0
                    else:
                        amt = float(amt_str) if amt_str else 0.0
                except ValueError:
                    amt = 0.0
            
            # Final safeguard against math.nan
            if pd.isna(amt):
                amt = 0.0
                
            category_val = str(row['category']).strip()
            cat_lower = category_val.lower()
            
            # Universal Option Lifecycle Standardization
            if "expired" in cat_lower:
                category_val = "Expired"
            elif "assigned" in cat_lower:
                category_val = "Assigned"
            elif "exercised" in cat_lower or "exercise" in cat_lower:
                category_val = "Exercised"
            elif cat_lower in ('buy', 'bought', 'you bought'):
                category_val = "Buy"
            elif cat_lower in ('sell', 'sold', 'you sold'):
                category_val = "Sell"
            elif cat_lower in ('short', 'short sell', 'sell short'):
                category_val = "Short"
            elif cat_lower in ('cover', 'buy to cover', 'bought to cover'):
                category_val = "Cover"
                
            if acc_inst_cache[acc_id] == "Fidelity Investments":
                if "bought to open" in cat_lower or "buy to open" in cat_lower or "bought opening" in cat_lower or "buy opening" in cat_lower:
                    category_val = "Buy to Open"
                elif "sold to open" in cat_lower or "sell to open" in cat_lower or "sold opening" in cat_lower or "sell opening" in cat_lower:
                    category_val = "Sell to Open"
                elif "bought to close" in cat_lower or "buy to close" in cat_lower or "bought closing" in cat_lower or "buy closing" in cat_lower:
                    category_val = "Buy to Close"
                elif "sold to close" in cat_lower or "sell to close" in cat_lower or "sold closing" in cat_lower or "sell closing" in cat_lower:
                    category_val = "Sell to Close"

            # Date parsing logic
            try:
                raw_date = str(row['date']).strip()
                category_str = category_val.lower()
                
                # Extract the actual option expiration date from the symbol for Expired transactions if possible
                opt_expiration = None
                if category_str == 'expired' and 'symbol' in df.columns and pd.notna(row.get('symbol')):
                    from services.options import parse_option_symbol
                    opt_data = parse_option_symbol(str(row['symbol']).strip())
                    if opt_data:
                        opt_expiration = opt_data['expiration']
                
                if opt_expiration:
                    formatted_date = opt_expiration
                elif ' as of ' in raw_date:
                    # For all "as of" backdated settlement rows (Expired, Assigned, Exercised, and assignment stock trades),
                    # use the actual event date (the date after "as of") rather than the broker's delayed statement posting date.
                    actual_date_str = raw_date.split(' as of ')[-1].strip()
                    formatted_date = pd.to_datetime(actual_date_str).strftime('%Y-%m-%d')
                else:
                    # Standard date parsing
                    formatted_date = pd.to_datetime(raw_date).strftime('%Y-%m-%d')
            except Exception:
                # Fallback if pandas can't parse it
                formatted_date = str(row['date']).strip()

            # Enforce 0.00 amount for expirations
            if category_val == "Expired":
                amt = 0.0

            transaction_id, is_new = add_transaction(
                account_id=acc_id,
                date=formatted_date,
                amount=amt,
                category=category_val,
                description=desc,
                imported_file_id=imported_file_id
            )
            if is_new:
                new_count += 1
            else:
                skipped_count += 1
                
            # Process option trade grouping (whether new or existing transaction)
            if transaction_id:
                from services.options import process_option_trade
                process_option_trade(transaction_id, acc_id, desc, category_val, amt)
            
        return True, f"Imported {new_count} new transactions and skipped {skipped_count} duplicates."
    
    except Exception as e:
        logger.error(f"Failed to import CSV: {e}")
        return False, str(e)
