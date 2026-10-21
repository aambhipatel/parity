import re
from datetime import datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP
from models.database import get_db_connection
from utils.logger import logger


def allocate_display_cents(values_dict, total_raw):
    """
    Allocates display cents across a dictionary of {key: raw_decimal}
    such that sum(display_cents) == round(total_raw, 2) exactly.
    Uses largest-remainder allocation (Hare-Niemeyer method) with magnitude tie-breaking.
    """
    if not values_dict:
        return {}
    total_dec = Decimal(str(total_raw if total_raw is not None else 0))
    total_cents = int(total_dec.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP) * 100)
    items = []
    current_sum_cents = 0
    for k, raw in values_dict.items():
        raw_dec = Decimal(str(raw if raw is not None else 0))
        rnd = raw_dec.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
        cents = int(rnd * 100)
        rem = (raw_dec * 100) - cents
        items.append({
            'key': k,
            'raw': raw_dec,
            'cents': cents,
            'rem': rem
        })
        current_sum_cents += cents

    diff = total_cents - current_sum_cents

    if diff > 0:
        items.sort(key=lambda x: (x['rem'], abs(x['raw'])), reverse=True)
        for i in range(diff):
            items[i]['cents'] += 1
    elif diff < 0:
        items.sort(key=lambda x: (x['rem'], -abs(x['raw'])))
        for i in range(abs(diff)):
            items[i]['cents'] -= 1

    result = {}
    for item in items:
        result[item['key']] = Decimal(item['cents']) / Decimal('100')
    return result

# Schwab format: SYMBOL MM/DD/YYYY STRIKE C
SCHWAB_OPTION_RE = re.compile(r"([A-Z]+)\s+(\d{2}/\d{2}/\d{4})\s+([\d\.]+)\s+([CP])")
# Fidelity format: [optional "-"][UNDERLYING][YY][MM][DD][C|P][STRIKE]
FIDELITY_OPTION_RE = re.compile(r"^-?([A-Z\.]+)(\d{2})(\d{2})(\d{2})([CP])(\d+(?:\.\d+)?)$", re.IGNORECASE)
# Fidelity custom format: ACTION (TICKER) FULL NAME OF TICKER 3LETTERMONTH 2DIGITDAY 2DIGITYEAR $STRIKEPRICE
FIDELITY_CUSTOM_OPTION_RE = re.compile(r"(CALL|PUT)\s+\(([A-Z\.]+)\)\s+(.+?)\s+([A-Z]{3})\s+(\d{1,2})\s+(\d{2})\s+\$([\d\.]+)", re.IGNORECASE)

months_map = {
    'JAN': '01', 'FEB': '02', 'MAR': '03', 'APR': '04',
    'MAY': '05', 'JUN': '06', 'JUL': '07', 'AUG': '08',
    'SEP': '09', 'OCT': '10', 'NOV': '11', 'DEC': '12'
}

def parse_option_symbol(symbol_str):
    # Try Schwab format
    match = SCHWAB_OPTION_RE.search(symbol_str)
    if match:
        underlying = match.group(1)
        exp_date_str = match.group(2)
        strike = float(match.group(3))
        opt_type = match.group(4)
        
        try:
            exp_date = datetime.strptime(exp_date_str, "%m/%d/%Y").strftime("%Y-%m-%d")
        except ValueError:
            return None
            
        return {
            "underlying": underlying,
            "expiration": exp_date,
            "strike": strike,
            "type": opt_type
        }

    # Try Fidelity Custom format
    match_fid_custom = FIDELITY_CUSTOM_OPTION_RE.search(symbol_str)
    if match_fid_custom:
        action = match_fid_custom.group(1).upper()
        underlying = match_fid_custom.group(2).upper()
        month_name = match_fid_custom.group(4).upper()[:3]
        day = int(match_fid_custom.group(5))
        yy = match_fid_custom.group(6)
        strike = float(match_fid_custom.group(7))
        
        mm = months_map.get(month_name, '01')
        exp_date = f"20{yy}-{mm}-{day:02d}"
        opt_type = 'C' if action == 'CALL' else 'P'
        return {
            "underlying": underlying,
            "expiration": exp_date,
            "strike": strike,
            "type": opt_type
        }

    # Try Fidelity OCC format
    match_fid = FIDELITY_OPTION_RE.match(symbol_str)
    if match_fid:
        underlying = match_fid.group(1).upper()
        yy = match_fid.group(2)
        mm = match_fid.group(3)
        dd = match_fid.group(4)
        opt_type = match_fid.group(5).upper()
        strike = float(match_fid.group(6))
        
        exp_date = f"20{yy}-{mm}-{dd}"
        return {
            "underlying": underlying,
            "expiration": exp_date,
            "strike": strike,
            "type": opt_type
        }
        
    return None

def process_option_trade(transaction_id, account_id, description, category, amount):
    """
    Parses a transaction description for option data and groups it into trade_positions.
    """
    # Check if this is a Fidelity account (they are pre-filtered during import)
    is_fidelity = False
    with get_db_connection() as conn:
        inst_row = conn.execute(
            "SELECT i.name FROM institutions i JOIN accounts a ON a.institution_id = i.id WHERE a.id = ?",
            (account_id,)
        ).fetchone()
        if inst_row and inst_row['name'] == 'Fidelity Investments':
            is_fidelity = True

    cat_lower = category.lower() if category else ""
    is_terminal = any(word in cat_lower for word in ['expired', 'assigned', 'exercised'])
    is_split = 'split' in cat_lower or 'split' in description.lower()
    is_transfer = 'transfer' in cat_lower or 'transfer' in description.lower()
    is_option_action = any(word in cat_lower for word in ['open', 'close', 'call', 'put', 'option'])
    
    if not is_fidelity and not is_terminal and not is_split and not is_transfer and not is_option_action:
        # Extract the original description from the enriched description string (joined by ' | ')
        parts = [p.strip() for p in description.split('|')]
        orig_desc = ""
        if parts:
            if parts[0].startswith('Sym:'):
                if len(parts) > 1:
                    orig_desc = parts[1]
            else:
                orig_desc = parts[0]
                
        orig_desc_upper = orig_desc.upper()
        if not (orig_desc_upper.startswith("PUT") or orig_desc_upper.startswith("CALL")):
            return False

    # Attempt to extract an option symbol from description. We expect the symbol 
    # to be stored as 'Sym: SYMBOL MM/DD/YYYY STRIKE C' by data_import.py
    sym_match = re.search(r"Sym:\s*([^\|]+)", description)
    if not sym_match:
        return False
        
    if category and category.strip().strip('"').lower() in ('journal', 'journaled shares'):
        return False

    symbol_str = sym_match.group(1).strip()
    opt_data = parse_option_symbol(symbol_str)
    if not opt_data:
        return False
        
    underlying = opt_data['underlying']
    
    with get_db_connection() as conn:
        position_id = None
        # Check if there is a synthetic or manual close leg that we need to reconcile
        synthetic_leg = conn.execute(
            """
            SELECT l.id as leg_id, l.transaction_id, l.position_id
            FROM option_legs l
            JOIN transactions t ON l.transaction_id = t.id
            JOIN trade_positions p ON l.position_id = p.id
            WHERE p.account_id = ? AND p.underlying_symbol = ? 
              AND l.expiration_date = ? AND ABS(l.strike_price - ?) < 0.01 AND l.option_type = ?
              AND l.transaction_id != ?
              AND t.description LIKE '%Synthetic due to Schwab delayed reporting%'
            """,
            (account_id, underlying, opt_data['expiration'], opt_data['strike'], opt_data['type'], transaction_id)
        ).fetchone()
        
        if synthetic_leg:
            conn.execute("DELETE FROM option_legs WHERE id = ?", (synthetic_leg['leg_id'],))
            conn.execute("DELETE FROM transactions WHERE id = ?", (synthetic_leg['transaction_id'],))
            logger.info(f"Reconciled option trade: Deleted placeholder close leg {synthetic_leg['leg_id']} "
                        f"and transaction {synthetic_leg['transaction_id']} to make way for official transaction {transaction_id}")
            position_id = synthetic_leg['position_id']
            
        cat_lower = category.lower() if category else ""
        desc_lower = description.lower() if description else ""
        is_expiration = any(word in cat_lower for word in ['expired', 'expiration', 'removal'])
        is_assignment_exercise = any(word in cat_lower for word in ['assigned', 'assignment', 'exercised', 'exercise'])
        is_terminal = is_expiration or is_assignment_exercise
        is_close = ('close' in cat_lower) or ('closing' in cat_lower) or ('to_close' in cat_lower) or ('to close' in desc_lower)

        if not position_id:
            # If closing or terminal event, prefer the position that holds the open leg for this specific contract
            if is_terminal or is_close:
                matching_open_leg = conn.execute(
                    """
                    SELECT l.position_id, l.action 
                    FROM option_legs l
                    JOIN trade_positions p ON l.position_id = p.id
                    WHERE p.account_id = ? AND p.underlying_symbol = ?
                      AND l.expiration_date = ? AND ABS(l.strike_price - ?) < 0.01 AND l.option_type = ?
                      AND l.action IN ('BTO', 'STO')
                    ORDER BY l.rowid DESC LIMIT 1
                    """,
                    (account_id, underlying, opt_data['expiration'], opt_data['strike'], opt_data['type'])
                ).fetchone()
                if matching_open_leg:
                    position_id = matching_open_leg['position_id']

            if not position_id:
                # Check if there is an open position for this underlying in this account
                pos = conn.execute(
                    "SELECT id FROM trade_positions WHERE account_id = ? AND underlying_symbol = ? AND status = 'Open'",
                    (account_id, underlying)
                ).fetchone()
                
                if pos:
                    position_id = pos['id']
                else:
                    # Create a new position
                    cursor = conn.execute(
                        "INSERT INTO trade_positions (account_id, underlying_symbol) VALUES (?, ?)",
                        (account_id, underlying)
                    )
                    position_id = cursor.lastrowid
            
        # Determine action (BTO, STO, BTC, STC, SPLIT)

        # Handle Option Stock Split events (e.g. "Options Frwd Split", "Options Rev Split")
        if 'split' in cat_lower or 'split' in desc_lower:
            qty_match = re.search(r"Qty:\s*-?([\d\.]+)", description)
            split_delta_qty = abs(float(qty_match.group(1))) if qty_match else 0.0
            
            existing = conn.execute(
                "SELECT id FROM option_legs WHERE transaction_id = ?",
                (transaction_id,)
            ).fetchone()
            
            if existing:
                conn.execute(
                    """
                    UPDATE option_legs 
                    SET position_id = ?, action = 'SPLIT', expiration_date = ?, strike_price = ?, option_type = ?, quantity = ?, fees = 0.0
                    WHERE id = ?
                    """,
                    (position_id, opt_data['expiration'], opt_data['strike'], opt_data['type'], split_delta_qty, existing['id'])
                )
            else:
                conn.execute(
                    """
                    INSERT INTO option_legs 
                    (transaction_id, position_id, expiration_date, strike_price, option_type, action, quantity, fees) 
                    VALUES (?, ?, ?, ?, ?, 'SPLIT', ?, 0.0)
                    """,
                    (transaction_id, position_id, opt_data['expiration'], opt_data['strike'], opt_data['type'], split_delta_qty)
                )
            logger.info(f"Recorded option split leg for {symbol_str} to position {position_id} (Delta Qty: {split_delta_qty})")
            return True

        # Handle Option Security Transfer events (e.g. "Security Transfer")
        is_trade_action = any(a in cat_lower for a in ['open', 'close', 'bto', 'sto', 'btc', 'stc'])
        if (('transfer' in cat_lower) or ('security transfer' in desc_lower)) and not is_trade_action:
            qty_match = re.search(r"Qty:\s*(-?[\d\.]+)", description)
            raw_qty = float(qty_match.group(1)) if qty_match else 1.0
            transfer_qty = abs(raw_qty) if raw_qty != 0.0 else 1.0
            action = 'TRANSFER_OUT' if raw_qty < 0 else 'TRANSFER_IN'

            existing_legs = conn.execute(
                "SELECT id FROM option_legs WHERE transaction_id = ?",
                (transaction_id,)
            ).fetchall()

            if len(existing_legs) > 1:
                logger.info(f"Transaction {transaction_id} already has {len(existing_legs)} allocated legs; preserving.")
                return True
            elif existing_legs:
                existing = existing_legs[0]
                conn.execute(
                    """
                    UPDATE option_legs 
                    SET position_id = ?, expiration_date = ?, strike_price = ?, option_type = ?, action = ?, quantity = ?, fees = 0.0
                    WHERE id = ?
                    """,
                    (position_id, opt_data['expiration'], opt_data['strike'], opt_data['type'], action, transfer_qty, existing['id'])
                )
            else:
                conn.execute(
                    """
                    INSERT INTO option_legs 
                    (transaction_id, position_id, expiration_date, strike_price, option_type, action, quantity, fees) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, 0.0)
                    """,
                    (transaction_id, position_id, opt_data['expiration'], opt_data['strike'], opt_data['type'], action, transfer_qty)
                )
            logger.info(f"Recorded option transfer leg ({action}) for {symbol_str} to position {position_id} (Qty: {transfer_qty})")
            return True
        
        if is_terminal:
            # Expirations: if no explicit close amount is attached, set to 0.00 in memory
            if is_expiration and (amount is None or amount == 0.0):
                amount = 0.0
            
            # Terminal events close the position. Look at existing open legs
            # for this contract across the account to determine the correct closing direction.
            existing_legs = conn.execute(
                """
                SELECT l.action, l.position_id 
                FROM option_legs l
                JOIN trade_positions p ON l.position_id = p.id
                WHERE p.account_id = ? AND l.expiration_date = ? AND ABS(l.strike_price - ?) < 0.01 AND l.option_type = ?
                ORDER BY l.rowid ASC LIMIT 1
                """,
                (account_id, opt_data['expiration'], opt_data['strike'], opt_data['type'])
            ).fetchone()
            
            if existing_legs:
                if existing_legs['position_id']:
                    position_id = existing_legs['position_id']
                if existing_legs['action'] in ('STO', 'STC'):
                    action = "BTC"
                else:
                    action = "STC"
            else:
                # Smart fallback if the original leg was never imported or not found
                if is_assignment_exercise:
                    if 'assign' in cat_lower:
                        action = "BTC"  # Only short options (STO) get assigned
                    elif 'exercis' in cat_lower:
                        action = "STC"  # Only long options (BTO) get exercised
                    else:
                        action = "STC"
                else:
                    action = "EXPIRED"  # Record as EXPIRED so FIFO engine resolves direction dynamically
        else:
            is_buy = ('buy' in cat_lower) or ('bought' in cat_lower) or (amount < 0 and 'sell' not in cat_lower and 'sold' not in cat_lower)
            is_close = ('close' in cat_lower) or ('closing' in cat_lower) or ('to_close' in cat_lower) or ('to close' in description.lower())
            if is_buy:
                action = "BTC" if is_close else "BTO"
            else:
                action = "STC" if is_close else "STO"
            
        # Parse Qty and Fees
        qty_match = re.search(r"Qty:\s*-?([\d\.]+)", description)
        qty = float(qty_match.group(1)) if qty_match else 1.0
        
        fee_matches = re.findall(r"Fees:\s*\$?([\d\.]+)", description)
        fees = sum(float(f) for f in fee_matches) if fee_matches else 0.0
        
        # Check for existing leg to ensure idempotency
        existing_legs = conn.execute(
            "SELECT id FROM option_legs WHERE transaction_id = ?",
            (transaction_id,)
        ).fetchall()
        
        if len(existing_legs) > 1:
            logger.info(f"Transaction {transaction_id} already has {len(existing_legs)} allocated legs (multi-lot allocation); preserving.")
            return True
        elif existing_legs:
            existing = existing_legs[0]
            # Update existing single leg instead of inserting
            conn.execute(
                """
                UPDATE option_legs 
                SET position_id = ?, expiration_date = ?, strike_price = ?, option_type = ?, action = ?, quantity = ?, fees = ?
                WHERE id = ?
                """,
                (position_id, opt_data['expiration'], opt_data['strike'], opt_data['type'], action, qty, fees, existing['id'])
            )
            logger.info(f"Updated existing option leg {existing['id']} for transaction {transaction_id}")
        else:
            # Insert new option leg
            conn.execute(
                """
                INSERT INTO option_legs 
                (transaction_id, position_id, expiration_date, strike_price, option_type, action, quantity, fees) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (transaction_id, position_id, opt_data['expiration'], opt_data['strike'], opt_data['type'], action, qty, fees)
            )
            logger.info(f"Added option leg for {symbol_str} to position {position_id} (Qty: {qty}, Fees: {fees})")
        
        return True

def classify_strategy(legs):
    if not legs:
        return "Custom"
        
    # Ignore adjustment rows (e.g. SPLIT, TRANSFER) when classifying strategy shape
    non_split_legs = [l for l in legs if l.get('action') not in ('SPLIT', 'FORWARD_SPLIT', 'REVERSE_SPLIT', 'TRANSFER_OUT', 'TRANSFER_IN', 'TRANSFER')]
    if not non_split_legs:
        return "Custom"

    # Group legs by unique contract (expiration, strike, type)
    contracts = {}
    for leg in non_split_legs:
        key = (leg['expiration'], leg['strike'], leg['type'])
        if key not in contracts:
            contracts[key] = leg['action']
            
    unique_legs = list(contracts.keys())
    
    # If all legs share the same expiration and type across a split (different strikes before and after the corporate action):
    if len(unique_legs) > 1:
        exps = {l['expiration'] for l in non_split_legs}
        types = {l['type'] for l in non_split_legs}
        actions = [l['action'] for l in non_split_legs]
        has_open = any(a in ('STO', 'BTO') for a in actions)
        has_close = any(a in ('BTC', 'STC') for a in actions)
        if len(exps) == 1 and len(types) == 1 and has_open and has_close and len(non_split_legs) <= 3:
            open_action = next(a for a in actions if a in ('STO', 'BTO'))
            opt_type = next(iter(types))
            return f"Naked {'Call' if opt_type == 'C' else 'Put'}" if open_action == 'STO' else f"Long {'Call' if opt_type == 'C' else 'Put'}"

    if len(unique_legs) == 1:
        leg_exp, leg_strike, leg_type = unique_legs[0]
        action = contracts[unique_legs[0]]
        if action in ('STO', 'BTC'):
            return f"Naked {'Call' if leg_type == 'C' else 'Put'}"
        else:
            return f"Long {'Call' if leg_type == 'C' else 'Put'}"
            
    if len(unique_legs) == 2:
        l1, l2 = unique_legs[0], unique_legs[1]
        same_exp = l1[0] == l2[0]
        same_strike = l1[1] == l2[1]
        same_type = l1[2] == l2[2]
        
        if same_exp and same_type and not same_strike:
            return "Vertical Spread"
        if same_exp and not same_type and same_strike:
            return "Straddle"
        if same_exp and not same_type and not same_strike:
            return "Strangle"
        if not same_exp and same_strike and same_type:
            return "Calendar Spread"
        if not same_exp and not same_strike and same_type:
            return "Diagonal Spread"
            
    if len(unique_legs) == 4:
        types = [l[2] for l in unique_legs]
        if types.count('C') == 2 and types.count('P') == 2:
            return "Iron Condor"
            
    return "Custom"

def auto_close_expired_options():
    """Disabled: strictly CSV-driven options expiration model is active."""
    pass

def repair_unlinked_expired_options(conn=None, opt_in=False):
    """
    Explicit opt-in repair utility:
    Finds transactions with category in ('Expired', 'Assigned', 'Exercised')
    that lack corresponding rows in option_legs, and creates closing legs
    attached to the matching open trade position.
    Requires opt_in=True to modify the database.
    """
    if not opt_in:
        return 0
    import re

    def _do_repair(c):
        unlinked = c.execute("""
            SELECT t.id, t.account_id, t.date, t.amount, t.category, t.description
            FROM transactions t
            LEFT JOIN option_legs ol ON t.id = ol.transaction_id
            WHERE ol.id IS NULL
              AND LOWER(t.category) NOT IN ('journal', 'journaled shares')
              AND (
                  LOWER(t.category) IN ('expired', 'assigned', 'exercised')
                  OR LOWER(t.category) LIKE '%expiration%'
                  OR LOWER(t.category) LIKE '%expired%'
              )
        """).fetchall()

        if not unlinked:
            return 0

        repaired_count = 0
        for tx in unlinked:
            desc = tx['description'] or ''
            sym_match = re.search(r"Sym:\s*([^\|]+)", desc)
            if not sym_match:
                continue
            opt_data = parse_option_symbol(sym_match.group(1).strip())
            if not opt_data:
                continue

            qty_match = re.search(r"Qty:\s*-?([\d\.]+)", desc)
            qty = abs(float(qty_match.group(1))) if qty_match else 1.0

            fee_matches = re.findall(r"Fees:\s*\$?([\d\.]+)", desc)
            fees = sum(float(f) for f in fee_matches) if fee_matches else 0.0

            underlying = opt_data['underlying']
            account_id = tx['account_id']
            cat_lower = (tx['category'] or '').lower()

            # Enforce 0.00 amount on expired transactions in memory


            # Find matching open leg for this specific contract
            matching_leg = c.execute("""
                SELECT l.position_id, l.action, l.quantity
                FROM option_legs l
                JOIN trade_positions p ON l.position_id = p.id
                WHERE p.account_id = ? AND p.underlying_symbol = ?
                  AND l.expiration_date = ? AND ABS(l.strike_price - ?) < 0.01 AND l.option_type = ?
                  AND l.action IN ('BTO', 'STO')
                ORDER BY l.rowid DESC LIMIT 1
            """, (account_id, underlying, opt_data['expiration'], opt_data['strike'], opt_data['type'])).fetchone()

            if matching_leg:
                position_id = matching_leg['position_id']
                open_act = matching_leg['action'].upper()
                close_action = 'BTC' if open_act == 'STO' else 'STC'
            else:
                # Fallback: check any leg for this contract
                any_leg = c.execute("""
                    SELECT l.position_id, l.action
                    FROM option_legs l
                    JOIN trade_positions p ON l.position_id = p.id
                    WHERE p.account_id = ? AND p.underlying_symbol = ?
                      AND l.expiration_date = ? AND ABS(l.strike_price - ?) < 0.01 AND l.option_type = ?
                    ORDER BY l.rowid DESC LIMIT 1
                """, (account_id, underlying, opt_data['expiration'], opt_data['strike'], opt_data['type'])).fetchone()
                if any_leg:
                    position_id = any_leg['position_id']
                else:
                    pos = c.execute(
                        "SELECT id FROM trade_positions WHERE account_id = ? AND underlying_symbol = ? ORDER BY id DESC LIMIT 1",
                        (account_id, underlying)
                    ).fetchone()
                    if pos:
                        position_id = pos['id']
                    else:
                        cur = c.execute(
                            "INSERT INTO trade_positions (account_id, underlying_symbol) VALUES (?, ?)",
                            (account_id, underlying)
                        )
                        position_id = cur.lastrowid
                
                if 'assign' in cat_lower:
                    close_action = 'BTC'
                elif 'exercis' in cat_lower:
                    close_action = 'STC'
                else:
                    close_action = 'EXPIRED'

            c.execute("""
                INSERT INTO option_legs
                (transaction_id, position_id, expiration_date, strike_price, option_type, action, quantity, fees)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (tx['id'], position_id, opt_data['expiration'], opt_data['strike'], opt_data['type'], close_action, qty, fees))
            repaired_count += 1

        if repaired_count > 0:
            c.commit()
            logger.info(f"Auto-linked {repaired_count} expired/assigned option transactions to option_legs.")
        return repaired_count

    if conn is not None:
        return _do_repair(conn)
    else:
        with get_db_connection() as c:
            return _do_repair(c)

def get_options_portfolio(account_ids=None, as_of_date=None, *, _analysis=None):
    # Queries must never create missing storage or persist repairs.
    from models.database import get_readonly_db_connection as get_db_connection
    query = """
        SELECT p.id as position_id, p.underlying_symbol, p.strategy_type, p.status, p.notes,
               p.account_id, a.name as account_name,
               l.id as leg_id, l.expiration_date, l.strike_price, l.option_type, l.action, l.quantity, l.fees,
               t.amount, t.date, t.description, t.id as transaction_id, t.category
        FROM trade_positions p
        JOIN accounts a ON p.account_id = a.id
        JOIN option_legs l ON p.id = l.position_id
        JOIN transactions t ON l.transaction_id = t.id
    """
    
    params = []
    if account_ids:
        placeholders = ','.join('?' * len(account_ids))
        query += f" WHERE p.account_id IN ({placeholders})"
        params.extend(account_ids)
        
    query += " ORDER BY p.id DESC, t.date ASC"
    
    positions = {}
    with get_db_connection() as conn:
        rows = [dict(r) for r in conn.execute(query, params).fetchall()]
        
        # In-memory synthesis for unlinked terminal option transactions (Expired, Assigned, Exercised)
        # Guarantees zero disk writes while reconciling unlinked broker expiration rows
        unlinked_query = """
            SELECT t.id as transaction_id, t.account_id, a.name as account_name,
                   t.amount, t.date, t.description, t.category
            FROM transactions t
            JOIN accounts a ON t.account_id = a.id
            LEFT JOIN option_legs ol ON t.id = ol.transaction_id
            WHERE ol.id IS NULL
              AND LOWER(t.category) NOT IN ('journal', 'journaled shares')
              AND (
                  LOWER(t.category) IN ('expired', 'assigned', 'exercised')
                  OR LOWER(t.category) LIKE '%expiration%'
                  OR LOWER(t.category) LIKE '%expired%'
              )
        """
        unlinked_params = []
        if account_ids:
            placeholders = ','.join('?' * len(account_ids))
            unlinked_query += f" AND t.account_id IN ({placeholders})"
            unlinked_params.extend(account_ids)
        unlinked_query += " ORDER BY t.date ASC"
        
        unlinked = conn.execute(unlinked_query, unlinked_params).fetchall()
        for tx in unlinked:
            desc = tx['description'] or ''
            sym_match = re.search(r"Sym:\s*([^\|]+)", desc)
            if not sym_match:
                continue
            opt_data = parse_option_symbol(sym_match.group(1).strip())
            if not opt_data:
                continue

            qty_match = re.search(r"Qty:\s*-?([\d\.]+)", desc)
            qty = abs(float(qty_match.group(1))) if qty_match else 1.0

            fee_matches = re.findall(r"Fees:\s*\$?([\d\.]+)", desc)
            fees = sum(float(f) for f in fee_matches) if fee_matches else 0.0

            underlying = opt_data['underlying']
            account_id = tx['account_id']
            cat_lower = (tx['category'] or '').lower()

            matching_leg = conn.execute("""
                SELECT l.position_id, p.underlying_symbol, p.strategy_type, p.status, p.notes, l.action
                FROM option_legs l
                JOIN trade_positions p ON l.position_id = p.id
                WHERE p.account_id = ? AND p.underlying_symbol = ?
                  AND l.expiration_date = ? AND ABS(l.strike_price - ?) < 0.01 AND l.option_type = ?
                  AND l.action IN ('BTO', 'STO')
                ORDER BY l.rowid DESC LIMIT 1
            """, (account_id, underlying, opt_data['expiration'], opt_data['strike'], opt_data['type'])).fetchone()

            if matching_leg:
                pos_id = matching_leg['position_id']
                strat_type = matching_leg['strategy_type']
                pos_status = matching_leg['status']
                pos_notes = matching_leg['notes']
                open_act = matching_leg['action'].upper()
                close_action = 'BTC' if open_act == 'STO' else 'STC'
            else:
                pos = conn.execute(
                    "SELECT id, strategy_type, status, notes FROM trade_positions WHERE account_id = ? AND underlying_symbol = ? ORDER BY id DESC LIMIT 1",
                    (account_id, underlying)
                ).fetchone()
                pos_id = pos['id'] if pos else -1
                strat_type = pos['strategy_type'] if pos else 'Single Option'
                pos_status = pos['status'] if pos else 'Open'
                pos_notes = pos['notes'] if pos else None
                close_action = 'BTC' if 'assign' in cat_lower else ('STC' if 'exercis' in cat_lower else 'EXPIRED')

            synth_row = {
                'position_id': pos_id,
                'underlying_symbol': underlying,
                'strategy_type': strat_type,
                'status': pos_status,
                'notes': pos_notes,
                'account_id': account_id,
                'account_name': tx['account_name'],
                'leg_id': -tx['transaction_id'],
                'expiration_date': opt_data['expiration'],
                'strike_price': opt_data['strike'],
                'option_type': opt_data['type'],
                'action': close_action,
                'quantity': qty,
                'fees': fees,
                'amount': 0.0,
                'date': tx['date'],
                'description': tx['description'],
                'transaction_id': tx['transaction_id'],
                'category': tx['category']
            }
            rows.append(synth_row)

        # Only equity sells contribute stock fees. Unlinked option-shaped sells
        # remain excluded regardless of their database-specific transaction ID.
        stock_fees_query = """
            SELECT t.id, t.account_id, t.description
            FROM transactions t
            LEFT JOIN option_legs ol ON t.id = ol.transaction_id
            WHERE ol.id IS NULL
              AND LOWER(TRIM(REPLACE(t.category, '"', ''))) IN ('sell', 'sold')
        """
        stock_fees_params = []
        if account_ids:
            placeholders = ','.join('?' * len(account_ids))
            stock_fees_query += f" AND t.account_id IN ({placeholders})"
            stock_fees_params.extend(account_ids)

        stock_sell_txs = conn.execute(stock_fees_query, stock_fees_params).fetchall()
        stock_fees = Decimal('0.0')
        for stx in stock_sell_txs:
            symbol = re.search(r'Sym:\s*([^|]+)', stx['description'] or '')
            if symbol and parse_option_symbol(symbol.group(1).strip()):
                continue
            s_matches = re.findall(r"Fees:\s*\$?([\d\.]+)", stx['description'] or '')
            if s_matches:
                stock_fees += sum(Decimal(m) for m in s_matches)

        # Data Quality Warnings: detect unlinked option transactions, including duplicates.
        orphan_query = """
            SELECT t.id, t.account_id, a.name as account_name, t.date, t.amount, t.category, t.description
            FROM transactions t
            JOIN accounts a ON t.account_id = a.id
            LEFT JOIN option_legs ol ON t.id = ol.transaction_id
            WHERE ol.id IS NULL
              AND LOWER(TRIM(REPLACE(t.category, '"', ''))) IN ('buy to open', 'sell to open', 'buy to close', 'sell to close')
        """
        orphan_txs = conn.execute(orphan_query).fetchall()
        from services.option_issues import IssueCollector, contract_scope
        issues = IssueCollector()
        data_quality_warnings = []
        orphan_underlyings = {}
        for ot in orphan_txs:
            dup = conn.execute("""
                SELECT t2.id, t2.account_id, a2.name as account_name
                FROM transactions t2
                JOIN accounts a2 ON t2.account_id = a2.id
                WHERE t2.id != ? AND t2.date = ? AND ABS(t2.amount - ?) < 0.001 AND t2.description = ?
                LIMIT 1
            """, (ot['id'], ot['date'], ot['amount'], ot['description'])).fetchone()

            sym_match = re.search(r"Sym:\s*([^\s\|]+)", ot['description'] or '')
            ticker = sym_match.group(1).strip() if sym_match else ""
            if ticker:
                orphan_underlyings.setdefault(ticker, []).append((ot, dup))

            if dup:
                warn_msg = f"Orphan transaction #{ot['id']} ({ot['category']} {ticker} in {ot['account_name']}): duplicate of #{dup['id']} ({dup['account_name']}) without option legs; excluded from calculations."
            else:
                warn_msg = f"Orphan transaction #{ot['id']} ({ot['category']} {ticker} in {ot['account_name']}): unlinked option trade without option legs; excluded from calculations."

            if not account_ids or ot['account_id'] in account_ids or (dup and dup['account_id'] in account_ids):
                data_quality_warnings.append(warn_msg)
                issues.add('unlinked_option_trade', warn_msg,
                           account_ids=[ot['account_id']] + ([dup['account_id']] if dup else []), transaction_ids=[ot['id']],
                           details={'possible_duplicate_transaction_id': dup['id'] if dup else None})

        # Check dismissed duplicate pairs from app_settings
        dismissed_dup_keys = conn.execute(
            "SELECT key FROM app_settings WHERE key LIKE 'dismissed_duplicate_pair:%'"
        ).fetchall()
        dismissed_pairs = set()
        for drow in dismissed_dup_keys:
            try:
                parts = drow['key'].split(':')
                dismissed_pairs.add((int(parts[1]), int(parts[2])))
            except Exception:
                pass

        # Cross-account identical transaction detection (same date, contract, qty, price, fees)
        cross_txs = conn.execute("""
            SELECT t.id, t.account_id, a.name as account_name, t.date, t.amount, t.category, t.description,
                   (SELECT COUNT(*) FROM option_legs ol WHERE ol.transaction_id = t.id) as leg_count
            FROM transactions t
            JOIN accounts a ON t.account_id = a.id
            WHERE t.description LIKE '%Sym:%'
               OR LOWER(TRIM(REPLACE(t.category, '"', ''))) IN ('buy to open', 'sell to open', 'buy to close', 'sell to close')
            ORDER BY t.date, t.id
        """).fetchall()

        parsed_cross = []
        for ct in cross_txs:
            cdesc = ct['description'] or ''
            csym_m = re.search(r"Sym:\s*([^\|]+)", cdesc)
            copt = parse_option_symbol(csym_m.group(1).strip()) if csym_m else None
            cq_m = re.search(r"Qty:\s*(-?[\d\.,]+)", cdesc)
            cqty = abs(float(cq_m.group(1).replace(',', ''))) if cq_m else None
            cp_m = re.search(r"Price:\s*\$?([\d\.,]+)", cdesc)
            cprice = float(cp_m.group(1).replace(',', '')) if cp_m else None
            cf_m = re.findall(r"Fees:\s*\$?([\d\.]+)", cdesc)
            cfees = sum(float(x) for x in cf_m) if cf_m else 0.0

            parsed_cross.append({
                'tx': ct,
                'opt': copt,
                'qty': cqty,
                'price': cprice,
                'fees': cfees,
                'leg_count': ct['leg_count']
            })

        unlinked_dup_warnings = []
        linked_dup_warnings = []
        seen_dup_pairs = set()

        for i in range(len(parsed_cross)):
            p1 = parsed_cross[i]
            t1 = p1['tx']
            for j in range(i + 1, len(parsed_cross)):
                p2 = parsed_cross[j]
                t2 = p2['tx']
                if t1['date'] != t2['date']:
                    continue
                if t1['account_id'] == t2['account_id']:
                    continue
                if abs(t1['amount'] - t2['amount']) > 0.001:
                    continue
                if not (p1['opt'] and p2['opt']):
                    continue

                c_match = (
                    p1['opt']['underlying'] == p2['opt']['underlying'] and
                    p1['opt']['expiration'] == p2['opt']['expiration'] and
                    abs(p1['opt']['strike'] - p2['opt']['strike']) < 0.01 and
                    p1['opt']['type'] == p2['opt']['type']
                )
                if not c_match:
                    continue

                q_match = (p1['qty'] is not None and p2['qty'] is not None and abs(p1['qty'] - p2['qty']) < 0.001)
                pr_match = (p1['price'] is not None and p2['price'] is not None and abs(p1['price'] - p2['price']) < 0.01)
                fe_match = abs(p1['fees'] - p2['fees']) < 0.01

                if q_match and pr_match and fe_match:
                    pair_key = (min(t1['id'], t2['id']), max(t1['id'], t2['id']))
                    if pair_key in dismissed_pairs:
                        continue
                    if pair_key not in seen_dup_pairs:
                        seen_dup_pairs.add(pair_key)
                        if not account_ids or t1['account_id'] in account_ids or t2['account_id'] in account_ids:
                            opt = p1['opt']
                            strike_str = f"{opt['strike']:g}"
                            has_unlinked = (p1['leg_count'] == 0 or p2['leg_count'] == 0)
                            if has_unlinked:
                                dup_warn = (
                                    f"Possible duplicate transaction (unlinked leg): #{t1['id']} ({t1['account_name']}) and "
                                    f"#{t2['id']} ({t2['account_name']}) share identical date ({t1['date']}), "
                                    f"contract ({opt['underlying']} {opt['expiration']} ${strike_str} {opt['type']}), "
                                    f"qty ({p1['qty']:g}), price (${p1['price']:.2f}), and fees (${p1['fees']:.2f})."
                                )
                                if not any(f"#{t1['id']}" in w and f"#{t2['id']}" in w for w in data_quality_warnings):
                                    unlinked_dup_warnings.append(dup_warn)
                            else:
                                dup_warn = (
                                    f"Possible duplicate transaction: #{t1['id']} ({t1['account_name']}) and "
                                    f"#{t2['id']} ({t2['account_name']}) share identical date ({t1['date']}), "
                                    f"contract ({opt['underlying']} {opt['expiration']} ${strike_str} {opt['type']}), "
                                    f"qty ({p1['qty']:g}), price (${p1['price']:.2f}), and fees (${p1['fees']:.2f})."
                                )
                                if not any(f"#{t1['id']}" in w and f"#{t2['id']}" in w for w in data_quality_warnings):
                                    linked_dup_warnings.append(dup_warn)
                            issues.add('possible_duplicate', dup_warn,
                                       account_ids=[t1['account_id'], t2['account_id']],
                                       transaction_ids=pair_key,
                                       contract=contract_scope(opt['underlying'], opt['expiration'], opt['strike'], opt['type']),
                                       details={'has_unlinked_leg': has_unlinked})

        # Rank leg-less matches above pairs that both have linked legs
        data_quality_warnings = data_quality_warnings + unlinked_dup_warnings + linked_dup_warnings
        
    # Pre-calculate total quantity and leg counts per transaction across legs to accurately proportion cash and fees
    tx_total_quantities = {}
    tx_leg_counts = {}
    for row in rows:
        tx_id = row['transaction_id']
        qty = Decimal(str(row['quantity'] or 0))
        tx_total_quantities[tx_id] = tx_total_quantities.get(tx_id, Decimal('0.0')) + qty
        tx_leg_counts[tx_id] = tx_leg_counts.get(tx_id, 0) + 1

    for row in rows:
        pid = row['position_id']
        if pid not in positions:
            positions[pid] = {
                "id": pid,
                "account_id": row['account_id'],
                "account_name": row['account_name'],
                "underlying": row['underlying_symbol'],
                "strategy": row['strategy_type'] or "Custom",
                "status": row['status'],
                "notes": row['notes'],
                "realized_pl": Decimal('0.0'),
                "unrealized_pl": Decimal('0.0'),
                "cost_basis": Decimal('0.0'),
                "total_fees": Decimal('0.0'),
                "legs": []
            }
            
        pos = positions[pid]
        raw_amt = Decimal(str(row['amount'] or 0))
        qty = Decimal(str(row['quantity'] or 0))
        tx_id = row['transaction_id']
        desc = row.get('description') or ''
        fee_matches = re.findall(r"Fees:\s*\$?([\d\.]+)", desc)
        if fee_matches:
            tx_total_fee = sum(Decimal(f) for f in fee_matches)
            total_tx_qty = tx_total_quantities.get(tx_id, Decimal('0.0'))
            if total_tx_qty > Decimal('0.0001') and tx_leg_counts.get(tx_id, 1) > 1:
                fees = (qty / total_tx_qty) * tx_total_fee
            else:
                fees = tx_total_fee
        else:
            fees = Decimal(str(row['fees'] or 0))
        pos['total_fees'] += fees

        total_tx_qty = tx_total_quantities.get(tx_id, Decimal('0.0'))
        if total_tx_qty > Decimal('0.0001'):
            amt = (qty / total_tx_qty) * raw_amt
        else:
            amt = raw_amt
            
        pos['legs'].append({
            "id": row['leg_id'],
            "transaction_id": row['transaction_id'],
            "expiration": row['expiration_date'],
            "strike": row['strike_price'],
            "type": row['option_type'],
            "action": row['action'],
            "category": row['category'] or "",
            "quantity": qty,
            "fees": fees,
            "amount": amt,
            "date": row['date'],
            "description": row['description'],
            "current_value": Decimal('0.0'),
            "itm": False
        })
        
    # ─── FIFO Unit-Matching Engine ────────────────────────────────────────────
    # Processes legs chronologically per position.
    # For identical dates, opening actions (BTO/STO) are sorted first, followed by
    # corporate action split adjustments (SPLIT), then closing actions (STC/BTC).
    #
    # Split adjustments re-key open lots in inventory from their old strike/qty
    # to the new post-split strike/qty while strictly preserving original open date,
    # original open price basis, and cumulative cash basis.
    #
    # Multi-leg sub-strategy clustering is applied symmetrically to both:
    #   • Closed clusters  — grouped by the close_date of the realized event.
    #   • Open inventory   — grouped by the open_date of the original opening leg.

    from services.options_fifo import process_position
    from services.option_events import matched_event
    position_events = {}
    for pos in positions.values():
        events, transfers = process_position(pos, as_of_date, orphan_underlyings, issues=issues)
        position_events[pos['id']] = tuple(matched_event(pos, ev) for ev in events)
        for event in position_events[pos['id']]:
            if event.basis_status == 'unknown_transfer_basis':
                issues.add('unknown_transfer_basis', 'Transferred position, no cost basis',
                           account_ids=[event.account_id], position_id=event.position_id,
                           transaction_ids=[event.opening_transaction_id, event.closing_transaction_id],
                           contract=contract_scope(event.underlying, event.expiration, event.strike, event.option_type),
                           details={'scope': 'matched_close', 'quantity': str(event.quantity),
                                    'basis_status': event.basis_status})
        if _analysis is not None:
            _analysis['matched_events'].extend(position_events[pos['id']])
            _analysis['transferred_basis'] += sum(
                ev['open_unit_cash'] * ev['transferred_qty'] for ev in transfers
            )

    # ─── Portfolio-level rollup ───────────────────────────────────────────────
    total_realized        = sum(p['realized_pl']  for p in positions.values())
    total_unrealized      = sum(p['unrealized_pl'] for p in positions.values())
    total_past_expiration = sum(p['past_expiration_pl'] for p in positions.values())
    total_cost_basis      = sum(p['cost_basis']   for p in positions.values())
    total_options_fees    = sum(p['total_fees']   for p in positions.values())
    total_fees            = total_options_fees + stock_fees

    closed_query = """
        SELECT COUNT(*) FROM transactions
        WHERE LOWER(TRIM(REPLACE(category, '"', ''))) IN ('buy to close', 'sell to close')
    """
    closed_params = []
    if account_ids:
        placeholders = ','.join('?' * len(account_ids))
        closed_query += f" AND account_id IN ({placeholders})"
        closed_params.extend(account_ids)

    with get_db_connection() as conn:
        total_closed = conn.execute(closed_query, closed_params).fetchone()[0]

    wins     = [p for p in positions.values() if p['realized_pl'] > Decimal('0.0')]
    win_rate = (len(wins) / len(positions)) * 100 if positions else 0.0

    # Calculate exact prorated unmatched close cash amounts and counts
    unmatched_signed_sum = Decimal('0.0')
    unmatched_abs_sum = Decimal('0.0')
    unmatched_cash_count = 0
    total_unmatched_count = 0
    for p in positions.values():
        for s in p['sub_strategies']:
            if s.get('is_unmatched'):
                total_unmatched_count += 1
                open_qty = Decimal(str(s.get('open_qty', 0) or 0))
                for l in s.get('legs', []):
                    leg_qty = Decimal(str(l.get('quantity', 1) or 1))
                    leg_amt = Decimal(str(l.get('amount', 0) or 0))
                    ratio = (open_qty / leg_qty) if leg_qty > Decimal('0') else Decimal('1')
                    prorated = leg_amt * ratio
                    unmatched_signed_sum += prorated
                    if abs(prorated) > Decimal('0.001'):
                        unmatched_abs_sum += abs(prorated)
                        unmatched_cash_count += 1

    past_expiration_count = sum(
        1 for p in positions.values()
        for s in p['sub_strategies']
        if s.get('status') == 'Past Expiration'
    )

    from datetime import datetime as dt, timedelta
    ref_date_str = as_of_date or dt.now().strftime('%Y-%m-%d')
    try:
        ref_dt = dt.strptime(ref_date_str, '%Y-%m-%d').date()
    except Exception:
        ref_dt = dt.now().date()
    current_monday = (ref_dt - timedelta(days=ref_dt.weekday())).strftime('%Y-%m-%d')
    current_month = ref_date_str[:7]

    def _get_week_range(d_str):
        try:
            d = dt.strptime(d_str, '%Y-%m-%d').date()
            mon = (d - timedelta(days=d.weekday())).strftime('%Y-%m-%d')
            sun = (d + timedelta(days=6 - d.weekday())).strftime('%Y-%m-%d')
            return mon, sun
        except Exception:
            return d_str, d_str

    weekly_perf_map = {}
    monthly_perf_map = {}
    weekly_closed_contracts = set()
    monthly_closed_contracts = set()

    for p in positions.values():
        ticker = p['underlying'].upper()
        # EX-007: retain the existing contract summaries, but attribute matched
        # cash to each actual close date in calendar aggregates. Multiple FIFO
        # opening-lot matches count as one contract within each period.
        performance_subs = [s for s in p['sub_strategies'] if s.get('status') != 'Closed']
        closed_by_date = {}
        for ev in position_events[p['id']]:
            contract = (ev.position_id, ev.expiration, ev.strike, ev.option_type, ev.open_action)
            key = (contract, ev.close_date)
            if key not in closed_by_date:
                closed_by_date[key] = {
                    'status': 'Closed', 'close_date': ev.close_date,
                    'realized_pl': Decimal('0'), '_contract': contract,
                }
            closed_by_date[key]['realized_pl'] += ev.realized_pl
        performance_subs.extend(closed_by_date.values())
        for s in performance_subs:
            st = s.get('status')
            r_pl = Decimal(str(s.get('realized_pl', 0) or 0))
            exp_pl = Decimal(str(s.get('past_expiration_pl', 0) or 0))
            tgt_pl = Decimal(str(s.get('unrealized_pl', 0) or 0))

            target_date = None
            is_closed = (st == 'Closed')
            is_past_exp = (st == 'Past Expiration')
            is_open = (st == 'Open' and bool(s.get('expiration')))

            if is_closed:
                target_date = s.get('close_date') or s.get('expiration')
            elif is_past_exp:
                target_date = s.get('expiration')
            elif is_open:
                target_date = s.get('expiration')

            if not target_date:
                continue

            mon, sun = _get_week_range(target_date)
            m_key = target_date[:7]

            # Weekly aggregation
            if mon not in weekly_perf_map:
                weekly_perf_map[mon] = {
                    'monday_date': mon,
                    'sunday_date': sun,
                    'closed_realized_pl': Decimal('0.0'),
                    'expired_realized_pl': Decimal('0.0'),
                    'total_realized_pl': Decimal('0.0'),
                    'future_target_pl': Decimal('0.0'),
                    'trade_count': 0,
                    'closed_trade_count': 0,
                    'expired_trade_count': 0,
                    'open_trade_count': 0,
                    'by_ticker': {}
                }
            w = weekly_perf_map[mon]
            count_week = not is_closed or (mon, s['_contract']) not in weekly_closed_contracts
            if count_week:
                w['trade_count'] += 1
            if ticker not in w['by_ticker']:
                w['by_ticker'][ticker] = {
                    'closed_realized_pl': Decimal('0.0'),
                    'expired_realized_pl': Decimal('0.0'),
                    'total_realized_pl': Decimal('0.0'),
                    'future_target_pl': Decimal('0.0'),
                    'trade_count': 0,
                }
            wt = w['by_ticker'][ticker]
            if count_week:
                wt['trade_count'] += 1

            if is_closed:
                w['closed_realized_pl'] += r_pl
                w['total_realized_pl'] += r_pl
                if count_week:
                    w['closed_trade_count'] += 1
                    weekly_closed_contracts.add((mon, s['_contract']))
                wt['closed_realized_pl'] += r_pl
                wt['total_realized_pl'] += r_pl
            elif is_past_exp:
                w['expired_realized_pl'] += exp_pl
                w['total_realized_pl'] += exp_pl
                w['expired_trade_count'] += 1
                wt['expired_realized_pl'] += exp_pl
                wt['total_realized_pl'] += exp_pl
            elif is_open:
                w['future_target_pl'] += tgt_pl
                w['open_trade_count'] += 1
                wt['future_target_pl'] += tgt_pl

            # Monthly aggregation
            if m_key not in monthly_perf_map:
                monthly_perf_map[m_key] = {
                    'month_key': m_key,
                    'closed_realized_pl': Decimal('0.0'),
                    'expired_realized_pl': Decimal('0.0'),
                    'total_realized_pl': Decimal('0.0'),
                    'future_target_pl': Decimal('0.0'),
                    'trade_count': 0,
                    'closed_trade_count': 0,
                    'expired_trade_count': 0,
                    'open_trade_count': 0,
                    'by_ticker': {}
                }
            m = monthly_perf_map[m_key]
            count_month = not is_closed or (m_key, s['_contract']) not in monthly_closed_contracts
            if count_month:
                m['trade_count'] += 1
            if ticker not in m['by_ticker']:
                m['by_ticker'][ticker] = {
                    'closed_realized_pl': Decimal('0.0'),
                    'expired_realized_pl': Decimal('0.0'),
                    'total_realized_pl': Decimal('0.0'),
                    'future_target_pl': Decimal('0.0'),
                    'trade_count': 0,
                }
            mt = m['by_ticker'][ticker]
            if count_month:
                mt['trade_count'] += 1

            if is_closed:
                m['closed_realized_pl'] += r_pl
                m['total_realized_pl'] += r_pl
                if count_month:
                    m['closed_trade_count'] += 1
                    monthly_closed_contracts.add((m_key, s['_contract']))
                mt['closed_realized_pl'] += r_pl
                mt['total_realized_pl'] += r_pl
            elif is_past_exp:
                m['expired_realized_pl'] += exp_pl
                m['total_realized_pl'] += exp_pl
                m['expired_trade_count'] += 1
                mt['expired_realized_pl'] += exp_pl
                mt['total_realized_pl'] += exp_pl
            elif is_open:
                m['future_target_pl'] += tgt_pl
                m['open_trade_count'] += 1
                mt['future_target_pl'] += tgt_pl

    # Allocate display cents using largest-remainder method so displayed columns foot exactly to displayed totals
    # EX-002: allocate the rounded headline to components first. Independently
    # rounding closed + staged-expiration totals can otherwise add an extra cent.
    display_components = allocate_display_cents(
        {'closed': total_realized, 'expired': total_past_expiration},
        total_realized + total_past_expiration,
    )
    disp_w_closed = allocate_display_cents({mon: w['closed_realized_pl'] for mon, w in weekly_perf_map.items()}, display_components['closed'])
    disp_w_exp = allocate_display_cents({mon: w['expired_realized_pl'] for mon, w in weekly_perf_map.items()}, display_components['expired'])
    disp_w_target = allocate_display_cents({mon: w['future_target_pl'] for mon, w in weekly_perf_map.items()}, total_unrealized)

    disp_m_closed = allocate_display_cents({m: m_val['closed_realized_pl'] for m, m_val in monthly_perf_map.items()}, display_components['closed'])
    disp_m_exp = allocate_display_cents({m: m_val['expired_realized_pl'] for m, m_val in monthly_perf_map.items()}, display_components['expired'])
    disp_m_target = allocate_display_cents({m: m_val['future_target_pl'] for m, m_val in monthly_perf_map.items()}, total_unrealized)

    weekly_performance_list = []
    for mon in sorted(weekly_perf_map.keys()):
        w = weekly_perf_map[mon]
        disp_c = disp_w_closed.get(mon, Decimal('0.00'))
        disp_e = disp_w_exp.get(mon, Decimal('0.00'))
        disp_tot = disp_c + disp_e
        disp_tgt = disp_w_target.get(mon, Decimal('0.00'))
        disp_net = disp_tot + disp_tgt

        weekly_performance_list.append({
            'monday_date': w['monday_date'],
            'sunday_date': w['sunday_date'],
            'closed_realized_pl': float(w['closed_realized_pl']),
            'expired_realized_pl': float(w['expired_realized_pl']),
            'total_realized_pl': float(w['total_realized_pl']),
            'future_target_pl': float(w['future_target_pl']),
            'net_pl': float(w['total_realized_pl'] + w['future_target_pl']),
            'display_closed_realized_pl': float(disp_c),
            'display_expired_realized_pl': float(disp_e),
            'display_total_realized_pl': float(disp_tot),
            'display_future_target_pl': float(disp_tgt),
            'display_net_pl': float(disp_net),
            'trade_count': w['trade_count'],
            'closed_trade_count': w['closed_trade_count'],
            'expired_trade_count': w['expired_trade_count'],
            'open_trade_count': w['open_trade_count'],
            'is_future': mon > current_monday,
            'by_ticker': {
                tk: {
                    'closed_realized_pl': float(tkw['closed_realized_pl']),
                    'expired_realized_pl': float(tkw['expired_realized_pl']),
                    'total_realized_pl': float(tkw['total_realized_pl']),
                    'future_target_pl': float(tkw['future_target_pl']),
                    'trade_count': tkw['trade_count'],
                }
                for tk, tkw in w['by_ticker'].items()
            }
        })

    monthly_performance_list = []
    for m_key in sorted(monthly_perf_map.keys()):
        m = monthly_perf_map[m_key]
        disp_c = disp_m_closed.get(m_key, Decimal('0.00'))
        disp_e = disp_m_exp.get(m_key, Decimal('0.00'))
        disp_tot = disp_c + disp_e
        disp_tgt = disp_m_target.get(m_key, Decimal('0.00'))
        disp_net = disp_tot + disp_tgt

        monthly_performance_list.append({
            'month_key': m['month_key'],
            'closed_realized_pl': float(m['closed_realized_pl']),
            'expired_realized_pl': float(m['expired_realized_pl']),
            'total_realized_pl': float(m['total_realized_pl']),
            'future_target_pl': float(m['future_target_pl']),
            'net_pl': float(m['total_realized_pl'] + m['future_target_pl']),
            'display_closed_realized_pl': float(disp_c),
            'display_expired_realized_pl': float(disp_e),
            'display_total_realized_pl': float(disp_tot),
            'display_future_target_pl': float(disp_tgt),
            'display_net_pl': float(disp_net),
            'trade_count': m['trade_count'],
            'closed_trade_count': m['closed_trade_count'],
            'expired_trade_count': m['expired_trade_count'],
            'open_trade_count': m['open_trade_count'],
            'is_future': m_key > current_month,
            'by_ticker': {
                tk: {
                    'closed_realized_pl': float(tkm['closed_realized_pl']),
                    'expired_realized_pl': float(tkm['expired_realized_pl']),
                    'total_realized_pl': float(tkm['total_realized_pl']),
                    'future_target_pl': float(tkm['future_target_pl']),
                    'trade_count': tkm['trade_count'],
                }
                for tk, tkm in m['by_ticker'].items()
            }
        })

    positions_list = list(positions.values())
    
    # Convert Decimals to float for JSON compatibility
    for pos in positions_list:
        pos['realized_pl'] = float(pos['realized_pl'])
        pos['unrealized_pl'] = float(pos['unrealized_pl'])
        pos['past_expiration_pl'] = float(pos['past_expiration_pl'])
        pos['cost_basis'] = float(pos['cost_basis'])
        pos['total_fees'] = float(pos['total_fees'])
        for s in pos['sub_strategies']:
            s['realized_pl'] = float(s['realized_pl'])
            s['unrealized_pl'] = float(s['unrealized_pl'])
            s['past_expiration_pl'] = float(s.get('past_expiration_pl', 0.0))
            s['open_qty'] = float(s['open_qty'])
            for l in s.get('legs', []):
                for k, v in list(l.items()):
                    if isinstance(v, Decimal):
                        l[k] = float(v)
        for leg in pos['legs']:
            leg['quantity'] = float(leg['quantity'])
            leg['fees'] = float(leg['fees'])
            leg['amount'] = float(leg['amount'])
            if 'current_value' in leg:
                leg['current_value'] = float(leg['current_value'])
                
    positions_list.sort(key=lambda p: (0 if p['status'] in ('Open', 'Past Expiration') else 1, p['underlying']))

    weekly_targets = {}
    for p in positions_list:
        for s in p.get('sub_strategies', []):
            if s.get('status') == 'Open' and s.get('expiration'):
                exp = s['expiration']
                try:
                    exp_dt = dt.strptime(exp, '%Y-%m-%d').date()
                    monday = (exp_dt - timedelta(days=exp_dt.weekday())).strftime('%Y-%m-%d')
                except Exception:
                    monday = exp

                if monday not in weekly_targets:
                    weekly_targets[monday] = {
                        'monday_date': monday,
                        'target_pl': Decimal('0.0'),
                        'unknown_basis_contracts': Decimal('0.0'),
                        'indicator': None
                    }
                weekly_targets[monday]['target_pl'] += Decimal(str(s.get('unrealized_pl', 0) or 0))
                if s.get('warning') and 'no cost basis' in s['warning']:
                    trf_qty = sum(
                        Decimal(str(l.get('quantity', 0) or 0))
                        for l in s.get('legs', [])
                        if (l.get('is_transfer') or 'transfer' in str(l.get('category', '')).lower() or 'transfer' in str(l.get('action', '')).lower())
                           and abs(Decimal(str(l.get('amount', 0) or 0))) < Decimal('0.0001')
                    )
                    weekly_targets[monday]['unknown_basis_contracts'] += trf_qty

    for mon, w in weekly_targets.items():
        if w['unknown_basis_contracts'] > Decimal('0.0'):
            qty_val = int(w['unknown_basis_contracts']) if w['unknown_basis_contracts'] % Decimal('1') == 0 else float(w['unknown_basis_contracts'])
            w['indicator'] = f"includes {qty_val} contracts with unknown basis"
        if mon in disp_w_target:
            w['display_target_pl'] = float(disp_w_target[mon])
        else:
            w['display_target_pl'] = float(Decimal(str(w['target_pl'])).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP))
        w['target_pl'] = float(w['target_pl'])
        w['unknown_basis_contracts'] = float(w['unknown_basis_contracts'])

    combined_realized = total_realized + total_past_expiration
    realized_plus_target = combined_realized + total_unrealized

    disp_combined_realized = Decimal(str(combined_realized or 0)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    disp_closed_realized = display_components['closed']
    disp_expired_realized = display_components['expired']
    disp_total_unrealized = Decimal(str(total_unrealized or 0)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    # The Realized + Target card adds the displayed components so the KPI cards foot.
    # Underlying exact Decimal/float realized_plus_target is preserved unrounded.
    disp_realized_plus_target = disp_combined_realized + disp_total_unrealized

    return {
        "positions":                    positions_list,
        "combined_realized_pl":          float(combined_realized),
        "closed_realized_pl":            float(total_realized),
        "expired_realized_pl":           float(total_past_expiration),
        "total_realized_pl":            float(total_realized),
        "total_unrealized_pl":          float(total_unrealized),
        "total_past_expiration_pl":     float(total_past_expiration),
        "past_expiration_count":         past_expiration_count,
        "realized_plus_target_pl":       float(realized_plus_target),
        "display_combined_realized_pl":  float(disp_combined_realized),
        "display_closed_realized_pl":    float(disp_closed_realized),
        "display_expired_realized_pl":   float(disp_expired_realized),
        "display_total_realized_pl":     float(disp_closed_realized),
        "display_total_unrealized_pl":   float(disp_total_unrealized),
        "display_realized_plus_target_pl": float(disp_realized_plus_target),
        "unmatched_closes_amount":       float(unmatched_signed_sum),
        "unmatched_closes_abs_amount":   float(unmatched_abs_sum),
        "unmatched_closes_count":        unmatched_cash_count,
        "unmatched_closes_total_count":  total_unmatched_count,
        "total_unmatched_closes_pl":     float(unmatched_signed_sum),
        "unmatched_closes_label":       "Closes with no opening trade in imported history",
        "realized_pl_note":             f"Realized P/L excludes ${float(unmatched_abs_sum):,.2f} across {unmatched_cash_count} closes with no opening trade in imported history" if unmatched_abs_sum > Decimal('0.0') else None,
        "total_cost_basis":             float(total_cost_basis),
        "options_fees":                 float(total_options_fees),
        "stock_fees":                   float(stock_fees),
        "total_fees":                   float(total_fees),
        "win_rate":                     win_rate,
        "total_closed":                 total_closed,
        "weekly_targets":               weekly_targets,
        "weekly_performance":            weekly_performance_list,
        "monthly_performance":           monthly_performance_list,
        "data_quality_warnings":        data_quality_warnings,
        "issues":                       issues.as_list(),
    }

# Cache for option prices
_price_cache = {}
_cache_ttl = 300 # 5 minutes

def format_occ_symbol(underlying, expiration, strike, opt_type):
    # Expiration: YYYY-MM-DD -> YYMMDD
    try:
        from datetime import datetime as dt
        exp_dt = dt.strptime(expiration, "%Y-%m-%d")
        yymmdd = exp_dt.strftime("%y%m%d")
    except Exception:
        yymmdd = expiration.replace("-", "")[2:]
        
    opt_type_char = 'C' if opt_type.upper() in ('C', 'CALL') else 'P'
    # Strike format: 8 digits, last 3 are decimal. e.g. 150.0 -> 00150000
    strike_int = int(round(float(strike) * 1000))
    strike_str = f"{strike_int:08d}"
    
    return f"{underlying.upper()}{yymmdd}{opt_type_char}{strike_str}"

def fetch_options_prices(open_legs):
    import time
    import yfinance as yf
    from concurrent.futures import ThreadPoolExecutor
    
    now = time.time()
    results = {}
    
    symbols_to_fetch = []
    symbol_to_leg_map = {}
    
    for leg in open_legs:
        occ = format_occ_symbol(leg['underlying'], leg['expiration'], leg['strike'], leg['type'])
        symbol_to_leg_map.setdefault(occ, []).append(leg)
        
        # Check cache
        cached = _price_cache.get(occ)
        if cached and (now - cached['time'] < _cache_ttl):
            results[leg['id']] = cached['price']
        else:
            if occ not in symbols_to_fetch:
                symbols_to_fetch.append(occ)
            
    if symbols_to_fetch:
        def get_price(sym):
            try:
                info = yf.Ticker(sym).info
                
                # Sanity check: ensure yfinance didn't accidentally return underlying equity data
                quote_type = info.get('quoteType', '')
                if quote_type == 'EQUITY' or 'underlyingSymbol' not in info:
                    logger.warning(f"Ticker contamination: received equity data instead of option for {sym}")
                    return sym, 0.0
                
                # Safely parse values, treating None as 0.0
                def safe_float(val):
                    try:
                        return float(val) if val is not None else 0.0
                    except (ValueError, TypeError):
                        return 0.0
                        
                bid = safe_float(info.get('bid'))
                ask = safe_float(info.get('ask'))
                
                # Out-of-the-money options often have a bid of 0.0 but a valid ask.
                if bid >= 0.0 and ask > 0.0:
                    price = (bid + ask) / 2.0
                else:
                    # Fallback if ask is missing or zero
                    price = safe_float(info.get('regularMarketPrice'))
                    if price == 0.0:
                        price = safe_float(info.get('lastPrice'))
                
                return sym, price
            except Exception as e:
                logger.warning(f"Failed to extract price for {sym}: {e}")
                return sym, 0.0

        with ThreadPoolExecutor(max_workers=5) as executor:
            futures = [executor.submit(get_price, sym) for sym in symbols_to_fetch]
            
            for future in futures:
                try:
                    sym, price = future.result()
                    _price_cache[sym] = {'price': price, 'time': now}
                    for leg in symbol_to_leg_map[sym]:
                        results[leg['id']] = price
                except Exception as e:
                    logger.error(f"Error resolving future for price fetch: {e}")
                    
    # Ensure all legs have a fallback if failed
    for sym in symbols_to_fetch:
        for leg in symbol_to_leg_map[sym]:
            leg_id = leg['id']
            if leg_id not in results:
                results[leg_id] = 0.0
            
    return results

def manually_close_option_contract(
    account_id: int,
    underlying: str,
    expiration: str,
    strike: float,
    opt_type: str,
    close_type: str,          # "Expired", "Assigned", "Exercised", "Buy to Close", "Sell to Close"
    close_date: str,          # "YYYY-MM-DD"
    quantity: float,
    close_price: float = 0.0,
    fees: float = 0.0,
    notes: str = ""
) -> dict:
    """
    Manually closes an open option contract or multi-contract lot by inserting
    an official closing transaction and matching option leg into the database.
    
    The closing transaction is fully integrated with the FIFO matching engine,
    supporting expired worthless ($0), assigned, exercised, or regular market close fills.
    """
    from services.crud import add_transaction

    # Format expiration for Schwab style description: YYYY-MM-DD -> MM/DD/YYYY
    try:
        exp_dt = datetime.strptime(expiration, "%Y-%m-%d")
        exp_schwab = exp_dt.strftime("%m/%d/%Y")
    except Exception:
        exp_schwab = expiration

    # Normalize opt_type
    opt_char = "C" if opt_type.upper().startswith("C") else "P"
    opt_word = "CALL" if opt_char == "C" else "PUT"

    strike_str = f"{float(strike):.2f}"
    sym_tag = f"Sym: {underlying} {exp_schwab} {strike_str} {opt_char}"
    
    # Calculate amount:
    # Option contract multiplier is 100
    gross_cash = Decimal(str(quantity)) * Decimal(str(close_price)) * Decimal('100.0')
    fees_dec = Decimal(str(fees))

    close_type_clean = close_type.strip()
    cat_lower = close_type_clean.lower()

    if "expired" in cat_lower or "removal" in cat_lower:
        category = "Expired"
        amount = 0.0
        fees = 0.0
        desc_parts = [
            sym_tag,
            f"{opt_word} {underlying} ${strike_str} EXP {exp_schwab}",
            f"Qty: {quantity}",
            "Manual Close (Expired)"
        ]
    elif "assign" in cat_lower:
        category = "Assigned"
        # Assignments close STO positions; cash settlement for the option leg itself is $0.00
        amount = 0.0
        desc_parts = [
            sym_tag,
            f"{opt_word} {underlying} ${strike_str} EXP {exp_schwab}",
            f"Qty: {quantity}",
            "Manual Close (Assigned)"
        ]
        if fees > 0:
            desc_parts.append(f"Fees: ${fees:.2f}")
            amount = -float(fees_dec)
    elif "exercis" in cat_lower:
        category = "Exercised"
        # Exercises close BTO positions; option contract itself exercises at $0 cash
        amount = 0.0
        desc_parts = [
            sym_tag,
            f"{opt_word} {underlying} ${strike_str} EXP {exp_schwab}",
            f"Qty: {quantity}",
            "Manual Close (Exercised)"
        ]
        if fees > 0:
            desc_parts.append(f"Fees: ${fees:.2f}")
            amount = -float(fees_dec)
    elif "buy" in cat_lower or "btc" in cat_lower:
        category = "Buy to Close"
        # Buying to close is a cash outflow (-debit -fees)
        net_amount = -(gross_cash + fees_dec)
        amount = float(net_amount)
        desc_parts = [
            sym_tag,
            f"{opt_word} {underlying} ${strike_str} EXP {exp_schwab}",
            f"Qty: {quantity}",
            f"Price: ${float(close_price):.2f}"
        ]
        if fees > 0:
            desc_parts.append(f"Fees: ${fees:.2f}")
        desc_parts.append("Manual Close")
    elif "sell" in cat_lower or "stc" in cat_lower:
        category = "Sell to Close"
        # Selling to close is a cash inflow (+credit -fees)
        net_amount = gross_cash - fees_dec
        amount = float(net_amount)
        desc_parts = [
            sym_tag,
            f"{opt_word} {underlying} ${strike_str} EXP {exp_schwab}",
            f"Qty: {quantity}",
            f"Price: ${float(close_price):.2f}"
        ]
        if fees > 0:
            desc_parts.append(f"Fees: ${fees:.2f}")
        desc_parts.append("Manual Close")
    else:
        # Default fallback to Expired
        category = "Expired"
        amount = 0.0
        desc_parts = [
            sym_tag,
            f"{opt_word} {underlying} ${strike_str} EXP {exp_schwab}",
            f"Qty: {quantity}",
            "Manual Close"
        ]

    if notes:
        desc_parts.append(f"Note: {notes.strip()}")

    description = " | ".join(desc_parts)


    tx_id, is_new = add_transaction(
        account_id=account_id,
        date=close_date,
        amount=amount,
        category=category,
        description=description,
        allow_duplicate=True
    )

    if tx_id:
        process_option_trade(tx_id, account_id, description, category, amount)

    return {
        "success": True,
        "transaction_id": tx_id,
        "is_new": is_new,
        "category": category,
        "amount": amount,
        "date": close_date,
        "description": description
    }

def dismiss_unmatched_option(transaction_id: int) -> dict:
    """
    Safely dismisses and removes an orphaned closing transaction from the database.
    """
    with get_db_connection() as conn:
        conn.execute("DELETE FROM option_legs WHERE transaction_id = ?", (transaction_id,))
        conn.execute("DELETE FROM transactions WHERE id = ?", (transaction_id,))
        logger.info(f"Dismissed unmatched option transaction {transaction_id}")
    return {"success": True, "transaction_id": transaction_id}

def dismiss_duplicate_pair(tx1_id: int, tx2_id: int) -> dict:
    """
    Dismisses a cross-account duplicate pair warning by storing the choice in app_settings.
    Does NOT modify or delete any transactions.
    """
    low_id = min(int(tx1_id), int(tx2_id))
    high_id = max(int(tx1_id), int(tx2_id))
    key = f"dismissed_duplicate_pair:{low_id}:{high_id}"
    with get_db_connection() as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)")
        conn.execute("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)", (key, 'dismissed'))
        logger.info(f"Dismissed duplicate pair #{low_id} and #{high_id}")
    return {"success": True, "tx1_id": low_id, "tx2_id": high_id, "status": "dismissed"}

def undismiss_duplicate_pair(tx1_id: int, tx2_id: int) -> dict:
    """
    Removes a dismissal of a duplicate pair, restoring any warnings in the UI/API.
    Does NOT modify or delete any transactions.
    """
    low_id = min(int(tx1_id), int(tx2_id))
    high_id = max(int(tx1_id), int(tx2_id))
    key = f"dismissed_duplicate_pair:{low_id}:{high_id}"
    with get_db_connection() as conn:
        conn.execute("DELETE FROM app_settings WHERE key = ?", (key,))
        logger.info(f"Restored duplicate pair warning for #{low_id} and #{high_id}")
    return {"success": True, "tx1_id": low_id, "tx2_id": high_id, "status": "active"}

def infer_option_direction(
    category: str,
    action: str = None,
    raw_description: str = "",
    signed_quantity: float = None,
    opt_type: str = None
) -> dict:
    """
    Audits and determines the true long/short contract direction and resulting opening action (BTO/STO).

    Broker CSV Export Sign Conventions (Charles Schwab, Fidelity, etc.):
    ---------------------------------------------------------------------
    1. EXPIRED:
       - A NEGATIVE quantity (e.g. 'Qty: -9', quantity < 0) in the raw statement indicates
         zeroing out / removal of an expired LONG contract lot (originally opened via Buy to Open / BTO).
         The closing action is STC (Sell to Close at $0.00).
       - A POSITIVE quantity (e.g. 'Qty: 2', 'Qty: 5', quantity > 0) indicates expiration of
         a worthless SHORT contract lot (originally opened via Sell to Open / STO).
         The closing action is BTC (Buy to Close at $0.00).
    2. ASSIGNED:
       - Only SHORT options carry assignment obligation (contract seller is assigned when holder exercises).
       - Therefore, an 'Assigned' action ALWAYS represents closing a SHORT position (originally STO).
       - Closing action is BTC at $0.00 cash settlement.
       - Short call assignment obligates selling 100 shares of stock at strike price.
       - Short put assignment obligates buying 100 shares of stock at strike price.
    3. EXERCISED:
       - Only LONG options are exercised by the contract holder.
       - Therefore, an 'Exercised' action ALWAYS represents closing a LONG position (originally BTO).
       - Closing action is STC at $0.00 cash settlement.
    4. BUY TO CLOSE (BTC) / BOUGHT TO CLOSE:
       - Explicit closing of a SHORT option position (originally STO).
    5. SELL TO CLOSE (STC) / SOLD TO CLOSE:
       - Explicit closing of a LONG option position (originally BTO).
    """
    cat_lower = (category or "").lower().strip()
    act_lower = (action or "").lower().strip()
    act_upper = (action or "").upper().strip()
    desc = raw_description or ""
    desc_lower = desc.lower()

    raw_qty_signed = signed_quantity
    if raw_qty_signed is None and desc:
        qty_match = re.search(r"Qty:\s*(-?[\d\.,]+)", desc)
        if qty_match:
            try:
                raw_qty_signed = float(qty_match.group(1).replace(',', ''))
            except ValueError:
                pass

    is_expired = (
        any(w in cat_lower for w in ['expired', 'expiration', 'removal'])
        or act_upper in ('EXPIRED', 'EXPIRATION', 'EXP')
        or 'expired' in desc_lower
        or 'expiration' in desc_lower
    )
    is_assigned = (
        any(w in cat_lower for w in ['assigned', 'assignment'])
        or 'assign' in act_lower
        or 'assigned' in desc_lower
    )
    is_exercised = (
        any(w in cat_lower for w in ['exercised', 'exercise'])
        or 'exercise' in act_lower
        or 'exercised' in desc_lower
    )
    is_btc = (
        any(w in cat_lower for w in ['buy to close', 'bought to close', 'btc', 'bought closing', 'buy closing'])
        or any(w in act_lower for w in ['buy to close', 'bought to close', 'btc', 'bought closing', 'buy closing'])
        or act_upper == 'BTC'
    )
    is_stc = (
        any(w in cat_lower for w in ['sell to close', 'sold to close', 'stc', 'sold closing', 'sell closing'])
        or any(w in act_lower for w in ['sell to close', 'sold to close', 'stc', 'sold closing', 'sell closing'])
        or act_upper == 'STC'
    )

    if is_assigned:
        return {
            "inferred_direction": "SHORT",
            "inferred_open_action": "STO",
            "inferred_close_action": "BTC",
            "confidence": "HIGH",
            "inference_reason": "Option assignment applies exclusively to short positions (STO). Call assignments obligate selling stock; put assignments obligate buying stock."
        }
    elif is_exercised:
        return {
            "inferred_direction": "LONG",
            "inferred_open_action": "BTO",
            "inferred_close_action": "STC",
            "confidence": "HIGH",
            "inference_reason": "Option exercise is initiated exclusively by long contract holders (BTO) exercising contract rights."
        }
    elif is_btc:
        return {
            "inferred_direction": "SHORT",
            "inferred_open_action": "STO",
            "inferred_close_action": "BTC",
            "confidence": "HIGH",
            "inference_reason": "Buy to Close (BTC) explicitly liquidates an existing short option position."
        }
    elif is_stc:
        return {
            "inferred_direction": "LONG",
            "inferred_open_action": "BTO",
            "inferred_close_action": "STC",
            "confidence": "HIGH",
            "inference_reason": "Sell to Close (STC) explicitly liquidates an existing long option position."
        }
    elif is_expired:
        if raw_qty_signed is not None and raw_qty_signed < 0:
            return {
                "inferred_direction": "LONG",
                "inferred_open_action": "BTO",
                "inferred_close_action": "STC",
                "confidence": "HIGH",
                "inference_reason": f"Negative quantity ({raw_qty_signed:g}) on expiration indicates zeroing out an expired LONG position (originally opened via BTO)."
            }
        else:
            qty_disp = f" ({raw_qty_signed:g})" if raw_qty_signed is not None else ""
            return {
                "inferred_direction": "SHORT",
                "inferred_open_action": "STO",
                "inferred_close_action": "BTC",
                "confidence": "HIGH",
                "inference_reason": f"Positive quantity{qty_disp} on expiration indicates expiration of a worthless SHORT position (originally opened via STO)."
            }
    else:
        if 'buy' in cat_lower or 'bto' in act_upper:
            return {
                "inferred_direction": "LONG",
                "inferred_open_action": "BTO",
                "inferred_close_action": "STC",
                "confidence": "MEDIUM",
                "inference_reason": "Transaction contains 'Buy' wording, defaulting to long position (BTO)."
            }
        else:
            return {
                "inferred_direction": "SHORT",
                "inferred_open_action": "STO",
                "inferred_close_action": "BTC",
                "confidence": "MEDIUM",
                "inference_reason": "Transaction defaults to short position (STO)."
            }

def find_linked_stock_assignment(
    account_id: int,
    underlying: str,
    strike: float,
    opt_type: str,
    contracts: float,
    trade_date: str,
    expiration_date: str = None
) -> dict:
    """
    For an Assigned option closing transaction, locates the corresponding stock trade
    generated by the assignment obligation in the same brokerage account.
    """
    opt_char = (opt_type or 'C').upper()[0]
    expected_action = "Sell" if opt_char == 'C' else "Buy"
    expected_shares = round(abs(float(contracts)) * 100)
    expected_price = float(strike)

    dates = [d for d in [trade_date, expiration_date] if d]
    min_date = min(dates)
    max_date = max(dates)

    try:
        start_dt = (datetime.strptime(min_date, '%Y-%m-%d') - timedelta(days=5)).strftime('%Y-%m-%d')
        end_dt = (datetime.strptime(max_date, '%Y-%m-%d') + timedelta(days=5)).strftime('%Y-%m-%d')
    except Exception:
        start_dt = min_date
        end_dt = max_date

    with get_db_connection() as conn:
        rows = list(conn.execute(
            """
            SELECT t.id, t.account_id, t.date, t.amount, t.category, t.description
            FROM transactions t
            LEFT JOIN option_legs ol ON t.id = ol.transaction_id
            WHERE t.account_id = ?
              AND t.date BETWEEN ? AND ?
              AND (t.description LIKE ? OR t.description LIKE ?)
              AND LOWER(TRIM(t.category)) IN ('buy', 'sell', 'short', 'cover')
              AND ol.id IS NULL
            """,
            (account_id, start_dt, end_dt, f"%Sym: {underlying} |%", f"%{underlying}%")
        ).fetchall())

    try:
        ref_dt = datetime.strptime(trade_date, '%Y-%m-%d')
        rows.sort(key=lambda r: (abs((datetime.strptime(r['date'], '%Y-%m-%d') - ref_dt).days), -r['id']))
    except Exception:
        pass

    matched = None
    for r in rows:
        desc = r['description'] or ""
        # Exclude actual option contracts
        if parse_option_symbol(desc):
            continue

        qty_m = re.search(r"Qty:\s*(-?[\d\.,]+)", desc)
        price_m = re.search(r"Price:\s*\$?([\d\.,]+)", desc)
        qty = abs(float(qty_m.group(1).replace(',', ''))) if qty_m else None
        price = float(price_m.group(1).replace(',', '')) if price_m else None

        amt_abs = abs(float(r['amount'] or 0.0))

        # Fallback extraction from amount if description didn't include Qty:/Price:
        if qty is None and expected_price > 0:
            calc_qty = round(amt_abs / expected_price)
            if abs(calc_qty - expected_shares) < 0.1:
                qty = float(calc_qty)
                logger.warning(
                    f"[Stock Assignment Fallback] Inferred shares {qty} from amount ${amt_abs:,.2f} "
                    f"and strike ${expected_price:,.2f} for Tx #{r['id']} ({desc}) because 'Qty:' regex did not match."
                )

        if price is None and (qty or expected_shares) > 0:
            eff_qty = qty if qty else expected_shares
            calc_price = amt_abs / eff_qty
            if abs(calc_price - expected_price) < 0.1:
                price = float(calc_price)
                logger.warning(
                    f"[Stock Assignment Fallback] Inferred price ${price:,.2f} from amount ${amt_abs:,.2f} "
                    f"and effective shares {eff_qty} for Tx #{r['id']} ({desc}) because 'Price:' regex did not match."
                )

        cat_clean = r['category'].strip().lower()
        cat_match = (
            expected_action.lower() in cat_clean or
            (expected_action.lower() == 'sell' and 'sold' in cat_clean) or
            (expected_action.lower() == 'buy' and 'bought' in cat_clean)
        )
        shares_match = (qty is not None and abs(qty - expected_shares) < 0.1)
        price_match = (price is not None and abs(price - expected_price) < 0.05) or (
            abs(amt_abs - (expected_shares * expected_price)) < 50.0
        )

        if cat_match and shares_match and price_match:
            matched = {
                "id": r['id'],
                "date": r['date'],
                "category": r['category'],
                "quantity": qty if qty is not None else float(expected_shares),
                "price": price if price is not None else float(expected_price),
                "amount": float(r['amount']),
                "description": r['description']
            }
            break

    if matched:
        return {
            "found": True,
            "trade": matched,
            "warning": None,
            "expected": {
                "action": expected_action,
                "shares": expected_shares,
                "price": expected_price,
                "underlying": underlying,
                "date": trade_date
            }
        }
    else:
        return {
            "found": False,
            "trade": None,
            "warning": f"No matching stock assignment transaction found for {expected_action} {expected_shares} {underlying} @ ${expected_price:.2f} on or around {trade_date}.",
            "expected": {
                "action": expected_action,
                "shares": expected_shares,
                "price": expected_price,
                "underlying": underlying,
                "date": trade_date
            }
        }

def get_match_candidates(transaction_id: int) -> dict:
    """
    Finds potential matching candidates for an unmatched closing option trade:
    1. Audited long/short direction inference.
    2. Linked stock assignment trade (if category is Assigned).
    3. Candidate manual closes (with multi-match ambiguity detection).
    4. Candidate individual open lots (sorted by FIFO order with timestamp/id tiebreakers).
    """
    with get_db_connection() as conn:
        tx_row = conn.execute(
            """
            SELECT id, account_id, date, amount, category, description
            FROM transactions
            WHERE id = ?
            """,
            (transaction_id,)
        ).fetchone()

        if not tx_row:
            return {"error": f"Transaction {transaction_id} not found"}

        tx_legs = conn.execute(
            """
            SELECT id as leg_id, position_id, expiration_date, strike_price,
                   option_type, action, quantity, fees
            FROM option_legs
            WHERE transaction_id = ?
            ORDER BY id ASC
            """,
            (transaction_id,)
        ).fetchall()

        primary_leg = tx_legs[0] if tx_legs else None
        total_leg_qty = sum(float(l['quantity'] or 0) for l in tx_legs) if tx_legs else None

        underlying = None
        if primary_leg and primary_leg['position_id']:
            pos_row = conn.execute(
                "SELECT underlying_symbol FROM trade_positions WHERE id = ?",
                (primary_leg['position_id'],)
            ).fetchone()
            if pos_row:
                underlying = pos_row['underlying_symbol']

        exp_date_val = str(primary_leg['expiration_date']) if (primary_leg and primary_leg['expiration_date']) else None
        strike_val = float(primary_leg['strike_price']) if (primary_leg and primary_leg['strike_price'] is not None) else None
        opt_type_val = primary_leg['option_type'] if primary_leg else None

        if tx_row['description']:
            if not underlying:
                sym_match = re.search(r"Sym:\s*([A-Z]+)", tx_row['description'])
                if sym_match:
                    underlying = sym_match.group(1).strip()
            
            if not underlying or not exp_date_val or strike_val is None or not opt_type_val:
                parsed = parse_option_symbol(tx_row['description'])
                if parsed:
                    underlying = underlying or parsed.get('underlying')
                    exp_date_val = exp_date_val or parsed.get('expiration')
                    strike_val = strike_val if strike_val is not None else parsed.get('strike')
                    opt_type_val = opt_type_val or parsed.get('type')

        # Extract raw signed quantity from description to detect negative expirations (-9)
        raw_qty_signed = None
        if tx_row['description']:
            q_match = re.search(r"Qty:\s*(-?[\d\.,]+)", tx_row['description'])
            if q_match:
                try:
                    raw_qty_signed = float(q_match.group(1).replace(',', ''))
                except ValueError:
                    pass

        qty_magnitude = abs(raw_qty_signed) if raw_qty_signed is not None else float(total_leg_qty or (primary_leg['quantity'] if primary_leg else 1.0))

        unmatched_trade = {
            "transaction_id": tx_row['id'],
            "account_id": tx_row['account_id'],
            "underlying": underlying or "",
            "date": tx_row['date'],
            "category": tx_row['category'],
            "amount": float(tx_row['amount'] or 0.0),
            "description": tx_row['description'],
            "expiration": exp_date_val,
            "strike": strike_val,
            "opt_type": opt_type_val,
            "action": primary_leg['action'] if primary_leg else None,
            "quantity": qty_magnitude,
            "raw_signed_quantity": raw_qty_signed
        }

        # 1. Audit Direction Inference
        direction_inference = infer_option_direction(
            category=tx_row['category'],
            action=primary_leg['action'] if primary_leg else None,
            raw_description=tx_row['description'],
            signed_quantity=raw_qty_signed,
            opt_type=opt_type_val
        )

        # 2. Assignment Cross-Linking to Stock Trade
        linked_stock = None
        action_val = primary_leg['action'] if primary_leg else ''
        is_assigned = ('assign' in (tx_row['category'] or '').lower()) or ('assign' in (action_val or '').lower())
        if is_assigned:
            linked_stock = find_linked_stock_assignment(
                account_id=tx_row['account_id'],
                underlying=underlying or "",
                strike=float(strike_val or 0.0),
                opt_type=opt_type_val or 'C',
                contracts=qty_magnitude,
                trade_date=tx_row['date'],
                expiration_date=exp_date_val
            )

        # 3. Candidate Manual Closes in the same account
        manual_rows = conn.execute(
            """
            SELECT t.id, t.date, t.amount, t.category, t.description,
                   ol.id as leg_id, ol.expiration_date, ol.strike_price, ol.option_type, ol.action, ol.quantity
            FROM transactions t
            LEFT JOIN option_legs ol ON t.id = ol.transaction_id
            LEFT JOIN trade_positions tp ON ol.position_id = tp.id
            WHERE t.account_id = ?
              AND (tp.underlying_symbol = ? OR t.description LIKE ?)
              AND (t.description LIKE '%Manual Close%' OR t.description LIKE '%Synthetic%')
              AND t.id != ?
            ORDER BY t.date DESC, t.id DESC
            """,
            (tx_row['account_id'], underlying or '', f"%{underlying}%" if underlying else "%Manual Close%", transaction_id)
        ).fetchall()

        manual_candidates = []
        for r in manual_rows:
            strike_match = abs(float(r['strike_price'] or 0.0) - float(strike_val or 0.0)) < 0.01 if (r['strike_price'] is not None and strike_val is not None) else False
            exp_match = (str(r['expiration_date']) == str(exp_date_val)) if (r['expiration_date'] and exp_date_val) else False
            type_match = (str(r['option_type']).upper() == str(opt_type_val).upper()) if (r['option_type'] and opt_type_val) else False
            is_exact = (strike_match and exp_match and type_match)

            manual_candidates.append({
                "transaction_id": r['id'],
                "leg_id": r['leg_id'],
                "date": r['date'],
                "category": r['category'],
                "amount": float(r['amount'] or 0.0),
                "description": r['description'],
                "expiration_date": str(r['expiration_date']) if r['expiration_date'] else None,
                "strike_price": float(r['strike_price']) if r['strike_price'] is not None else None,
                "option_type": r['option_type'],
                "action": r['action'],
                "quantity": float(r['quantity'] or 0.0),
                "is_exact_match": is_exact,
                "has_multiple_exact_matches": False
            })

        exact_manual_count = sum(1 for m in manual_candidates if m['is_exact_match'])
        if exact_manual_count > 1:
            for m in manual_candidates:
                if m['is_exact_match']:
                    m['has_multiple_exact_matches'] = True

        manual_candidates.sort(key=lambda x: (0 if x['is_exact_match'] else 1, x['date']), reverse=False)

    # 4. Candidate Open Lots from Portfolio (outside DB connection to avoid locks)
    candidate_open_lots = []
    open_candidates = []
    try:
        portfolio = get_options_portfolio()
        for pos in portfolio.get('positions', []):
            if pos.get('underlying') == underlying and pos.get('account_id') == tx_row['account_id']:
                for sub in pos.get('sub_strategies', []):
                    if sub.get('status') in ('Open', 'Past Expiration') and not sub.get('is_unmatched') and float(sub.get('open_qty', 0)) > 0:
                        open_candidates.append({
                            "name": sub.get('name'),
                            "expiration": sub.get('expiration'),
                            "strike": float(sub.get('strike', 0.0)),
                            "opt_type": sub.get('opt_type'),
                            "action": sub.get('action'),
                            "open_qty": float(sub.get('open_qty', 0.0)),
                            "legs": sub.get('legs', [])
                        })
                        for leg in sub.get('legs', []):
                            leg_qty = float(leg.get('quantity', 0.0))
                            if leg_qty > 0.001:
                                leg_exp = leg.get('expiration', sub.get('expiration'))
                                leg_strike = float(leg.get('strike', sub.get('strike', 0.0)))
                                leg_opt_type = leg.get('type', sub.get('opt_type'))
                                leg_act = leg.get('action', sub.get('action'))

                                exp_match = (str(leg_exp) == str(exp_date_val)) if exp_date_val else False
                                strike_match = abs(leg_strike - float(strike_val or 0.0)) < 0.01 if strike_val is not None else False
                                type_match = (str(leg_opt_type).upper() == str(opt_type_val).upper()) if opt_type_val else False
                                action_match = (leg_act.upper() == direction_inference['inferred_open_action'])

                                is_exact = (exp_match and strike_match and type_match and action_match)

                                candidate_open_lots.append({
                                    "leg_id": leg.get('id'),
                                    "transaction_id": leg.get('transaction_id'),
                                    "date": leg.get('date'),
                                    "expiration": leg_exp,
                                    "strike": leg_strike,
                                    "opt_type": leg_opt_type,
                                    "action": leg_act,
                                    "open_qty": leg_qty,
                                    "price": float(leg.get('price', 0.0)) if leg.get('price') else (abs(float(leg.get('amount', 0.0)) / (leg_qty * 100)) if leg_qty > 0 else 0.0),
                                    "amount": float(leg.get('amount', 0.0)),
                                    "description": leg.get('description', ''),
                                    "name": f"{sub.get('name')} (Tx #{leg.get('transaction_id')})",
                                    "is_exact_match": is_exact,
                                    "has_multiple_exact_matches": False
                                })
    except Exception as e:
        logger.warning(f"Could not load open candidate lots from portfolio: {e}")

    # Preserve deterministic FIFO order using transaction ID and leg ID as tiebreaker when dates are identical
    candidate_open_lots.sort(key=lambda l: (l['date'], l.get('transaction_id', 0), l.get('leg_id', 0)))

    exact_open_count = sum(1 for l in candidate_open_lots if l['is_exact_match'])
    if exact_open_count > 1:
        for l in candidate_open_lots:
            if l['is_exact_match']:
                l['has_multiple_exact_matches'] = True

    return {
        "unmatched_trade": unmatched_trade,
        "direction_inference": direction_inference,
        "linked_stock_assignment": linked_stock,
        "candidate_manual_closes": manual_candidates,
        "candidate_open_lots": candidate_open_lots,
        "candidate_open_contracts": open_candidates
    }

def match_unmatched_option(
    transaction_id: int,
    mode: str,                       # "reconcile_manual" | "link_open_leg" | "create_open"
    manual_transaction_ids: list = None,
    allocations: list = None,        # list of { "leg_id", "transaction_id", "quantity", "expiration", "strike", "opt_type" }
    open_lots: list = None,          # list of { "open_date", "open_price", "open_action", "quantity", "fees", "notes" }
    target_expiration: str = None,
    target_strike: float = None,
    target_opt_type: str = None,
    open_date: str = None,
    open_price: float = 0.0,
    open_action: str = None,         # "BTO" or "STO"
    open_quantity: float = None,
    fees: float = 0.0,
    notes: str = ""
) -> dict:
    """
    Executes a manual match operation on an unmatched closing option trade.
    Supports:
    1. 'reconcile_manual': Deletes placeholder manual close transactions to let official broker close pair with open legs.
    2. 'link_open_leg': Supports many-to-one / one-to-many allocations across candidate lots with exact quantity validation.
    3. 'create_open': Supports multi-lot opening trades with confirmed BTO/STO direction and exact quantity validation.
    """
    from services.crud import add_transaction

    if mode == "reconcile_manual":
        if not manual_transaction_ids:
            return {"error": "No manual transaction IDs specified for reconciliation"}

        with get_db_connection() as conn:
            tx = conn.execute(
                "SELECT id, account_id, description, category, amount FROM transactions WHERE id = ?",
                (transaction_id,)
            ).fetchone()
            if not tx:
                return {"error": f"Transaction {transaction_id} not found"}

            for m_id in manual_transaction_ids:
                conn.execute("DELETE FROM option_legs WHERE transaction_id = ?", (m_id,))
                conn.execute("DELETE FROM transactions WHERE id = ?", (m_id,))
                logger.info(f"Deleted manual close transaction {m_id} during reconciliation with official trade {transaction_id}")
            conn.commit()

        process_option_trade(tx['id'], tx['account_id'], tx['description'], tx['category'], tx['amount'])
        return {
            "success": True,
            "mode": "reconcile_manual",
            "transaction_id": transaction_id,
            "reconciled_ids": manual_transaction_ids,
            "message": f"Successfully reconciled official trade {transaction_id} and removed {len(manual_transaction_ids)} placeholder close(s)."
        }

    elif mode == "link_open_leg":
        with get_db_connection() as conn:
            tx = conn.execute(
                "SELECT id, account_id, description, category, amount FROM transactions WHERE id = ?",
                (transaction_id,)
            ).fetchone()
            if not tx:
                return {"error": f"Transaction {transaction_id} not found"}

            leg = conn.execute(
                "SELECT id, position_id, expiration_date, strike_price, option_type, action, quantity FROM option_legs WHERE transaction_id = ?",
                (transaction_id,)
            ).fetchone()

            sym_match = re.search(r"Sym:\s*([A-Z]+)", tx['description'])
            underlying = sym_match.group(1).strip() if sym_match else ""

            pos = conn.execute(
                "SELECT id FROM trade_positions WHERE account_id = ? AND underlying_symbol = ?",
                (tx['account_id'], underlying)
            ).fetchone()
            pos_id = pos['id'] if pos else None

            # Get target closing trade quantity
            raw_qty_signed = None
            if tx['description']:
                q_match = re.search(r"Qty:\s*(-?[\d\.,]+)", tx['description'])
                if q_match:
                    try:
                        raw_qty_signed = float(q_match.group(1).replace(',', ''))
                    except ValueError:
                        pass
            close_qty = abs(raw_qty_signed) if raw_qty_signed is not None else float(leg['quantity'] if leg else 1.0)

            # Inferred direction
            direction_inf = infer_option_direction(
                category=tx['category'],
                action=leg['action'] if leg else '',
                raw_description=tx['description'],
                signed_quantity=raw_qty_signed,
                opt_type=leg['option_type'] if leg else None
            )
            close_action = direction_inf['inferred_close_action']

            # Handle multi-lot allocations
            if allocations and len(allocations) > 0:
                total_alloc = sum(float(a.get('quantity', 0.0)) for a in allocations)
                if abs(total_alloc - close_qty) > 0.001:
                    return {
                        "error": f"Allocated quantity ({total_alloc:g}) must sum exactly to the closing transaction quantity ({close_qty:g})."
                    }

                # Remove existing option_legs for this closing transaction
                conn.execute("DELETE FROM option_legs WHERE transaction_id = ?", (transaction_id,))

                # Check for transaction-level fees in description
                fee_matches = re.findall(r"Fees:\s*\$?([\d\.]+)", tx['description']) if tx['description'] else []
                tx_fees = sum(float(f) for f in fee_matches) if fee_matches else 0.0

                # Sort allocations deterministically by (date, transaction_id, leg_id, expiration, strike, quantity)
                # to guarantee canonical FIFO order and stable fee-remainder assignment regardless of payload order
                sorted_allocations = sorted(
                    allocations,
                    key=lambda a: (
                        str(a.get('date') or ''),
                        int(a.get('transaction_id') or 0),
                        int(a.get('leg_id') or 0),
                        str(a.get('expiration') or ''),
                        float(a.get('strike') or 0.0),
                        float(a.get('quantity') or 0.0)
                    )
                )

                # Insert a leg for each allocated portion
                desc_parts = []
                allocated_fees_total = 0.0
                for i, a in enumerate(sorted_allocations):
                    pos_id = a.get('position_id') or leg['position_id']
                    a_qty = float(a.get('quantity', 0.0))
                    a_exp = str(a.get('expiration') or (leg['expiration_date'] if leg else tx['date']))
                    a_strike = float(a.get('strike') or (leg['strike_price'] if leg else 0.0))
                    a_type = (a.get('opt_type') or (leg['option_type'] if leg else 'C')).upper()[0]

                    if a.get('fees') is not None:
                        a_fees = float(a['fees'])
                    elif total_alloc > 0 and tx_fees > 0:
                        if i == len(sorted_allocations) - 1:
                            a_fees = round(tx_fees - allocated_fees_total, 4)
                        else:
                            a_fees = round((a_qty / total_alloc) * tx_fees, 4)
                            allocated_fees_total += a_fees
                    else:
                        a_fees = 0.0

                    conn.execute(
                        """
                        INSERT INTO option_legs 
                        (transaction_id, position_id, expiration_date, strike_price, option_type, action, quantity, fees) 
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (transaction_id, pos_id, a_exp, a_strike, a_type, close_action, a_qty, a_fees)
                    )
                    desc_parts.append(f"{a_qty:g}x ${a_strike:g} {a_type} (Exp {a_exp})")

                # Update description to note multi-lot link
                new_desc = tx['description']
                conn.commit()

                return {
                    "success": True,
                    "mode": "link_open_leg",
                    "transaction_id": transaction_id,
                    "message": f"Successfully allocated {close_qty:g} contract(s) across {len(allocations)} open lot(s): {', '.join(desc_parts)}."
                }

            # Fallback single target allocation
            if not target_expiration or target_strike is None or not target_opt_type:
                return {"error": "Missing target contract parameters (expiration, strike, option type)"}

            target_opt_char = "C" if target_opt_type.upper().startswith("C") else "P"
            target_strike_float = float(target_strike)

            conn.execute(
                """
                UPDATE option_legs 
                SET position_id = COALESCE(?, position_id),
                    expiration_date = ?,
                    strike_price = ?,
                    option_type = ?,
                    action = ?
                WHERE transaction_id = ?
                """,
                (pos_id, target_expiration, target_strike_float, target_opt_char, close_action, transaction_id)
            )

            try:
                exp_dt = datetime.strptime(target_expiration, "%Y-%m-%d")
                exp_fmt = exp_dt.strftime("%m/%d/%Y")
            except Exception:
                exp_fmt = target_expiration

            new_sym = f"Sym: {underlying} {exp_fmt} {target_strike_float:g} {target_opt_char}"
            old_desc = tx['description']
            new_desc = re.sub(r"Sym:\s*[^\|]+", new_sym, old_desc) if "Sym:" in old_desc else f"{new_sym} | {old_desc}"

            conn.execute("UPDATE transactions SET description = ? WHERE id = ?", (new_desc, transaction_id))
            conn.commit()

        process_option_trade(tx['id'], tx['account_id'], new_desc, tx['category'], tx['amount'])
        return {
            "success": True,
            "mode": "link_open_leg",
            "transaction_id": transaction_id,
            "message": f"Successfully linked trade {transaction_id} to {underlying} {target_expiration} ${target_strike_float} {target_opt_char}."
        }

    elif mode == "create_open":
        with get_db_connection() as conn:
            tx = conn.execute(
                "SELECT id, account_id, description, category, amount FROM transactions WHERE id = ?",
                (transaction_id,)
            ).fetchone()
            if not tx:
                return {"error": f"Transaction {transaction_id} not found"}

            leg = conn.execute(
                "SELECT expiration_date, strike_price, option_type, action, quantity FROM option_legs WHERE transaction_id = ?",
                (transaction_id,)
            ).fetchone()

            account_id = tx['account_id']
            sym_match = re.search(r"Sym:\s*([A-Z]+)", tx['description'])
            underlying = sym_match.group(1).strip() if sym_match else "OPTION"

            raw_qty_signed = None
            if tx['description']:
                q_match = re.search(r"Qty:\s*(-?[\d\.,]+)", tx['description'])
                if q_match:
                    try:
                        raw_qty_signed = float(q_match.group(1).replace(',', ''))
                    except ValueError:
                        pass
            close_qty = abs(raw_qty_signed) if raw_qty_signed is not None else float(open_quantity if open_quantity is not None else (leg['quantity'] if leg else 1.0))

            direction_inf = infer_option_direction(
                category=tx['category'],
                action=leg['action'] if leg else '',
                raw_description=tx['description'],
                signed_quantity=raw_qty_signed,
                opt_type=leg['option_type'] if leg else None
            )

        # Normalize open lots list
        lots_to_create = []
        if open_lots and len(open_lots) > 0:
            total_open = sum(float(l.get('quantity', 0.0)) for l in open_lots)
            if abs(total_open - close_qty) > 0.001:
                return {
                    "error": f"Total opening lot quantity ({total_open:g}) must sum exactly to the closing transaction quantity ({close_qty:g})."
                }
            lots_to_create = open_lots
        else:
            if not open_date or open_price is None:
                return {"error": "Missing required fields: open_date and open_price are required"}
            lots_to_create = [{
                "open_date": open_date,
                "open_price": float(open_price),
                "open_action": open_action,
                "quantity": close_qty,
                "fees": float(fees or 0.0),
                "notes": notes
            }]

        created_tx_ids = []
        for lot in lots_to_create:
            lot_dt = lot.get('open_date')
            lot_pr = float(lot.get('open_price', 0.0))
            lot_qt = float(lot.get('quantity', 1.0))
            lot_fe = float(lot.get('fees', 0.0) or 0.0)
            lot_no = lot.get('notes', '')

            lot_act = (lot.get('open_action') or open_action or direction_inf['inferred_open_action']).upper()
            if lot_act not in ('BTO', 'STO'):
                lot_act = direction_inf['inferred_open_action']

            exp_date = target_expiration or (leg['expiration_date'] if leg else lot_dt)
            strike = float(target_strike) if target_strike is not None else float(leg['strike_price'] if leg else 0.0)
            opt_t = (target_opt_type or (leg['option_type'] if leg else 'C')).upper()[0]

            try:
                exp_dt = datetime.strptime(exp_date, "%Y-%m-%d")
                exp_schwab = exp_dt.strftime("%m/%d/%Y")
            except Exception:
                exp_schwab = exp_date

            opt_word = "CALL" if opt_t == 'C' else "PUT"
            strike_str = f"{float(strike):.2f}"
            sym_tag = f"Sym: {underlying} {exp_schwab} {strike_str} {opt_t}"

            gross_cash = Decimal(str(lot_qt)) * Decimal(str(lot_pr)) * Decimal('100.0')
            fees_dec = Decimal(str(lot_fe))

            if lot_act == 'STO':
                category_name = "Sell to Open"
                amount = float(gross_cash - fees_dec)
            else:
                category_name = "Buy to Open"
                amount = -float(gross_cash + fees_dec)

            desc_parts = [
                sym_tag,
                f"{opt_word} {underlying} ${strike_str} EXP {exp_schwab}",
                f"Qty: {lot_qt:g}",
                f"Price: ${lot_pr:.2f}"
            ]
            if lot_fe > 0:
                desc_parts.append(f"Fees: ${lot_fe:.2f}")
            desc_parts.append("Manual Open")
            if lot_no:
                desc_parts.append(f"Note: {lot_no.strip()}")

            open_desc = " | ".join(desc_parts)

            open_tx_id, _ = add_transaction(
                account_id=account_id,
                date=lot_dt,
                amount=amount,
                category=category_name,
                description=open_desc,
                allow_duplicate=True
            )

            if open_tx_id:
                process_option_trade(open_tx_id, account_id, open_desc, category_name, amount)
                created_tx_ids.append(open_tx_id)

        # Re-process closing transaction so FIFO immediately matches
        with get_db_connection() as conn:
            tx_refresh = conn.execute(
                "SELECT id, account_id, description, category, amount FROM transactions WHERE id = ?",
                (transaction_id,)
            ).fetchone()
        if tx_refresh:
            process_option_trade(tx_refresh['id'], tx_refresh['account_id'], tx_refresh['description'], tx_refresh['category'], tx_refresh['amount'])

        return {
            "success": True,
            "mode": "create_open",
            "transaction_id": transaction_id,
            "created_open_ids": created_tx_ids,
            "open_transaction_id": created_tx_ids[0] if created_tx_ids else None,
            "message": f"Successfully created {len(created_tx_ids)} opening trade(s) ({lots_to_create[0].get('open_action', direction_inf['inferred_open_action'])} total {close_qty:g}x) and matched trade {transaction_id}."
        }

    return {"error": f"Unknown matching mode: {mode}"}




def get_options_analysis(account_ids=None, as_of_date=None):
    """Internal Phase 1 event view; legacy portfolio/date attribution remains unchanged."""
    analysis = {'matched_events': [], 'transferred_basis': Decimal('0')}
    analysis['portfolio'] = get_options_portfolio(account_ids, as_of_date, _analysis=analysis)
    analysis['matched_events'] = tuple(analysis['matched_events'])
    analysis['confirmed_realized'] = sum((e.realized_pl for e in analysis['matched_events']), Decimal('0'))
    analysis['unknown_basis_events'] = tuple(e for e in analysis['matched_events'] if e.basis_status == 'unknown_transfer_basis')
    analysis['unknown_basis_realized'] = sum((e.realized_pl for e in analysis['unknown_basis_events']), Decimal('0'))
    return analysis
