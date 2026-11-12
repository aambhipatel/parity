import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardTitle, CardValue } from '../components/Card';
import { LoadingSpinner, ErrorMessage } from '../components/StatusIndicators';
import { useAsync } from '../hooks/useAsync';
import { getDashboardSummary, getOptionsPortfolio } from '../services/api';
import { formatCurrency, getGlobalHideAmounts } from '../utils/helpers';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Legend
} from 'recharts';
import {
  TrendingUp, Wallet, CreditCard, ShieldCheck, Target, Clock,
  ArrowUpRight, ArrowRight, Upload, Landmark, FileText,
  ShoppingBag, HelpCircle, Database, AlertTriangle
} from 'lucide-react';

// Map category strings to professional icons
const getCategoryIcon = (category: string) => {
  const cat = category.toLowerCase();
  if (cat.includes('income') || cat.includes('salary') || cat.includes('deposit')) {
    return <ArrowUpRight className="text-success-400" size={16} />;
  }
  if (cat.includes('food') || cat.includes('dining') || cat.includes('restaurant')) {
    return <ShoppingBag className="text-amber-400" size={16} />;
  }
  if (cat.includes('invest') || cat.includes('stock') || cat.includes('option')) {
    return <TrendingUp className="text-primary-400" size={16} />;
  }
  if (cat.includes('housing') || cat.includes('rent') || cat.includes('mortgage')) {
    return <Wallet className="text-blue-400" size={16} />;
  }
  if (cat.includes('utility') || cat.includes('bill') || cat.includes('phone') || cat.includes('internet')) {
    return <FileText className="text-sky-400" size={16} />;
  }
  if (cat.includes('travel') || cat.includes('car') || cat.includes('gas') || cat.includes('transport')) {
    return <CreditCard className="text-rose-400" size={16} />;
  }
  return <HelpCircle className="text-text-muted" size={16} />;
};

export function DashboardPage() {
  const [chartMode, setChartMode] = useState<'networth' | 'cashflow'>('networth');

  const { data, loading, error, refetch } = useAsync(async () => {
    const [summary, options] = await Promise.all([
      getDashboardSummary(),
      getOptionsPortfolio()
    ]);
    return { ...summary, options };
  }, []);

  if (loading) return <LoadingSpinner message="Loading your financial dashboard..." />;
  if (error || !data) return <ErrorMessage message={error || 'Failed to load dashboard'} onRetry={refetch} />;

  const openPositions = data.options?.positions?.filter((p: any) => p.status === 'Open') || [];
  
  // Calculate Savings Rate
  const netSavings = data.monthly_income - data.monthly_expenses;
  const savingsRate = data.monthly_income > 0 
    ? Math.max(0, Math.min(100, Math.round((netSavings / data.monthly_income) * 100))) 
    : 0;

  // Formatting Date for Welcome Header
  const formattedDate = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // Dynamic greeting based on current hour
  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good Morning';
    if (hour < 18) return 'Good Afternoon';
    return 'Good Evening';
  };

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Precision Financial Cockpit Banner */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-surface-card p-6 md:p-8 shadow-lg shadow-black/20">
        <div className="relative z-10 flex flex-col md:flex-row md:items-center md:justify-between gap-6">
          <div className="space-y-2">
            <div>
              <span className="text-xs text-text-muted font-medium">{formattedDate}</span>
            </div>
            <h1 className="text-3xl sm:text-4xl font-extrabold text-text-primary tracking-tight">
              {getGreeting()}, <span className="text-primary-400">Investor</span>
            </h1>
            <p className="text-text-secondary text-sm max-w-2xl leading-relaxed">
              Aggregated real-time wealth telemetry, multi-account cash flows, and precision options strategy lifecycles.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link to="/accounts" className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold uppercase tracking-wider bg-primary-600 hover:bg-primary-500 text-white transition-all shadow-sm active:scale-95 group cursor-pointer">
              <Upload size={14} className="group-hover:-translate-y-0.5 transition-transform" />
              <span>Import CSV</span>
            </Link>
            <button
              onClick={refetch}
              aria-label="Refresh financial telemetry"
              className="p-2.5 rounded-xl border border-border bg-surface hover:bg-surface-lighter text-text-secondary hover:text-text-primary transition-all active:scale-95 cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary-500/40"
              title="Refresh telemetry"
            >
              <Clock size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Past Expiration Alert Banner */}
      {data.has_past_expiration && (
        <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2.5 text-amber-300 font-medium">
            <AlertTriangle size={18} className="text-amber-400 flex-shrink-0" />
            <div>
              <strong>Action Needed:</strong> Open option positions are past expiration awaiting broker confirmation ({formatCurrency(data.options_past_expiration_pl || 0)}). These are excluded from future target and realized P/L until confirmed or closed.
            </div>
          </div>
          <Link
            to="/options"
            className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/40 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <span>Review Options</span>
            <ArrowRight size={13} />
          </Link>
        </div>
      )}

      {/* Main KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {/* Net Worth Hero Card */}
        <Card className="animate-fade-in stagger-1 hover:border-primary-500/40 transition-all duration-200 border border-border bg-surface-card relative overflow-hidden group">
          <div className="flex items-start justify-between">
            <div className="space-y-1.5">
              <CardTitle className="text-primary-400 font-bold tracking-wider uppercase text-[11px]">Net Worth</CardTitle>
              <CardValue className="text-text-primary text-3xl font-extrabold tracking-tight">{formatCurrency(data.net_worth)}</CardValue>
              <p className="text-xs text-text-muted font-medium flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-primary-400" />
                Aggregated Equity
              </p>
            </div>
            <div className="p-3 rounded-xl bg-primary-500/10 text-primary-400 border border-primary-500/20 group-hover:scale-105 transition-transform">
              <ShieldCheck size={22} />
            </div>
          </div>
        </Card>

        {/* Total Assets Card */}
        <Card className="animate-fade-in stagger-2 hover:border-success-500/40 transition-all duration-200 border border-border bg-surface-card relative overflow-hidden group">
          <div className="flex items-start justify-between">
            <div className="space-y-1.5">
              <CardTitle className="text-success-400 font-bold tracking-wider uppercase text-[11px]">Total Assets</CardTitle>
              <CardValue className="text-text-primary text-3xl font-extrabold tracking-tight">{formatCurrency(data.total_assets)}</CardValue>
              <p className="text-xs text-text-muted font-medium flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-success-400" />
                Liquid & Brokerage
              </p>
            </div>
            <div className="p-3 rounded-xl bg-success-500/10 text-success-400 border border-success-500/20 group-hover:scale-105 transition-transform">
              <Wallet size={22} />
            </div>
          </div>
        </Card>

        {/* Total Liabilities Card */}
        <Card className="animate-fade-in stagger-3 hover:border-danger-500/40 transition-all duration-200 border border-border bg-surface-card relative overflow-hidden group">
          <div className="flex items-start justify-between">
            <div className="space-y-1.5">
              <CardTitle className="text-danger-400 font-bold tracking-wider uppercase text-[11px]">Total Liabilities</CardTitle>
              <CardValue className="text-text-primary text-3xl font-extrabold tracking-tight">{formatCurrency(data.total_liabilities)}</CardValue>
              <p className="text-xs text-text-muted font-medium flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-danger-400" />
                Debt & Credit
              </p>
            </div>
            <div className="p-3 rounded-xl bg-danger-500/10 text-danger-400 border border-danger-500/20 group-hover:scale-105 transition-transform">
              <CreditCard size={22} />
            </div>
          </div>
        </Card>

        {/* Savings Rate Card */}
        <Card className="animate-fade-in stagger-4 hover:border-border/80 transition-all duration-200 border border-border bg-surface-card relative overflow-hidden group">
          <div className="flex items-start justify-between">
            <div className="space-y-1.5 w-full pr-2">
              <CardTitle className="text-text-secondary font-bold tracking-wider uppercase text-[11px]">Savings Rate</CardTitle>
              <CardValue className="text-text-primary text-3xl font-extrabold tracking-tight">{savingsRate}%</CardValue>
              <div className="w-full bg-surface-lighter h-2 rounded-full mt-2 overflow-hidden border border-border/60">
                <div 
                  className="bg-primary-500 h-full rounded-full transition-all duration-500" 
                  style={{ width: `${savingsRate}%` }}
                />
              </div>
            </div>
            <div className="p-3 rounded-xl bg-surface-lighter text-text-primary border border-border group-hover:scale-105 transition-transform flex-shrink-0">
              <Target size={22} />
            </div>
          </div>
        </Card>
      </div>

      {/* Quick Command Center Tiles */}
      <div className="animate-fade-in stagger-2">
        <h2 className="text-xs font-bold uppercase tracking-wider text-text-muted mb-3 flex items-center gap-2">
          <span>Quick Command Center</span>
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Link to="/accounts" className="flex items-center gap-3.5 p-4 rounded-xl bg-surface-card border border-border hover:border-primary-500/50 hover:bg-surface-lighter/40 hover:-translate-y-0.5 transition-all shadow-sm group cursor-pointer">
            <div className="p-2.5 rounded-lg bg-blue-500/15 text-blue-400 group-hover:scale-110 transition-transform border border-blue-500/25">
              <Landmark size={18} />
            </div>
            <div>
              <p className="text-xs font-bold text-text-primary">Accounts</p>
              <p className="text-[10px] text-text-muted">Manage banks & balances</p>
            </div>
          </Link>
          <Link to="/options" className="flex items-center gap-3.5 p-4 rounded-xl bg-surface-card border border-border hover:border-primary-500/50 hover:bg-surface-lighter/40 hover:-translate-y-0.5 transition-all shadow-sm group cursor-pointer">
            <div className="p-2.5 rounded-lg bg-primary-500/15 text-primary-400 group-hover:scale-110 transition-transform border border-primary-500/25">
              <TrendingUp size={18} />
            </div>
            <div>
              <p className="text-xs font-bold text-text-primary">Options Cockpit</p>
              <p className="text-[10px] text-text-muted">FIFO P/L & Payoff curves</p>
            </div>
          </Link>
          <Link to="/reports" className="flex items-center gap-3.5 p-4 rounded-xl bg-surface-card border border-border hover:border-primary-500/50 hover:bg-surface-lighter/40 hover:-translate-y-0.5 transition-all shadow-sm group cursor-pointer">
            <div className="p-2.5 rounded-lg bg-emerald-500/15 text-emerald-400 group-hover:scale-110 transition-transform border border-emerald-500/25">
              <FileText size={18} />
            </div>
            <div>
              <p className="text-xs font-bold text-text-primary">Statements</p>
              <p className="text-[10px] text-text-muted">Income, Balance & Cashflow</p>
            </div>
          </Link>
          <Link to="/admin" className="flex items-center gap-3.5 p-4 rounded-xl bg-surface-card border border-border hover:border-primary-500/50 hover:bg-surface-lighter/40 hover:-translate-y-0.5 transition-all shadow-sm group cursor-pointer">
            <div className="p-2.5 rounded-lg bg-amber-500/15 text-amber-400 group-hover:scale-110 transition-transform border border-amber-500/25">
              <Database size={18} />
            </div>
            <div>
              <p className="text-xs font-bold text-text-primary">System Admin</p>
              <p className="text-[10px] text-text-muted">Database & Maintenance</p>
            </div>
          </Link>
        </div>
      </div>

      {/* Charts Row */}
      <Card className="relative overflow-hidden">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6 border-b border-border/40 pb-4">
          <div>
            <h3 className="text-base font-bold text-text-primary">Financial Trends Hub</h3>
            <p className="text-xs text-text-muted">Visualizing historical performance metrics</p>
          </div>
          <div className="flex bg-surface rounded-xl p-1 border border-border">
            <button
              onClick={() => setChartMode('networth')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                chartMode === 'networth'
                  ? 'bg-primary-600 text-white shadow-sm'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              Net Worth
            </button>
            <button
              onClick={() => setChartMode('cashflow')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                chartMode === 'cashflow'
                  ? 'bg-primary-600 text-white shadow-sm'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              Cashflow Profile
            </button>
          </div>
        </div>

        <div className="w-full">
          {chartMode === 'networth' ? (
            <ResponsiveContainer width="100%" height={320}>
              <AreaChart data={data.net_worth_history}>
                <defs>
                  <linearGradient id="colorNetWorth" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.25}/>
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#232b38" />
                <XAxis dataKey="month" tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => getGlobalHideAmounts() ? '••••' : `$${(v / 1000).toFixed(0)}k`} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#13171f', border: '1px solid #232b38', borderRadius: 8, color: '#f8fafc' }}
                  formatter={(value: any) => [formatCurrency(Number(value)), "Net Worth"]}
                />
                <Area type="monotone" dataKey="value" stroke="#3b82f6" strokeWidth={2} fillOpacity={1} fill="url(#colorNetWorth)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={data.income_expense_history} barGap={6}>
                <CartesianGrid strokeDasharray="3 3" stroke="#232b38" />
                <XAxis dataKey="month" tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => getGlobalHideAmounts() ? '••••' : `$${(v / 1000).toFixed(0)}k`} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#13171f', border: '1px solid #232b38', borderRadius: 8, color: '#f8fafc' }}
                  formatter={(value: any) => formatCurrency(Number(value))}
                />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 11, paddingTop: 10 }} />
                <Bar dataKey="income" fill="#10b981" radius={[4, 4, 0, 0]} name="Income" />
                <Bar dataKey="expenses" fill="#f97316" radius={[4, 4, 0, 0]} name="Expenses" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </Card>

      {/* Details Row: Open Positions vs Recent Transactions */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Recent Transactions List */}
        <Card className="lg:col-span-7 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-5 border-b border-border/40 pb-3">
              <h3 className="text-base font-bold text-text-primary">Recent Activity Feed</h3>
              <Link to="/transactions" className="text-xs text-primary-400 hover:text-primary-300 flex items-center gap-1 font-semibold group">
                <span>All Transactions</span>
                <ArrowRight size={12} className="group-hover:translate-x-0.5 transition-transform" />
              </Link>
            </div>

            <div className="space-y-3.5">
              {data.recent_transactions && data.recent_transactions.length > 0 ? (
                data.recent_transactions.map((tx: any) => {
                  const isCredit = tx.amount >= 0;
                  return (
                    <div key={tx.id} className="flex items-center justify-between py-1.5 px-1 hover:bg-surface-lighter/10 rounded-xl transition-all">
                      <div className="flex items-center gap-3.5 min-w-0">
                        <div className="w-9 h-9 rounded-xl bg-surface-lighter flex items-center justify-center border border-border/50 shadow-sm flex-shrink-0">
                          {getCategoryIcon(tx.category)}
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-text-primary truncate">{tx.description || 'Transaction'}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[10px] text-text-muted">{tx.date}</span>
                            <span className="w-1 h-1 rounded-full bg-border"></span>
                            <span className="text-[10px] text-text-secondary truncate max-w-[120px]">{tx.account_name}</span>
                          </div>
                        </div>
                      </div>

                      <div className="text-right flex-shrink-0">
                        <p className={`text-xs font-bold ${isCredit ? 'text-success-400' : 'text-danger-400'}`}>
                          {isCredit ? '+' : ''}{formatCurrency(tx.amount)}
                        </p>
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-surface border border-border/50 text-text-secondary mt-0.5 inline-block font-medium">
                          {tx.category}
                        </span>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="py-12 text-center">
                  <p className="text-text-muted text-xs italic">No recent transactions found.</p>
                </div>
              )}
            </div>
          </div>
        </Card>

        {/* Options Summary List */}
        <Card className="lg:col-span-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-5 border-b border-border/40 pb-3">
              <div>
                <h3 className="text-base font-bold text-text-primary">Options Portfolio</h3>
                <p className="text-[10px] text-text-muted mt-0.5">Active options strategies & P/L</p>
              </div>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-primary-500/10 text-primary-400 border border-primary-500/20">
                {openPositions.length} Active
              </span>
            </div>

            <div className="space-y-3">
              {openPositions.length > 0 ? (
                openPositions.slice(0, 4).map((pos: any) => (
                  <div key={pos.underlying} className="p-3 rounded-xl bg-surface/50 border border-border/40 flex items-center justify-between group hover:border-primary-500/30 transition-all">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-primary-500/10 text-primary-400 flex items-center justify-center flex-shrink-0">
                        <Target size={15} />
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5">
                          <p className="text-xs font-bold text-text-primary uppercase">{pos.underlying}</p>
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-surface border border-border text-text-muted">
                            {pos.sub_strategies?.[0]?.name || 'Option'}
                          </span>
                        </div>
                        <p className="text-[10px] text-text-muted mt-0.5">
                          {pos.sub_strategies?.length} active contract{pos.sub_strategies?.length !== 1 ? 's' : ''}
                        </p>
                      </div>
                    </div>

                    <div className="text-right">
                      <p className={`text-xs font-bold ${pos.realized_pl >= 0 ? 'text-success-400' : 'text-danger-400'}`}>
                        {formatCurrency(pos.realized_pl)}
                      </p>
                      <span className="text-[9px] text-text-muted">Realized P/L</span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="py-12 text-center">
                  <p className="text-text-muted text-xs italic">No open options positions found.</p>
                </div>
              )}
            </div>
          </div>

          <div className="pt-4 mt-4 border-t border-border/40">
            <Link to="/options" className="w-full flex items-center justify-center gap-2 py-2 rounded-xl bg-primary-600/10 hover:bg-primary-600/20 text-primary-400 text-xs font-bold transition-all border border-primary-500/20">
              <span>View Options Strategy Deck</span>
              <ArrowRight size={14} />
            </Link>
          </div>
        </Card>
      </div>
    </div>
  );
}

