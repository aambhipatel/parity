"""FIFO position processing extracted mechanically from the characterized engine.

Mutates only the supplied in-memory position. No database or market-data access.
Legacy contract aggregation and dates are intentionally preserved.
"""
import re
from datetime import datetime
from decimal import Decimal
from utils.logger import logger


def process_position(pos, as_of_date, orphan_underlyings, *, issues=None):
    pos['realized_pl'] = Decimal('0.0')
    pos['unrealized_pl'] = Decimal('0.0')
    pos['past_expiration_pl'] = Decimal('0.0')
    pos['cost_basis']  = Decimal('0.0')
    pos['sub_strategies'] = []
    pos['warnings'] = []
    pos['warning'] = None
    position_warnings = []
    token_warnings = {}
    all_transfer_rows = []

    def emit(kind, message, legs, token, **details):
        if issues is not None:
            from services.option_issues import contract_scope
            issues.add(kind, message, account_ids=[pos['account_id']], position_id=pos['id'],
                       transaction_ids=[l.get('transaction_id') for l in legs],
                       contract=contract_scope(pos['underlying'], *token), details=details)

    def _get_eff_date(d):
        s = str(d or '').strip()
        if ' as of ' in s:
            return s.split(' as of ')[-1].strip()
        return s

    from datetime import datetime
    today_str = datetime.now().strftime('%Y-%m-%d')
    pos_latest_date = max((_get_eff_date(l['date']) for l in pos['legs']), default=today_str)
    if as_of_date:
        cutoff_date = as_of_date
    else:
        cutoff_date = max(today_str, pos_latest_date)

    orig_leg_index = {id(l): idx for idx, l in enumerate(pos['legs'])}

    def _get_sort_priority(leg):
        act = str(leg.get('action', '')).upper()
        cat = str(leg.get('category', '')).lower()
        desc = str(leg.get('description', '')).lower()
        is_trf = act in ('TRANSFER', 'TRANSFER_IN', 'TRANSFER_OUT') or 'transfer' in cat or 'transfer' in desc
        if act in ('BTO', 'STO'):
            return 0
        if is_trf:
            return 1
        if act in ('SPLIT', 'FORWARD_SPLIT', 'REVERSE_SPLIT'):
            return 2
        return 3 # STC, BTC, EXPIRED, ASSIGNMENT, ASSIGNED, EXERCISE, etc.

    # Intraday sort: Opens (BTO/STO=0) -> Transfers (1) -> Splits (SPLIT=2) -> Closes (STC/BTC/EXP=3) on the same date.
    # Uses the effective event date (the date after 'as of') if 'as of' is present.
    sorted_legs = sorted(
        pos['legs'],
        key=lambda l: (
            _get_eff_date(l['date']),
            _get_sort_priority(l),
            l.get('timestamp', ''),
            l.get('transaction_id', 0)
        )
    )

    # FIFO inventory: (token, open_action) → [{'qty', 'unit_cash', 'leg', 'open_date'}, ...]
    inventory = {}
    realized_events = []   # completed lot records used for closed clustering
    transferred_events = [] # transferred lot records
    unmatched_close_legs = [] # unmatched closes / orphan expirations

    for leg in sorted_legs:
        action   = leg['action'].upper()
        qty      = leg['quantity']
        amount   = leg['amount']
        exp      = leg['expiration']
        strike   = leg['strike']
        opt_type = leg['type']
        token    = (exp, strike, opt_type)

        # Broker Action Type Mapping
        # Map non-standard actions to standard closes/opens for FIFO engine
        is_exp_event = (
            action in ('EXPIRED', 'EXPIRATION', 'REMOVAL', 'EXP') or 
            'expired' in leg.get('category', '').lower()
        )
        if is_exp_event:
            sto_qty = sum(l['qty'] for l in inventory.get((token, 'STO'), []))
            bto_qty = sum(l['qty'] for l in inventory.get((token, 'BTO'), []))

            if sto_qty > Decimal('0.001') and bto_qty > Decimal('0.001'):
                # Both queues are open simultaneously for this exact token
                # 1. Match exact quantity if one queue matches and the other does not
                if abs(sto_qty - qty) < Decimal('0.001') and abs(bto_qty - qty) >= Decimal('0.001'):
                    action = 'BTC'
                elif abs(bto_qty - qty) < Decimal('0.001') and abs(sto_qty - qty) >= Decimal('0.001'):
                    action = 'STC'
                # 2. Honor explicit broker action direction if present
                elif leg['action'].upper() == 'BTC':
                    action = 'BTC'
                elif leg['action'].upper() == 'STC':
                    action = 'STC'
                # 3. Default to short position (STO) as short options carry assignment obligation
                else:
                    action = 'BTC'
            elif sto_qty > Decimal('0.001'):
                action = 'BTC'
            elif bto_qty > Decimal('0.001'):
                action = 'STC'
            else:
                action = 'BTC' if leg['action'].upper() == 'BTC' else 'STC'
        elif action in ('ASSIGNMENT', 'ASSIGNED'):
            action = 'BTC' # Assignments close STO positions
        elif action in ('EXERCISE', 'EXERCISED'):
            action = 'STC' # Exercises close BTO positions
        elif action in ('STC', 'BTC'):
            # Resilient FIFO queue matching: if expected open queue is empty but opposing queue is open for this token
            expected_open = 'BTO' if action == 'STC' else 'STO'
            opposing_open = 'STO' if expected_open == 'BTO' else 'BTO'
            if (token, expected_open) not in inventory or sum(l['qty'] for l in inventory[(token, expected_open)]) < Decimal('0.001'):
                if (token, opposing_open) in inventory and sum(l['qty'] for l in inventory[(token, opposing_open)]) > Decimal('0.001'):
                    flipped_action = 'BTC' if opposing_open == 'STO' else 'STC'
                    logger.warning(
                        f"[FIFO] Close direction mismatch for {pos['underlying']} {token}: "
                        f"requested {action} against empty {expected_open} queue, redirected to active {opposing_open} queue ({flipped_action})."
                    )
                    action = flipped_action
                    leg['direction_reconciled'] = True

        unit_cash = amount / qty if qty else Decimal('0.0')

        if action in ('BTO', 'STO'):
            # ── Opening leg ─────────────────────────────────────────────
            open_act = action
            inv_key = (token, open_act)
            eff_open_date = _get_eff_date(leg['date'])
            had_prior = any(l['open_date'] < eff_open_date for l in inventory.get(inv_key, []))
            inventory.setdefault(inv_key, []).append({
                'qty':       qty,
                'unit_cash': unit_cash,
                'leg':       leg,
                'open_date': eff_open_date,
                'original_strike': strike,
                'original_token': token,
                'orig_idx':  orig_leg_index.get(id(leg), 0),
                'had_prior_inventory': had_prior
            })

        elif action in ('SPLIT', 'FORWARD_SPLIT', 'REVERSE_SPLIT'):
            # ── Corporate Action / Stock Split Adjustment ───────────────
            # Re-keys existing open lot(s) in place to the new post-split contract identity.
            # Computes split ratio R = old_strike / new_strike, scales contract quantity by R,
            # rounds non-integer contract quantities to whole contracts, and adjusts unit cash
            # preserving exact total cost basis.
            new_strike_dec = Decimal(str(strike))

            # Find matching open keys with same expiration and option type but pre-split strike
            matching_keys = [
                k for k in list(inventory.keys())
                if k[0][0] == exp and k[0][2] == opt_type and abs(Decimal(str(k[0][1])) - new_strike_dec) > Decimal('0.001')
                and sum(l['qty'] for l in inventory[k]) > Decimal('0.001')
            ]

            for old_key in matching_keys:
                old_token, open_action = old_key
                old_strike_dec = Decimal(str(old_token[1]))
                split_ratio = old_strike_dec / new_strike_dec

                old_lots = inventory.pop(old_key)
                old_open_qty = sum(l['qty'] for l in old_lots)
                split_delta = qty
                if split_delta > Decimal('0.001') and old_open_qty > Decimal('0.001'):
                    implied_new_qty = old_open_qty + split_delta
                    qty_ratio = implied_new_qty / old_open_qty
                    if abs(qty_ratio - split_ratio) > Decimal('0.05'):
                        logger.warning(
                            f"[FIFO] Split ratio divergence for {pos['underlying']} {old_token} -> {new_strike_dec}: "
                            f"Strike ratio={split_ratio:.4f} vs Quantity delta ratio={qty_ratio:.4f} "
                            f"(Delta={split_delta}, Old Qty={old_open_qty}). Prioritizing strike ratio."
                        )

                new_token = (exp, float(new_strike_dec), opt_type)
                new_inv_key = (new_token, open_action)

                for lot in old_lots:
                    old_qty = lot['qty']
                    new_qty = old_qty * split_ratio

                    # Handle fractional contract quantities (e.g. 3 contracts on 1:5 reverse split = 0.6)
                    rem = new_qty % Decimal('1')
                    if rem > Decimal('0.0001') and rem < Decimal('0.9999'):
                        rounded_qty = Decimal(str(int(round(new_qty))))
                        logger.warning(
                            f"[FIFO] Fractional contract quantity {new_qty} for {pos['underlying']} {open_action} "
                            f"on split adjustment (Ratio: {split_ratio}). Rounded to {rounded_qty} whole contract(s)."
                        )
                        lot['fractional_remainder'] = float(new_qty - rounded_qty)
                        new_qty = rounded_qty

                    if new_qty > Decimal('0.001'):
                        new_unit_cash = (lot['unit_cash'] * old_qty) / new_qty
                    else:
                        new_unit_cash = Decimal('0.0')

                    lot['qty'] = new_qty
                    lot['unit_cash'] = new_unit_cash
                    lot['split_adjusted'] = True
                    lot['split_ratio'] = float(split_ratio)

                    if new_qty > Decimal('0.001'):
                        inventory.setdefault(new_inv_key, []).append(lot)

                logger.info(
                    f"[FIFO] Corporate action split adjustment on {pos['underlying']}: "
                    f"re-keyed {old_token} -> {new_token} (Split Ratio: {split_ratio}, "
                    f"New Open Qty: {sum(l['qty'] for l in inventory.get(new_inv_key, []))})"
                )

        elif action in ('STC', 'BTC'):
            # ── Closing leg — drain opposing FIFO queue ──────────────────
            open_action = 'BTO' if action == 'STC' else 'STO'
            inv_key     = (token, open_action)

            remaining = qty
            lots      = inventory.get(inv_key, [])
            new_lots  = []
            eff_close_date = _get_eff_date(leg['date'])
            close_orig_idx = orig_leg_index.get(id(leg), 0)

            for lot in lots:
                if remaining <= Decimal('0.0'):
                    new_lots.append(lot)
                    continue

                match_qty  = min(lot['qty'], remaining)
                open_cash  = lot['unit_cash'] * match_qty
                close_cash = unit_cash        * match_qty

                # Realized P/L = net of opening credit/debit + closing credit/debit
                realized_pl_lot = open_cash + close_cash
                pos['realized_pl'] += realized_pl_lot

                same_day = (lot['open_date'] == eff_close_date)
                is_same_day_inferred = same_day and (
                    close_orig_idx < lot.get('orig_idx', 0) or
                    not lot.get('had_prior_inventory', False)
                )

                realized_events.append({
                    'token':           token,
                    'exp':             exp,
                    'strike':          strike,
                    'type':            opt_type,
                    'open_action':     open_action,
                    'close_action':    action,
                    'closed_qty':      match_qty,
                    'open_unit_cash':  lot['unit_cash'],
                    'close_unit_cash': unit_cash,
                    'realized_pl':     realized_pl_lot,
                    'close_date':      eff_close_date,
                    'open_date':       lot['open_date'],
                    'open_leg':        lot['leg'],
                    'close_leg':       leg,
                    'same_day_inferred': is_same_day_inferred,
                    'is_transfer': lot.get('is_transfer', False),
                    'is_confirmed_transfer': lot.get('is_confirmed_transfer', False),
                })

                remaining  -= match_qty
                lot['qty'] -= match_qty
                if lot['qty'] > Decimal('0.001'):
                    new_lots.append(lot)

            inventory[inv_key] = new_lots

            if remaining > Decimal('0.001'):
                logger.warning(
                    f"[FIFO] Close overflow {remaining:.2f} for "
                    f"{pos['underlying']} {token} ({action}) — missing BTO/STO?"
                )
                unmatched_close_legs.append({
                    'leg': leg,
                    'unmatched_qty': float(remaining),
                    'action': action,
                    'token': token
                })

        elif action in ('TRANSFER', 'TRANSFER_IN', 'TRANSFER_OUT') or 'transfer' in leg.get('category', '').lower() or 'transfer' in action.lower():
            # ── Security Transfer event ──
            # A security transfer can be:
            # 1. OUTGOING: Drains active inventory without realizing P/L (no economic closing trade occurred).
            # 2. INCOMING: Establishes open inventory at $0 cost basis (e.g. ACAT incoming position transfer).
            eff_date = _get_eff_date(leg['date'])
            desc_lower = str(leg.get('description', '')).lower()
            cat_lower = str(leg.get('category', '')).lower()
            notes_lower = str(leg.get('notes', '')).lower()
            is_explicit_out = (
                'out' in cat_lower or 'outgoing' in cat_lower or 'removal' in cat_lower or
                'out' in desc_lower or 'outgoing' in desc_lower or 'removal' in desc_lower
            )

            qty_m = re.search(r"Qty:\s*(-?[\d\.]+)", str(leg.get('description', '')))
            raw_qty = float(qty_m.group(1)) if qty_m else ( -float(qty) if action == 'TRANSFER_OUT' else float(qty) )
            remaining = qty

            # ── Transfer Confirmation of Existing Manual Lots ───────────
            # Rule 3a: When a transfer row arrives for a token that already has an open
            # manual/user-entered lot with matching quantity and direction, treat the
            # transfer as confirming that lot (keep its user-entered cost basis, mark it transferred),
            # not as an outgoing drain plus a new $0 lot. A user-entered basis must never be replaced by $0.
            transfer_open_action = 'STO' if raw_qty < 0 else 'BTO'
            manual_lots = [
                l for l in inventory.get((token, transfer_open_action), [])
                if l['qty'] > Decimal('0.001') and (
                    'manual open' in str(l['leg'].get('description', '')).lower() or
                    'manual' in str(l['leg'].get('description', '')).lower()
                )
            ]
            manual_qty = sum(l['qty'] for l in manual_lots)

            if manual_qty > Decimal('0.001'):
                if abs(manual_qty - remaining) < Decimal('0.001'):
                    # (i) Manual lot + matching transfer = one lot with the manual basis
                    for l in manual_lots:
                        l['is_transfer'] = True
                        l['is_confirmed_transfer'] = True
                        l['leg']['is_transfer'] = True
                    all_transfer_rows.append({
                        'token': token,
                        'eff_date': eff_date,
                        'qty': remaining,
                        'raw_qty': raw_qty,
                        'action': action,
                        'description': leg.get('description', ''),
                        'category': leg.get('category', ''),
                        'amount': leg.get('amount', 0),
                        'transaction_id': leg.get('transaction_id'),
                        'direction': 'IN',
                        'leg': leg
                    })
                    logger.info(
                        f"[FIFO] Security transfer for {pos['underlying']} {token} confirmed "
                        f"existing manual open lot ({manual_qty:g} contracts) keeping manual basis."
                    )
                    continue
                else:
                    # (iii) Manual lot of different quantity than the transfer = flagged "quantity mismatch"
                    mismatch_msg = f"Quantity mismatch with transferred position (Manual: {manual_qty:g}, Transfer: {remaining:g})"
                    emit('transfer_quantity_mismatch', mismatch_msg, [leg] + [l['leg'] for l in manual_lots], token,
                         manual_quantity=str(manual_qty), transfer_quantity=str(remaining))
                    logger.warning(f"[FIFO] {mismatch_msg} for {pos['underlying']} {token}.")
                    if mismatch_msg not in position_warnings:
                        position_warnings.append(mismatch_msg)
                    if mismatch_msg not in token_warnings.setdefault(token, []):
                        token_warnings[token].append(mismatch_msg)
                    for l in manual_lots:
                        l['is_transfer'] = True
                        l['leg']['is_transfer'] = True
                    all_transfer_rows.append({
                        'token': token,
                        'eff_date': eff_date,
                        'qty': remaining,
                        'raw_qty': raw_qty,
                        'action': action,
                        'description': leg.get('description', ''),
                        'category': leg.get('category', ''),
                        'amount': leg.get('amount', 0),
                        'transaction_id': leg.get('transaction_id'),
                        'direction': 'IN',
                        'leg': leg
                    })
                    continue

            # Check which lots in inventory are eligible to be drained by this transfer.
            # A lot is drainable if:
            # 1. It is not a manual open lot created specifically for unmatched close reconciliation.
            # 2. AND either:
            #    - It was opened on an earlier date (open_date < eff_date), OR
            #    - It was opened by a regular trade (not is_transfer, e.g. BTO/STO), OR
            #    - This transfer row is explicitly marked as OUT.
            # Lots created by incoming transfers on the SAME date are NOT drained by another transfer on the same date.
            def _is_drainable(l):
                if 'manual open' in str(l['leg'].get('description', '')).lower():
                    return False
                if is_explicit_out:
                    return True
                if not l.get('is_transfer'):
                    return True
                return l.get('open_date') < eff_date

            sto_lots = inventory.get((token, 'STO'), [])
            bto_lots = inventory.get((token, 'BTO'), [])

            drainable_sto_qty = sum(l['qty'] for l in sto_lots if l['qty'] > Decimal('0.001') and _is_drainable(l))
            drainable_bto_qty = sum(l['qty'] for l in bto_lots if l['qty'] > Decimal('0.001') and _is_drainable(l))

            target_queues = []
            if drainable_sto_qty > Decimal('0.001') and drainable_bto_qty <= Decimal('0.001'):
                # Only STO inventory exists -> drain STO regardless of transfer sign
                target_queues = [('STO', (token, 'STO'))]
            elif drainable_bto_qty > Decimal('0.001') and drainable_sto_qty <= Decimal('0.001'):
                # Only BTO inventory exists -> drain BTO regardless of transfer sign
                target_queues = [('BTO', (token, 'BTO'))]
            elif drainable_sto_qty > Decimal('0.001') and drainable_bto_qty > Decimal('0.001'):
                # Both queues have active drainable inventory:
                if abs(drainable_sto_qty - remaining) < Decimal('0.001') and abs(drainable_bto_qty - remaining) >= Decimal('0.001'):
                    target_queues = [('STO', (token, 'STO')), ('BTO', (token, 'BTO'))]
                elif abs(drainable_bto_qty - remaining) < Decimal('0.001') and abs(drainable_sto_qty - remaining) >= Decimal('0.001'):
                    target_queues = [('BTO', (token, 'BTO')), ('STO', (token, 'STO'))]
                elif raw_qty < 0:
                    target_queues = [('STO', (token, 'STO')), ('BTO', (token, 'BTO'))]
                else:
                    target_queues = [('BTO', (token, 'BTO')), ('STO', (token, 'STO'))]
            else:
                target_queues = []

            drained_any = False
            for open_action, inv_key in target_queues:
                if remaining <= Decimal('0.0'):
                    break
                lots = inventory.get(inv_key, [])
                new_lots = []
                for lot in lots:
                    if remaining <= Decimal('0.0'):
                        new_lots.append(lot)
                        continue
                    if not _is_drainable(lot):
                        new_lots.append(lot)
                        continue

                    match_qty = min(lot['qty'], remaining)
                    drained_any = True

                    transferred_events.append({
                        'token':           token,
                        'exp':             exp,
                        'strike':          strike,
                        'type':            opt_type,
                        'open_action':     open_action,
                        'transfer_action': action,
                        'transferred_qty': match_qty,
                        'open_unit_cash':  lot['unit_cash'],
                        'open_date':       lot['open_date'],
                        'transfer_date':   eff_date,
                        'open_leg':        lot['leg'],
                        'transfer_leg':    leg,
                    })

                    remaining  -= match_qty
                    lot['qty'] -= match_qty
                    if lot['qty'] > Decimal('0.001'):
                        new_lots.append(lot)

                inventory[inv_key] = new_lots

            if drained_any:
                all_transfer_rows.append({
                    'token': token,
                    'eff_date': eff_date,
                    'qty': qty,
                    'raw_qty': raw_qty,
                    'action': action,
                    'description': leg.get('description', ''),
                    'category': leg.get('category', ''),
                    'amount': leg.get('amount', 0),
                    'transaction_id': leg.get('transaction_id'),
                    'direction': 'OUT',
                    'leg': leg
                })

                # If any inventory was drained, this was an outgoing transfer.
                # Excess quantity beyond open inventory must NOT create a phantom incoming lot.
                if remaining > Decimal('0.001'):
                    excess_msg = "Transfer out exceeded available inventory"
                    emit('transfer_out_exceeds_inventory', excess_msg, [leg], token, excess_quantity=str(remaining))
                    logger.warning(
                        f"[FIFO] {excess_msg} by {remaining} for "
                        f"{pos['underlying']} {token}. Excess transfer quantity discarded."
                    )
                    if excess_msg not in position_warnings:
                        position_warnings.append(excess_msg)
                    if excess_msg not in token_warnings.setdefault(token, []):
                        token_warnings[token].append(excess_msg)
            else:
                REISSUE_PATTERN = re.compile(
                    r'\b(reissue|re-issue|duplicate|corrected|correction|adjusted|adjustment|void|reversal|cancel|canceled|cancelled|amended|superseded)\b',
                    re.IGNORECASE
                )

                matching_prev_rows = [
                    r for r in all_transfer_rows
                    if r['token'] == token and r['eff_date'] == eff_date and abs(r['qty'] - remaining) < Decimal('0.001')
                ]

                if matching_prev_rows:
                    prev = matching_prev_rows[-1]
                    has_reissue_signal = (
                        bool(REISSUE_PATTERN.search(desc_lower)) or
                        bool(REISSUE_PATTERN.search(cat_lower)) or
                        (leg.get('transaction_id') is not None and prev.get('transaction_id') is not None and leg['transaction_id'] == prev['transaction_id'])
                    )

                    if has_reissue_signal:
                        logger.info(
                            f"[FIFO] Duplicate re-issue transfer row for {pos['underlying']} {token} on {eff_date} ignored (re-issue signal found)."
                        )
                        continue
                    else:
                        dup_msg = "Possible duplicate transfer row, verify quantity"
                        emit('possible_duplicate_transfer', dup_msg, [prev['leg'], leg], token)
                        if dup_msg not in position_warnings:
                            position_warnings.append(dup_msg)
                        if dup_msg not in token_warnings.setdefault(token, []):
                            token_warnings[token].append(dup_msg)

                        if prev.get('direction') == 'OUT':
                            logger.info(
                                f"[FIFO] Duplicate outgoing transfer row for {pos['underlying']} {token} on {eff_date} recorded without open lot."
                            )
                            all_transfer_rows.append({
                                'token': token,
                                'eff_date': eff_date,
                                'qty': remaining,
                                'raw_qty': raw_qty,
                                'action': action,
                                'description': leg.get('description', ''),
                                'category': leg.get('category', ''),
                                'amount': leg.get('amount', 0),
                                'transaction_id': leg.get('transaction_id'),
                                'direction': 'OUT',
                                'leg': leg
                            })
                            continue

                # Check explicit removal or transfer OUT of untracked position
                if is_explicit_out:
                    logger.info(
                        f"[FIFO] Explicit transfer OUT for untracked position {pos['underlying']} {token} recorded without open lot."
                    )
                    all_transfer_rows.append({
                        'token': token,
                        'eff_date': eff_date,
                        'qty': remaining,
                        'raw_qty': raw_qty,
                        'action': action,
                        'description': leg.get('description', ''),
                        'category': leg.get('category', ''),
                        'amount': leg.get('amount', 0),
                        'transaction_id': leg.get('transaction_id'),
                        'direction': 'OUT',
                        'leg': leg
                    })
                    continue

                # Genuine INCOMING position transfer (e.g. ACAT incoming transfer) establishing inventory at $0 basis.
                open_act = 'STO' if raw_qty < 0 else 'BTO'
                inv_key = (token, open_act)
                leg_copy = dict(leg)
                leg_copy['is_transfer'] = True
                had_prior = any(l['open_date'] < eff_date for l in inventory.get(inv_key, []))
                inventory.setdefault(inv_key, []).append({
                    'qty':             remaining,
                    'unit_cash':       Decimal('0.0'),
                    'leg':             leg_copy,
                    'open_date':       eff_date,
                    'original_strike': strike,
                    'original_token':  token,
                    'is_transfer':     True,
                    'orig_idx':        orig_leg_index.get(id(leg), 0),
                    'had_prior_inventory': had_prior
                })
                all_transfer_rows.append({
                    'token': token,
                    'eff_date': eff_date,
                    'qty': remaining,
                    'raw_qty': raw_qty,
                    'action': action,
                    'description': leg.get('description', ''),
                    'category': leg.get('category', ''),
                    'amount': leg.get('amount', 0),
                    'transaction_id': leg.get('transaction_id'),
                    'direction': 'IN',
                    'leg': leg
                })
                logger.info(
                    f"[FIFO] Security transfer for {pos['underlying']} {token} added to open inventory ({open_act} Qty: {remaining})."
                )

    # ─── Note: Auto-Expiration Removed ──────────────────────────────────────
    # Previously, a calendar-based auto-expiration pass would close any open
    # inventory whose expiration date <= today, assuming the option expired
    # worthless (close_cash = $0).  This was INCORRECT because:
    #   1. It realized P/L for positions that may have been assigned/exercised
    #      (not expired worthless), producing wrong amounts.
    #   2. It counted proceeds from positions the user has not yet imported a
    #      closing transaction for, overstating realized P/L.
    # Now, only CSV-driven actions (BTC, STC, EXPIRED, ASSIGNMENT, etc.) at
    # line ~464 above trigger realized P/L.  Any open inventory that has
    # passed its expiration date but lacks an explicit close row will flow
    # into the "open clusters" below and show as unrealized / still-open.

    # Recalculate cost basis as the sum of remaining open contracts in inventory
    for (token, open_action), lots in inventory.items():
        for lot in lots:
            if lot['qty'] > Decimal('0.001'):
                pos['cost_basis'] += abs(lot['unit_cash'] * lot['qty'])
    # ─── Individual Option Contract Pairing ─────────────────────────────
    # Instead of artificially merging legs into complex multi-leg strategies
    # (Iron Condors, Spreads, Straddles), each contract (Expiration, Strike, Type, Action)
    # is tracked as its own individual trade, pairing its opens with its matching closes.

    # --- 1. Open Contracts (from inventory) ---
    for (token, open_action), lots in sorted(inventory.items(), key=lambda x: (x[0][0][0], x[0][0][1])):
        remaining_qty = sum(l['qty'] for l in lots if l['qty'] > Decimal('0.001'))
        if remaining_qty < Decimal('0.001'):
            continue

        exp, strike, opt_type = token
        action_label = "Short" if open_action == 'STO' else "Long"
        opt_word = "Call" if opt_type == 'C' else "Put"
        strike_str = f"{float(strike):g}"
        trade_name = f"{action_label} ${strike_str} {opt_word}"

        cluster_legs = []
        for lot in lots:
            if lot['qty'] < Decimal('0.001'):
                continue
            live_leg = dict(lot['leg'])
            live_leg['expiration'] = exp
            live_leg['strike'] = float(strike)
            live_leg['type'] = opt_type
            live_leg['action'] = open_action
            live_leg['quantity'] = lot['qty']
            live_leg['amount'] = lot['unit_cash'] * lot['qty']
            live_leg['split_adjusted'] = lot.get('split_adjusted', False)
            live_leg['is_transfer'] = lot.get('is_transfer', False)
            live_leg['is_confirmed_transfer'] = lot.get('is_confirmed_transfer', False)
            cluster_legs.append(live_leg)

        net_cash_flow = sum(l['amount'] for l in cluster_legs)
        is_past_exp = (exp < cutoff_date)

        # Detect transferred legs (warning only appears on lots originating from a transfer)
        sub_warnings = []
        if is_past_exp:
            sub_warnings.append("Past expiration, awaiting broker confirmation")
            emit('awaiting_expiration_confirmation', sub_warnings[-1], cluster_legs, token,
                 quantity=str(remaining_qty))

        has_confirmed_transfer = any(
            lot.get('is_confirmed_transfer') for lot in lots if lot['qty'] >= Decimal('0.001')
        ) or any(l.get('is_confirmed_transfer') for l in cluster_legs)
        has_transfer_lot = has_confirmed_transfer or any(
            lot.get('is_transfer') for lot in lots if lot['qty'] >= Decimal('0.001')
        ) or any(
            l.get('is_transfer') or
            'transfer' in str(l.get('category', '')).lower() or
            'transfer' in str(l.get('action', '')).lower() or
            'transfer' in str(l.get('description', '')).lower() or
            'acat' in str(l.get('description', '')).lower()
            for l in cluster_legs
        )
        if has_confirmed_transfer:
            sub_warnings.append("Transferred position (basis from manual lot)")
        elif has_transfer_lot:
            has_zero_basis = any(
                (l.get('is_transfer') or 'transfer' in str(l.get('category', '')).lower() or 'transfer' in str(l.get('action', '')).lower() or 'transfer' in str(l.get('description', '')).lower())
                and abs(Decimal(str(l.get('amount', 0) or 0))) < Decimal('0.0001')
                for l in cluster_legs
            )
            if has_zero_basis:
                msg = "Transferred position, no cost basis"
                emit('unknown_transfer_basis', msg, cluster_legs, token,
                     scope='open_inventory', quantity=str(remaining_qty), basis_status='unknown_transfer_basis')
                sub_warnings.append(msg)
                if msg not in position_warnings:
                    position_warnings.append(msg)
            else:
                sub_warnings.append("Transferred position")

        for tw in token_warnings.get(token, []):
            if tw not in sub_warnings:
                sub_warnings.append(tw)

        warning = ", ".join(sub_warnings) if sub_warnings else None

        if is_past_exp:
            sub_status = 'Past Expiration'
            sub_unrealized = Decimal('0.0')
            sub_past_exp_pl = net_cash_flow
            pos['past_expiration_pl'] += net_cash_flow
            position_warnings.append("Past expiration, awaiting broker confirmation")
        else:
            sub_status = 'Open'
            sub_unrealized = net_cash_flow
            sub_past_exp_pl = Decimal('0.0')
            pos['unrealized_pl'] += sub_unrealized

        pos['sub_strategies'].append({
            'name':               trade_name,
            'expiration':         exp,
            'expirations':        [exp],
            'status':             sub_status,
            'realized_pl':        Decimal('0.0'),
            'unrealized_pl':      sub_unrealized,
            'past_expiration_pl': sub_past_exp_pl,
            'open_qty':           remaining_qty,
            'legs':               cluster_legs,
            'strike':             float(strike),
            'opt_type':           opt_type,
            'action':             open_action,
            'warning':            warning,
        })

    # --- 2. Closed Contracts: grouped by (exp, strike, opt_type, open_action) ---
    closed_by_contract = {}
    for ev in realized_events:
        exp = ev['exp']
        strike = ev['strike']
        opt_type = ev['type']
        open_action = ev['open_action']
        key = (exp, strike, opt_type, open_action)
        if key not in closed_by_contract:
            closed_by_contract[key] = {
                'pl': Decimal('0.0'),
                'legs': [],
                'leg_ids': set(),
                'exp': exp,
                'strike': strike,
                'opt_type': opt_type,
                'open_action': open_action,
                'same_day_inferred': False,
            }
        c = closed_by_contract[key]
        c['pl'] += ev['realized_pl']
        if ev.get('same_day_inferred'):
            c['same_day_inferred'] = True
        for lg in (ev['open_leg'], ev['close_leg']):
            if id(lg) not in c['leg_ids']:
                c['legs'].append(lg)
                c['leg_ids'].add(id(lg))

    for key, c in sorted(closed_by_contract.items(), key=lambda x: (x[0][0], x[0][1])):
        exp, strike, opt_type, open_action = key
        action_label = "Short" if open_action == 'STO' else "Long"
        opt_word = "Call" if opt_type == 'C' else "Put"
        strike_str = f"{float(strike):g}"
        trade_name = f"{action_label} ${strike_str} {opt_word}"

        sorted_legs = sorted(c['legs'], key=lambda l: (l['date'], l.get('id', 0)))
        c_warning = "Same-day match inferred" if c.get('same_day_inferred') else None
        if c_warning:
            emit('same_day_match_inferred', c_warning, sorted_legs, (exp, strike, opt_type))

        pos['sub_strategies'].append({
            'name':               trade_name,
            'expiration':         exp,
            'expirations':        [exp],
            'status':             'Closed',
            'close_date':         sorted_legs[-1]['date'] if sorted_legs else exp,
            'realized_pl':        c['pl'],
            'unrealized_pl':      Decimal('0.0'),
            'past_expiration_pl': Decimal('0.0'),
            'open_qty':           Decimal('0.0'),
            'legs':               sorted_legs,
            'strike':             float(strike),
            'opt_type':           opt_type,
            'action':             open_action,
            'warning':            c_warning,
        })

    # --- 3. Transferred Contracts: grouped by (exp, strike, opt_type, open_action) ---
    transferred_by_contract = {}
    for ev in transferred_events:
        exp = ev['exp']
        strike = ev['strike']
        opt_type = ev['type']
        open_action = ev['open_action']
        key = (exp, strike, opt_type, open_action)
        if key not in transferred_by_contract:
            transferred_by_contract[key] = {
                'legs': [],
                'leg_ids': set(),
                'exp': exp,
                'strike': strike,
                'opt_type': opt_type,
                'open_action': open_action,
                'qty': Decimal('0.0')
            }
        t = transferred_by_contract[key]
        t['qty'] += ev['transferred_qty']
        for lg in (ev['open_leg'], ev['transfer_leg']):
            if id(lg) not in t['leg_ids']:
                t['legs'].append(lg)
                t['leg_ids'].add(id(lg))

    for key, t in sorted(transferred_by_contract.items(), key=lambda x: (x[0][0], x[0][1])):
        exp, strike, opt_type, open_action = key
        action_label = "Short" if open_action == 'STO' else "Long"
        opt_word = "Call" if opt_type == 'C' else "Put"
        strike_str = f"{float(strike):g}"
        trade_name = f"{action_label} ${strike_str} {opt_word} (Transferred)"

        sorted_legs = sorted(t['legs'], key=lambda l: (l['date'], l.get('id', 0)))
        is_zero = all(abs(Decimal(str(l.get('amount', 0) or 0))) < Decimal('0.0001') for l in t['legs'])
        sub_warnings = []
        if is_zero:
            sub_warnings.append("Transferred position, no cost basis")
            emit('unknown_transfer_basis', sub_warnings[-1], sorted_legs, (exp, strike, opt_type),
                 scope='transferred_out', basis_status='unknown_transfer_basis')
        else:
            sub_warnings.append("Transferred position")
        token_for_transferred = (exp, strike, opt_type)
        for tw in token_warnings.get(token_for_transferred, []):
            if tw not in sub_warnings:
                sub_warnings.append(tw)
        warning = ", ".join(sub_warnings) if sub_warnings else None

        pos['sub_strategies'].append({
            'name':               trade_name,
            'expiration':         exp,
            'expirations':        [exp],
            'status':             'Transferred Out',
            'realized_pl':        Decimal('0.0'),
            'unrealized_pl':      Decimal('0.0'),
            'past_expiration_pl': Decimal('0.0'),
            'open_qty':           Decimal('0.0'),
            'legs':               sorted_legs,
            'strike':             float(strike),
            'opt_type':           opt_type,
            'action':             open_action,
            'warning':            warning,
        })

    for u in unmatched_close_legs:
        emit('unmatched_close', 'Closes with no opening trade in imported history (excluded from realized P/L)',
             [u['leg']], u['token'], quantity=str(u['unmatched_qty']))
        action_label = "Expired" if 'expired' in u['leg'].get('category', '').lower() or u['leg']['action'].upper() in ('EXPIRED', 'EXP') else u['action']
        pos['sub_strategies'].append({
            'name':               f"Unmatched {action_label} (Needs Review)",
            'bucket':             "Closes with no opening trade in imported history",
            'expiration':         u['token'][0],
            'expirations':        [u['token'][0]],
            'status':             'Open',
            'realized_pl':        Decimal('0.0'),
            'unrealized_pl':      Decimal('0.0'),
            'past_expiration_pl': Decimal('0.0'),
            'open_qty':           Decimal(str(u['unmatched_qty'])),
            'legs':               [u['leg']],
            'strike':             float(u['token'][1]),
            'opt_type':           u['token'][2],
            'action':             u['action'],
            'is_unmatched':       True,
            'transaction_id':     u['leg'].get('transaction_id'),
            'warning':            'Closes with no opening trade in imported history (excluded from realized P/L)',
        })

    # Sort: open first, then past expiration, then closed/transferred; then expiration ascending, strike ascending
    pos['sub_strategies'].sort(
        key=lambda s: (
            0 if s['status'] == 'Open' else (1 if s['status'] == 'Past Expiration' else 2),
            s['expiration'],
            s.get('strike', 0)
        )
    )

    has_open_contracts = any(s['status'] == 'Open' for s in pos['sub_strategies'])
    has_past_exp_contracts = any(s['status'] == 'Past Expiration' for s in pos['sub_strategies'])
    pos['has_past_expiration'] = has_past_exp_contracts
    if has_open_contracts or has_past_exp_contracts:
        pos['status'] = 'Open'
    elif any(s['status'] == 'Transferred Out' for s in pos['sub_strategies']) and not any(s['status'] == 'Closed' for s in pos['sub_strategies']):
        pos['status'] = 'Transferred Out'
    else:
        pos['status'] = 'Closed'

    if pos['underlying'] in orphan_underlyings:
        for ot, dup in orphan_underlyings[pos['underlying']]:
            dup_warn = f"Orphan duplicate transaction #{ot['id']} in {ot['account_name']} detected; excluded from calculations"
            if dup_warn not in position_warnings:
                position_warnings.append(dup_warn)

    active_count = len([s for s in pos['sub_strategies'] if s['status'] in ('Open', 'Past Expiration')])
    pos['strategy'] = f"{active_count} Active Trade{'s' if active_count != 1 else ''}"
    pos['warnings'] = list(dict.fromkeys(position_warnings))
    pos['warning'] = "; ".join(pos['warnings']) if pos['warnings'] else None


    return realized_events, transferred_events
