"""Invented CSVs characterize the endpoint used by the Accounts import button."""
from isolated_support import IsolatedTestCase
import io
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


class TestAccountCSVImport(IsolatedTestCase):
    def setUp(self):
        import models.database as db
        import server
        from models.schema import setup_database
        self.db=db;self.server=server
        temp=tempfile.TemporaryDirectory(dir=Path.cwd());self.addCleanup(temp.cleanup)
        self.directory=Path(temp.name)
        self.enterContext(patch.object(db,'DB_NAME',str(self.directory/'invented.db')))
        self.enterContext(patch.object(db,'DB_REGISTRY_FILE',str(self.directory/'registry.json')))
        setup_database()
        with db.get_db_connection() as conn:
            user=conn.execute('SELECT id FROM users LIMIT 1').fetchone()[0]
            bank=conn.execute("INSERT INTO institutions(name) VALUES ('Invented bank')").lastrowid
            self.accounts=[conn.execute("INSERT INTO accounts(user_id,institution_id,name,type) VALUES(?,?,?,'checking')",(user,bank,n)).lastrowid for n in ('Invented selected','Invented other')]
        directory=self.directory
        class Paths:
            def __getattr__(self,n):return getattr(os.path,n)
            def join(self,base,*args):return os.path.join(str(directory) if base=='/tmp' else base,*args)
            def exists(self,path):return True if path=='/tmp' else os.path.exists(path)
        self.enterContext(patch.object(server,'os',SimpleNamespace(path=Paths(),remove=os.remove,makedirs=os.makedirs)))
        self.client=server.app.test_client()

    def upload(self,body):
        return self.client.post('/api/transactions/import',data={
            'account_id':str(self.accounts[0]),'file':(io.BytesIO(body),'invented.csv')},content_type='multipart/form-data')

    def test_selected_account_balance_history_and_duplicate_rejection(self):
        csv=b'Date,Amount,Category,Description,Account Name\n2034-01-02,84.12,Deposit,Invented credit,Ignored CSV account\n2034-01-03,-13.17,Purchase,Invented debit,Ignored CSV account\n'
        result=self.upload(csv)
        self.assertEqual(result.status_code,200,result.get_json())
        accounts={a['id']:a for a in self.client.get('/api/accounts').get_json()}
        self.assertAlmostEqual(accounts[self.accounts[0]]['balance'],70.95)
        self.assertEqual(accounts[self.accounts[1]]['balance'],0)
        with self.db.get_db_connection() as conn:
            rows=conn.execute('SELECT account_id FROM transactions').fetchall()
            self.assertEqual([r[0] for r in rows],[self.accounts[0]]*2)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM accounts').fetchone()[0],2)
        history=self.client.get('/api/imports').get_json()
        self.assertEqual(len(history),1)
        self.assertEqual(history[0]['filename'],'invented.csv')
        duplicate=self.upload(csv)
        self.assertEqual(duplicate.status_code,400)
        self.assertIn('Duplicate',duplicate.get_json()['error'])
        with self.db.get_db_connection() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM transactions').fetchone()[0],2)

    def test_invalid_csv_has_clear_error_and_no_transactions(self):
        result=self.upload(b'Description,Other\nNot a transaction,1\n')
        self.assertEqual(result.status_code,400)
        self.assertIn('Missing columns',result.get_json()['error'])
        with self.db.get_db_connection() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM transactions').fetchone()[0],0)
