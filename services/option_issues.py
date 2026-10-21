"""Read-only reconciliation diagnostics. No persistence or accounting decisions."""
import hashlib
import json
from decimal import Decimal


def contract_scope(underlying, expiration, strike, option_type):
    return {
        'underlying': underlying,
        'expiration': expiration,
        'strike': format(Decimal(str(strike)).normalize(), 'f'),
        'option_type': option_type,
    }


class IssueCollector:
    """Stable identities use database-local entities, not warning text or cash."""

    def __init__(self):
        self._issues = {}

    def add(self, kind, message, *, account_ids, transaction_ids=(), position_id=None,
            contract=None, details=None, severity='warning'):
        if kind == 'same_day_match_inferred':
            severity = 'info'
        scope = dict(kind=kind, account_ids=sorted(set(account_ids)),
                     transaction_ids=sorted(set(x for x in transaction_ids if x is not None)),
                     position_id=position_id, contract=contract)
        identity = json.dumps(scope, sort_keys=True, separators=(',', ':'))
        key = 'option-issue-v1:' + hashlib.sha256(identity.encode('utf-8')).hexdigest()
        if key not in self._issues:
            self._issues[key] = dict(
                issue_id=key, schema_version=1, **scope, severity=severity,
                message=message, legacy_messages=[], details=dict(details or {}),
                # Describes the existing warning-setting capability, not deletion.
                dismissible=(kind == 'possible_duplicate' and len(scope['transaction_ids']) == 2),
            )
        item = self._issues[key]
        if message not in item['legacy_messages']:
            item['legacy_messages'].append(message)

    def as_list(self):
        # Put pairs with an unlinked leg first, as in the legacy warning list.
        return sorted(self._issues.values(), key=lambda x: (
            1 if x['severity'] == 'info' else 0,
            0 if x['details'].get('has_unlinked_leg') else 1,
            x['kind'], x['account_ids'], x['transaction_ids'], x['issue_id'],
        ))
