import sqlite3
import re
from models.database import get_db_connection
from utils.logger import logger

def get_default_user_id():
    with get_db_connection() as conn:
        row = conn.execute("SELECT id FROM users WHERE username='default_user'").fetchone()
        if not row:
            row = conn.execute("SELECT id FROM users ORDER BY id ASC LIMIT 1").fetchone()
        return row['id'] if row else 1

def list_institutions():
    with get_db_connection() as conn:
        rows = conn.execute("SELECT id, name FROM institutions").fetchall()
        return [(r['id'], r['name']) for r in rows]

def get_or_create_institution(name):
    with get_db_connection() as conn:
        row = conn.execute("SELECT id FROM institutions WHERE name = ?", (name,)).fetchone()
        if row:
            return row['id']
        cursor = conn.execute("INSERT INTO institutions (name) VALUES (?)", (name,))
        return cursor.lastrowid

def list_accounts():
    query = """
        SELECT a.id as account_id, i.name as inst_name, a.name as acc_name, a.type
        FROM accounts a
        JOIN institutions i ON a.institution_id = i.id
    """
    with get_db_connection() as conn:
        rows = conn.execute(query).fetchall()
        return [(r['account_id'], r['inst_name'], r['acc_name'], r['type']) for r in rows]

def get_or_create_account(institution_id, name, acc_type):
    user_id = get_default_user_id()
    if not user_id:
        logger.error("Default user not found.")
        return None
        
    with get_db_connection() as conn:
        row = conn.execute(
            "SELECT id FROM accounts WHERE institution_id = ? AND name = ?", 
            (institution_id, name)
        ).fetchone()
        if row:
            return row['id']
            
        try:
            cursor = conn.execute(
                "INSERT INTO accounts (user_id, institution_id, name, type) VALUES (?, ?, ?, ?)",
                (user_id, institution_id, name, acc_type)
            )
            return cursor.lastrowid
        except sqlite3.IntegrityError as e:
            logger.error(f"Error creating account {name}: {e}")
            raise e

def update_account_name(account_id, new_name):
    with get_db_connection() as conn:
        conn.execute("UPDATE accounts SET name = ? WHERE id = ?", (new_name, account_id))

def delete_account(account_id):
    with get_db_connection() as conn:
        # Get all transactions for this account to delete their option legs
        tx_rows = conn.execute("SELECT id FROM transactions WHERE account_id = ?", (account_id,)).fetchall()
        tx_ids = [r['id'] for r in tx_rows]
        
        if tx_ids:
            placeholders = ','.join('?' * len(tx_ids))
            conn.execute(f"DELETE FROM option_legs WHERE transaction_id IN ({placeholders})", tx_ids)
            
        # Delete any remaining option legs for positions in this account
        conn.execute("DELETE FROM option_legs WHERE position_id IN (SELECT id FROM trade_positions WHERE account_id = ?)", (account_id,))
        
        # Delete trade positions
        conn.execute("DELETE FROM trade_positions WHERE account_id = ?", (account_id,))
        
        # Delete balance snapshots
        conn.execute("DELETE FROM balance_snapshots WHERE account_id = ?", (account_id,))
        
        # Delete transactions and account
        conn.execute("DELETE FROM transactions WHERE account_id = ?", (account_id,))
        
        # Clean up orphaned imported_files so the user can re-import the exact same CSV
        conn.execute("""
            DELETE FROM imported_files 
            WHERE id NOT IN (
                SELECT DISTINCT imported_file_id 
                FROM transactions 
                WHERE imported_file_id IS NOT NULL
            )
        """)
        
        conn.execute("DELETE FROM accounts WHERE id = ?", (account_id,))

def normalize_sym_desc(desc):
    if not desc:
        return ""
    def fix_strike(match):
        sym_prefix = match.group(1)
        strike_str = match.group(2)
        opt_type = match.group(3)
        try:
            val = float(strike_str)
            return f"{sym_prefix}{val:g} {opt_type}"
        except ValueError:
            return match.group(0)

    return re.sub(r'(Sym:\s+[A-Z\.]+\s+\d{2}/\d{2}/\d{4}\s+)([\d\.]+)(\s+[CP])', fix_strike, desc).strip()

def add_transaction(account_id, date, amount, category, description, imported_file_id=None, allow_duplicate=False):
    with get_db_connection() as conn:
        if not allow_duplicate:
            # Prevent row-level duplicates since CSVs often overlap or get re-imported
            existing = conn.execute(
                """
                SELECT id, imported_file_id FROM transactions 
                WHERE account_id = ? AND date = ? AND amount = ? AND category = ? AND description = ?
                """,
                (account_id, date, amount, category, description)
            ).fetchone()

            # Robust normalized description check for option format variations
            if not existing:
                candidates = conn.execute(
                    """
                    SELECT id, description, imported_file_id FROM transactions 
                    WHERE account_id = ? AND date = ? AND ABS(amount - ?) < 0.0001 AND category = ?
                    """,
                    (account_id, date, amount, category)
                ).fetchall()
                norm_incoming = normalize_sym_desc(description)
                for cand in candidates:
                    if normalize_sym_desc(cand['description']) == norm_incoming:
                        existing = cand
                        break

            if existing:
                # If existing transaction was created in the SAME file import session, it's a valid repeated order in the same file
                if imported_file_id is not None and existing['imported_file_id'] == imported_file_id:
                    existing = None
                else:
                    if existing['imported_file_id'] is None and imported_file_id is not None:
                        conn.execute(
                            "UPDATE transactions SET imported_file_id = ? WHERE id = ?",
                            (imported_file_id, existing['id'])
                        )
                    logger.info(f"Skipped duplicate transaction for account {account_id}: {amount} on {date}")
                    return existing['id'], False

        cursor = conn.execute(
            "INSERT INTO transactions (account_id, date, amount, category, description, imported_file_id) VALUES (?, ?, ?, ?, ?, ?)",
            (account_id, date, amount, category, description, imported_file_id)
        )
        logger.info(f"Added transaction for account {account_id}: {amount} on {date}")
        return cursor.lastrowid, True

def repair_duplicate_transactions(dry_run=False, opt_in=True):
    """
    Scans for duplicate option/cash transactions in the active database.
    When dry_run=True:
      Performs an in-memory audit and returns preview dictionary without modifying data.
    When dry_run=False and opt_in=True:
      Explicitly executes the deletion of duplicate transactions, logging to audit_deletion_log,
      and returns the integer count of deleted transactions.
    """
    with get_db_connection() as conn:
        journal_del_count = 0
        if opt_in and not dry_run:
            # Clean any option legs mistakenly created for Journal transactions
            journal_del_count = conn.execute("DELETE FROM option_legs WHERE transaction_id IN (SELECT id FROM transactions WHERE LOWER(category) = 'journal')").rowcount
            if journal_del_count > 0:
                logger.info(f"[Repair] Cleaned {journal_del_count} option legs associated with Journal transactions.")

        txs = conn.execute("SELECT id, account_id, date, amount, category, description, imported_file_id FROM transactions ORDER BY id ASC").fetchall()
        
        seen_by_key = {}
        to_delete_ids = []
        
        for t in txs:
            norm_desc = normalize_sym_desc(t['description'])
            key = (t['account_id'], t['date'], round(float(t['amount']), 2), t['category'].strip(), norm_desc)
            
            if key not in seen_by_key:
                seen_by_key[key] = [t]
            else:
                existing_list = seen_by_key[key]
                # Check if there is an existing transaction from a DIFFERENT file that hasn't been matched yet
                matched = False
                for ex in existing_list:
                    # If this is from a different file_id, it is a cross-file re-import duplicate!
                    if t['imported_file_id'] is not None and ex['imported_file_id'] is not None and t['imported_file_id'] != ex['imported_file_id']:
                        to_delete_ids.append((t['id'], ex['id'], t['date'], t['amount'], t['description'], t['imported_file_id']))
                        logger.info(f"[Repair] Found cross-file duplicate Tx ID {t['id']} (File {t['imported_file_id']}) matching Orig Tx ID {ex['id']} (File {ex['imported_file_id']})")
                        matched = True
                        break
                if not matched:
                    seen_by_key[key].append(t)

        if dry_run:
            return {
                "duplicate_count": len(to_delete_ids),
                "candidates": to_delete_ids,
                "dry_run": True,
                "opt_in": opt_in,
                "modified": False
            }

        if to_delete_ids and opt_in and not dry_run:
            for item in to_delete_ids:
                del_id, orig_id, d_date, d_amt, d_desc, d_file_id = item
                conn.execute(
                    """
                    INSERT INTO audit_deletion_log (deleted_tx_id, matched_orig_tx_id, date, amount, description, imported_file_id)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (del_id, orig_id, d_date, d_amt, d_desc, d_file_id)
                )
            del_ids = [d[0] for d in to_delete_ids]
            placeholders = ','.join('?' * len(del_ids))
            conn.execute(f"DELETE FROM option_legs WHERE transaction_id IN ({placeholders})", del_ids)
            conn.execute(f"DELETE FROM transactions WHERE id IN ({placeholders})", del_ids)
            logger.info(f"[Repair] Successfully deleted {len(del_ids)} duplicate transactions and linked option legs, logged to audit_deletion_log.")

        return len(to_delete_ids)

def check_duplicate_file(file_hash):
    with get_db_connection() as conn:
        row = conn.execute("SELECT id FROM imported_files WHERE file_hash = ?", (file_hash,)).fetchone()
        return bool(row)

def record_imported_file(file_hash, filename):
    with get_db_connection() as conn:
        cursor = conn.execute("INSERT INTO imported_files (file_hash, filename) VALUES (?, ?)", (file_hash, filename))
        return cursor.lastrowid

def revert_imported_file(file_id):
    with get_db_connection() as conn:
        # 1. Delete option legs linked to transactions in this file
        conn.execute(
            """
            DELETE FROM option_legs 
            WHERE transaction_id IN (
                SELECT id FROM transactions WHERE imported_file_id = ?
            )
            """,
            (file_id,)
        )
        
        # 2. Delete transactions
        conn.execute("DELETE FROM transactions WHERE imported_file_id = ?", (file_id,))
        
        # 3. Delete the imported file record
        conn.execute("DELETE FROM imported_files WHERE id = ?", (file_id,))
        
        # 4. Clean up empty trade positions
        conn.execute(
            """
            DELETE FROM trade_positions 
            WHERE id NOT IN (SELECT DISTINCT position_id FROM option_legs)
            """
        )
        logger.info(f"Reverted CSV file import ID {file_id} successfully.")

def wipe_database():
    """Wipes transaction data and accounts while preserving institutions."""
    with get_db_connection() as conn:
        # Delete option-related data first (foreign key dependencies)
        conn.execute("DELETE FROM option_legs")
        conn.execute("DELETE FROM trade_positions")
        
        # Delete transaction data
        conn.execute("DELETE FROM transactions")
        conn.execute("DELETE FROM balance_snapshots")
        conn.execute("DELETE FROM imported_files")
        
        # Delete accounts
        conn.execute("DELETE FROM accounts")
        
        # Reset autoincrement sequences (keep institutions intact)
        conn.execute("DELETE FROM sqlite_sequence WHERE name IN ('transactions', 'balance_snapshots', 'imported_files', 'option_legs', 'trade_positions', 'accounts')")
        
        logger.info("Database wiped (accounts deleted, institutions preserved).")
