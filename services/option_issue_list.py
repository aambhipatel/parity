"""Read-only presentation of reconciliation issues; never resolves a transaction."""
from decimal import Decimal, ROUND_HALF_UP
from pathlib import PureWindowsPath
import re

from models.database import get_readonly_db_connection
from services.options import get_options_portfolio


ISSUE_TYPES = (
    'unlinked_option_trade', 'possible_duplicate', 'unmatched_close',
    'awaiting_expiration_confirmation', 'unknown_transfer_basis',
    'transfer_quantity_mismatch', 'transfer_out_exceeds_inventory',
    'possible_duplicate_transfer', 'same_day_match_inferred',
)


def money(value):
    return format(value.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP), '.2f')


def get_option_issue_list(account_ids=None, issue_types=None, as_of_date=None):
    portfolio = get_options_portfolio(account_ids, as_of_date=as_of_date)
    issues = portfolio['issues']
    if issue_types:
        issues = [i for i in issues if i['kind'] in issue_types]
    ids = sorted({tid for issue in issues for tid in issue['transaction_ids']})
    records = {}
    # Parameterized batches stay below SQLite's variable limit for large histories.
    with get_readonly_db_connection() as conn:
        for start in range(0, len(ids), 400):
            batch = ids[start:start + 400]
            rows = conn.execute('''
                SELECT t.*, a.name AS account_name, f.filename AS imported_filename,
                       (SELECT SUM(ABS(l.quantity)) FROM option_legs l
                        WHERE l.transaction_id=t.id) AS leg_quantity
                FROM transactions t JOIN accounts a ON a.id=t.account_id
                LEFT JOIN imported_files f ON f.id=t.imported_file_id
                WHERE t.id IN (''' + ','.join('?' for _ in batch) + ')', batch)
            records.update({row['id']: dict(row) for row in rows})
    output = []
    for issue in issues:
        provenance = []
        for tid in issue['transaction_ids']:
            row = records.get(tid)
            if row is None:
                provenance.append(dict(transaction_id=tid, source='unavailable'))
                continue
            qty = row['leg_quantity']
            if qty is None:
                match = re.search(r'Qty:\s*(-?[\d.]+)', row['description'] or '')
                qty = abs(Decimal(match.group(1))) if match else None
            filename = row['imported_filename']
            source = 'broker_import' if filename else 'recorded_transaction'
            # No import link is not proof of manual origin.
            provenance.append(dict(
                transaction_id=tid, account_id=row['account_id'], account_name=row['account_name'],
                date=row['date'], category=row['category'], source=source,
                filename=PureWindowsPath(filename).name if filename else None,
                quantity=str(qty) if qty is not None else None,
                signed_cash=money(Decimal(str(row['amount']))),
            ))
        signed_cash = None
        cash_scope = 'Referenced transaction cash is shown below; it is not realized P/L.'
        if issue['kind'] == 'unmatched_close':
            # Use the existing accounting read model's allocated cash, not full row cash.
            cash = Decimal('0')
            found = False
            for position in portfolio['positions']:
                if position['id'] != issue['position_id']:
                    continue
                for sub in position['sub_strategies']:
                    if not sub.get('is_unmatched'):
                        continue
                    contract = issue['contract']
                    if (sub.get('expiration') != contract['expiration']
                            or Decimal(str(sub.get('strike'))) != Decimal(contract['strike'])
                            or sub.get('opt_type') != contract['option_type']):
                        continue
                    for leg in sub['legs']:
                        if leg.get('transaction_id') in issue['transaction_ids']:
                            qty = Decimal(str(leg.get('quantity', 1) or 1))
                            cash += Decimal(str(leg.get('amount', 0) or 0)) * (
                                Decimal(str(sub.get('open_qty', 0) or 0)) / qty if qty > 0 else 1)
                            found = True
            signed_cash = money(cash) if found else None
            cash_scope = 'Unmatched portion only; excluded from realized P/L.'
        elif issue['kind'] == 'unlinked_option_trade' and len(provenance) == 1:
            signed_cash = provenance[0].get('signed_cash')
            cash_scope = 'Unlinked transaction cash; not realized P/L.'
        actions = []
        if issue['kind'] == 'unmatched_close':
            actions = ['Match opening trade in Trade Positions', 'Delete transaction in Trade Positions']
        elif issue['kind'] == 'awaiting_expiration_confirmation':
            actions = ['Review broker confirmation', 'Manual close in Trade Positions']
        elif issue['kind'] != 'same_day_match_inferred':
            actions = ['Review source transactions']
        output.append(dict(issue, signed_cash=signed_cash, cash_scope=cash_scope,
                           quantity=issue['details'].get('quantity', issue['details'].get('excess_quantity')),
                           provenance=provenance, available_actions=actions))
    return dict(issues=output, count=len(output), available_types=list(ISSUE_TYPES))
