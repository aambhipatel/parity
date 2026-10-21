from isolated_support import IsolatedTestCase
"""Run only in the disposable checkout created by scripts/test_isolated.py."""
import hashlib
import importlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from contextlib import closing


def file_hashes(directory):
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in Path(directory).iterdir() if p.is_file()}


class TestReadOnlyLifecycle(IsolatedTestCase):
    def setUp(self):
        import models.database as db
        self.db = db
        self.temp = tempfile.TemporaryDirectory(dir=Path.cwd())
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        for name in ('one.db', 'two.db'):
            with closing(sqlite3.connect(self.directory / name)) as conn, conn:
                conn.execute('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)')
                conn.execute('CREATE TABLE transactions (id INTEGER)')
                conn.execute('CREATE TABLE trade_positions (id INTEGER)')
                conn.execute("INSERT INTO app_settings VALUES ('admin_password_hash', 'test-admin')")
        self.registry = self.directory / 'registry.json'
        self.registry.write_text(json.dumps({'default_db': 'one.db', 'active_db': 'one.db', 'databases': {}}))
        for key, value in [('REPO_ROOT', str(self.directory)), ('DB_REGISTRY_FILE', str(self.registry)), ('DB_NAME', 'one.db')]:
            self.enterContext(patch.object(db, key, value))

    def test_switch_inspect_and_password_lookup_never_persist(self):
        before = file_hashes(self.directory)
        self.db.get_admin_password_hash()
        self.db.is_database_protected('two.db')
        self.db.switch_database('two.db')
        self.db.get_active_db_info()
        self.db.list_available_databases()
        self.assertEqual(before, file_hashes(self.directory))

    def test_protected_internal_settings_lookup_does_not_populate_registry(self):
        with closing(sqlite3.connect(self.directory / 'two.db')) as conn, conn:
            conn.execute("INSERT INTO app_settings VALUES ('db_password_hash', 'x')")
            conn.execute("INSERT INTO app_settings VALUES ('db_password_salt', '00')")
        before = file_hashes(self.directory)
        self.assertTrue(self.db.is_database_protected('two.db'))
        self.assertFalse(self.db.verify_database_password('two.db', 'incorrect'))
        self.assertEqual(before, file_hashes(self.directory))

    def test_module_reload_and_server_import_do_not_initialize_or_repair(self):
        before = file_hashes(self.directory)
        with patch.object(self.db, '_save_registry', side_effect=AssertionError('Import wrote registry')):
            # Source-level guarantee complements directory mutation tests without resetting patched globals.
            import ast
            module = ast.parse(Path(self.db.__file__).read_text())
            calls = [node.func.id for statement in module.body
                     if not isinstance(statement, (ast.FunctionDef, ast.ClassDef))
                     for node in ast.walk(statement)
                     if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)]
            self.assertNotIn('_save_registry', calls)
        import server
        with patch('models.schema.setup_database', side_effect=AssertionError('Startup initialized')):
            importlib.reload(server)
        self.assertEqual(before, file_hashes(self.directory))

    def test_readonly_connection_cannot_create_or_write(self):
        with self.assertRaises(sqlite3.OperationalError):
            with self.db.get_readonly_db_connection('missing.db'):
                pass
        self.assertFalse((self.directory / 'missing.db').exists())
        with self.db.get_readonly_db_connection() as conn:
            with self.assertRaises(sqlite3.OperationalError):
                conn.execute("INSERT INTO app_settings VALUES ('bad', 'bad')")

    def test_missing_default_connection_does_not_create_a_file(self):
        with patch.object(self.db, 'DB_NAME', 'finance.db'):
            before = file_hashes(self.directory)
            with self.assertRaisesRegex(self.db.DatabaseNotFoundError, 'does not exist.*initialize'):
                with self.db.get_db_connection():
                    pass
            self.assertFalse((self.directory / 'finance.db').exists())
            self.assertEqual(before, file_hashes(self.directory))

    def test_switch_to_missing_name_preserves_active_database_and_files(self):
        before = file_hashes(self.directory)
        active = self.db.DB_NAME
        with self.assertRaisesRegex(FileNotFoundError, 'does not exist'):
            self.db.switch_database('missing.db')
        self.assertEqual(self.db.DB_NAME, active)
        self.assertEqual(before, file_hashes(self.directory))

    def test_api_reads_and_switch_to_missing_database_never_create_files(self):
        from server import app
        client = app.test_client()
        before = file_hashes(self.directory)
        with patch.object(self.db, 'DB_NAME', 'finance.db'):
            for route in ('/api/dashboard', '/api/options', '/api/accounts', '/api/admin/migrations'):
                with self.subTest(route=route):
                    response = client.get(route)
                    self.assertEqual(response.status_code, 404)
                    self.assertIn('does not exist', response.get_json()['error'])
                    if route != '/api/admin/migrations':
                        self.assertIn('python -m models.schema', response.get_json()['error'])
                    self.assertEqual(before, file_hashes(self.directory))
            for confirm in (False, True):
                response = client.post('/api/admin/migrations/apply', json={'confirm': confirm})
                self.assertEqual(response.status_code, 404)
                self.assertIn('does not exist', response.get_json()['error'])
                self.assertEqual(before, file_hashes(self.directory))
        response = client.post('/api/database/switch', json={'filename': 'missing.db'})
        self.assertEqual(response.status_code, 404)
        self.assertEqual(before, file_hashes(self.directory))

    def test_wal_inspection_reads_latest_commit_without_touching_source_sidecars(self):
        target = self.directory / 'one.db'
        conn = sqlite3.connect(target)
        self.addCleanup(conn.close)
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('PRAGMA wal_autocheckpoint=0')
        conn.execute("INSERT INTO transactions VALUES (7)")
        conn.commit()
        before = file_hashes(self.directory)
        with self.db.get_readonly_db_connection('one.db') as reader:
            self.assertEqual(reader.execute('SELECT id FROM transactions').fetchone()[0], 7)
        self.db.switch_database('one.db')
        self.db.get_active_db_info()
        self.assertEqual(before, file_hashes(self.directory))

    def test_migration_backup_contains_uncheckpointed_wal_and_reopens(self):
        from models.schema import run_versioned_migrations
        target = self.directory / 'legacy.db'
        conn = sqlite3.connect(target)
        self.addCleanup(conn.close)
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('PRAGMA wal_autocheckpoint=0')
        conn.execute('CREATE TABLE sentinel (value TEXT)')
        conn.execute("INSERT INTO sentinel VALUES ('committed in WAL')")
        conn.commit()
        before = file_hashes(self.directory)
        self.assertEqual(run_versioned_migrations(str(target))['status'], 'confirmation_required')
        self.assertEqual(before, file_hashes(self.directory))
        result = run_versioned_migrations(str(target), user_confirmed=True)
        with closing(sqlite3.connect(result['backup_created'])) as backup:
            self.assertEqual(backup.execute('SELECT value FROM sentinel').fetchone()[0], 'committed in WAL')
            self.assertEqual(backup.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
