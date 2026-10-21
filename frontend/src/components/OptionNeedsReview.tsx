import { useEffect, useState } from 'react';
import { getOptionIssues, type OptionIssueList } from '../services/api';
import { Card, CardTitle } from './Card';
import { formatCurrency } from '../utils/helpers';

const title = (value: string) => value.replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());
const signed = (value: string) => `${Number(value) > 0 ? '+' : ''}${formatCurrency(Number(value))}`;

/** Deliberately has no mutation callbacks, modal state, or mutation API imports. */
export function OptionNeedsReview({ accountsKey, revision }: { accountsKey: string; revision: unknown }) {
  const [type, setType] = useState('');
  const [result, setResult] = useState<OptionIssueList | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    getOptionIssues(accountsKey ? accountsKey.split(',').map(Number) : [], type || undefined)
      .then(value => { if (!cancelled) setResult(value); })
      .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Unable to load issues'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [accountsKey, type, revision, retry]);
  return (
    <Card className="!p-0 overflow-hidden" >
      <section aria-labelledby="option-review-title" aria-busy={loading}>
        <div className="p-4 flex flex-wrap items-center justify-between gap-3 border-b border-border">
          <div>
            <CardTitle><span id="option-review-title">Needs Review</span></CardTitle>
            <p className="text-sm text-text-secondary mt-1">Selected accounts · warnings first, informational matches last</p>
          </div>
          <label className="text-sm text-text-secondary flex items-center gap-2">
            Issue type
            <select value={type} onChange={event => setType(event.target.value)}
              className="bg-surface border border-border rounded-lg p-2 text-text-primary max-w-64 focus-visible:outline-2 focus-visible:outline-primary-400">
              <option value="">All types</option>
              {result?.available_types.map(value => <option key={value} value={value}>{title(value)}</option>)}
            </select>
          </label>
        </div>
        {loading ? <p role="status" className="p-4 text-text-secondary">Loading review issues…</p>
          : error ? <div role="alert" className="p-4 text-danger-400">Could not load review issues: {error}
            <button className="ml-3 underline underline-offset-4" onClick={() => setRetry(value => value + 1)}>Retry</button></div>
          : !result?.count ? <p role="status" className="p-4 text-text-secondary">No issues for these accounts and this type.</p>
          : <>
            <p className="px-4 py-2 text-sm text-text-secondary">{result.count} {result.count === 1 ? 'issue' : 'issues'} · Workflow names below are references; use the existing trade controls to act.</p>
            <ul className="divide-y divide-border max-h-[36rem] overflow-y-auto">
              {result.issues.map(issue => <li key={issue.issue_id} className="p-4 space-y-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className={`text-xs font-semibold ${issue.severity === 'info' ? 'text-text-secondary' : 'text-warning-400'}`}>
                    {issue.severity === 'info' ? 'Information' : 'Warning'}</span>
                  <h3 className="font-semibold text-text-primary">{title(issue.kind)}</h3>
                  {issue.contract && <span className="text-sm text-text-secondary tabular-nums">
                    {issue.contract.underlying} · {issue.contract.expiration} · {issue.contract.strike} {issue.contract.option_type}</span>}
                </div>
                <p className="text-sm text-text-secondary max-w-prose break-words">{issue.message}</p>
                <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
                  <div><dt className="text-text-secondary">Issue quantity</dt><dd className="tabular-nums text-text-primary">{issue.quantity ?? 'See source quantities below'}</dd></div>
                  <div><dt className="text-text-secondary">Signed cash</dt><dd className="tabular-nums text-text-primary">{issue.signed_cash === null ? 'See source cash below' : signed(issue.signed_cash)}</dd></div>
                </dl>
                <p className="text-xs text-text-secondary">{issue.cash_scope}</p>
                <details className="text-sm text-text-secondary">
                  <summary className="cursor-pointer w-fit focus-visible:outline-2 focus-visible:outline-primary-400">Provenance · {issue.provenance.length} source {issue.provenance.length === 1 ? 'transaction' : 'transactions'}</summary>
                  <ul className="mt-2 space-y-2">
                    {issue.provenance.map(row => <li key={row.transaction_id} className="break-words tabular-nums">
                      #{row.transaction_id} · {row.account_name ?? 'Account unavailable'} · {row.date ?? 'Date unavailable'} · {row.category}
                      <br />Quantity {row.quantity ?? 'unknown'} · Cash {row.signed_cash === undefined ? 'unknown' : signed(row.signed_cash)} · {title(row.source)}
                      {row.filename && <span className="block break-all">{row.filename}</span>}
                    </li>)}
                  </ul>
                </details>
                <p className="text-sm text-text-secondary">Available workflows: {issue.available_actions.join('; ') || 'No action required.'}</p>
              </li>)}
            </ul>
          </>}
      </section>
    </Card>
  );
}
