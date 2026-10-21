import os
import re
import json
import sqlite3
import shutil
import hmac
import hashlib
import secrets
from datetime import datetime
from contextlib import contextmanager, closing
from pathlib import Path
import logging
import tempfile
from contextlib import ExitStack

logger = logging.getLogger('finance_app')

class DatabasePasswordRequiredError(PermissionError):
    """Raised when attempting to access a password-protected database without a valid password."""
    pass


class DatabaseNotFoundError(sqlite3.OperationalError):
    """An ordinary connection must never create an absent database."""

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_REGISTRY_FILE = os.path.join(REPO_ROOT, "db_registry.json")

def _load_registry():
    data = {"active_db": "finance.db", "default_db": "finance.db", "databases": {}}
    if os.path.exists(DB_REGISTRY_FILE):
        try:
            with open(DB_REGISTRY_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            pass
    if not isinstance(data, dict):
        data = {"active_db": "finance.db", "default_db": "finance.db", "databases": {}}
    if "databases" not in data:
        data["databases"] = {}
    if "default_db" not in data:
        data["default_db"] = "finance.db"
    if "active_db" not in data:
        data["active_db"] = data.get("default_db", "finance.db")
    
    # Defaults
    if "finance.db" not in data["databases"]:
        data["databases"]["finance.db"] = {
            "name": "Main Portfolio",
            "created_at": datetime.now().isoformat()
        }
    if "finance_backup.db" not in data["databases"] and os.path.exists(os.path.join(REPO_ROOT, "finance_backup.db")):
        data["databases"]["finance_backup.db"] = {
            "name": "Pre-Import Backup",
            "created_at": datetime.now().isoformat()
        }
    return data

def _save_registry(data):
    try:
        with open(DB_REGISTRY_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        print(f"Error saving database registry: {e}")

def _resolve_db_path(name):
    if not name:
        return os.path.join(REPO_ROOT, "finance.db")
    if os.path.isabs(name) or name.startswith(":memory:"):
        return name
    return os.path.join(REPO_ROOT, name)


def require_existing_database(name=None):
    target = _resolve_db_path(DB_NAME if name is None else name)
    if not os.path.isfile(target):
        raise DatabaseNotFoundError(
            f"Database file '{os.path.basename(target)}' does not exist. "
            "Select an existing database or initialize a new one explicitly with python -m models.schema."
        )
    return target


@contextmanager
def get_readonly_db_connection(name=None):
    """Read existing storage without touching it, including its WAL coordination file.

    SQLite read-only WAL connections may update -shm. Replay a stable byte snapshot
    in disposable temp storage instead; never ignore uncheckpointed committed pages.
    """
    target = require_existing_database(name)
    with ExitStack() as stack:
        wal = Path(str(target) + '-wal')
        if wal.exists() and wal.stat().st_size:
            directory = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='finance-read-')))
            paths = [Path(target), wal]
            def stamps():
                return [(p.stat().st_size, p.stat().st_mtime_ns) for p in paths]
            for attempt in range(3):
                before = stamps()
                snapshots = [p.read_bytes() for p in paths]
                if before == stamps():
                    break
            else:
                raise sqlite3.OperationalError('Database changed during read snapshot; retry.')
            target = directory / 'snapshot.db'
            target.write_bytes(snapshots[0])
            Path(str(target) + '-wal').write_bytes(snapshots[1])
            uri = target.resolve().as_uri() + '?mode=ro'
        else:
            # No WAL to replay. Immutable prevents read-side journal/SHM creation.
            # Callers needing a live transaction must use get_db_connection instead.
            uri = Path(target).resolve().as_uri() + '?mode=ro&immutable=1'
        conn = sqlite3.connect(uri, uri=True, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA query_only = ON')
        try:
            yield conn
        finally:
            conn.close()

def _get_db_stats(db_path):
    stats = {"accounts": 0, "transactions": 0, "positions": 0, "is_valid": False}
    if not os.path.exists(db_path):
        return stats
    try:
        with get_readonly_db_connection(db_path) as conn:
            tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
            for table, key in [('transactions', 'transactions'), ('accounts', 'accounts'), ('trade_positions', 'positions')]:
                if table in tables:
                    stats[key] = conn.execute(f'SELECT COUNT(1) FROM {table}').fetchone()[0]
            stats['is_valid'] = 'transactions' in tables and 'trade_positions' in tables
    except Exception:
        pass
    return stats

def get_admin_password_hash():
    """
    Returns the application-level admin password hash.
    Checks db_registry.json first, and falls back to app_settings in the active DB.
    """
    reg = _load_registry()
    if "admin_password_hash" in reg:
        return reg["admin_password_hash"]
    try:
        with get_readonly_db_connection() as conn:
            row = conn.execute("SELECT value FROM app_settings WHERE key = 'admin_password_hash'").fetchone()
            if row and row['value']:
                return row['value']
    except Exception:
        pass
    return None

def set_admin_password_hash(pw_hash):
    """
    Sets the admin password hash globally in the registry and syncs across databases.
    If pw_hash is None or empty, deletes the admin password.
    """
    reg = _load_registry()
    reg["admin_password_hash"] = pw_hash if pw_hash else None
    _save_registry(reg)
    
    # Sync to active DB
    try:
        with get_db_connection() as conn:
            if pw_hash:
                conn.execute("""
                    INSERT INTO app_settings (key, value) VALUES ('admin_password_hash', ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """, (pw_hash,))
            else:
                conn.execute("DELETE FROM app_settings WHERE key = 'admin_password_hash'")
    except Exception:
        pass

    # Sync to all other existing database files
    for db in list_available_databases():
        fn = db['filename']
        resolved = _resolve_db_path(fn)
        if os.path.exists(resolved):
            try:
                with closing(sqlite3.connect(resolved)) as conn, conn:
                    tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
                    if 'app_settings' in tables:
                        if pw_hash:
                            conn.execute("""
                                INSERT INTO app_settings (key, value) VALUES ('admin_password_hash', ?)
                                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                            """, (pw_hash,))
                        else:
                            conn.execute("DELETE FROM app_settings WHERE key = 'admin_password_hash'")
            except Exception:
                pass

def _hash_db_password(password: str, salt: str = None) -> tuple:
    """Generates a PBKDF2-HMAC-SHA256 hash with a cryptographically secure salt."""
    if not salt:
        salt = secrets.token_hex(16)
    pw_hash = hashlib.pbkdf2_hmac(
        'sha256',
        password.encode('utf-8'),
        bytes.fromhex(salt),
        100_000
    ).hex()
    return pw_hash, salt

def is_database_protected(filename: str) -> bool:
    """Checks whether the specified database file has a password configured."""
    filename = os.path.basename(filename)
    if not filename.endswith('.db'):
        filename += '.db'
    reg = _load_registry()
    entry = reg.get("databases", {}).get(filename, {})
    if entry.get("password_hash"):
        return True

    # Check SQLite file's internal app_settings table as durable source of truth
    resolved = _resolve_db_path(filename)
    if os.path.exists(resolved):
        try:
            with get_readonly_db_connection(filename) as conn:
                tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
                if 'app_settings' in tables:
                    row = conn.execute("SELECT value FROM app_settings WHERE key = 'db_password_hash'").fetchone()
                    if row and row[0]:
                        salt_row = conn.execute("SELECT value FROM app_settings WHERE key = 'db_password_salt'").fetchone()
                        salt = salt_row[0] if salt_row else ""
                        return True
        except Exception:
            pass
    return False

def verify_database_password(filename: str, password: str) -> bool:
    """Verifies a password against the target database's stored hash."""
    filename = os.path.basename(filename)
    if not filename.endswith('.db'):
        filename += '.db'
    if not is_database_protected(filename):
        return True
    if not password:
        return False

    reg = _load_registry()
    entry = reg.get("databases", {}).get(filename, {})
    stored_hash = entry.get("password_hash")
    stored_salt = entry.get("password_salt")

    if not stored_hash:
        resolved = _resolve_db_path(filename)
        if os.path.exists(resolved):
            try:
                with get_readonly_db_connection(filename) as conn:
                    row = conn.execute("SELECT value FROM app_settings WHERE key = 'db_password_hash'").fetchone()
                    salt_row = conn.execute("SELECT value FROM app_settings WHERE key = 'db_password_salt'").fetchone()
                    if row and row[0]:
                        stored_hash = row[0]
                        stored_salt = salt_row[0] if salt_row else ""
            except Exception:
                pass

    if not stored_hash:
        return True

    if stored_salt:
        test_hash, _ = _hash_db_password(password, stored_salt)
        return hmac.compare_digest(test_hash, stored_hash)
    else:
        test_hash = hashlib.sha256(password.encode('utf-8')).hexdigest()
        return hmac.compare_digest(test_hash, stored_hash)

def set_database_password(filename: str, new_password: str, current_password: str = None, bypass_current: bool = False):
    """Sets or updates the password for a specific database file."""
    filename = os.path.basename(filename)
    if not filename.endswith('.db'):
        filename += '.db'
    target_path = _resolve_db_path(filename)
    if not os.path.exists(target_path):
        raise FileNotFoundError(f"Database file '{filename}' does not exist.")

    if is_database_protected(filename) and not bypass_current:
        # Allow app-level admin password as master recovery override
        admin_hash = get_admin_password_hash()
        is_admin_override = False
        if current_password and admin_hash:
            if hmac.compare_digest(hashlib.sha256(current_password.encode()).hexdigest(), admin_hash):
                is_admin_override = True

        if not is_admin_override and not verify_database_password(filename, current_password or ""):
            raise ValueError("Current database password is incorrect.")

    if not new_password or len(new_password) < 4:
        raise ValueError("Password must be at least 4 characters.")

    pw_hash, pw_salt = _hash_db_password(new_password)

    reg = _load_registry()
    if filename not in reg.get("databases", {}):
        reg["databases"][filename] = {
            "name": filename.replace('.db', '').replace('_', ' ').title(),
            "created_at": datetime.now().isoformat()
        }
    reg["databases"][filename]["password_hash"] = pw_hash
    reg["databases"][filename]["password_salt"] = pw_salt
    reg["databases"][filename]["is_protected"] = True
    _save_registry(reg)

    # Sync to SQLite file app_settings
    try:
        with closing(sqlite3.connect(target_path)) as conn, conn:
            tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
            if 'app_settings' not in tables:
                conn.execute("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            conn.execute("""
                INSERT INTO app_settings (key, value) VALUES ('db_password_hash', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """, (pw_hash,))
            conn.execute("""
                INSERT INTO app_settings (key, value) VALUES ('db_password_salt', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """, (pw_salt,))
            conn.commit()
    except Exception as e:
        print(f"Warning: Failed to persist password inside {filename}: {e}")

    return {
        "filename": filename,
        "is_protected": True,
        "message": f"Password protection enabled for '{filename}'."
    }

def remove_database_password(filename: str, current_password: str, bypass_current: bool = False):
    """Removes password protection from a database file."""
    filename = os.path.basename(filename)
    if not filename.endswith('.db'):
        filename += '.db'
    target_path = _resolve_db_path(filename)
    if not os.path.exists(target_path):
        raise FileNotFoundError(f"Database file '{filename}' does not exist.")

    if is_database_protected(filename) and not bypass_current:
        admin_hash = get_admin_password_hash()
        is_admin_override = False
        if current_password and admin_hash:
            if hmac.compare_digest(hashlib.sha256(current_password.encode()).hexdigest(), admin_hash):
                is_admin_override = True

        if not is_admin_override and not verify_database_password(filename, current_password or ""):
            raise ValueError("Current database password is incorrect.")

    reg = _load_registry()
    if filename in reg.get("databases", {}):
        reg["databases"][filename].pop("password_hash", None)
        reg["databases"][filename].pop("password_salt", None)
        reg["databases"][filename]["is_protected"] = False
        _save_registry(reg)

    try:
        with closing(sqlite3.connect(target_path)) as conn, conn:
            tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
            if 'app_settings' in tables:
                conn.execute("DELETE FROM app_settings WHERE key IN ('db_password_hash', 'db_password_salt')")
                conn.commit()
    except Exception as e:
        print(f"Warning: Failed to clear password inside {filename}: {e}")

    return {
        "filename": filename,
        "is_protected": False,
        "message": f"Password protection removed from '{filename}'."
    }

def get_default_database():
    """Returns the filename of the configured default database."""
    reg = _load_registry()
    default_db = reg.get("default_db", "finance.db")
    if not os.path.exists(_resolve_db_path(default_db)):
        default_db = "finance.db"
    return default_db

def set_default_database(filename):
    """Configures the default database to load on server start, page reload, etc."""
    filename = os.path.basename(filename).strip()
    if not filename.endswith('.db'):
        filename += '.db'
    target_path = _resolve_db_path(filename)
    if not os.path.exists(target_path):
        raise FileNotFoundError(f"Database file '{filename}' does not exist.")

    reg = _load_registry()
    if filename not in reg.get("databases", {}):
        reg["databases"][filename] = {
            "name": filename.replace('.db', '').replace('_', ' ').title(),
            "created_at": datetime.now().isoformat()
        }
    reg["default_db"] = filename
    _save_registry(reg)

    try:
        with closing(sqlite3.connect(target_path)) as conn, conn:
            tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
            if 'app_settings' in tables:
                conn.execute("""
                    INSERT INTO app_settings (key, value) VALUES ('is_default_db', 'true')
                    ON CONFLICT(key) DO UPDATE SET value = 'true'
                """)
                conn.commit()
    except Exception:
        pass

    return {
        "filename": filename,
        "is_default": True,
        "message": f"Database '{filename}' is now set as the default database."
    }

def reset_to_default_database(password=None):
    """Switches the active runtime database back to the configured default database."""
    default_db = get_default_database()
    return switch_database(default_db, password=password)

DB_NAME = get_default_database()

@contextmanager
def get_db_connection(*, allow_create=False):
    """
    Open existing storage, closing it and committing/rolling back on exit.
    Only explicit schema initialization may opt into creating a missing file.
    """
    target = _resolve_db_path(DB_NAME)
    if target == ':memory:':
        conn = sqlite3.connect(target, timeout=30.0)
    else:
        if not allow_create:
            require_existing_database()
        # mode=rw also prevents creation if the file disappears after the check.
        mode = 'rwc' if allow_create else 'rw'
        conn = sqlite3.connect(Path(target).resolve().as_uri() + f'?mode={mode}', uri=True, timeout=30.0)
    # Configure connection to enable foreign key support and return dict-like rows
    conn.execute("PRAGMA foreign_keys = 1")
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception as e:
        conn.rollback()
        raise e
    finally:
        conn.close()

def get_active_db_info():
    """Returns details of the currently active database."""
    resolved = _resolve_db_path(DB_NAME)
    filename = os.path.basename(resolved) if not DB_NAME.startswith(':') else DB_NAME
    reg = _load_registry()
    default_filename = get_default_database()
    db_entry = reg.get("databases", {}).get(filename, {})
    display_name = db_entry.get("name") or (
        "Main Portfolio" if filename == "finance.db" else filename
    )
    
    size_bytes = os.path.getsize(resolved) if os.path.exists(resolved) else 0
    modified_at = None
    if os.path.exists(resolved):
        mtime = os.path.getmtime(resolved)
        modified_at = datetime.fromtimestamp(mtime).isoformat()
        
    stats = _get_db_stats(resolved)
    
    return {
        "filename": filename,
        "display_name": display_name,
        "full_path": resolved,
        "size_bytes": size_bytes,
        "modified_at": modified_at,
        "is_active": True,
        "is_default": (filename == default_filename),
        "is_protected": is_database_protected(filename),
        "accounts_count": stats.get("accounts", 0),
        "transactions_count": stats.get("transactions", 0),
        "positions_count": stats.get("positions", 0)
    }

def list_available_databases():
    """Scans for all .db files in REPO_ROOT and merges with registry."""
    reg = _load_registry()
    active_filename = os.path.basename(_resolve_db_path(DB_NAME))
    default_filename = get_default_database()
    
    databases = []
    found_files = set()
    
    if os.path.exists(REPO_ROOT):
        for entry in os.listdir(REPO_ROOT):
            if entry.endswith('.db') and not entry.endswith(('-journal', '-wal', '-shm')):
                found_files.add(entry)
                
    for reg_file in reg.get("databases", {}).keys():
        resolved = _resolve_db_path(reg_file)
        if os.path.exists(resolved):
            found_files.add(reg_file)
            
    found_files.add("finance.db")
    
    for filename in sorted(found_files):
        resolved = _resolve_db_path(filename)
        if not os.path.exists(resolved):
            continue
        entry = reg.get("databases", {}).get(filename, {})
        display_name = entry.get("name") or (
            "Main Portfolio" if filename == "finance.db" 
            else ("Pre-Import Backup" if filename == "finance_backup.db" else filename.replace('.db', '').replace('_', ' ').title())
        )
        size_bytes = os.path.getsize(resolved)
        mtime = os.path.getmtime(resolved)
        modified_at = datetime.fromtimestamp(mtime).isoformat()
        stats = _get_db_stats(resolved)
        is_active = (filename == active_filename)
        
        databases.append({
            "filename": filename,
            "display_name": display_name,
            "full_path": resolved,
            "size_bytes": size_bytes,
            "modified_at": modified_at,
            "is_active": is_active,
            "is_default": (filename == default_filename),
            "is_protected": is_database_protected(filename),
            "accounts_count": stats.get("accounts", 0),
            "transactions_count": stats.get("transactions", 0),
            "positions_count": stats.get("positions", 0)
        })
        
    databases.sort(key=lambda d: (not d["is_active"], not d["is_default"], d["filename"]))
    return databases

def set_database_name(filename, display_name):
    """Sets a custom display name / alias for a database file."""
    filename = os.path.basename(filename)
    display_name = display_name.strip()
    if not display_name:
        raise ValueError("Display name cannot be empty.")
    reg = _load_registry()
    if filename not in reg.get("databases", {}):
        reg["databases"][filename] = {}
    reg["databases"][filename]["name"] = display_name
    _save_registry(reg)
    return {"filename": filename, "display_name": display_name}

def switch_database(filename, password=None):
    """
    Switch the runtime database after validation. Never persist settings, initialize
    schema, change journal mode, or run repair scripts during a switch.
    """
    global DB_NAME
    filename = os.path.basename(filename)
    if not filename.endswith('.db'):
        filename += '.db'
    target_path = _resolve_db_path(filename)
    if not os.path.exists(target_path):
        raise FileNotFoundError(f"Database file '{filename}' does not exist.")

    if is_database_protected(filename):
        if password is None or password == '':
            raise DatabasePasswordRequiredError(f"Database '{filename}' is password protected.")
        if not verify_database_password(filename, password):
            raise ValueError("Incorrect password for this database.")
        
    reg = _load_registry()
    stats = {"accounts": 0, "transactions": 0, "positions": 0, "is_valid": False}
    try:
        with get_readonly_db_connection(filename) as conn:
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
            if 'transactions' in tables:
                stats["transactions"] = conn.execute("SELECT COUNT(1) FROM transactions").fetchone()[0]
            if 'accounts' in tables:
                stats["accounts"] = conn.execute("SELECT COUNT(1) FROM accounts").fetchone()[0]
            if 'trade_positions' in tables:
                stats["positions"] = conn.execute("SELECT COUNT(1) FROM trade_positions").fetchone()[0]
            stats["is_valid"] = ('transactions' in tables and 'trade_positions' in tables)
    except Exception as e:
        logger.warning(f"Error reading stats for {filename}: {e}")

    if not stats['is_valid']:
        raise ValueError('Database requires explicit initialization or migration before switching.')
    DB_NAME = filename
    size_bytes = os.path.getsize(target_path) if os.path.exists(target_path) else 0
    mtime = os.path.getmtime(target_path) if os.path.exists(target_path) else None
    modified_at = datetime.fromtimestamp(mtime).isoformat() if mtime else None
    db_entry = reg.get("databases", {}).get(filename, {})
    display_name = db_entry.get("name") or (
        "Main Portfolio" if filename == "finance.db" 
        else ("Pre-Import Backup" if filename == "finance_backup.db" else filename.replace('.db', '').replace('_', ' ').title())
    )
    return {
        "filename": filename,
        "display_name": display_name,
        "full_path": target_path,
        "size_bytes": size_bytes,
        "modified_at": modified_at,
        "is_active": True,
        "is_default": (filename == get_default_database()),
        "is_protected": is_database_protected(filename),
        "accounts_count": stats.get("accounts", 0),
        "transactions_count": stats.get("transactions", 0),
        "positions_count": stats.get("positions", 0)
    }

def create_database(filename, display_name=None, copy_from_current=False, password=None, set_as_default=False):
    """Creates a new database file (cloned or empty)."""
    global DB_NAME
    filename = os.path.basename(filename).strip()
    if not filename.endswith('.db'):
        filename += '.db'
        
    base = filename[:-3]
    if not base or not all(c.isalnum() or c in ('_', '-') for c in base):
        raise ValueError("Filename must contain only letters, numbers, hyphens, and underscores.")
        
    target_path = _resolve_db_path(filename)
    if os.path.exists(target_path):
        raise FileExistsError(f"Database file '{filename}' already exists.")
        
    if copy_from_current:
        current_path = _resolve_db_path(DB_NAME)
        if os.path.exists(current_path):
            shutil.copy2(current_path, target_path)
    else:
        with closing(sqlite3.connect(target_path)) as conn, conn:
            pass
            
    reg = _load_registry()
    if not display_name:
        display_name = base.replace('_', ' ').replace('-', ' ').title()
    reg["databases"][filename] = {
        "name": display_name,
        "created_at": datetime.now().isoformat()
    }
    _save_registry(reg)
    
    if not copy_from_current:
        orig = DB_NAME
        try:
            DB_NAME = filename
            from models.schema import setup_database
            setup_database()
        finally:
            DB_NAME = orig

    pw_hash = get_admin_password_hash()
    if pw_hash:
        try:
            with closing(sqlite3.connect(target_path)) as conn, conn:
                tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
                if 'app_settings' in tables:
                    conn.execute("""
                        INSERT INTO app_settings (key, value) VALUES ('admin_password_hash', ?)
                        ON CONFLICT(key) DO UPDATE SET value = excluded.value
                    """, (pw_hash,))
        except Exception:
            pass

    if password:
        set_database_password(filename, password, bypass_current=True)

    if set_as_default:
        set_default_database(filename)
            
    return {
        "filename": filename,
        "display_name": display_name,
        "full_path": target_path,
        "is_default": (filename == get_default_database()),
        "is_protected": is_database_protected(filename)
    }

def delete_database(filename):
    """Deletes an inactive database file."""
    global DB_NAME
    filename = os.path.basename(filename)
    active_filename = os.path.basename(_resolve_db_path(DB_NAME))
    if filename == active_filename:
        raise ValueError("Cannot delete the currently active database.")
    if filename == "finance.db":
        raise ValueError("Cannot delete the primary database 'finance.db'.")
        
    target_path = _resolve_db_path(filename)
    if not os.path.exists(target_path):
        raise FileNotFoundError(f"Database file '{filename}' does not exist.")
        
    for suffix in ('', '-journal', '-wal', '-shm'):
        p = target_path + suffix
        if os.path.exists(p):
            try:
                os.remove(p)
            except Exception:
                pass
                
    reg = _load_registry()
    if filename in reg.get("databases", {}):
        del reg["databases"][filename]
    if filename == reg.get("default_db"):
        reg["default_db"] = "finance.db"
    _save_registry(reg)
        
    return {"message": f"Database '{filename}' deleted successfully."}

def upload_database(file_stream, original_filename, display_name=None, switch_now=False, password=None, set_as_default=False):
    """
    Validates and saves an uploaded SQLite database file into REPO_ROOT.
    Ensures SQLite format validity, assigns display name, and optionally activates it.
    """
    global DB_NAME
    if not original_filename:
        raise ValueError("Filename is required.")
        
    clean_filename = os.path.basename(original_filename).strip()
    if not clean_filename.endswith('.db'):
        clean_filename += '.db'
        
    clean_filename = re.sub(r'[^a-zA-Z0-9_\-\.]', '_', clean_filename)
    base, ext = os.path.splitext(clean_filename)
    if not base:
        base = "uploaded_database"
        clean_filename = base + ext

    # Avoid overwriting existing files by appending counter
    target_filename = clean_filename
    counter = 1
    while os.path.exists(_resolve_db_path(target_filename)):
        target_filename = f"{base}_{counter}{ext}"
        counter += 1
        
    target_path = _resolve_db_path(target_filename)
    
    # Read first 16 bytes to verify SQLite header
    header = file_stream.read(16)
    if header != b'SQLite format 3\x00':
        raise ValueError("The uploaded file is not a valid SQLite database (missing SQLite 3 header).")
        
    with open(target_path, 'wb') as f:
        f.write(header)
        shutil.copyfileobj(file_stream, f)
        
    reg = _load_registry()
    if not display_name or not display_name.strip():
        display_name = base.replace('_', ' ').replace('-', ' ').title()
    else:
        display_name = display_name.strip()
        
    reg["databases"][target_filename] = {
        "name": display_name,
        "created_at": datetime.now().isoformat(),
        "uploaded": True
    }
    _save_registry(reg)

    if password:
        set_database_password(target_filename, password, bypass_current=True)

    if set_as_default:
        set_default_database(target_filename)
    
    if switch_now:
        return switch_database(target_filename, password=password)
    else:
        orig = DB_NAME
        try:
            DB_NAME = target_filename
            from models.schema import setup_database
            setup_database()
        finally:
            DB_NAME = orig

        # Overwrite any foreign admin password inside uploaded file with active application password
        pw_hash = get_admin_password_hash()
        if pw_hash:
            try:
                with closing(sqlite3.connect(target_path)) as conn, conn:
                    tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
                    if 'app_settings' in tables:
                        conn.execute("""
                            INSERT INTO app_settings (key, value) VALUES ('admin_password_hash', ?)
                            ON CONFLICT(key) DO UPDATE SET value = excluded.value
                        """, (pw_hash,))
            except Exception:
                pass
            
        databases = list_available_databases()
        return next((d for d in databases if d['filename'] == target_filename), {
            "filename": target_filename,
            "display_name": display_name,
            "full_path": target_path,
            "is_active": False,
            "is_default": (target_filename == get_default_database()),
            "is_protected": is_database_protected(target_filename)
        })

