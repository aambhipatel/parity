import { useRef, useState, type FormEvent } from 'react';
import { Upload } from 'lucide-react';
import { Modal } from './Modal';
import { Button, Input, Select } from './FormControls';
import { importTransactionsCSV } from '../services/api';
import type { Account } from '../types';

export function AccountCSVImport({ accounts, onClose, onImported }: {
  accounts: Account[];
  onClose: () => void;
  onImported: (message: string) => void;
}) {
  const [accountId, setAccountId] = useState(accounts.length === 1 ? String(accounts[0].id) : '');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const close = () => { if (!inFlight.current) onClose(); };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (inFlight.current || !file || !accounts.some(a => String(a.id) === accountId)) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await importTransactionsCSV(file, accountId);
      onImported(result.message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Import failed. Please try again.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return <Modal open onClose={close} title="Import CSV">
    <form onSubmit={submit} className="space-y-5" aria-busy={busy}>
      <p className="text-sm text-text-secondary">Import transactions into an existing account. All rows in this file will be assigned to the selected account.</p>
      {!accounts.length && <p role="status" className="text-sm text-text-secondary">Add an account first, then return here to import its transactions.</p>}
      <Select label="Destination account" id="csv-import-account" value={accountId}
        onChange={event => { setAccountId(event.target.value); setError(''); }}
        required disabled={busy || !accounts.length}
        options={[{ value: '', label: 'Select an account' }, ...accounts.map(a => ({
          value: String(a.id), label: `${a.name} · ${a.institution_name}`,
        }))]} />
      <Input label="CSV file" id="account-csv-file" type="file" accept=".csv,text/csv" required
        disabled={busy || !accounts.length} onChange={event => {
          const selected = event.target.files?.[0] ?? null;
          setError('');
          if (selected && (!/\.csv$/i.test(selected.name) || selected.size === 0)) {
            setFile(null);
            setError(selected.size === 0 ? 'The CSV file is empty. Choose a file with transactions.' : 'Choose a .csv file.');
            event.target.value = '';
          } else setFile(selected);
        }} />
      <p className="text-xs text-text-secondary">Use a supported bank or broker export with a date and amount column. Broker Action columns are supported.</p>
      {error && <p role="alert" className="text-sm text-danger-400 whitespace-pre-wrap break-words">{error}</p>}
      {busy && <p role="status" className="text-sm text-text-secondary">Importing transactions…</p>}
      <div className="flex justify-end gap-3">
        <Button type="button" variant="secondary" onClick={close} disabled={busy}>Cancel</Button>
        <Button type="submit" disabled={busy || !file || !accountId}>
          <Upload size={16} /> {busy ? 'Importing…' : 'Import transactions'}
        </Button>
      </div>
    </form>
  </Modal>;
}
