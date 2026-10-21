"""Invented accounting examples, independent of private reference packs."""
from isolated_support import IsolatedTestCase
from decimal import Decimal


class TestSyntheticAccounting(IsolatedTestCase):
    def test_display_allocation_conserves_headline(self):
        from services.options import allocate_display_cents
        values = {'left': Decimal('1.005'), 'right': Decimal('2.005')}
        self.assertEqual(sum(allocate_display_cents(values, Decimal('3.01')).values()), Decimal('3.01'))

    def test_empty_display_allocation(self):
        from services.options import allocate_display_cents
        self.assertEqual(allocate_display_cents({}, 0), {})

    def test_partial_closes_use_each_event_date(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        import models.database as db
        from models.schema import setup_database
        from services.options import process_option_trade, get_options_analysis
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as directory:
            with patch.object(db, 'DB_NAME', str(Path(directory)/'synthetic.db')):
                setup_database()
                with db.get_db_connection() as conn:
                    user = conn.execute('SELECT id FROM users LIMIT 1').fetchone()[0]
                    inst = conn.execute("INSERT INTO institutions(name) VALUES ('Synthetic institution')").lastrowid
                    acc = conn.execute("INSERT INTO accounts(user_id,institution_id,name,type) VALUES(?,?,?,'investment')",
                                       (user,inst,'Synthetic brokerage')).lastrowid
                for day,amount,action,quantity in [('2032-01-02',62,'Sell to Open',2),
                                                  ('2032-01-30',-7,'Buy to Close',1),
                                                  ('2032-02-02',-11,'Buy to Close',1)]:
                    description=f'Sym: ZZXQ 03/19/2032 17 C | Qty: {quantity}'
                    with db.get_db_connection() as conn:
                        tx=conn.execute('INSERT INTO transactions(account_id,date,amount,category,description) VALUES(?,?,?,?,?)',
                                        (acc,day,amount,action,description)).lastrowid
                    process_option_trade(tx,acc,description,action,amount)
                result=get_options_analysis([acc],as_of_date='2032-02-03')
                totals={}
                for event in result['matched_events']:
                    totals[event.close_date]=totals.get(event.close_date,Decimal(0))+event.realized_pl
                self.assertEqual(totals,{'2032-01-30':Decimal(24),'2032-02-02':Decimal(20)})
                self.assertEqual(result['portfolio']['closed_realized_pl'],44)
