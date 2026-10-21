import { useState, useEffect } from 'react';
import { Modal } from './Modal';
import { Input, Select } from './FormControls';
import { formatCurrency, formatDate } from '../utils/helpers';
import { AlertCircle, Calendar, Layers, Check } from 'lucide-react';
import { closeOptionContract } from '../services/api';

export interface CloseOptionTarget {
  account_id: number;
  account_name: string;
  underlying: string;
  expiration: string;
  strike: number;
  opt_type: string;
  action: string;
  available_qty: number;
  strategy_name?: string;
  all_legs?: Array<{
    account_id: number;
    account_name: string;
    underlying: string;
    expiration: string;
    strike: number;
    opt_type: string;
    action: string;
    available_qty: number;
  }>;
}

interface CloseOptionModalProps {
  open: boolean;
  onClose: () => void;
  target: CloseOptionTarget | null;
  onSuccess: () => void;
}

export function CloseOptionModal({ open, onClose, target, onSuccess }: CloseOptionModalProps) {
  const [closeType, setCloseType] = useState<string>('Expired');
  const [closeDate, setCloseDate] = useState<string>('');
  const [quantity, setQuantity] = useState<number>(1);
  const [closePrice, setClosePrice] = useState<string>('0.00');
  const [fees, setFees] = useState<string>('0.00');
  const [notes, setNotes] = useState<string>('');
  const [closeAllLegs, setCloseAllLegs] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Initialize form when target changes or modal opens
  useEffect(() => {
    if (open && target) {
      // Default to today's date YYYY-MM-DD
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      
      // If expiration is in the past, default to expiration date or today
      setCloseDate(target.expiration && target.expiration <= todayStr ? target.expiration : todayStr);
      setQuantity(target.available_qty || 1);
      setCloseType('Expired');
      setClosePrice('0.00');
      setFees('0.00');
      setNotes('');
      setError(null);
      setCloseAllLegs(Boolean(target.all_legs && target.all_legs.length > 1));
    }
  }, [open, target]);

  if (!open || !target) return null;

  const isBTO = target.action.toUpperCase().includes('B'); // Long contract
  const hasMultipleLegs = Boolean(target.all_legs && target.all_legs.length > 1);

  const maxAvailable = (hasMultipleLegs && !closeAllLegs && target.all_legs?.[0])
    ? target.all_legs[0].available_qty
    : target.available_qty;

  // Calculate estimated cash impact
  const numPrice = parseFloat(closePrice) || 0;
  const numFees = parseFloat(fees) || 0;
  const numQty = quantity || 0;
  const grossProceeds = numPrice * numQty * 100;
  
  let netCashImpact = 0;
  if (closeType === 'Buy to Close') {
    netCashImpact = -(grossProceeds + numFees);
  } else if (closeType === 'Sell to Close') {
    netCashImpact = grossProceeds - numFees;
  } else if (closeType === 'Assigned' || closeType === 'Exercised') {
    netCashImpact = -numFees;
  } else {
    // Expired
    netCashImpact = 0;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!target) return;
    if (quantity <= 0) {
      setError('Quantity must be greater than 0');
      return;
    }
    if (quantity > maxAvailable) {
      setError(`Quantity cannot exceed available open ${hasMultipleLegs && closeAllLegs ? 'spreads' : 'contracts'} (${maxAvailable})`);
      return;
    }
    if (!closeDate) {
      setError('Please select a closing date');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      if (hasMultipleLegs && closeAllLegs && target.all_legs) {
        // Close each leg in the multi-leg strategy
        for (const leg of target.all_legs) {
          const legIsBTO = leg.action.toUpperCase().includes('B');
          let legCloseType = closeType;
          if (closeType === 'Buy to Close' || closeType === 'Sell to Close') {
            legCloseType = legIsBTO ? 'Sell to Close' : 'Buy to Close';
          } else if (closeType === 'Assigned' || closeType === 'Exercised') {
            legCloseType = legIsBTO ? 'Exercised' : 'Assigned';
          }
          await closeOptionContract({
            account_id: leg.account_id,
            underlying: leg.underlying,
            expiration: leg.expiration,
            strike: leg.strike,
            opt_type: leg.opt_type,
            close_type: legCloseType,
            close_date: closeDate,
            quantity: Math.min(quantity, leg.available_qty),
            close_price: numPrice,
            fees: numFees / target.all_legs.length,
            notes: notes ? `${notes} (Part of ${target.strategy_name || 'multi-leg'})` : ''
          });
        }
      } else {
        // Close single selected contract
        await closeOptionContract({
          account_id: target.account_id,
          underlying: target.underlying,
          expiration: target.expiration,
          strike: target.strike,
          opt_type: target.opt_type,
          close_type: closeType,
          close_date: closeDate,
          quantity: quantity,
          close_price: numPrice,
          fees: numFees,
          notes: notes
        });
      }

      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to close contract');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Close Option Contract">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Contract Summary Header */}
        <div className="p-3.5 rounded-xl bg-surface border border-border flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-text-primary text-base tracking-wide">
                {target.underlying} ${target.strike.toFixed(2)} {target.opt_type === 'C' ? 'Call' : 'Put'}
              </span>
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${
                isBTO ? 'bg-info-500/10 text-info-400 border border-info-500/20' : 'bg-warning-500/10 text-warning-400 border border-warning-500/20'
              }`}>
                {target.action}
              </span>
            </div>
            <div className="flex items-center gap-3 text-xs text-text-secondary mt-1">
              <span className="flex items-center gap-1">
                <Calendar size={12} className="text-text-muted" />
                Exp: {formatDate(target.expiration)}
              </span>
              <span className="border-l border-border pl-3 text-text-muted">
                {target.account_name}
              </span>
            </div>
          </div>

          <div className="text-right">
            <span className="text-[10px] text-text-muted uppercase tracking-wider block">Available</span>
            <span className="font-mono font-bold text-primary-400 text-sm">
              {maxAvailable} {hasMultipleLegs && closeAllLegs ? 'Spread' : 'Contract'}{maxAvailable !== 1 ? 's' : ''}
            </span>
          </div>
        </div>

        {/* Multi-leg Strategy Toggle (if applicable) */}
        {hasMultipleLegs && (
          <div className="p-3 rounded-xl bg-primary-500/5 border border-primary-500/20 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Layers size={15} className="text-primary-400" />
                <div>
                  <p className="text-xs font-semibold text-text-primary">
                    Close all legs of {target.strategy_name || 'Spread'}?
                  </p>
                  <p className="text-[11px] text-text-muted">
                    Closes all {target.all_legs?.length} legs synchronously on {closeDate || 'this date'}.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  const nextCloseAll = !closeAllLegs;
                  setCloseAllLegs(nextCloseAll);
                  const nextMax = (hasMultipleLegs && !nextCloseAll && target.all_legs?.[0])
                    ? target.all_legs[0].available_qty
                    : target.available_qty;
                  if (quantity > nextMax) setQuantity(nextMax);
                }}
                className={`w-9 h-5 rounded-full transition-colors relative flex items-center p-0.5 ${
                  closeAllLegs ? 'bg-primary-500' : 'bg-surface-lighter border border-border'
                }`}
              >
                <div
                  className={`w-4 h-4 rounded-full bg-white transition-transform ${
                    closeAllLegs ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            {target.all_legs && target.all_legs.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1 border-t border-primary-500/10">
                {target.all_legs.map((leg, idx) => (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-surface border border-border/60 text-[11px] font-medium text-text-secondary"
                  >
                    <span className={leg.action.includes('B') ? 'text-info-400 font-bold' : 'text-warning-400 font-bold'}>
                      {leg.action}
                    </span>
                    <span className="font-mono text-text-primary font-semibold">
                      {Number(leg.available_qty)}x
                    </span>
                    <span>
                      ${leg.strike} {leg.opt_type}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Form Controls */}
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Closing Reason"
            value={closeType}
            onChange={(e) => {
              const val = e.target.value;
              setCloseType(val);
              if (val === 'Expired') {
                setClosePrice('0.00');
              }
            }}
            options={[
              { value: 'Expired', label: 'Expired Worthless ($0.00)' },
              { value: isBTO ? 'Sell to Close' : 'Buy to Close', label: isBTO ? 'Sell to Close (Market Fill)' : 'Buy to Close (Market Fill)' },
              { value: isBTO ? 'Exercised' : 'Assigned', label: isBTO ? 'Exercised' : 'Assigned (Short Leg)' },
            ]}
          />

          <Input
            label="Closing Date"
            type="date"
            value={closeDate}
            onChange={(e) => setCloseDate(e.target.value)}
            required
          />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Input
            label={hasMultipleLegs && closeAllLegs ? "Spreads" : "Contracts"}
            type="number"
            min={1}
            max={maxAvailable}
            step={1}
            value={quantity}
            onChange={(e) => setQuantity(Math.min(maxAvailable, Math.max(1, parseInt(e.target.value) || 1)))}
            required
          />

          <Input
            label="Fill Price / Sh ($)"
            type="number"
            step="0.01"
            min="0.00"
            disabled={closeType === 'Expired'}
            value={closePrice}
            onChange={(e) => setClosePrice(e.target.value)}
          />

          <Input
            label="Broker Fees ($)"
            type="number"
            step="0.01"
            min="0.00"
            disabled={closeType === 'Expired'}
            value={fees}
            onChange={(e) => setFees(e.target.value)}
          />
        </div>

        <Input
          label="Notes (Optional)"
          type="text"
          placeholder="e.g. Manually closed prior to weekend earnings release"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        {/* Cash Settlement Preview */}
        <div className="p-3 rounded-xl bg-surface border border-border/70 flex items-center justify-between text-xs">
          <span className="text-text-secondary">Expected Cash Impact:</span>
          <span className={`font-mono font-bold ${
            netCashImpact > 0 ? 'text-success-400' : netCashImpact < 0 ? 'text-danger-400' : 'text-text-muted'
          }`}>
            {netCashImpact > 0 ? `+${formatCurrency(netCashImpact)} (Credit)` : netCashImpact < 0 ? `-${formatCurrency(Math.abs(netCashImpact))} (Debit)` : '$0.00'}
          </span>
        </div>

        {error && (
          <div className="p-3 rounded-xl bg-danger-500/10 border border-danger-500/30 flex items-center gap-2 text-danger-400 text-xs">
            <AlertCircle size={15} />
            <span>{error}</span>
          </div>
        )}

        {/* Modal Actions */}
        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 rounded-xl text-text-secondary hover:text-text-primary hover:bg-surface transition-colors text-sm font-medium cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 rounded-xl bg-primary-500 hover:bg-primary-600 text-white font-medium text-sm transition-colors flex items-center gap-1.5 shadow-lg shadow-primary-500/20 cursor-pointer disabled:opacity-50"
          >
            {submitting ? (
              <span>Closing...</span>
            ) : (
              <>
                <Check size={16} />
                <span>Confirm Close</span>
              </>
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}
