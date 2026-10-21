import React, { useState, useEffect, useMemo } from 'react';
import { Modal } from './Modal';
import { Input, Select } from './FormControls';
import { formatCurrency, formatDate } from '../utils/helpers';
import {
  Link2,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Calendar,
  Layers,
  RefreshCw,
  PlusCircle,
  HelpCircle,
  FileText,
  Trash2,
  Info,
  Split
} from 'lucide-react';
import {
  getMatchCandidates,
  matchOptionContract,
  type MatchCandidatesResponse,
  type MatchOptionPayload,
  type CandidateOpenLot,
  type MissingOpenLot
} from '../services/api';

export interface MatchOptionTarget {
  transactionId: number;
  underlying: string;
  expiration: string;
  strike: number;
  optType: string;
  action: string;
  quantity: number;
  date: string;
  description?: string;
  accountId?: number;
  accountName?: string;
}

interface MatchOptionModalProps {
  open: boolean;
  onClose: () => void;
  target: MatchOptionTarget | null;
  onSuccess: () => void;
}

export function MatchOptionModal({ open, onClose, target, onSuccess }: MatchOptionModalProps) {
  const [activeTab, setActiveTab] = useState<'reconcile' | 'create_open' | 'link'>('reconcile');
  const [loading, setLoading] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<MatchCandidatesResponse | null>(null);

  // Direction confirmation state (Bug 2)
  const [confirmedOpenAction, setConfirmedOpenAction] = useState<'BTO' | 'STO'>('STO');
  const [mediumConfirmed, setMediumConfirmed] = useState<boolean>(false);

  // Reconcile mode state
  const [selectedManualIds, setSelectedManualIds] = useState<number[]>([]);

  // Link Open Leg multi-lot allocation state (Bug 1)
  // Map of lot key (leg_id or index) -> allocated quantity
  const [allocatedQuantities, setAllocatedQuantities] = useState<Record<number, number>>({});
  const [customStrike, setCustomStrike] = useState<string>('');
  const [customExp, setCustomExp] = useState<string>('');
  const [customType, setCustomType] = useState<string>('C');

  // Create Open mode multi-lot state (Bug 1 & 2)
  const [openLots, setOpenLots] = useState<MissingOpenLot[]>([]);

  // Load candidates whenever target opens
  useEffect(() => {
    if (!open || !target) {
      setCandidates(null);
      setSelectedManualIds([]);
      setAllocatedQuantities({});
      setOpenLots([]);
      setMediumConfirmed(false);
      setError(null);
      return;
    }

    let isMounted = true;
    setLoading(true);
    setError(null);

    // Initial default open lot
    const closeDt = new Date(target.date || Date.now());
    const priorDt = new Date(closeDt.getTime() - 7 * 24 * 60 * 60 * 1000);
    const priorStr = priorDt.toISOString().slice(0, 10);

    getMatchCandidates(target.transactionId)
      .then((res) => {
        if (!isMounted) return;
        setCandidates(res);

        // Set confirmed direction from audited inference (Bug 2)
        const inferredOpen = res.direction_inference?.inferred_open_action || 'STO';
        setConfirmedOpenAction(inferredOpen);

        // Initialize single open lot with inferred action
        setOpenLots([
          {
            open_date: priorStr,
            open_price: 0,
            open_action: inferredOpen,
            quantity: target.quantity || 1,
            fees: 0,
            notes: '',
          },
        ]);

        // Auto-select tab based on candidates
        const exactManuals = (res.candidate_manual_closes || []).filter((m) => m.is_exact_match);
        if (exactManuals.length > 0) {
          setSelectedManualIds(exactManuals.map((m) => m.transaction_id));
          setActiveTab('reconcile');
        } else if ((res.candidate_manual_closes || []).length > 0) {
          setSelectedManualIds([res.candidate_manual_closes[0].transaction_id]);
          setActiveTab('reconcile');
        } else if ((res.candidate_open_lots || []).length > 0) {
          setActiveTab('link');
        } else {
          setActiveTab('create_open');
        }
      })
      .catch((err: any) => {
        if (!isMounted) return;
        setError(err.message || 'Failed to fetch match candidates');
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [open, target]);

  // Keep openLots in sync if user changes confirmed open action
  const handleDirectionOverride = (newAction: 'BTO' | 'STO') => {
    setConfirmedOpenAction(newAction);
    setMediumConfirmed(true);
    setOpenLots((prev) =>
      prev.map((lot) => ({
        ...lot,
        open_action: newAction,
      }))
    );
  };

  // Multi-lot allocation calculations for Link Open Leg
  const totalAllocated = useMemo(() => {
    return Object.values(allocatedQuantities).reduce((sum, q) => sum + (Number(q) || 0), 0);
  }, [allocatedQuantities]);

  const targetQty = target?.quantity || 1;
  const isAllocationComplete = Math.abs(totalAllocated - targetQty) < 0.001;
  const allocationDelta = totalAllocated - targetQty;

  // "Suggest FIFO Split" action (Bug 1 Requirement 3)
  const handleSuggestFifoSplit = () => {
    if (!candidates?.candidate_open_lots || candidates.candidate_open_lots.length === 0) return;

    let remainingNeeded = targetQty;
    const newAllocations: Record<number, number> = {};

    // Lots are already sorted strictly in deterministic FIFO order by backend
    for (const lot of candidates.candidate_open_lots) {
      if (remainingNeeded <= 0.0001) break;

      const lotAvailable = Number(lot.open_qty) || 0;
      if (lotAvailable <= 0) continue;

      const take = Math.min(lotAvailable, remainingNeeded);
      newAllocations[lot.leg_id] = take;
      remainingNeeded -= take;
    }

    setAllocatedQuantities(newAllocations);
  };

  const handleToggleLotAllocation = (lot: CandidateOpenLot) => {
    setAllocatedQuantities((prev) => {
      const copy = { ...prev };
      if (lot.leg_id in copy) {
        delete copy[lot.leg_id];
      } else {
        const remainingToFill = Math.max(0, targetQty - totalAllocated);
        const defaultQty = remainingToFill > 0 ? Math.min(lot.open_qty, remainingToFill) : lot.open_qty;
        copy[lot.leg_id] = defaultQty;
      }
      return copy;
    });
  };

  const handleUpdateLotQuantity = (legId: number, qty: number) => {
    setAllocatedQuantities((prev) => ({
      ...prev,
      [legId]: isNaN(qty) ? 0 : qty,
    }));
  };

  // Multi-lot calculations for Record Missing Open
  const totalOpenLotsQty = useMemo(() => {
    return openLots.reduce((sum, lot) => sum + (Number(lot.quantity) || 0), 0);
  }, [openLots]);

  const isOpenLotsComplete = Math.abs(totalOpenLotsQty - targetQty) < 0.001;

  const handleAddOpenLot = () => {
    const remainingToFill = Math.max(0, targetQty - totalOpenLotsQty);
    const closeDt = new Date(target?.date || Date.now());
    const priorDt = new Date(closeDt.getTime() - 7 * 24 * 60 * 60 * 1000);

    setOpenLots((prev) => [
      ...prev,
      {
        open_date: priorDt.toISOString().slice(0, 10),
        open_price: 0,
        open_action: confirmedOpenAction,
        quantity: remainingToFill > 0 ? remainingToFill : 1,
        fees: 0,
        notes: '',
      },
    ]);
  };

  const handleRemoveOpenLot = (idx: number) => {
    if (openLots.length <= 1) return;
    setOpenLots((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleUpdateOpenLot = (idx: number, updates: Partial<MissingOpenLot>) => {
    setOpenLots((prev) =>
      prev.map((lot, i) => (i === idx ? { ...lot, ...updates } : lot))
    );
  };

  // Live Realized P/L calculation for Record Missing Open
  const estimatedRealizedPl = useMemo(() => {
    const closeAmount = target ? (candidates?.unmatched_trade?.amount ?? 0) : 0;
    let totalOpenCash = 0;

    for (const lot of openLots) {
      const p = Number(lot.open_price) || 0;
      const q = Number(lot.quantity) || 0;
      const f = Number(lot.fees) || 0;

      if (lot.open_action === 'STO') {
        totalOpenCash += p * q * 100 - f;
      } else {
        totalOpenCash -= (p * q * 100 + f);
      }
    }

    return totalOpenCash + closeAmount;
  }, [openLots, target, candidates]);

  const handleToggleManualId = (id: number) => {
    setSelectedManualIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleSelectAllExactManuals = () => {
    if (!candidates) return;
    const exactIds = candidates.candidate_manual_closes
      .filter((m) => m.is_exact_match)
      .map((m) => m.transaction_id);
    setSelectedManualIds(exactIds);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!target) return;

    if (directionInfo?.confidence === 'MEDIUM' && !mediumConfirmed) {
      setError('Active verification required: Please verify and confirm the original position direction before proceeding.');
      return;
    }

    setError(null);
    setSubmitting(true);

    try {
      if (activeTab === 'reconcile') {
        if (selectedManualIds.length === 0) {
          setError('Please select at least one manual close placeholder to reconcile.');
          setSubmitting(false);
          return;
        }

        const payload: MatchOptionPayload = {
          transaction_id: target.transactionId,
          mode: 'reconcile_manual',
          manual_transaction_ids: selectedManualIds,
        };
        await matchOptionContract(payload);
      } else if (activeTab === 'create_open') {
        if (!isOpenLotsComplete) {
          setError(
            `Total opening lot quantity (${totalOpenLotsQty}) must sum exactly to the closing transaction quantity (${targetQty}).`
          );
          setSubmitting(false);
          return;
        }

        for (let i = 0; i < openLots.length; i++) {
          const lot = openLots[i];
          if (!lot.open_date) {
            setError(`Please specify an open date for lot #${i + 1}.`);
            setSubmitting(false);
            return;
          }
          if (isNaN(Number(lot.open_price)) || Number(lot.open_price) < 0) {
            setError(`Please provide a valid open price for lot #${i + 1}.`);
            setSubmitting(false);
            return;
          }
          if (Number(lot.quantity) <= 0) {
            setError(`Quantity for lot #${i + 1} must be greater than 0.`);
            setSubmitting(false);
            return;
          }
        }

        const payload: MatchOptionPayload = {
          transaction_id: target.transactionId,
          mode: 'create_open',
          open_lots: openLots.map((l) => ({
            ...l,
            open_action: confirmedOpenAction,
          })),
        };
        await matchOptionContract(payload);
      } else if (activeTab === 'link') {
        const hasOpenLots = (candidates?.candidate_open_lots || []).length > 0;

        if (hasOpenLots) {
          if (!isAllocationComplete) {
            setError(
              `Total allocated quantity (${totalAllocated}) must sum exactly to the closing transaction quantity (${targetQty}).`
            );
            setSubmitting(false);
            return;
          }

          const selectedEntries = Object.entries(allocatedQuantities).filter(
            ([_, q]) => Number(q) > 0.0001
          );
          if (selectedEntries.length === 0) {
            setError('Please select at least one open lot and allocate quantity.');
            setSubmitting(false);
            return;
          }

          const allocations = selectedEntries.map(([legIdStr, qty]) => {
            const legId = Number(legIdStr);
            const lot = candidates!.candidate_open_lots.find((l) => l.leg_id === legId);
            return {
              leg_id: legId,
              transaction_id: lot?.transaction_id,
              quantity: Number(qty),
              expiration: lot?.expiration || target.expiration,
              strike: lot?.strike || target.strike,
              opt_type: lot?.opt_type || target.optType,
            };
          });

          const payload: MatchOptionPayload = {
            transaction_id: target.transactionId,
            mode: 'link_open_leg',
            allocations: allocations,
          };
          await matchOptionContract(payload);
        } else {
          // Manual fallback if no candidate open lots exist
          const strike = parseFloat(customStrike);
          if (!customExp || isNaN(strike)) {
            setError('Please specify target contract parameters (expiration and strike).');
            setSubmitting(false);
            return;
          }

          const payload: MatchOptionPayload = {
            transaction_id: target.transactionId,
            mode: 'link_open_leg',
            target_expiration: customExp,
            target_strike: strike,
            target_opt_type: customType,
          };
          await matchOptionContract(payload);
        }
      }

      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to match option contract');
    } finally {
      setSubmitting(false);
    }
  };

  if (!open || !target) return null;

  const manualCount = candidates?.candidate_manual_closes?.length || 0;
  const exactManualCount = candidates?.candidate_manual_closes?.filter((m) => m.is_exact_match).length || 0;
  const openLotCount = candidates?.candidate_open_lots?.length || 0;
  const exactOpenLotCount = candidates?.candidate_open_lots?.filter((l) => l.is_exact_match).length || 0;

  const directionInfo = candidates?.direction_inference;
  const linkedStock = candidates?.linked_stock_assignment;
  const isAssigned =
    target.action.toUpperCase().includes('ASSIGN') ||
    (target.description && target.description.toLowerCase().includes('assigned'));

  return (
    <Modal open={open} onClose={onClose} title="Match & Reconcile Trade">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Unmatched Trade Target Card */}
        <div className="p-3.5 rounded-xl bg-surface border border-border">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-bold text-text-primary text-base tracking-wide">
                {target.underlying} ${target.strike.toFixed(2)} {target.optType === 'C' ? 'Call' : 'Put'}
              </span>
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase bg-amber-500/15 text-amber-400 border border-amber-500/30">
                Unmatched Close
              </span>
            </div>
            <div className="text-right">
              <span className="text-[10px] text-text-muted uppercase tracking-wider block">Quantity</span>
              <span className="font-mono font-bold text-primary-400 text-sm">
                {target.quantity} Contract{target.quantity !== 1 ? 's' : ''}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-secondary mt-2 pt-2 border-t border-border/50">
            <span className="flex items-center gap-1">
              <Calendar size={12} className="text-text-muted" />
              Close Date: {formatDate(target.date)}
            </span>
            <span className="flex items-center gap-1">
              <Layers size={12} className="text-text-muted" />
              Exp: {formatDate(target.expiration)}
            </span>
            <span className="text-text-muted">
              Tx ID: <span className="font-mono text-text-secondary">{target.transactionId}</span>
            </span>
            {target.accountName && (
              <span className="text-text-muted">
                Account: <span className="text-text-secondary">{target.accountName}</span>
              </span>
            )}
          </div>

          {/* Inferred Direction & Confidence Confirmation UI */}
          {directionInfo && (
            <div className={`p-3 rounded-xl border mt-2.5 transition-colors ${
              directionInfo.confidence === 'MEDIUM'
                ? 'bg-amber-500/5 border-amber-500/30'
                : 'bg-surface-lighter/50 border-border'
            }`}>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-semibold text-text-secondary">Inferred Original Position:</span>
                  <span
                    className={`text-xs font-bold px-2 py-0.5 rounded border ${
                      confirmedOpenAction === 'BTO'
                        ? 'bg-info-500/15 text-info-400 border-info-500/30'
                        : 'bg-warning-500/15 text-warning-400 border-warning-500/30'
                    }`}
                  >
                    {confirmedOpenAction === 'BTO' ? 'LONG (BTO)' : 'SHORT (STO)'}
                  </span>
                  {directionInfo.confidence === 'HIGH' ? (
                    <span className="flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded uppercase bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                      <CheckCircle2 size={11} className="text-emerald-400" />
                      High Confidence
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded uppercase bg-amber-500/15 text-amber-400 border border-amber-500/30">
                      <AlertTriangle size={11} className="text-amber-400" />
                      Medium Confidence — Please Verify
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-text-muted text-[11px]">Direction Override:</span>
                  <select
                    value={confirmedOpenAction}
                    onChange={(e) => handleDirectionOverride(e.target.value as 'BTO' | 'STO')}
                    className="px-2 py-1 rounded bg-surface border border-border text-xs text-text-primary focus:outline-none cursor-pointer"
                  >
                    <option value="BTO">BTO (Long Contract)</option>
                    <option value="STO">STO (Short Contract)</option>
                  </select>
                </div>
              </div>
              <p className="text-[11px] text-text-muted mt-1.5 flex items-start gap-1">
                <Info size={13} className="shrink-0 mt-0.5 text-primary-400" />
                <span>{directionInfo.inference_reason}</span>
              </p>

              {directionInfo.confidence === 'MEDIUM' && (
                <div className={`mt-2.5 p-2 rounded-lg border text-xs flex items-start gap-2 transition-colors ${
                  mediumConfirmed
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                    : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                }`}>
                  <input
                    type="checkbox"
                    id="confirm-medium-direction"
                    checked={mediumConfirmed}
                    onChange={(e) => setMediumConfirmed(e.target.checked)}
                    className="mt-0.5 rounded border-border text-primary-500 focus:ring-primary-400 cursor-pointer"
                  />
                  <label htmlFor="confirm-medium-direction" className="text-[11px] leading-snug cursor-pointer select-none">
                    <span className="font-semibold">Active Verification Required:</span> I confirm this trade originally opened as a{' '}
                    <span className="font-bold underline">{confirmedOpenAction === 'BTO' ? 'LONG (BTO)' : 'SHORT (STO)'}</span> position.
                  </label>
                </div>
              )}
            </div>
          )}

          {/* Bug 3: Assignment Stock Trade Cross-Linking Banner */}
          {isAssigned && linkedStock && (
            <div className="mt-2.5">
              {linkedStock.found && linkedStock.trade ? (
                <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs flex items-start gap-2">
                  <CheckCircle2 size={16} className="shrink-0 mt-0.5 text-emerald-400" />
                  <div>
                    <span className="font-bold block">Assignment Stock Trade Linked:</span>
                    <span className="text-text-secondary text-[11px]">
                      {linkedStock.trade.category} {linkedStock.trade.quantity} shares of {target.underlying} @ ${linkedStock.trade.price.toFixed(2)} on {formatDate(linkedStock.trade.date)} (Tx #{linkedStock.trade.id})
                    </span>
                  </div>
                </div>
              ) : (
                <div className="p-3 rounded-xl bg-warning-500/15 border border-warning-500/30 text-warning-400 text-xs flex items-start gap-2">
                  <AlertTriangle size={16} className="shrink-0 mt-0.5 text-warning-400" />
                  <div>
                    <span className="font-bold block">Assignment Data-Integrity Warning:</span>
                    <span className="text-text-secondary text-[11px]">
                      {linkedStock.warning || 'No corresponding stock trade found for this assignment.'} Please verify that your broker statements include the resulting stock transaction.
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Mode Navigation Tabs */}
        <div className="flex items-center gap-1 bg-surface-lighter/50 p-1 rounded-xl border border-border text-xs">
          <button
            type="button"
            onClick={() => setActiveTab('reconcile')}
            className={`flex-1 py-1.5 px-2 rounded-lg font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
              activeTab === 'reconcile'
                ? 'bg-primary-500/20 text-primary-300 border border-primary-500/40 shadow-sm'
                : 'text-text-muted hover:text-text-secondary border border-transparent'
            }`}
          >
            <RefreshCw size={13} />
            <span>Reconcile Manual</span>
            {manualCount > 0 && (
              <span
                className={`ml-1 text-[10px] px-1.5 py-0.2 rounded-full font-bold ${
                  exactManualCount > 0
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                    : 'bg-surface text-text-muted'
                }`}
              >
                {manualCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('link')}
            className={`flex-1 py-1.5 px-2 rounded-lg font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
              activeTab === 'link'
                ? 'bg-primary-500/20 text-primary-300 border border-primary-500/40 shadow-sm'
                : 'text-text-muted hover:text-text-secondary border border-transparent'
            }`}
          >
            <Link2 size={13} />
            <span>Link Open Leg</span>
            {openLotCount > 0 && (
              <span
                className={`ml-1 text-[10px] px-1.5 py-0.2 rounded-full font-bold ${
                  exactOpenLotCount > 0
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                    : 'bg-surface text-text-muted'
                }`}
              >
                {openLotCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('create_open')}
            className={`flex-1 py-1.5 px-2 rounded-lg font-semibold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
              activeTab === 'create_open'
                ? 'bg-primary-500/20 text-primary-300 border border-primary-500/40 shadow-sm'
                : 'text-text-muted hover:text-text-secondary border border-transparent'
            }`}
          >
            <PlusCircle size={13} />
            <span>Record Missing Open</span>
          </button>
        </div>

        {/* Loading Indicator */}
        {loading && (
          <div className="py-8 flex flex-col items-center justify-center text-text-muted text-xs gap-2">
            <RefreshCw size={18} className="animate-spin text-primary-400" />
            <span>Scanning transaction history for candidates...</span>
          </div>
        )}

        {/* Tab 1: Reconcile Manual Close */}
        {!loading && activeTab === 'reconcile' && (
          <div className="space-y-3">
            <div className="p-3 rounded-lg bg-primary-500/5 border border-primary-500/15 text-xs text-text-secondary">
              <div className="flex items-start gap-2">
                <HelpCircle size={15} className="text-primary-400 shrink-0 mt-0.5" />
                <p>
                  Your broker statement arrived with this official closing transaction. If you previously recorded placeholder manual close(s), select them below to replace and reconcile.
                </p>
              </div>
            </div>

            {manualCount > 0 ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs px-1">
                  <span className="font-semibold text-text-primary">
                    Candidate Manual Closes ({candidates?.candidate_manual_closes.length})
                  </span>
                  {exactManualCount > 0 && (
                    <button
                      type="button"
                      onClick={handleSelectAllExactManuals}
                      className="text-primary-400 hover:text-primary-300 text-[11px] font-semibold underline cursor-pointer"
                    >
                      Select All Exact Matches ({exactManualCount})
                    </button>
                  )}
                </div>

                <div className="max-h-60 overflow-y-auto space-y-2 pr-1">
                  {candidates?.candidate_manual_closes.map((m) => {
                    const isSelected = selectedManualIds.includes(m.transaction_id);
                    return (
                      <div
                        key={m.transaction_id}
                        onClick={() => handleToggleManualId(m.transaction_id)}
                        className={`p-3 rounded-xl border text-xs cursor-pointer transition-all ${
                          isSelected
                            ? 'bg-primary-500/10 border-primary-500/50 shadow-sm'
                            : 'bg-surface border-border hover:border-border/80'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-start gap-2.5">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => handleToggleManualId(m.transaction_id)}
                              className="mt-0.5 rounded border-border text-primary-500 focus:ring-primary-500 cursor-pointer"
                            />
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="font-bold text-text-primary">
                                  Tx #{m.transaction_id} &bull; {m.quantity}x ${m.strike_price} {m.option_type === 'C' ? 'Call' : 'Put'}
                                </span>
                                {/* Bonus: Ambiguity Flagging */}
                                {m.has_multiple_exact_matches ? (
                                  <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30">
                                    ⚠️ Multiple Exact Matches — verify allocation
                                  </span>
                                ) : m.is_exact_match ? (
                                  <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                                    Exact Match
                                  </span>
                                ) : (
                                  <span className="text-[10px] font-medium px-1.5 py-0.2 rounded bg-surface-lighter text-text-muted border border-border">
                                    Partial Match
                                  </span>
                                )}
                              </div>
                              <p className="text-[11px] text-text-muted mt-0.5 line-clamp-1">
                                {m.description}
                              </p>
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <span className="font-mono text-text-secondary">{formatDate(m.date)}</span>
                            <span className="block text-[10px] text-text-muted">{m.category}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="p-6 text-center rounded-xl bg-surface border border-border text-text-muted text-xs space-y-1">
                <p className="font-semibold text-text-secondary">No manual closes found for this contract.</p>
                <p>Use "Link Open Leg" to pair with active lots, or "Record Missing Open" if unrecorded.</p>
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Link Open Leg (Bug 1: Multi-Lot Allocation) */}
        {!loading && activeTab === 'link' && (
          <div className="space-y-3">
            <div className="p-3 rounded-lg bg-primary-500/5 border border-primary-500/15 text-xs text-text-secondary">
              <div className="flex items-start gap-2">
                <HelpCircle size={15} className="text-primary-400 shrink-0 mt-0.5" />
                <p>
                  Allocate this closing trade across one or more open contract lots (e.g., when a close for 9 contracts resolves two opening lots of 4x and 5x).
                </p>
              </div>
            </div>

            {openLotCount > 0 ? (
              <div className="space-y-2">
                {/* Actions & Suggest FIFO Split Header */}
                <div className="flex items-center justify-between text-xs px-1">
                  <span className="font-semibold text-text-primary">
                    Candidate Open Lots ({openLotCount})
                  </span>
                  <button
                    type="button"
                    onClick={handleSuggestFifoSplit}
                    className="px-2.5 py-1 rounded bg-primary-500/10 hover:bg-primary-500/20 text-primary-400 hover:text-primary-300 border border-primary-500/20 text-[11px] font-semibold flex items-center gap-1 transition-colors cursor-pointer"
                    title="Auto-allocate across candidate lots in FIFO chronological order"
                  >
                    <Split size={12} />
                    <span>Suggest FIFO Split</span>
                  </button>
                </div>

                {/* Candidate Lots List with Checkbox & Editable Allocation Input */}
                <div className="max-h-60 overflow-y-auto space-y-2 pr-1">
                  {candidates?.candidate_open_lots.map((lot) => {
                    const isAllocated = lot.leg_id in allocatedQuantities;
                    const allocQty = allocatedQuantities[lot.leg_id] || 0;

                    return (
                      <div
                        key={lot.leg_id}
                        className={`p-3 rounded-xl border text-xs transition-all ${
                          isAllocated
                            ? 'bg-primary-500/10 border-primary-500/50 shadow-sm'
                            : 'bg-surface border-border hover:border-border/80'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-2.5 flex-1 min-w-0">
                            <input
                              type="checkbox"
                              checked={isAllocated}
                              onChange={() => handleToggleLotAllocation(lot)}
                              className="mt-1 rounded border-border text-primary-500 focus:ring-primary-500 cursor-pointer shrink-0"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-bold text-text-primary">
                                  Tx #{lot.transaction_id} &bull; {lot.action} {lot.open_qty}x ${lot.strike} {lot.opt_type === 'C' ? 'Call' : 'Put'}
                                </span>
                                {/* Bonus: Ambiguity Flagging */}
                                {lot.has_multiple_exact_matches ? (
                                  <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30">
                                    ⚠️ Multiple Exact Matches — verify allocation
                                  </span>
                                ) : lot.is_exact_match ? (
                                  <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                                    Exact Match
                                  </span>
                                ) : (
                                  <span className="text-[10px] font-medium px-1.5 py-0.2 rounded bg-surface-lighter text-text-muted border border-border">
                                    Partial Match
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-2 text-[11px] text-text-muted mt-1">
                                <span>Opened: {formatDate(lot.date)}</span>
                                <span>&bull;</span>
                                <span>Exp: {formatDate(lot.expiration)}</span>
                                <span>&bull;</span>
                                <span>Available: {lot.open_qty}x</span>
                              </div>
                            </div>
                          </div>

                          {/* Editable Allocation Input (Bug 1 Requirement 1) */}
                          <div className="shrink-0 flex items-center gap-1.5">
                            <label className="text-[11px] text-text-muted font-medium">Allocated:</label>
                            <input
                              type="number"
                              min="0"
                              max={lot.open_qty}
                              step="any"
                              disabled={!isAllocated}
                              value={isAllocated ? allocQty : 0}
                              onChange={(e) => handleUpdateLotQuantity(lot.leg_id, parseFloat(e.target.value))}
                              className="w-20 px-2 py-1 rounded bg-surface border border-border text-text-primary text-xs font-mono font-bold focus:outline-none focus:border-primary-500 disabled:opacity-30 disabled:bg-surface-lighter text-right"
                            />
                            <span className="text-[11px] text-text-muted">/{lot.open_qty}x</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Bug 1 Requirement 2: Exact Sum Validation Banner */}
                <div
                  className={`p-3 rounded-xl border flex items-center justify-between text-xs transition-colors ${
                    isAllocationComplete
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                      : allocationDelta < 0
                      ? 'bg-amber-500/15 border-amber-500/30 text-amber-400'
                      : 'bg-danger-500/15 border-danger-500/30 text-danger-400'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {isAllocationComplete ? (
                      <CheckCircle2 size={16} className="shrink-0" />
                    ) : (
                      <AlertCircle size={16} className="shrink-0" />
                    )}
                    <div>
                      <span className="font-bold block">
                        {isAllocationComplete
                          ? `✓ Fully Allocated: ${totalAllocated} / ${targetQty} contracts`
                          : allocationDelta < 0
                          ? `⚠️ Under-allocated: ${totalAllocated} / ${targetQty} contracts (${Math.abs(allocationDelta)} remaining)`
                          : `⚠️ Over-allocated: ${totalAllocated} / ${targetQty} contracts (exceeds by ${allocationDelta})`}
                      </span>
                      <span className="text-[11px] opacity-80">
                        {isAllocationComplete
                          ? 'All closing contracts are accounted for across selected lots.'
                          : 'Allocations across open lots must sum exactly to the closing transaction quantity.'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-xs text-text-secondary">
                  No active open legs found for {target.underlying}. Specify target contract parameters manually:
                </p>
                <div className="grid grid-cols-3 gap-3">
                  <Input
                    label="Expiration Date"
                    type="date"
                    value={customExp}
                    onChange={(e) => setCustomExp(e.target.value)}
                    required
                  />
                  <Input
                    label="Strike Price ($)"
                    type="number"
                    step="0.01"
                    placeholder="e.g. 1200"
                    value={customStrike}
                    onChange={(e) => setCustomStrike(e.target.value)}
                    required
                  />
                  <Select
                    label="Type"
                    value={customType}
                    onChange={(e) => setCustomType(e.target.value)}
                    options={[
                      { value: 'C', label: 'Call (C)' },
                      { value: 'P', label: 'Put (P)' },
                    ]}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tab 3: Record Missing Open (Bug 1 & 2: Multi-Lot & Inferred Direction) */}
        {!loading && activeTab === 'create_open' && (
          <div className="space-y-3">
            <div className="p-3 rounded-lg bg-primary-500/5 border border-primary-500/15 text-xs text-text-secondary">
              <div className="flex items-start gap-2">
                <HelpCircle size={15} className="text-primary-400 shrink-0 mt-0.5" />
                <p>
                  Record the missing opening trade(s) to pair with this close. You can enter a single trade or split across multiple opening lots (e.g. 4x at $2.00 and 5x at $2.50).
                </p>
              </div>
            </div>

            {/* List of Opening Lots */}
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs px-1">
                <span className="font-semibold text-text-primary">
                  Opening Trade Lots ({openLots.length})
                </span>
                <button
                  type="button"
                  onClick={handleAddOpenLot}
                  className="px-2.5 py-1 rounded bg-primary-500/10 hover:bg-primary-500/20 text-primary-400 hover:text-primary-300 border border-primary-500/20 text-[11px] font-semibold flex items-center gap-1 transition-colors cursor-pointer"
                >
                  <PlusCircle size={12} />
                  <span>+ Add Another Opening Lot</span>
                </button>
              </div>

              {openLots.map((lot, idx) => (
                <div key={idx} className="p-3 rounded-xl bg-surface border border-border space-y-2.5 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-text-primary">Opening Lot #{idx + 1}</span>
                    {openLots.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleRemoveOpenLot(idx)}
                        className="text-danger-400 hover:text-danger-300 p-1 rounded hover:bg-danger-500/10 transition-colors cursor-pointer"
                        title="Remove this lot"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <Input
                      label="Open Date"
                      type="date"
                      value={lot.open_date}
                      onChange={(e) => handleUpdateOpenLot(idx, { open_date: e.target.value })}
                      required
                    />
                    <Input
                      label="Quantity"
                      type="number"
                      min="0.01"
                      step="any"
                      value={lot.quantity}
                      onChange={(e) => handleUpdateOpenLot(idx, { quantity: parseFloat(e.target.value) || 0 })}
                      required
                    />
                    <Input
                      label="Open Price ($ per share)"
                      type="number"
                      step="0.01"
                      placeholder="e.g. 3.50"
                      value={lot.open_price || ''}
                      onChange={(e) => handleUpdateOpenLot(idx, { open_price: parseFloat(e.target.value) || 0 })}
                      required
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <Input
                      label="Commission / Fees ($)"
                      type="number"
                      step="0.01"
                      value={lot.fees || 0}
                      onChange={(e) => handleUpdateOpenLot(idx, { fees: parseFloat(e.target.value) || 0 })}
                    />
                    <Input
                      label="Notes"
                      type="text"
                      placeholder="e.g. Opened prior to CSV import"
                      value={lot.notes || ''}
                      onChange={(e) => handleUpdateOpenLot(idx, { notes: e.target.value })}
                    />
                  </div>
                </div>
              ))}

              {/* Bug 1 Requirement 2: Exact Sum Validation Banner for Open Lots */}
              <div
                className={`p-3 rounded-xl border flex items-center justify-between text-xs transition-colors ${
                  isOpenLotsComplete
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                    : 'bg-danger-500/15 border-danger-500/30 text-danger-400'
                }`}
              >
                <div className="flex items-center gap-2">
                  {isOpenLotsComplete ? (
                    <CheckCircle2 size={16} className="shrink-0" />
                  ) : (
                    <AlertCircle size={16} className="shrink-0" />
                  )}
                  <div>
                    <span className="font-bold block">
                      {isOpenLotsComplete
                        ? `✓ Quantities Match: ${totalOpenLotsQty} / ${targetQty} contracts`
                        : `⚠️ Quantity Mismatch: ${totalOpenLotsQty} / ${targetQty} contracts (${targetQty - totalOpenLotsQty} difference)`}
                    </span>
                    <span className="text-[11px] opacity-80">
                      Total opening lot contracts must sum exactly to the closing transaction quantity.
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Estimated Realized P/L Preview */}
            <div className="p-3 rounded-xl bg-surface border border-border flex items-center justify-between">
              <div>
                <span className="text-[10px] uppercase text-text-muted font-bold tracking-wider block">
                  Estimated Realized P/L ({confirmedOpenAction})
                </span>
                <span className="text-xs text-text-secondary">
                  Based on {confirmedOpenAction} opening lots and closing proceeds
                </span>
              </div>
              <div className="text-right">
                <span
                  className={`text-base font-extrabold font-mono tabular-nums ${
                    estimatedRealizedPl >= 0 ? 'text-success-400' : 'text-danger-400'
                  }`}
                >
                  {formatCurrency(estimatedRealizedPl)}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Error Banner */}
        {error && (
          <div className="p-3 rounded-xl bg-danger-500/10 border border-danger-500/20 text-danger-400 text-xs flex items-start gap-2">
            <AlertCircle size={16} className="shrink-0 mt-0.5" />
            <div className="flex-1">{error}</div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex items-center justify-end gap-3 pt-3 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-text-secondary hover:text-text-primary hover:bg-surface-lighter transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={
              submitting ||
              loading ||
              (activeTab === 'link' && (candidates?.candidate_open_lots || []).length > 0 && !isAllocationComplete) ||
              (activeTab === 'create_open' && !isOpenLotsComplete) ||
              (activeTab === 'reconcile' && selectedManualIds.length === 0)
            }
            className="px-4 py-2 rounded-xl text-xs font-semibold bg-primary-500 hover:bg-primary-600 text-white shadow-sm flex items-center gap-1.5 transition-all disabled:opacity-50 cursor-pointer"
          >
            {submitting ? (
              <>
                <RefreshCw size={14} className="animate-spin" />
                <span>Processing...</span>
              </>
            ) : activeTab === 'reconcile' ? (
              <>
                <CheckCircle2 size={14} />
                <span>Reconcile Selected ({selectedManualIds.length})</span>
              </>
            ) : activeTab === 'create_open' ? (
              <>
                <FileText size={14} />
                <span>Record Open & Pair ({totalOpenLotsQty}x)</span>
              </>
            ) : (
              <>
                <Link2 size={14} />
                <span>Link Selected ({totalAllocated}x)</span>
              </>
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}
