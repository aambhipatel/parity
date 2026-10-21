import { useMemo } from 'react';
import { Modal } from './Modal';
import { formatCurrency, formatDate } from '../utils/helpers';
import { TrendingUp, AlertOctagon, Target, Layers, Calendar, AlertTriangle } from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ReferenceLine
} from 'recharts';

interface Leg {
  id: number;
  action: string;
  strike: number;
  type: string;
  amount: number;
  quantity?: number;
  price?: number;
  fees?: number;
  date: string;
}

interface SubStrategy {
  name: string;
  expiration: string;
  status: string;
  unrealized_pl: number;
  realized_pl: number;
  legs: Leg[];
  warning?: string | null;
}

interface PayoffModalProps {
  open: boolean;
  onClose: () => void;
  underlying: string;
  subStrategy: SubStrategy | null;
}

export function PayoffModal({ open, onClose, underlying, subStrategy }: PayoffModalProps) {
  const payoffData = useMemo(() => {
    if (!subStrategy || !subStrategy.legs || subStrategy.legs.length === 0) {
      return { chartPoints: [], maxProfit: 0, maxLoss: 0, breakevens: [], minStrike: 0, maxStrike: 0, hasUnboundedLoss: false, hasUnboundedProfit: false, highPrice: 0, lossAtBound: 0 };
    }

    const strikes = subStrategy.legs.map((l) => Number(l.strike)).filter((s) => !isNaN(s) && s > 0);
    if (strikes.length === 0) {
      return { chartPoints: [], maxProfit: 0, maxLoss: 0, breakevens: [], minStrike: 0, maxStrike: 0, hasUnboundedLoss: false, hasUnboundedProfit: false, highPrice: 0, lossAtBound: 0 };
    }

    const minStrike = Math.min(...strikes);
    const maxStrike = Math.max(...strikes);
    const spreadWidth = maxStrike - minStrike || minStrike * 0.2;
    const lowPrice = Math.max(1, Math.floor(minStrike - spreadWidth * 1.5));
    const highPrice = Math.ceil(maxStrike + spreadWidth * 1.5);
    const steps = 60;
    const stepSize = Math.max(0.5, (highPrice - lowPrice) / steps);

    const calculatePLAtPrice = (st: number) => {
      let totalPL = 0;
      for (const leg of subStrategy.legs) {
        const isBuy = leg.action.toUpperCase().includes('B'); // BTO or BTC
        const isCall = leg.type.toUpperCase().startsWith('C');
        const strike = Number(leg.strike);
        const qty = Number(leg.quantity) || 1;
        const rawAmt = leg.amount !== undefined && leg.amount !== null && !isNaN(Number(leg.amount)) ? Math.abs(Number(leg.amount)) : null;
        const premium = rawAmt !== null ? rawAmt : (Number(leg.price || 0) * 100 * qty);

        let intrinsic = 0;
        if (isCall) {
          intrinsic = Math.max(0, st - strike) * 100 * qty;
        } else {
          intrinsic = Math.max(0, strike - st) * 100 * qty;
        }

        if (isBuy) {
          // Bought option: payoff = intrinsic - initial premium paid
          totalPL += intrinsic - premium;
        } else {
          // Sold option: payoff = initial premium collected - intrinsic
          totalPL += premium - intrinsic;
        }
      }
      return totalPL;
    };

    const chartPoints: { price: number; pl: number }[] = [];
    let maxProfit = -Infinity;
    let maxLoss = Infinity;
    const breakevens: number[] = [];

    let prevPL: number | null = null;
    let prevPrice: number | null = null;

    // Ensure simulation points cover exactly lowPrice up to highPrice
    const prices: number[] = [];
    for (let p = lowPrice; p < highPrice - 0.001; p += stepSize) {
      prices.push(Math.round(p * 100) / 100);
    }
    if (prices.length === 0 || Math.abs(prices[prices.length - 1] - highPrice) > 0.01) {
      prices.push(highPrice);
    }

    for (const p of prices) {
      const pl = calculatePLAtPrice(p);
      chartPoints.push({ price: p, pl: Math.round(pl * 100) / 100 });

      if (pl > maxProfit) maxProfit = pl;
      if (pl < maxLoss) maxLoss = pl;

      if (prevPL !== null && prevPrice !== null) {
        // Zero-crossing detection for breakeven
        if ((prevPL < 0 && pl >= 0) || (prevPL > 0 && pl <= 0)) {
          if (pl !== prevPL) {
            const be = prevPrice + (0 - prevPL) * ((p - prevPrice) / (pl - prevPL));
            breakevens.push(Math.round(be * 100) / 100);
          }
        }
      }
      prevPL = pl;
      prevPrice = p;
    }

    let netCallQty = 0;
    for (const leg of subStrategy.legs) {
      const isBuy = leg.action.toUpperCase().includes('B');
      const isCall = leg.type.toUpperCase().startsWith('C');
      const qty = Number(leg.quantity) || 1;
      if (isCall) {
        netCallQty += isBuy ? qty : -qty;
      }
    }
    const hasUnboundedLoss = netCallQty < -0.001;
    const hasUnboundedProfit = netCallQty > 0.001;
    const lossAtBound = calculatePLAtPrice(highPrice);

    return { chartPoints, maxProfit, maxLoss, breakevens, minStrike, maxStrike, hasUnboundedLoss, hasUnboundedProfit, highPrice, lossAtBound };
  }, [subStrategy]);

  if (!open || !subStrategy) return null;

  return (
    <Modal open={open} onClose={onClose} title={`${underlying} Strategy Payoff & Breakeven Diagram`} maxWidth="max-w-2xl">
      <div className="space-y-6">
        {/* Strategy Context Summary */}
        <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-xl bg-surface border border-border">
          <div className="flex items-center gap-3">
            <span className="px-2.5 py-1 rounded-lg bg-primary-500/20 text-primary-400 text-xs font-bold uppercase tracking-wider flex items-center gap-1.5">
              <Layers size={13} />
              {subStrategy.name}
            </span>
            <span className="text-xs text-text-secondary flex items-center gap-1">
              <Calendar size={13} className="text-text-muted" />
              Exp: {formatDate(subStrategy.expiration)}
            </span>
          </div>
          <div className="text-xs text-text-muted">
            {subStrategy.legs.length} Option Leg{subStrategy.legs.length !== 1 ? 's' : ''}
          </div>
        </div>

        {/* Warning Banner for transferred positions or special trade conditions */}
        {subStrategy.warning && (
          <div className="flex items-center gap-2.5 p-3 rounded-xl bg-warning-500/10 border border-warning-500/25 text-xs text-warning-400">
            <AlertTriangle size={15} className="shrink-0 text-warning-400" />
            <span className="font-medium">{subStrategy.warning}</span>
          </div>
        )}

        {/* Risk Metrics Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div className="p-3.5 rounded-xl bg-surface border border-border">
            <div className="flex items-center gap-1.5 text-xs text-text-muted mb-1">
              <TrendingUp size={14} className="text-success-400" />
              <span>Max Profit</span>
            </div>
            <p className="text-lg font-bold text-success-400">
              {payoffData.hasUnboundedProfit || payoffData.maxProfit === Infinity ? 'Unlimited' : formatCurrency(payoffData.maxProfit)}
            </p>
          </div>

          <div className="p-3.5 rounded-xl bg-surface border border-border">
            <div className="flex items-center gap-1.5 text-xs text-text-muted mb-1">
              <AlertOctagon size={14} className="text-danger-400" />
              <span>Max Loss</span>
            </div>
            <p className="text-lg font-bold text-danger-400">
              {payoffData.hasUnboundedLoss || payoffData.maxLoss === -Infinity ? 'Unlimited' : formatCurrency(payoffData.maxLoss)}
            </p>
            {payoffData.hasUnboundedLoss && (
              <span className="text-[11px] text-text-muted">
                at ${payoffData.highPrice} chart bound: {formatCurrency(payoffData.lossAtBound)}
              </span>
            )}
          </div>

          <div className="p-3.5 rounded-xl bg-surface border border-border col-span-2 sm:col-span-1">
            <div className="flex items-center gap-1.5 text-xs text-text-muted mb-1">
              <Target size={14} className="text-primary-400" />
              <span>Breakeven Point(s)</span>
            </div>
            <p className="text-lg font-bold text-primary-300">
              {payoffData.breakevens.length > 0
                ? payoffData.breakevens.map((b) => `$${b.toFixed(2)}`).join(', ')
                : 'N/A'}
            </p>
          </div>
        </div>

        {/* Payoff Curve Visualization */}
        <div className="p-4 rounded-xl bg-surface border border-border">
          <div className="flex items-center justify-between mb-3 text-xs text-text-secondary">
            <span className="font-semibold text-text-primary">P/L at Expiration vs. Underlying Price ($S_T$)</span>
            <span className="text-[11px] text-text-muted">Hover curve to inspect projected P/L</span>
          </div>

          <div className="h-[260px] w-full">
            {payoffData.chartPoints.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={payoffData.chartPoints} margin={{ top: 10, right: 15, left: 10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#232b38" vertical={false} />
                  <XAxis
                    dataKey="price"
                    stroke="#94a3b8"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `$${v}`}
                  />
                  <YAxis
                    stroke="#94a3b8"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    width={75}
                    tickFormatter={(v) => formatCurrency(v)}
                  />
                  <RechartsTooltip
                    contentStyle={{ backgroundColor: '#13171f', border: '1px solid #232b38', borderRadius: '8px', color: '#f8fafc' }}
                    labelStyle={{ color: '#94a3b8', fontWeight: 'bold' }}
                    formatter={(val: any) => [formatCurrency(Number(val)), 'Projected Expiration P/L']}
                    labelFormatter={(price) => `Underlying Stock Price: $${Number(price).toFixed(2)}`}
                  />
                  <ReferenceLine y={0} stroke="#64748b" strokeWidth={2} strokeDasharray="4 4" />
                  {payoffData.breakevens.map((be, idx) => (
                    <ReferenceLine
                      key={idx}
                      x={be}
                      stroke="#60a5fa"
                      strokeWidth={1.5}
                      strokeDasharray="3 3"
                      label={{ value: `BE: $${be.toFixed(2)}`, fill: '#93c5fd', fontSize: 10, position: 'top' }}
                    />
                  ))}
                  <Line
                    type="monotone"
                    dataKey="pl"
                    stroke="#3b82f6"
                    strokeWidth={2.5}
                    dot={false}
                    activeDot={{ r: 6, fill: '#60a5fa', stroke: '#13171f', strokeWidth: 2 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-text-muted text-xs">
                Unable to compute payoff curve for this trade structure.
              </div>
            )}
          </div>
        </div>

        {/* Legs Table Summary */}
        <div className="space-y-1.5">
          <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Position Legs</span>
          <div className="divide-y divide-border border border-border rounded-xl overflow-hidden text-xs">
            {subStrategy.legs.map((leg) => (
              <div key={leg.id} className="flex items-center justify-between p-2.5 bg-surface/50">
                <div className="flex items-center gap-2.5">
                  <span className={`font-bold ${leg.action.includes('B') ? 'text-info-400' : 'text-warning-400'}`}>
                    {leg.action}
                  </span>
                  {leg.quantity != null && (
                    <span className="font-mono text-[11px] font-semibold px-1.5 py-0.5 rounded bg-surface-lighter text-text-secondary border border-border/40">
                      {Number(leg.quantity)}x
                    </span>
                  )}
                  <span className="text-text-primary font-medium">
                    ${leg.strike} {leg.type}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-text-muted">{formatDate(leg.date)}</span>
                  <span className={`font-bold ${leg.amount >= 0 ? 'text-success-400' : 'text-text-primary'}`}>
                    {formatCurrency(leg.amount)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
