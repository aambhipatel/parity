"""Internal cash-basis event contract. Not a market valuation or a public API."""
from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True)
class MatchedOptionEvent:
    account_id: int
    position_id: int
    underlying: str
    expiration: str
    strike: Decimal
    option_type: str
    open_action: str
    opening_transaction_id: int
    closing_transaction_id: int
    open_date: str
    close_date: str
    quantity: Decimal
    open_cash: Decimal
    close_cash: Decimal
    opening_fees: Decimal
    closing_fees: Decimal
    realized_pl: Decimal
    close_kind: str
    basis_status: str
    same_day_inferred: bool


def matched_event(position, event):
    """Copy values now, before the legacy JSON adapter converts legs to floats."""
    opening, closing = event['open_leg'], event['close_leg']
    quantity = event['closed_qty']
    open_cash = event['open_unit_cash'] * quantity
    close_cash = event['close_unit_cash'] * quantity

    def allocated_fee(leg, cash):
        # Cash ratios survive split-adjusted quantities. Zero-cash legs use quantity.
        amount = Decimal(str(leg['amount']))
        ratio = abs(cash / amount) if amount else quantity / Decimal(str(leg['quantity'] or 1))
        return Decimal(str(leg['fees'])) * ratio

    category = str(closing.get('category', '')).lower()
    kind = ('assigned' if 'assign' in category else
            'exercised' if 'exercis' in category else
            'expired' if 'expir' in category or event['close_action'] in ('EXP', 'EXPIRED') else 'closed')
    unknown = event.get('is_transfer', False) and not event.get('is_confirmed_transfer', False) and not open_cash
    return MatchedOptionEvent(
        position['account_id'], position['id'], position['underlying'], event['exp'],
        Decimal(str(event['strike'])), event['type'], event['open_action'], opening['transaction_id'], closing['transaction_id'],
        event['open_date'], event['close_date'], quantity, open_cash, close_cash,
        allocated_fee(opening, open_cash), allocated_fee(closing, close_cash),
        event['realized_pl'], kind, 'unknown_transfer_basis' if unknown else 'recorded_basis',
        event['same_day_inferred'],
    )
