"""Invented issue scenarios; no private reference data or fixed database IDs."""
from isolated_support import IsolatedTestCase
import hashlib
import json
from pathlib import Path
import tempfile
from unittest.mock import patch

from services.option_issues import IssueCollector, contract_scope


class TestIssueIdentity(IsolatedTestCase):
    def test_identity_ignores_messages_and_normalizes_scope(self):
        a, b = IssueCollector(), IssueCollector()
        a.add('possible_duplicate', 'first wording', account_ids=[9, 8, 9], transaction_ids=[5, 4],
              contract=contract_scope('ZZXQ', '2032-03-19', '17.00', 'C'))
        b.add('possible_duplicate', 'renamed accounts and wording', account_ids=[8, 9], transaction_ids=[4, 5, 4],
              contract=contract_scope('ZZXQ', '2032-03-19', 17, 'C'))
        self.assertEqual(a.as_list()[0]['issue_id'], b.as_list()[0]['issue_id'])
        self.assertTrue(a.as_list()[0]['dismissible'])

    def test_deduplication_retains_messages_and_unlinked_pairs_rank_first(self):
        c = IssueCollector()
        c.add('possible_duplicate', 'linked', account_ids=[1], transaction_ids=[2, 3])
        c.add('possible_duplicate', 'unlinked', account_ids=[1], transaction_ids=[4, 5], details={'has_unlinked_leg': True})
        c.add('possible_duplicate', 'another observation', account_ids=[1], transaction_ids=[4, 5])
        rows = c.as_list()
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['legacy_messages'], ['unlinked', 'another observation'])


class TestIssueReadModel(IsolatedTestCase):
    def setUp(self):
        import models.database as db
        from models.schema import setup_database
        self.db = db
        self.tmp = tempfile.TemporaryDirectory(dir=Path.cwd())
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)/'invented.db'
        self.enterContext(patch.object(db, 'DB_NAME', str(self.path)))
        setup_database()
        with db.get_db_connection() as conn:
            user = conn.execute('SELECT id FROM users LIMIT 1').fetchone()[0]
            inst = conn.execute("INSERT INTO institutions(name) VALUES ('Invented institution')").lastrowid
            self.accounts = [conn.execute("INSERT INTO accounts(user_id,institution_id,name,type) VALUES(?,?,?,'investment')",
                                         (user, inst, name)).lastrowid for name in ('Invented alpha', 'Invented beta')]

    def trade(self, action, amount, *, account=None, quantity=1, linked=True,
              symbol='ZZXQ', date='2032-01-02', expiration='03/19/2032', extra=''):
        from services.options import process_option_trade
        account = account or self.accounts[0]
        desc = f'Sym: {symbol} {expiration} 17 C | Qty: {quantity} | Price: 0.31 | Fees: 0.00{extra}'
        with self.db.get_db_connection() as conn:
            tx = conn.execute('INSERT INTO transactions(account_id,date,amount,category,description) VALUES(?,?,?,?,?)',
                              (account, date, amount, action, desc)).lastrowid
        if linked:
            self.assertTrue(process_option_trade(tx, account, desc, action, amount))
        return tx

    def portfolio(self, accounts=None, date='2032-02-01'):
        from services.options import get_options_portfolio
        return get_options_portfolio(accounts, as_of_date=date)

    def test_empty_portfolio_has_empty_issues(self):
        self.assertEqual(self.portfolio()['issues'], [])

    def test_orphan_and_duplicate_have_distinct_nondestructive_scopes(self):
        orphan = self.trade('Sell to Open', 31, linked=False)
        linked = self.trade('Sell to Open', 31, account=self.accounts[1])
        p = self.portfolio()
        by_kind = {x['kind']: x for x in p['issues']}
        self.assertEqual(by_kind['unlinked_option_trade']['transaction_ids'], [orphan])
        pair = by_kind['possible_duplicate']
        self.assertEqual(pair['transaction_ids'], sorted([orphan, linked]))
        self.assertTrue(pair['details']['has_unlinked_leg'])
        self.assertIn('Possible duplicate', pair['message'])
        self.assertFalse(by_kind['unlinked_option_trade']['dismissible'])
        self.assertTrue(p['data_quality_warnings'])

    def test_existing_dismissal_setting_hides_only_duplicate_issue(self):
        a = self.trade('Sell to Open', 31, linked=False)
        b = self.trade('Sell to Open', 31, account=self.accounts[1])
        with self.db.get_db_connection() as conn:
            conn.execute('INSERT INTO app_settings(key,value) VALUES (?,?)',
                         (f'dismissed_duplicate_pair:{min(a,b)}:{max(a,b)}', 'dismissed'))
        kinds = {x['kind'] for x in self.portfolio()['issues']}
        self.assertIn('unlinked_option_trade', kinds)
        self.assertNotIn('possible_duplicate', kinds)

    def test_account_filter_excludes_unrelated_issues(self):
        self.trade('Buy to Close', -7, account=self.accounts[1])
        self.assertEqual(self.portfolio([self.accounts[0]])['issues'], [])
        self.assertTrue(self.portfolio([self.accounts[1]])['issues'])

    def test_partial_overclose_identifies_closing_row_and_excess_quantity(self):
        self.trade('Sell to Open', 31)
        close = self.trade('Buy to Close', -14, quantity=2, date='2032-01-05')
        issue = next(x for x in self.portfolio()['issues'] if x['kind'] == 'unmatched_close')
        self.assertEqual(issue['transaction_ids'], [close])
        self.assertEqual(float(issue['details']['quantity']), 1)
        self.assertFalse(issue['dismissible'])

    def test_past_expiration_is_awaiting_confirmation_not_confirmed_expired(self):
        tx = self.trade('Sell to Open', 31, expiration='01/16/2032')
        p = self.portfolio()
        issue = next(x for x in p['issues'] if x['kind'] == 'awaiting_expiration_confirmation')
        self.assertEqual(issue['transaction_ids'], [tx])
        self.assertEqual(p['closed_realized_pl'], 0)
        self.assertEqual(p['total_past_expiration_pl'], 31)

    def test_unknown_basis_is_disclosed_after_transferred_contract_closes(self):
        opening = self.trade('Security Transfer', 0)
        closing = self.trade('Buy to Close', -7, date='2032-01-05')
        p = self.portfolio()
        issue = next(x for x in p['issues'] if x['kind'] == 'unknown_transfer_basis')
        self.assertEqual(issue['details']['scope'], 'matched_close')
        self.assertEqual(issue['transaction_ids'], sorted([opening, closing]))
        self.assertEqual(p['closed_realized_pl'], -7)

    def test_read_is_stable_readonly_and_only_adds_issues(self):
        self.trade('Buy to Close', -7)
        before = hashlib.sha256(self.path.read_bytes()).hexdigest()
        result = self.portfolio()
        self.assertEqual(result, self.portfolio())
        json.dumps(result, allow_nan=False)
        self.assertEqual(hashlib.sha256(self.path.read_bytes()).hexdigest(), before)
        with patch.object(IssueCollector, 'add'):
            without_issues = self.portfolio()
        result.pop('issues'); without_issues.pop('issues')
        self.assertEqual(result, without_issues)

    def test_transfer_diagnostics_cover_open_basis_duplicates_and_excess(self):
        a = self.trade('Security Transfer', 0, quantity=-1)
        b = self.trade('Security Transfer', 0, quantity=-1)
        issues = self.portfolio()['issues']
        duplicate = next(x for x in issues if x['kind'] == 'possible_duplicate_transfer')
        self.assertEqual(duplicate['transaction_ids'], sorted([a, b]))
        self.assertFalse(duplicate['dismissible'])
        self.assertTrue(any(x['kind'] == 'unknown_transfer_basis' for x in issues))
        self.trade('Sell to Open', 31, symbol='ZZYQ')
        excess = self.trade('Security Transfer', 0, quantity=3, symbol='ZZYQ', date='2032-01-05')
        issue = next(x for x in self.portfolio()['issues'] if x['kind'] == 'transfer_out_exceeds_inventory')
        self.assertEqual(issue['transaction_ids'], [excess])
        self.assertEqual(float(issue['details']['excess_quantity']), 2)

    def test_manual_transfer_quantity_mismatch_is_structured(self):
        manual = self.trade('Sell to Open', 31, extra=' | Manual Open')
        transfer = self.trade('Security Transfer', 0, quantity=-2, date='2032-01-05')
        issue = next(x for x in self.portfolio()['issues'] if x['kind'] == 'transfer_quantity_mismatch')
        self.assertEqual(issue['transaction_ids'], sorted([manual, transfer]))

    def test_same_day_inference_is_not_lost(self):
        a = self.trade('Sell to Open', 31)
        b = self.trade('Buy to Close', -7)
        issue = next(x for x in self.portfolio()['issues'] if x['kind'] == 'same_day_match_inferred')
        self.assertEqual(issue['transaction_ids'], sorted([a, b]))
        self.assertEqual(issue['severity'], 'info')
        self.trade('Buy to Close', -9, symbol='ZZYQ')
        issues = self.portfolio()['issues']
        self.assertEqual(issues[0]['severity'], 'warning')
        self.assertEqual(issues[-1]['severity'], 'info')

    def test_recorded_zero_basis_does_not_become_unknown_transfer_basis(self):
        self.trade('Sell to Open', 0)
        self.trade('Buy to Close', -7, date='2032-01-05')
        self.assertNotIn('unknown_transfer_basis', [x['kind'] for x in self.portfolio()['issues']])

    def test_api_exposes_additive_issues_and_keeps_legacy_warning_array(self):
        from server import app
        self.trade('Buy to Close', -7)
        response = app.test_client().get('/api/options?as_of_date=2032-02-01')
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body['issues'], self.portfolio()['issues'])
        self.assertIsInstance(body['data_quality_warnings'], list)

    def test_issue_api_partial_cash_provenance_and_account_type_filters(self):
        from server import app
        self.trade('Sell to Open', 31)
        closing = self.trade('Buy to Close', -14, quantity=2, date='2032-01-05')
        self.trade('Buy to Close', -9, account=self.accounts[1])
        before = hashlib.sha256(self.path.read_bytes()).hexdigest()
        client = app.test_client()
        query = f'/api/options/issues?account_ids={self.accounts[0]}&type=unmatched_close&as_of_date=2032-02-01'
        response = client.get(query)
        self.assertEqual(response.status_code, 200, response.get_json())
        body = response.get_json()
        self.assertEqual(body['count'], 1)
        row = body['issues'][0]
        self.assertEqual(row['signed_cash'], '-7.00')
        self.assertEqual(float(row['quantity']), 1)
        self.assertEqual(row['provenance'][0]['transaction_id'], closing)
        self.assertEqual(row['provenance'][0]['signed_cash'], '-14.00')
        self.assertEqual(row['provenance'][0]['source'], 'recorded_transaction')
        self.assertIn('Delete transaction in Trade Positions', row['available_actions'])
        self.assertEqual(body, client.get(query).get_json())
        self.assertEqual(hashlib.sha256(self.path.read_bytes()).hexdigest(), before)

    def test_issue_api_rejects_bad_filters_and_does_not_mutate(self):
        from server import app
        before = hashlib.sha256(self.path.read_bytes()).hexdigest()
        for query in ('account_ids=0', 'account_ids=1,x', 'account_ids=',
                      'type=not_a_type', 'type=', 'as_of_date=2032-99-01'):
            response = app.test_client().get('/api/options/issues?' + query)
            self.assertEqual(response.status_code, 400, query)
        empty = app.test_client().get('/api/options/issues?type=unmatched_close').get_json()
        self.assertEqual(empty['issues'], [])
        self.assertEqual(hashlib.sha256(self.path.read_bytes()).hexdigest(), before)

    def test_issue_api_multi_type_and_import_filename(self):
        from server import app
        orphan = self.trade('Buy to Close', -9, linked=False)
        with self.db.get_db_connection() as conn:
            imported = conn.execute("INSERT INTO imported_files(file_hash,filename) VALUES(?,?)",
                                    ('invented-hash', 'C:\\invented\\synthetic.csv')).lastrowid
            conn.execute('UPDATE transactions SET imported_file_id=? WHERE id=?', (imported, orphan))
        result = app.test_client().get('/api/options/issues?type=unlinked_option_trade,possible_duplicate').get_json()
        row = result['issues'][0]
        self.assertEqual(row['signed_cash'], '-9.00')
        self.assertEqual(row['provenance'][0]['filename'], 'synthetic.csv')
        self.assertEqual(row['provenance'][0]['source'], 'broker_import')

    def test_issue_api_includes_zero_cash_terminal_excess(self):
        from server import app
        self.trade('Sell to Open', 31, quantity=3)
        self.trade('Buy to Close', -8, quantity=2, date='2032-01-05')
        expired = self.trade('Expired', 0, quantity=2, date='2032-03-19')
        response = app.test_client().get('/api/options/issues?type=unmatched_close&as_of_date=2032-03-20')
        self.assertEqual(response.status_code, 200)
        row = response.get_json()['issues'][0]
        self.assertEqual(row['transaction_ids'], [expired])
        self.assertEqual(row['signed_cash'], '0.00')
        self.assertEqual(float(row['quantity']), 1)

    def test_issue_api_missing_database_is_an_error_without_creation(self):
        from server import app
        missing = self.path.with_name('missing.db')
        with patch.object(self.db, 'DB_NAME', str(missing)):
            response = app.test_client().get('/api/options/issues')
        self.assertEqual(response.status_code, 404)
        self.assertIn('does not exist', response.get_json()['error'])
        self.assertFalse(missing.exists())

    def test_issue_cash_is_scoped_to_contract_when_one_row_has_multiple_legs(self):
        from server import app
        self.trade('Sell to Open', 31)
        closing = self.trade('Buy to Close', -20, quantity=4, date='2032-01-05')
        with self.db.get_db_connection() as conn:
            position = conn.execute('SELECT position_id FROM option_legs WHERE transaction_id=?', (closing,)).fetchone()[0]
            conn.execute('UPDATE option_legs SET quantity=2 WHERE transaction_id=?', (closing,))
            conn.execute('''INSERT INTO option_legs(transaction_id,position_id,expiration_date,strike_price,option_type,action,quantity)
                            VALUES(?,?,'2032-03-19',19,'C','BTC',2)''', (closing, position))
        result = app.test_client().get('/api/options/issues?type=unmatched_close&as_of_date=2032-02-01').get_json()
        cash = {row['contract']['strike']: row['signed_cash'] for row in result['issues']}
        self.assertEqual(cash, {'17': '-5.00', '19': '-10.00'})
