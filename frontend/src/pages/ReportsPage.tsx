import { useState } from 'react';
import { Card, CardTitle, CardValue } from '../components/Card';
import { Select } from '../components/FormControls';
import { LoadingSpinner, ErrorMessage } from '../components/StatusIndicators';
import { useAsync } from '../hooks/useAsync';
import { getIncomeStatement, getBalanceSheet, getCashFlow, getAccounts } from '../services/api';
import { formatCurrency, getMonthOptions, cn, getGlobalHideAmounts } from '../utils/helpers';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import { FileText, Scale, ArrowRightLeft, Info } from 'lucide-react';

const months = getMonthOptions(12);
type ReportTab = 'income' | 'balance' | 'cashflow';

const tabs: { key: ReportTab; label: string; icon: typeof FileText }[] = [
  { key: 'income', label: 'Income Statement', icon: FileText },
  { key: 'balance', label: 'Balance Sheet', icon: Scale },
  { key: 'cashflow', label: 'Cash Flow', icon: ArrowRightLeft },
];

export function ReportsPage() {
  const { data: accounts } = useAsync(() => getAccounts(), []);
  const [activeTab, setActiveTab] = useState<ReportTab>('income');
  const [selectedMonth, setSelectedMonth] = useState(months[0].value);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const balanceDate = `${selectedMonth}-28`;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Reports</h1>
          <p className="text-text-secondary text-sm mt-1">Financial statements and analysis</p>
        </div>
        <div className="flex gap-3">
          <div className="w-48">
            <Select
              label=""
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              options={[
                { value: '', label: 'All Accounts' },
                ...(accounts || []).map((a) => ({ value: String(a.id), label: `${a.institution_name} - ${a.name}` })),
              ]}
            />
          </div>
          <div className="w-48">
            <Select
              label=""
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              options={months}
            />
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 bg-surface-card border border-border rounded-2xl p-1.5">
        {tabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={cn(
              'flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-sm font-medium transition-all duration-150',
              activeTab === key
                ? 'bg-primary-600/15 text-primary-400 shadow-sm'
                : 'text-text-secondary hover:text-text-primary hover:bg-surface-lighter/50'
            )}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'income' && <IncomeStatementView month={selectedMonth} accountId={selectedAccountId} />}
      {activeTab === 'balance' && <BalanceSheetView date={balanceDate} accountId={selectedAccountId} />}
      {activeTab === 'cashflow' && <CashFlowView month={selectedMonth} accountId={selectedAccountId} />}
    </div>
  );
}

const WrappedYAxisTick = (props: any) => {
  const { x, y, payload } = props;
  const val = payload.value || '';
  
  const words = val.split(' ');
  const lines: string[] = [];
  let currentLine = '';
  
  for (const word of words) {
    if ((currentLine + ' ' + word).trim().length <= 14) {
      currentLine = (currentLine + ' ' + word).trim();
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);

  const lineHeight = 13;
  const startDy = -((lines.length - 1) * lineHeight) / 2 + 3;

  return (
    <g transform={`translate(${x},${y})`}>
      <text
        x={-8}
        y={0}
        textAnchor="end"
        fill="#94a3b8"
        fontSize={11}
        className="capitalize"
      >
        {lines.map((line, idx) => (
          <tspan
            key={idx}
            x={-8}
            dy={idx === 0 ? startDy : lineHeight}
          >
            {line}
          </tspan>
        ))}
      </text>
    </g>
  );
};

function IncomeStatementView({ month, accountId }: { month: string; accountId: string }) {
  const { data, loading, error, refetch } = useAsync(() => getIncomeStatement(month, accountId), [month, accountId]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  if (loading) return <LoadingSpinner />;
  if (error || !data) return <ErrorMessage message={error || 'Failed'} onRetry={refetch} />;

  const toggleCategory = (cat: string) => {
    setExcluded(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const incomeEntries = Object.entries(data.income);
  const expenseEntries = Object.entries(data.expenses);

  const effectiveIncome = incomeEntries.reduce((sum, [k, v]) => sum + (excluded.has(k) ? 0 : v), 0);
  const effectiveExpenses = expenseEntries.reduce((sum, [k, v]) => sum + (excluded.has(k) ? 0 : v), 0);
  const effectiveNet = effectiveIncome - effectiveExpenses;

  const chartData = [
    ...incomeEntries.filter(([k]) => !excluded.has(k)).map(([k, v]) => ({ name: k, value: v, type: 'Income' })),
    ...expenseEntries.filter(([k]) => !excluded.has(k)).map(([k, v]) => ({ name: k, value: v, type: 'Expense' })),
  ];

  const chartHeight = Math.max(300, chartData.length * 50 + 60);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
      {/* Summary Cards */}
      <Card>
        <CardTitle>Total Income</CardTitle>
        <CardValue className="text-success-400">{formatCurrency(effectiveIncome)}</CardValue>
      </Card>
      <Card>
        <CardTitle>Total Expenses</CardTitle>
        <CardValue className="text-danger-400">{formatCurrency(effectiveExpenses)}</CardValue>
      </Card>
      <Card>
        <CardTitle>Net Income</CardTitle>
        <CardValue className={effectiveNet >= 0 ? 'text-success-400' : 'text-danger-400'}>
          {formatCurrency(effectiveNet)}
        </CardValue>
      </Card>

      {/* Chart */}
      <Card className="lg:col-span-3">
        <CardTitle className="mb-4 text-base">Income & Expenses by Category</CardTitle>
        <ResponsiveContainer width="100%" height={chartHeight}>
          <BarChart data={chartData} layout="vertical" margin={{ left: 110, right: 20, top: 10, bottom: 10 }} barCategoryGap="40%">
            <CartesianGrid strokeDasharray="3 3" stroke="#232b38" />
            <XAxis type="number" tick={{ fill: '#94a3b8', fontSize: 12 }} tickFormatter={(v) => getGlobalHideAmounts() ? '••••' : `$${v.toLocaleString()}`} axisLine={false} tickLine={false} />
            <YAxis
              type="category"
              dataKey="name"
              axisLine={false}
              tickLine={false}
              width={100}
              tick={<WrappedYAxisTick />}
            />
            <Tooltip
              contentStyle={{ backgroundColor: '#13171f', border: '1px solid #232b38', borderRadius: 8, color: '#f8fafc' }}
              formatter={(value: any) => formatCurrency(Number(value))}
            />
            <Bar dataKey="value" radius={[0, 6, 6, 0]} barSize={16}>
              {chartData.map((entry, i) => (
                <Cell key={i} fill={entry.type === 'Income' ? '#10b981' : '#f97316'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Card>

      {/* Detailed Breakdown */}
      <Card className="lg:col-span-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div>
            <h3 className="text-sm font-semibold text-success-400 mb-3 uppercase tracking-wider">Income</h3>
            {incomeEntries.map(([cat, amt]) => (
              <div key={cat} className="flex items-center justify-between py-2 border-b border-border/50">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!excluded.has(cat)}
                    onChange={() => toggleCategory(cat)}
                    className="rounded border-border text-primary-600 focus:ring-primary-500 bg-surface"
                  />
                  <span className={`text-sm capitalize transition-colors ${excluded.has(cat) ? 'text-text-muted line-through' : 'text-text-secondary'}`}>
                    {cat}
                  </span>
                </label>
                <span className={`text-sm font-medium transition-colors ${excluded.has(cat) ? 'text-text-muted' : 'text-text-primary'}`}>
                  {formatCurrency(amt)}
                </span>
              </div>
            ))}
            <div className="flex justify-between py-2 mt-1">
              <span className="text-sm font-semibold text-text-primary">Effective Total</span>
              <span className="text-sm font-bold text-success-400">{formatCurrency(effectiveIncome)}</span>
            </div>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-danger-400 mb-3 uppercase tracking-wider">Expenses</h3>
            {expenseEntries.map(([cat, amt]) => (
              <div key={cat} className="flex items-center justify-between py-2 border-b border-border/50">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!excluded.has(cat)}
                    onChange={() => toggleCategory(cat)}
                    className="rounded border-border text-primary-600 focus:ring-primary-500 bg-surface"
                  />
                  <span className={`text-sm capitalize transition-colors ${excluded.has(cat) ? 'text-text-muted line-through' : 'text-text-secondary'}`}>
                    {cat}
                  </span>
                </label>
                <span className={`text-sm font-medium transition-colors ${excluded.has(cat) ? 'text-text-muted' : 'text-text-primary'}`}>
                  {formatCurrency(amt)}
                </span>
              </div>
            ))}
            <div className="flex justify-between py-2 mt-1">
              <span className="text-sm font-semibold text-text-primary">Effective Total</span>
              <span className="text-sm font-bold text-danger-400">{formatCurrency(effectiveExpenses)}</span>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

function BalanceSheetView({ date, accountId }: { date: string; accountId: string }) {
  const { data, loading, error, refetch } = useAsync(() => getBalanceSheet(date, accountId), [date, accountId]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  if (loading) return <LoadingSpinner />;
  if (error || !data) return <ErrorMessage message={error || 'Failed'} onRetry={refetch} />;

  const toggleCategory = (cat: string) => {
    setExcluded(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const assetEntries = Object.entries(data.assets);
  const liabEntries = Object.entries(data.liabilities);

  const effectiveAssets = assetEntries.reduce((sum, [k, v]) => sum + (excluded.has(k) ? 0 : v), 0);
  const effectiveLiabilities = liabEntries.reduce((sum, [k, v]) => sum + (excluded.has(k) ? 0 : v), 0);
  const effectiveEquity = effectiveAssets - effectiveLiabilities;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
      <Card>
        <CardTitle>Total Assets</CardTitle>
        <CardValue className="text-success-400">{formatCurrency(effectiveAssets)}</CardValue>
      </Card>
      <Card>
        <CardTitle>Total Liabilities</CardTitle>
        <CardValue className="text-danger-400">{formatCurrency(effectiveLiabilities)}</CardValue>
      </Card>
      <Card>
        <CardTitle>Net Worth (Equity)</CardTitle>
        <CardValue className="text-primary-400">{formatCurrency(effectiveEquity)}</CardValue>
      </Card>

      <Card className="lg:col-span-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div>
            <h3 className="text-sm font-semibold text-success-400 mb-3 uppercase tracking-wider">Assets</h3>
            {assetEntries.map(([cat, amt]) => (
              <div key={cat} className="flex items-center justify-between py-2.5 border-b border-border/50">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!excluded.has(cat)}
                    onChange={() => toggleCategory(cat)}
                    className="rounded border-border text-primary-600 focus:ring-primary-500 bg-surface"
                  />
                  <span className={`text-sm capitalize transition-colors ${excluded.has(cat) ? 'text-text-muted line-through' : 'text-text-secondary'}`}>
                    {cat}
                  </span>
                </label>
                <span className={`text-sm font-medium transition-colors ${excluded.has(cat) ? 'text-text-muted' : 'text-text-primary'}`}>
                  {formatCurrency(amt)}
                </span>
              </div>
            ))}
            <div className="flex justify-between py-2.5 mt-1">
              <span className="text-sm font-bold text-text-primary">Effective Assets</span>
              <span className="text-sm font-bold text-success-400">{formatCurrency(effectiveAssets)}</span>
            </div>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-danger-400 mb-3 uppercase tracking-wider">Liabilities</h3>
            {liabEntries.map(([cat, amt]) => (
              <div key={cat} className="flex items-center justify-between py-2.5 border-b border-border/50">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!excluded.has(cat)}
                    onChange={() => toggleCategory(cat)}
                    className="rounded border-border text-primary-600 focus:ring-primary-500 bg-surface"
                  />
                  <span className={`text-sm capitalize transition-colors ${excluded.has(cat) ? 'text-text-muted line-through' : 'text-text-secondary'}`}>
                    {cat}
                  </span>
                </label>
                <span className={`text-sm font-medium transition-colors ${excluded.has(cat) ? 'text-text-muted' : 'text-text-primary'}`}>
                  {formatCurrency(amt)}
                </span>
              </div>
            ))}
            <div className="flex justify-between py-2.5 mt-1">
              <span className="text-sm font-bold text-text-primary">Effective Liabilities</span>
              <span className="text-sm font-bold text-danger-400">{formatCurrency(effectiveLiabilities)}</span>
            </div>
          </div>
        </div>

        <div className="mt-6 pt-4 border-t-2 border-primary-500/30">
          <div className="flex justify-between items-center">
            <span className="text-base font-bold text-text-primary">Effective Equity (Net Worth)</span>
            <span className="text-xl font-bold text-primary-400">{formatCurrency(effectiveEquity)}</span>
          </div>
        </div>
      </Card>
    </div>
  );
}

function CashFlowView({ month, accountId }: { month: string; accountId: string }) {
  const { data, loading, error, refetch } = useAsync(() => getCashFlow(month, accountId), [month, accountId]);

  if (loading) return <LoadingSpinner />;
  if (error || !data) return <ErrorMessage message={error || 'Failed'} onRetry={refetch} />;

  const flows = [
    { label: 'Operating Activities', value: data.operating, color: 'text-sky-400', bg: 'bg-sky-500/10', desc: 'Day-to-day transaction flows not categorized as investments or financing.' },
    { label: 'Investing Activities', value: data.investing, color: 'text-primary-400', bg: 'bg-primary-500/10', desc: 'Flows matching: stock, crypto, investment, brokerage, 401k' },
    { label: 'Financing Activities', value: data.financing, color: 'text-amber-400', bg: 'bg-amber-500/10', desc: 'Flows matching: loan, mortgage, credit card, dividend, interest' },
  ];

  const chartData = flows.map((f) => ({ name: f.label.replace(' Activities', ''), value: f.value }));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
      {flows.map((f) => (
        <Card key={f.label} className="relative overflow-visible pb-4">
          <div className="flex items-center gap-2 mb-2">
            <CardTitle>{f.label}</CardTitle>
            <div className="group relative flex items-center justify-center">
              <Info size={14} className="text-text-muted hover:text-text-primary cursor-help transition-colors" />
              <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 w-48 p-2 bg-surface border border-border rounded-lg text-xs text-text-secondary shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50 pointer-events-none">
                {f.desc}
              </div>
            </div>
          </div>
          <CardValue className={f.value >= 0 ? 'text-success-400' : 'text-danger-400'}>
            {formatCurrency(f.value)}
          </CardValue>
        </Card>
      ))}

      <Card className="lg:col-span-3">
        <CardTitle className="mb-4 text-base">Cash Flows by Activity</CardTitle>
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#232b38" />
            <XAxis dataKey="name" tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={(v) => getGlobalHideAmounts() ? '••••' : `$${(v / 1000).toFixed(0)}k`} />
            <Tooltip
              contentStyle={{ backgroundColor: '#13171f', border: '1px solid #232b38', borderRadius: 8, color: '#f8fafc' }}
              formatter={(value: any) => formatCurrency(Number(value))}
            />
            <Bar dataKey="value" radius={[6, 6, 0, 0]}>
              {chartData.map((entry, i) => (
                <Cell key={i} fill={entry.value >= 0 ? '#10b981' : '#f43f5e'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <Card className="lg:col-span-3">
        <div className="space-y-3">
          {flows.map((f) => (
            <div key={f.label} className="flex items-center justify-between py-3 px-4 rounded-xl bg-surface/50 border border-border/50">
              <div className="flex items-center gap-3">
                <div className={`w-2 h-8 rounded-full ${f.value >= 0 ? 'bg-success-500' : 'bg-danger-500'}`} />
                <span className="text-sm font-medium text-text-primary">{f.label}</span>
              </div>
              <span className={`text-sm font-bold ${f.value >= 0 ? 'text-success-400' : 'text-danger-400'}`}>
                {formatCurrency(f.value)}
              </span>
            </div>
          ))}
          <div className="flex items-center justify-between py-3 px-4 rounded-xl bg-primary-600/10 border border-primary-500/20">
            <span className="text-sm font-bold text-text-primary">Net Cash Flow</span>
            <span className={`text-lg font-bold ${data.total_net_flow >= 0 ? 'text-success-400' : 'text-danger-400'}`}>
              {formatCurrency(data.total_net_flow)}
            </span>
          </div>
        </div>
      </Card>
    </div>
  );
}
