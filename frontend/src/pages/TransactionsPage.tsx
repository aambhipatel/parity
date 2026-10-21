import { useState, useMemo, useRef } from 'react';
import { Card } from '../components/Card';
import { DataTable } from '../components/DataTable';
import { Modal } from '../components/Modal';
import { Input, Select, Button } from '../components/FormControls';
import { LoadingSpinner, ErrorMessage } from '../components/StatusIndicators';
import { useAsync } from '../hooks/useAsync';
import { getTransactions, getAccounts, createTransaction, importTransactionsCSV } from '../services/api';
import { formatCurrency, formatDate, parseDescription } from '../utils/helpers';
import { Plus, Upload, Search, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import type { Transaction } from '../types';

export function TransactionsPage() {
  const { data: transactions, loading, error, refetch } = useAsync(() => getTransactions(), []);
  const { data: accounts } = useAsync(() => getAccounts(), []);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [filterCat, setFilterCat] = useState('');
  const [filterAccount, setFilterAccount] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [importMsg, setImportMsg] = useState('');
  const [importAccountId, setImportAccountId] = useState('');

  const [form, setForm] = useState({
    account_id: '',
    date: new Date().toISOString().slice(0, 10),
    amount: '',
    category: '',
    description: '',
  });
  const [submitting, setSubmitting] = useState(false);

  const categories = useMemo(() => {
    if (!transactions) return [];
    return [...new Set(transactions.map((t) => t.category))].sort();
  }, [transactions]);

  const filtered = useMemo(() => {
    if (!transactions) return [];
    return transactions.filter((t) => {
      if (search && !t.description.toLowerCase().includes(search.toLowerCase()) && !t.category.toLowerCase().includes(search.toLowerCase())) return false;
      if (filterCat && t.category !== filterCat) return false;
      if (filterAccount && t.account_id !== Number(filterAccount)) return false;
      if (startDate && t.date < startDate) return false;
      if (endDate && t.date > endDate) return false;
      return true;
    });
  }, [transactions, search, filterCat, filterAccount, startDate, endDate]);

  if (loading) return <LoadingSpinner message="Loading transactions..." />;
  if (error) return <ErrorMessage message={error} onRetry={refetch} />;

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.account_id || !form.amount || !form.category) return;
    setSubmitting(true);
    try {
      await createTransaction({
        account_id: Number(form.account_id),
        date: form.date,
        amount: Number(form.amount),
        category: form.category.trim(),
        description: form.description.trim(),
      });
      setAddOpen(false);
      setForm({ account_id: '', date: new Date().toISOString().slice(0, 10), amount: '', category: '', description: '' });
      refetch();
    } finally {
      setSubmitting(false);
    }
  };

  const handleImport = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setImportMsg('Importing...');
    try {
      const result = await importTransactionsCSV(file, importAccountId);
      setImportMsg(result.message);
      refetch();
    } catch (err) {
      setImportMsg(err instanceof Error ? err.message : 'Import failed');
    }
  };

  const columns = [
    {
      header: 'Date',
      accessor: (t: Transaction) => (
        <span className="text-text-secondary text-xs">{formatDate(t.date)}</span>
      ),
    },
    {
      header: 'Description',
      accessor: (t: Transaction) => {
        const parsed = parseDescription(t.description);
        return (
          <div className="flex items-start gap-2">
            <div className={`mt-0.5 w-6 h-6 flex-shrink-0 rounded-md flex items-center justify-center ${
              t.amount >= 0 ? 'bg-success-500/10' : 'bg-danger-500/10'
            }`}>
              {t.amount >= 0
                ? <ArrowUpRight size={12} className="text-success-400" />
                : <ArrowDownRight size={12} className="text-danger-400" />}
            </div>
            <div className="min-w-0">
              <p className="font-medium text-text-primary truncate">{parsed.title || parsed.optionLabel || t.description}</p>
              <div className="flex flex-wrap items-center gap-1.5 mt-1">
                {parsed.optionLabel && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary-500/10 text-primary-400 border border-primary-500/20 font-mono whitespace-nowrap">
                    {parsed.optionLabel}
                  </span>
                )}
                {parsed.qty && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-lighter text-text-muted border border-border whitespace-nowrap">
                    Qty {parsed.qty}
                  </span>
                )}
                {parsed.price && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-lighter text-text-muted border border-border whitespace-nowrap">
                    @ {parsed.price}
                  </span>
                )}
                {parsed.fees && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-danger-500/5 text-danger-400 border border-danger-500/15 whitespace-nowrap">
                    Fees {parsed.fees}
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      },
    },
    {
      header: 'Category',
      accessor: (t: Transaction) => (
        <span className="inline-flex px-2 py-0.5 rounded-md bg-surface-lighter text-xs text-text-secondary capitalize">{t.category}</span>
      ),
    },
    {
      header: 'Account',
      accessor: 'account_name' as keyof Transaction,
    },
    {
      header: 'Amount',
      accessor: (t: Transaction) => (
        <span className={`font-semibold ${t.amount >= 0 ? 'text-success-400' : 'text-danger-400'}`}>
          {formatCurrency(t.amount)}
        </span>
      ),
      className: 'text-right',
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Transactions</h1>
          <p className="text-text-secondary text-sm mt-1">
            {filtered.length} transaction{filtered.length !== 1 ? 's' : ''}
          </p>
        </div>
        <div className="hidden md:flex gap-3">
          <Button variant="secondary" onClick={() => { setImportMsg(''); setImportOpen(true); }}>
            <Upload size={16} /> Import CSV
          </Button>
          <Button onClick={() => setAddOpen(true)}>
            <Plus size={16} /> Add
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card className="!p-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[200px] relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              placeholder="Search transactions..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 rounded-xl bg-surface border border-border text-text-primary text-sm placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary-500/40"
            />
          </div>
          <select
            value={filterCat}
            onChange={(e) => setFilterCat(e.target.value)}
            className="px-3 py-2 rounded-xl bg-surface border border-border text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/40 appearance-none min-w-[140px]"
          >
            <option value="">All Categories</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select
            value={filterAccount}
            onChange={(e) => setFilterAccount(e.target.value)}
            className="px-3 py-2 rounded-xl bg-surface border border-border text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/40 appearance-none min-w-[140px]"
          >
            <option value="">All Accounts</option>
            {(accounts || []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="px-3 py-2 rounded-xl bg-surface border border-border text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/40"
            placeholder="Start date"
          />
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="px-3 py-2 rounded-xl bg-surface border border-border text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/40"
            placeholder="End date"
          />
        </div>
      </Card>

      {/* Table */}
      <Card className="!p-0 overflow-hidden">
        <DataTable columns={columns} data={filtered} keyField="id" emptyMessage="No transactions match your filters." />
      </Card>

      {/* Add Transaction Modal */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add Transaction">
        <form onSubmit={handleAdd} className="space-y-4">
          <Select
            label="Account"
            value={form.account_id}
            onChange={(e) => setForm((f) => ({ ...f, account_id: e.target.value }))}
            options={[
              { value: '', label: 'Select account...' },
              ...(accounts || []).map((a) => ({ value: String(a.id), label: `${a.institution_name} - ${a.name}` })),
            ]}
          />
          <Input label="Date" type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
          <Input label="Amount" type="number" step="0.01" placeholder="Positive = income, negative = expense" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} />
          <Input label="Category" placeholder="e.g. salary, groceries" value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} />
          <Input label="Description" placeholder="Brief note" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" type="button" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={submitting}>{submitting ? 'Adding...' : 'Add Transaction'}</Button>
          </div>
        </form>
      </Modal>

      {/* Import Modal */}
      <Modal open={importOpen} onClose={() => setImportOpen(false)} title="Import CSV">
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            Upload a Charles Schwab or compatible CSV file. Duplicate transactions will be automatically skipped.
          </p>
          <Select
            label="Target Account (Optional)"
            value={importAccountId}
            onChange={(e) => setImportAccountId(e.target.value)}
            options={[
              { value: '', label: 'Auto-detect or Create Default' },
              ...(accounts || []).map((a) => ({ value: String(a.id), label: `${a.institution_name} - ${a.name}` })),
            ]}
          />
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            className="block w-full text-sm text-text-secondary file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-sm file:font-medium file:bg-primary-600 file:text-white hover:file:bg-primary-500 file:cursor-pointer"
          />
          {importMsg && (
            <div className="p-3 rounded-xl bg-surface border border-border text-sm text-text-primary">
              {importMsg}
            </div>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setImportOpen(false)}>Close</Button>
            <Button onClick={handleImport}>
              <Upload size={16} /> Import
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
