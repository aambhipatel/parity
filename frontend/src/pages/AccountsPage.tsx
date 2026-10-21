import { useState, useMemo } from 'react';
import { Card } from '../components/Card';
import { Modal } from '../components/Modal';
import { AccountCSVImport } from '../components/AccountCSVImport';
import { Input, Button } from '../components/FormControls';
import { LoadingSpinner, ErrorMessage } from '../components/StatusIndicators';
import { useAsync } from '../hooks/useAsync';
import { getAccounts, getInstitutions, createAccount, deleteAccount, createInstitution, importTransactionsCSV, getImports, revertImport } from '../services/api';
import { formatCurrency } from '../utils/helpers';
import { DataTable } from '../components/DataTable';
import { Tooltip } from '../components/Tooltip';
import {
  Plus, Trash2, Building2, PiggyBank, CreditCard, TrendingUp, Landmark,
  Upload, Info, Wallet, ShieldCheck, Layers, ExternalLink, RefreshCw, AlertTriangle,
} from 'lucide-react';
import type { Account, AccountType } from '../types';

const typeConfig: Record<AccountType, { icon: typeof Building2; color: string; bg: string; border: string; glow: string }> = {
  checking:      { icon: Building2,  color: 'text-blue-400',    bg: 'bg-blue-500/10',    border: 'border-blue-500/20',    glow: '' },
  savings:       { icon: PiggyBank,  color: 'text-emerald-400', bg: 'bg-emerald-500/10',  border: 'border-emerald-500/20', glow: '' },
  'credit card': { icon: CreditCard, color: 'text-rose-400',    bg: 'bg-rose-500/10',     border: 'border-rose-500/20',    glow: '' },
  investment:    { icon: TrendingUp, color: 'text-primary-400', bg: 'bg-primary-500/10',  border: 'border-primary-500/20', glow: '' },
  loan:          { icon: Landmark,   color: 'text-amber-400',   bg: 'bg-amber-500/10',   border: 'border-amber-500/20',   glow: '' },
};

const groups: { type: AccountType; label: string }[] = [
  { type: 'checking', label: 'Checking Accounts' },
  { type: 'savings', label: 'Savings Accounts' },
  { type: 'credit card', label: 'Credit Cards' },
  { type: 'investment', label: 'Brokerage Accounts' },
  { type: 'loan', label: 'Loans' },
];

const defaultInstitutionsByType: Record<AccountType, string[]> = {
  checking: ['Chase', 'Bank of America', 'Wells Fargo', 'Citibank', 'Capital One'],
  savings: ['Ally Bank', 'Marcus by Goldman Sachs', 'Capital One 360', 'Discover Bank', 'Wealthfront'],
  'credit card': ['Chase', 'Citibank'],
  investment: ['Charles Schwab', 'Fidelity Investments', 'Vanguard', 'E*TRADE', 'Robinhood'],
  loan: ['Chase', 'Wells Fargo', 'SoFi', 'Nelnet', 'Rocket Mortgage'],
};

export function AccountsPage() {
  const { data: accounts, loading, error, refetch } = useAsync(() => getAccounts(), []);
  const { data: institutions } = useAsync(() => getInstitutions(), []);
  const { data: imports, refetch: refetchImports } = useAsync(() => getImports(), []);
  const [modalOpen, setModalOpen] = useState(false);
  const [csvImportOpen, setCSVImportOpen] = useState(false);
  const [importNotice, setImportNotice] = useState('');
  const [form, setForm] = useState<{
    type: AccountType;
    institutionName: string;
    name: string;
    file: File | null;
  }>({
    type: 'checking',
    institutionName: '',
    name: '',
    file: null,
  });
  const [submitting, setSubmitting] = useState(false);
  const [showHints, setShowHints] = useState(true);

  // Aggregate stats
  const stats = useMemo(() => {
    if (!accounts) return { total: 0, totalBalance: 0, positive: 0, negative: 0, institutionCount: 0 };
    const instSet = new Set(accounts.map((a) => a.institution_name));
    const totalBalance = accounts.reduce((s, a) => s + a.balance, 0);
    const positive = accounts.reduce((s, a) => s + (a.balance >= 0 ? a.balance : 0), 0);
    const negative = accounts.reduce((s, a) => s + (a.balance < 0 ? a.balance : 0), 0);
    return { total: accounts.length, totalBalance, positive, negative, institutionCount: instSet.size };
  }, [accounts]);

  if (loading) return <LoadingSpinner message="Loading accounts..." />;
  if (error || !accounts) return <ErrorMessage message={error || 'Failed to load'} onRetry={refetch} />;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.institutionName.trim()) return;

    setSubmitting(true);
    try {
      const trimmedInstName = form.institutionName.trim();
      let inst = institutions?.find(
        (i) => i.name.toLowerCase() === trimmedInstName.toLowerCase()
      );

      if (!inst) {
        inst = await createInstitution(trimmedInstName);
      }

      const newAccount = await createAccount({
        institution_id: inst.id,
        name: form.name.trim(),
        type: form.type,
      });

      // Import CSV if provided
      if (form.file) {
        await importTransactionsCSV(form.file, String(newAccount.id));
      }

      setModalOpen(false);
      setForm({ type: 'checking', institutionName: '', name: '', file: null });
      refetch();
      refetchImports();
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevertImport = async (id: number, filename: string) => {
    if (!window.confirm(`Are you sure you want to revert the import of "${filename}"? All transactions and option legs associated with this file will be permanently deleted.`)) {
      return;
    }
    try {
      await revertImport(id);
      refetch();
      refetchImports();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Revert failed');
    }
  };

  const formatImportDate = (dateStr: string) => {
    try {
      const d = new Date(dateStr.replace(' ', 'T'));
      return d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch (e) {
      return dateStr;
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this account and all associated data?')) return;
    await deleteAccount(id);
    refetch();
  };

  const renderedGroups = groups
    .map(({ type, label }) => {
      const grouped = accounts.filter((a) => a.type === type);
      if (grouped.length === 0) return null;
      const cfg = typeConfig[type];
      const Icon = cfg.icon;
      const total = grouped.reduce((s, a) => s + a.balance, 0);

      return (
        <div key={type} className="animate-fade-in">
          {/* Group Header */}
          <div className="flex items-center gap-3 mb-4">
            <div className={`p-2 rounded-xl ${cfg.bg} ${cfg.border} border`}>
              <Icon size={18} className={cfg.color} />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-sm font-bold text-text-primary tracking-tight">{label}</h2>
              <p className="text-[10px] text-text-muted">{grouped.length} account{grouped.length !== 1 ? 's' : ''}</p>
            </div>
            <div className="text-right">
              <p className={`text-base font-bold ${total >= 0 ? 'text-success-400' : 'text-danger-400'}`}>
                {formatCurrency(total)}
              </p>
              <p className="text-[10px] text-text-muted">Group Total</p>
            </div>
          </div>

          {/* Account Cards Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {grouped.map((a) => (
              <AccountCard key={a.id} account={a} config={cfg} onDelete={handleDelete} showHints={showHints} />
            ))}
          </div>
        </div>
      );
    })
    .filter(Boolean);

  return (
    <div className="space-y-8 animate-fade-in">
      {/* ──── Institutional Hero Header ──── */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-surface-card p-6 md:p-8 shadow-lg shadow-black/20">
        <div className="relative z-10 flex flex-col md:flex-row md:items-center md:justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-primary-500/10 text-primary-400 border border-primary-500/20 flex items-center gap-1">
                <Layers size={11} /> {stats.total} Account{stats.total !== 1 ? 's' : ''}
              </span>
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-surface-lighter text-text-muted border border-border">
                {stats.institutionCount} Institution{stats.institutionCount !== 1 ? 's' : ''}
              </span>
            </div>
            <h1 className="text-2xl md:text-3xl font-extrabold text-text-primary tracking-tight">
              Account <span className="text-primary-400">Manager</span>
            </h1>
            <p className="text-text-secondary text-sm mt-1.5 max-w-xl leading-relaxed">
              Track all your financial accounts in one place — balances, institutions, and transaction imports.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 flex-shrink-0">
            <button
              onClick={() => setShowHints(!showHints)}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold transition-all border ${
                showHints
                  ? 'bg-primary-500/10 text-primary-400 border-primary-500/20 shadow-sm'
                  : 'bg-surface text-text-muted border-border hover:text-text-secondary hover:border-border'
              }`}
            >
              <Info size={14} />
              Hints
            </button>
            <button
              onClick={refetch}
              className="p-2.5 rounded-xl border border-border bg-surface-lighter text-text-secondary hover:text-text-primary transition-all active:scale-95"
              title="Refresh accounts"
            >
              <RefreshCw size={16} />
            </button>
            <Button variant="secondary" onClick={() => { setImportNotice(''); setCSVImportOpen(true); }}>
              <Upload size={16} /> Import CSV
            </Button>
            <Button onClick={() => setModalOpen(true)} className="shadow-sm active:scale-95">
              <Plus size={16} /> Add Account
            </Button>
          </div>
        </div>
      </div>

      {importNotice && <p role="status" className="rounded-xl border border-success-500/30 bg-success-500/10 p-4 text-sm text-success-400">{importNotice}</p>}
      {csvImportOpen && <AccountCSVImport accounts={accounts} onClose={() => setCSVImportOpen(false)}
        onImported={message => {
          setCSVImportOpen(false);
          setImportNotice(message);
          refetch();
          refetchImports();
        }} />}

      {/* ──── KPI Summary Row ──── */}
      {accounts.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="hover:border-primary-500/40 transition-all border border-border bg-surface-card">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-primary-400 font-semibold tracking-wide uppercase text-[10px]">Net Balance</p>
                <p className={`text-2xl font-extrabold ${stats.totalBalance >= 0 ? 'text-text-primary' : 'text-danger-400'}`}>
                  {formatCurrency(stats.totalBalance)}
                </p>
                <p className="text-[10px] text-text-muted mt-1">All accounts combined</p>
              </div>
              <div className="p-3 rounded-2xl bg-primary-500/10 border border-primary-500/20">
                <ShieldCheck size={20} className="text-primary-400" />
              </div>
            </div>
          </Card>

          <Card className="hover:border-success-500/40 transition-all border border-border bg-surface-card">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-success-400 font-semibold tracking-wide uppercase text-[10px]">Positive Balances</p>
                <p className="text-2xl font-extrabold text-text-primary">{formatCurrency(stats.positive)}</p>
                <p className="text-[10px] text-text-muted mt-1">Asset accounts</p>
              </div>
              <div className="p-3 rounded-2xl bg-success-500/10 border border-success-500/20">
                <Wallet size={20} className="text-success-400" />
              </div>
            </div>
          </Card>

          <Card className="hover:border-danger-500/40 transition-all border border-border bg-surface-card">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-danger-400 font-semibold tracking-wide uppercase text-[10px]">Negative Balances</p>
                <p className="text-2xl font-extrabold text-text-primary">{formatCurrency(stats.negative)}</p>
                <p className="text-[10px] text-text-muted mt-1">Liabilities & credit</p>
              </div>
              <div className="p-3 rounded-2xl bg-danger-500/10 border border-danger-500/20">
                <CreditCard size={20} className="text-danger-400" />
              </div>
            </div>
          </Card>

          <Card className="hover:border-border/80 transition-all border border-border bg-surface-card">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <p className="text-text-secondary font-semibold tracking-wide uppercase text-[10px]">Total Accounts</p>
                <p className="text-2xl font-extrabold text-text-primary">{stats.total}</p>
                <p className="text-[10px] text-text-muted mt-1">Across {stats.institutionCount} institution{stats.institutionCount !== 1 ? 's' : ''}</p>
              </div>
              <div className="p-3 rounded-2xl bg-surface-lighter border border-border">
                <Layers size={20} className="text-text-secondary" />
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* ──── Account Groups ──── */}
      {accounts.length === 0 ? (
        <Card className="border-dashed py-16 flex flex-col items-center justify-center text-center">
          <div className="w-16 h-16 rounded-2xl bg-surface-lighter border border-border flex items-center justify-center mb-6">
            <Building2 size={32} className="text-text-muted" />
          </div>
          <h3 className="text-xl font-bold text-text-primary tracking-tight">No Accounts Yet</h3>
          <p className="text-text-secondary text-sm max-w-md mt-3 leading-relaxed">
            Get started by linking your first financial account. Click{' '}
            <button onClick={() => setModalOpen(true)} className="font-semibold text-primary-400 hover:text-primary-300 transition-colors inline-flex items-center gap-1 underline underline-offset-2">
              Add Account <ExternalLink size={12} />
            </button>{' '}
            to connect a bank, brokerage, or credit card.
          </p>
        </Card>
      ) : (
        <div className="space-y-8">
          {renderedGroups}
        </div>
      )}

      {/* Import History */}
      <div className="pt-8 border-t border-border/50">
        <div className="mb-4">
          <h2 className="text-lg font-bold text-text-primary">Import History</h2>
          <p className="text-xs text-text-secondary mt-0.5">Track and manage your uploaded statement files</p>
        </div>
        <Card className="!p-0 overflow-hidden">
          <DataTable
            columns={[
              {
                header: 'File Name',
                accessor: (imp: any) => <span className="font-mono text-xs text-text-primary">{imp.filename}</span>,
              },
              {
                header: 'Date Imported',
                accessor: (imp: any) => <span className="text-text-secondary text-xs">{formatImportDate(imp.imported_at)}</span>,
              },
              {
                header: 'Target Account',
                accessor: (imp: any) => <span className="text-text-secondary text-xs">{imp.account_name || 'Auto-Detected'}</span>,
              },
              {
                header: 'Actions',
                accessor: (imp: any) => (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="!py-1 !px-2.5 text-xs text-danger-400 hover:text-danger-300 border-danger-500/20 hover:bg-danger-500/10"
                    onClick={() => handleRevertImport(imp.id, imp.filename)}
                  >
                    Revert
                  </Button>
                ),
                className: 'text-right',
              },
            ]}
            data={imports || []}
            keyField="id"
            emptyMessage="No statement files have been imported yet."
          />
        </Card>
      </div>

      {/* ──── Add Account Modal ──── */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Link / Add Account">
        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Account Type Selector with visual icons */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-text-secondary">Account Type</label>
            <div className="grid grid-cols-5 gap-2">
              {([
                { value: 'checking' as AccountType, label: 'Checking', Icon: Building2 },
                { value: 'savings' as AccountType, label: 'Savings', Icon: PiggyBank },
                { value: 'credit card' as AccountType, label: 'Credit', Icon: CreditCard },
                { value: 'investment' as AccountType, label: 'Invest', Icon: TrendingUp },
                { value: 'loan' as AccountType, label: 'Loan', Icon: Landmark },
              ]).map(({ value, label, Icon }) => {
                const isActive = form.type === value;
                const cfg = typeConfig[value];
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, type: value, institutionName: '' }))}
                    className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border text-xs font-medium transition-all duration-200 ${
                      isActive
                        ? `${cfg.bg} ${cfg.border} ${cfg.color} shadow-sm ring-1 ring-current/20`
                        : 'bg-surface border-border text-text-muted hover:text-text-secondary hover:border-border hover:bg-surface-lighter/40'
                    }`}
                  >
                    <Icon size={18} />
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Institution Input with Autocomplete */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-text-secondary">
              Institution
            </label>
            <div className="relative">
              <div className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none">
                <Building2 size={16} />
              </div>
              <input
                type="text"
                list="institutions-list"
                placeholder={`e.g. ${defaultInstitutionsByType[form.type][0]}`}
                value={form.institutionName}
                onChange={(e) => setForm((f) => ({ ...f, institutionName: e.target.value }))}
                className="w-full pl-10 pr-3 py-2.5 rounded-xl bg-surface border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary-500/40 focus:border-primary-500 transition-all duration-150"
              />
              <datalist id="institutions-list">
                {defaultInstitutionsByType[form.type].map((inst) => (
                  <option key={inst} value={inst} />
                ))}
              </datalist>
            </div>
            <p className="text-[10px] text-text-muted pl-1">Start typing to see suggestions for {form.type} accounts</p>
          </div>

          {/* Account Name */}
          <Input
            label="Account Name"
            placeholder="e.g. Primary Checking"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />

          {/* CSV Upload Zone */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-text-secondary">Import Transactions (Optional)</label>
            <div className="relative group">
              <input
                type="file"
                accept=".csv"
                onChange={(e) => setForm((f) => ({ ...f, file: e.target.files?.[0] || null }))}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
              />
              <div className={`px-4 py-4 rounded-xl border border-dashed text-sm flex items-center justify-center gap-3 transition-all duration-200 ${
                form.file
                  ? 'bg-success-500/5 border-success-500/30 text-success-400'
                  : 'bg-surface border-border text-text-muted group-hover:bg-surface-lighter/40 group-hover:border-primary-500/30 group-hover:text-text-secondary'
              }`}>
                <Upload size={18} className={form.file ? 'text-success-400' : ''} />
                <span className="font-medium">{form.file ? form.file.name : 'Drop CSV file or click to browse'}</span>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-5 border-t border-border/50">
            <Button variant="secondary" type="button" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={submitting || !form.name.trim() || !form.institutionName.trim()}>
              {submitting ? 'Adding...' : 'Add Account'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/* ──── Account Card Component ──── */
function AccountCard({
  account,
  config,
  onDelete,
  showHints,
}: {
  account: Account;
  config: typeof typeConfig.checking;
  onDelete: (id: number) => void;
  showHints: boolean;
}) {
  const Icon = config.icon;
  const isPositive = account.balance >= 0;

  return (
    <Card className={`group relative hover:scale-[1.015] duration-300 transition-all border hover:shadow-xl ${config.border} hover:border-primary-500/30`}>
      {/* Delete Button */}
      <button
        onClick={() => onDelete(account.id)}
        className="absolute top-4 right-4 p-1.5 rounded-lg text-text-muted hover:text-danger-400 hover:bg-danger-500/10 opacity-0 group-hover:opacity-100 transition-all duration-200"
        title="Delete account"
      >
        <Trash2 size={14} />
      </button>

      <div className="flex items-start gap-4">
        {/* Icon Badge */}
        <div className={`p-3 rounded-xl ${config.bg} ${config.border} border shadow-sm`}>
          <Icon size={20} className={config.color} />
        </div>

        {/* Account Info */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-text-primary truncate tracking-tight">{account.name}</p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <Building2 size={10} className="text-text-muted flex-shrink-0" />
            <p className="text-[11px] text-text-muted truncate">{account.institution_name}</p>
          </div>

          <Tooltip enabled={showHints} content="Current balance based on all imported transactions. For brokerage accounts, this includes net premium from options and trade activity.">
            <div className="mt-3 pt-3 border-t border-border/30">
              <p className="text-[10px] text-text-muted uppercase tracking-wider font-medium mb-0.5">Balance</p>
              <p className={`text-xl font-extrabold cursor-help ${isPositive ? 'text-success-400' : 'text-danger-400'}`}>
                {formatCurrency(account.balance)}
              </p>
            </div>
          </Tooltip>

          {account.unrealized_pl_target !== undefined && Math.abs(account.unrealized_pl_target) > 0.001 && (
            <Tooltip enabled={showHints} content="Absolute maximum target profit from your currently open options positions in this account.">
              <div className="mt-2.5 pt-2.5 border-t border-border/20 flex items-center justify-between">
                <p className="text-[9px] text-text-muted uppercase tracking-wider font-medium">Options Target</p>
                <p className={`text-xs font-bold ${account.unrealized_pl_target >= 0 ? 'text-success-400' : 'text-danger-400'}`}>
                  {account.unrealized_pl_target >= 0 ? '+' : ''}{formatCurrency(account.unrealized_pl_target)}
                </p>
              </div>
            </Tooltip>
          )}

          {account.has_past_expiration && (
            <Tooltip enabled={showHints} content="Option contracts past expiration awaiting broker confirmation (excluded from target and realized P/L).">
              <div className="mt-2 pt-2 border-t border-border/20 flex items-center justify-between">
                <span className="text-[9px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded flex items-center gap-1">
                  <AlertTriangle size={9} />
                  Past Expiration
                </span>
                <p className="text-xs font-bold text-amber-400">
                  {formatCurrency(account.past_expiration_pl || 0)}
                </p>
              </div>
            </Tooltip>
          )}
        </div>
      </div>
    </Card>
  );
}
