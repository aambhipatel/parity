import os
import sys
from pathlib import Path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from models.database import get_db_connection

def setup_database():
    """
    Initializes the database schema including tables for users, institutions, 
    accounts, transactions, and balance_snapshots. Also creates a default user.
    """
    
    schema = """
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS institutions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        institution_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('checking', 'savings', 'credit card', 'investment', 'loan')),
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(institution_id) REFERENCES institutions(id),
        UNIQUE(institution_id, name)
    );

    CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        date DATE NOT NULL,
        amount REAL NOT NULL,
        category TEXT NOT NULL,
        description TEXT,
        imported_file_id INTEGER,
        FOREIGN KEY(account_id) REFERENCES accounts(id),
        FOREIGN KEY(imported_file_id) REFERENCES imported_files(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS balance_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        date DATE NOT NULL,
        balance REAL NOT NULL,
        FOREIGN KEY(account_id) REFERENCES accounts(id)
    );

    CREATE TABLE IF NOT EXISTS imported_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_hash TEXT UNIQUE NOT NULL,
        filename TEXT NOT NULL,
        imported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS trade_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        underlying_symbol TEXT NOT NULL,
        strategy_type TEXT,
        status TEXT DEFAULT 'Open',
        notes TEXT,
        opened_at DATE,
        closed_at DATE,
        FOREIGN KEY(account_id) REFERENCES accounts(id)
    );

    CREATE TABLE IF NOT EXISTS option_legs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id INTEGER,
        position_id INTEGER NOT NULL,
        expiration_date DATE NOT NULL,
        strike_price REAL NOT NULL,
        option_type TEXT NOT NULL CHECK(option_type IN ('C', 'P', 'Call', 'Put')),
        action TEXT,
        quantity REAL DEFAULT 0,
        fees REAL DEFAULT 0,
        FOREIGN KEY(transaction_id) REFERENCES transactions(id),
        FOREIGN KEY(position_id) REFERENCES trade_positions(id)
    );

    CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_deletion_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        deleted_tx_id INTEGER NOT NULL,
        matched_orig_tx_id INTEGER,
        date DATE,
        amount REAL,
        description TEXT,
        imported_file_id INTEGER,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """
    
    with get_db_connection(allow_create=True) as conn:
        conn.executescript(schema)
        # Migration: add imported_file_id column to transactions if it doesn't exist
        try:
            conn.execute("ALTER TABLE transactions ADD COLUMN imported_file_id INTEGER REFERENCES imported_files(id) ON DELETE SET NULL")
        except Exception:
            # Column already exists or error which we ignore
            pass
        # Schema-level safeguards: index on option_legs(transaction_id)
        try:
            conn.execute("DROP INDEX IF EXISTS idx_option_legs_tx")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_option_legs_tx ON option_legs(transaction_id) WHERE transaction_id IS NOT NULL")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_transactions_dedup ON transactions(account_id, date, amount, category)")
        except Exception:
            pass

        # Ensure default user exists
        conn.execute("""
            INSERT OR IGNORE INTO users (id, username) 
            VALUES (1, 'default_user')
        """)


def migrate_option_split_legs(conn):
    """
    Self-healing migration:
    1. Restores accurate pre-split strike prices on option legs from their transactions' descriptions.
    2. Ensures split adjustment transactions are properly registered in option_legs with action='SPLIT'.
    """
    import re
    from services.options import parse_option_symbol

    # Find split transactions and ensure they have legs
    split_txs = conn.execute("""
        SELECT t.id, t.account_id, t.description, t.category
        FROM transactions t
        WHERE LOWER(t.category) LIKE '%split%' OR LOWER(t.description) LIKE '%split%'
    """).fetchall()

    if not split_txs:
        return

    split_underlyings = set()
    for tx in split_txs:
        desc = tx['description'] or ''
        sym_match = re.search(r"Sym:\s*([^\|]+)", desc)
        if sym_match:
            opt = parse_option_symbol(sym_match.group(1).strip())
            if opt:
                split_underlyings.add(opt['underlying'])
                qty_match = re.search(r"Qty:\s*-?([\d\.]+)", desc)
                split_qty = abs(float(qty_match.group(1))) if qty_match else 0.0
                
                pos = conn.execute(
                    "SELECT id FROM trade_positions WHERE account_id = ? AND underlying_symbol = ?",
                    (tx['account_id'], opt['underlying'])
                ).fetchone()
                if pos:
                    existing = conn.execute("SELECT id FROM option_legs WHERE transaction_id = ?", (tx['id'],)).fetchone()
                    if not existing:
                        conn.execute("""
                            INSERT INTO option_legs 
                            (transaction_id, position_id, expiration_date, strike_price, option_type, action, quantity, fees)
                            VALUES (?, ?, ?, ?, ?, 'SPLIT', ?, 0.0)
                        """, (tx['id'], pos['id'], opt['expiration'], opt['strike'], opt['type'], split_qty))

    if not split_underlyings:
        return

    # Restore original strike prices only on non-split legs of affected underlyings
    placeholders = ','.join('?' * len(split_underlyings))
    legs = conn.execute(f"""
        SELECT l.id, t.description, t.category
        FROM option_legs l
        JOIN transactions t ON l.transaction_id = t.id
        JOIN trade_positions p ON l.position_id = p.id
        WHERE p.underlying_symbol IN ({placeholders})
          AND LOWER(t.category) NOT LIKE '%split%' 
          AND LOWER(t.description) NOT LIKE '%split%'
    """, list(split_underlyings)).fetchall()

    for leg in legs:
        desc = leg['description'] or ''
        sym_match = re.search(r"Sym:\s*([^\|]+)", desc)
        if sym_match:
            opt = parse_option_symbol(sym_match.group(1).strip())
            if opt:
                conn.execute("""
                    UPDATE option_legs
                    SET strike_price = ?, expiration_date = ?, option_type = ?
                    WHERE id = ? AND (ABS(strike_price - ?) > 0.01 OR expiration_date != ? OR option_type != ?)
                """, (opt['strike'], opt['expiration'], opt['type'], leg['id'], opt['strike'], opt['expiration'], opt['type']))

import shutil
import sqlite3
from datetime import datetime

BASE_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS institutions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    institution_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('checking', 'savings', 'credit card', 'investment', 'loan')),
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(institution_id) REFERENCES institutions(id),
    UNIQUE(institution_id, name)
);

CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    date DATE NOT NULL,
    amount REAL NOT NULL,
    category TEXT NOT NULL,
    description TEXT,
    imported_file_id INTEGER,
    FOREIGN KEY(account_id) REFERENCES accounts(id),
    FOREIGN KEY(imported_file_id) REFERENCES imported_files(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS balance_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    date DATE NOT NULL,
    balance REAL NOT NULL,
    FOREIGN KEY(account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS imported_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_hash TEXT UNIQUE NOT NULL,
    filename TEXT NOT NULL,
    imported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS trade_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    underlying_symbol TEXT NOT NULL,
    strategy_type TEXT,
    status TEXT DEFAULT 'Open',
    notes TEXT,
    opened_at DATE,
    closed_at DATE,
    FOREIGN KEY(account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS option_legs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER,
    position_id INTEGER NOT NULL,
    expiration_date DATE NOT NULL,
    strike_price REAL NOT NULL,
    option_type TEXT NOT NULL CHECK(option_type IN ('C', 'P', 'Call', 'Put')),
    action TEXT,
    quantity REAL DEFAULT 0,
    fees REAL DEFAULT 0,
    FOREIGN KEY(transaction_id) REFERENCES transactions(id),
    FOREIGN KEY(position_id) REFERENCES trade_positions(id)
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_deletion_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deleted_tx_id INTEGER NOT NULL,
    matched_orig_tx_id INTEGER,
    date DATE,
    amount REAL,
    description TEXT,
    imported_file_id INTEGER,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
"""


def _migration_001_base_schema(conn):
    conn.executescript(BASE_SCHEMA_SQL)
    try:
        conn.execute("ALTER TABLE transactions ADD COLUMN imported_file_id INTEGER REFERENCES imported_files(id) ON DELETE SET NULL")
    except Exception:
        pass
    conn.execute("INSERT OR IGNORE INTO users (id, username) VALUES (1, 'default_user')")


def _migration_002_split_legs_and_indexes(conn):
    migrate_option_split_legs(conn)
    try:
        conn.execute("DROP INDEX IF EXISTS idx_option_legs_tx")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_option_legs_tx ON option_legs(transaction_id) WHERE transaction_id IS NOT NULL")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_transactions_dedup ON transactions(account_id, date, amount, category)")
    except Exception:
        pass


def _migration_003_trade_positions_indexes(conn):
    try:
        conn.execute("CREATE INDEX IF NOT EXISTS idx_trade_positions_account ON trade_positions(account_id, underlying_symbol)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_option_legs_pos ON option_legs(position_id)")
    except Exception:
        pass


MIGRATIONS = [
    (1, '001_base_schema', _migration_001_base_schema),
    (2, '002_split_legs_and_indexes', _migration_002_split_legs_and_indexes),
    (3, '003_trade_positions_indexes', _migration_003_trade_positions_indexes),
]
LATEST_VERSION = 3


def get_migration_status(db_name=None):
    """
    Inspects database migration status in a read-only manner.
    Never alters database file or creates tables on read.
    """
    from models.database import DB_NAME, _resolve_db_path
    target_db = _resolve_db_path(db_name or DB_NAME)
    if not os.path.exists(target_db):
        return {
            "db_name": target_db,
            "error": "Database file does not exist",
            "current_version": 0,
            "latest_version": LATEST_VERSION,
            "pending_migrations": [],
            "is_up_to_date": False
        }

    from models.database import get_readonly_db_connection
    applied_versions = set()
    with get_readonly_db_connection(target_db) as conn:
        try:
            has_table = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
            ).fetchone()
            if has_table:
                rows = conn.execute("SELECT version FROM schema_migrations ORDER BY version").fetchall()
                applied_versions = {r['version'] for r in rows}
        except sqlite3.DatabaseError:
            pass

    pending = [
        {"version": v, "name": name}
        for v, name, func in MIGRATIONS
        if v not in applied_versions
    ]
    cur_v = max(applied_versions) if applied_versions else 0
    return {
        "db_name": target_db,
        "current_version": cur_v,
        "latest_version": LATEST_VERSION,
        "pending_migrations": pending,
        "is_up_to_date": len(pending) == 0
    }


def run_versioned_migrations(db_name=None, user_confirmed=False):
    """
    Runs pending versioned migrations strictly on explicit user confirmation.
    Takes a timestamped database backup before making any schema modifications.
    """
    from models.database import DB_NAME, _resolve_db_path
    target_db = _resolve_db_path(db_name or DB_NAME)
    status = get_migration_status(target_db)
    if status.get('error'):
        return {'status': 'error', 'error': status['error'], 'message': status['error'],
                'db_name': target_db}
    if not status.get("pending_migrations"):
        return {
            "status": "up_to_date",
            "message": f"Database '{target_db}' is already up to date (version {status['current_version']}).",
            "current_version": status['current_version'],
            "latest_version": LATEST_VERSION,
            "pending_migrations": []
        }

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = f"{target_db}.backup_{timestamp}.db"

    if not user_confirmed:
        return {
            "status": "confirmation_required",
            "prompt": (
                f"Confirmation required: Database '{target_db}' will be backed up to '{backup_path}' "
                f"and upgraded from version {status['current_version']} to {LATEST_VERSION} "
                f"({len(status['pending_migrations'])} pending migration(s): "
                f"{', '.join(m['name'] for m in status['pending_migrations'])}). "
                f"To proceed, provide confirm=True."
            ),
            "backup_destination": backup_path,
            "pending_migrations": status['pending_migrations'],
            "current_version": status['current_version'],
            "latest_version": LATEST_VERSION,
            "user_confirmed": False
        }

    # Explicit user confirmation received: take backup first
    # SQLite's online backup includes committed WAL pages; copying just the .db does not.
    from contextlib import closing
    from models.database import get_readonly_db_connection
    with get_readonly_db_connection(target_db) as source:
        with closing(sqlite3.connect(backup_path)) as backup:
            source.backup(backup)

    conn = sqlite3.connect(Path(target_db).resolve().as_uri() + '?mode=rw', uri=True)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        applied_now = []
        for v, name, func in MIGRATIONS:
            already = conn.execute("SELECT 1 FROM schema_migrations WHERE version = ?", (v,)).fetchone()
            if not already:
                func(conn)
                conn.execute("INSERT INTO schema_migrations (version, name) VALUES (?, ?)", (v, name))
                applied_now.append(name)
        conn.commit()
    except Exception as e:
        conn.rollback()
        raise e
    finally:
        conn.close()

    return {
        "status": "success",
        "message": f"Successfully upgraded '{target_db}' to version {LATEST_VERSION}.",
        "backup_created": backup_path,
        "applied_versions": applied_now,
        "current_version": LATEST_VERSION
    }


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description="Database schema and migrations manager")
    parser.add_argument('--status', action='store_true', help="Check migration status of database")
    parser.add_argument('--migrate', action='store_true', help="Run pending migrations")
    parser.add_argument('--confirm', action='store_true', help="Explicit user confirmation to create backup and apply migrations")
    parser.add_argument('--db', type=str, default=None, help="Specific database file to inspect/migrate")
    args = parser.parse_args()

    if args.status:
        st = get_migration_status(args.db)
        print(f"Database: {st['db_name']}")
        print(f"Current version: {st['current_version']} / Latest: {st['latest_version']}")
        print(f"Pending migrations: {len(st['pending_migrations'])}")
        for m in st['pending_migrations']:
            print(f"  - v{m['version']}: {m['name']}")
    elif args.migrate:
        res = run_versioned_migrations(args.db, user_confirmed=args.confirm)
        if res.get('status') == 'confirmation_required':
            print(f"\n[PROMPT] {res['prompt']}\nRun with --confirm to proceed.")
        elif res.get('status') == 'success':
            print(f"\n[SUCCESS] {res['message']}")
            print(f"Backup created at: {res['backup_created']}")
        else:
            print(res.get('message', res))
    else:
        setup_database()

