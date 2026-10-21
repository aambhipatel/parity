import type {
  Account,
  Institution,
  Transaction,
  IncomeStatement,
  BalanceSheet,
  CashFlow,
  DashboardSummary,
  Portfolio,
  DatabaseInfo,
  DatabaseListResponse,
} from '../types';

const API_BASE = '/api';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

// ─── Institutions ────────────────────────────────────────────
export async function getInstitutions(): Promise<Institution[]> {
  return request<Institution[]>('/institutions');
}

export async function createInstitution(name: string): Promise<Institution> {
  return request<Institution>('/institutions', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

// ─── Accounts ────────────────────────────────────────────────
export async function getAccounts(): Promise<Account[]> {
  return request<Account[]>('/accounts');
}

export async function createAccount(data: {
  institution_id: number;
  name: string;
  type: string;
}): Promise<Account> {
  return request<Account>('/accounts', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function deleteAccount(id: number): Promise<void> {
  return request<void>(`/accounts/${id}`, { method: 'DELETE' });
}

export async function updateAccount(id: number, data: { name: string }): Promise<void> {
  return request<void>(`/accounts/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

// ─── Transactions ────────────────────────────────────────────
export async function getTransactions(params?: {
  account_id?: number;
  category?: string;
  start_date?: string;
  end_date?: string;
  search?: string;
}): Promise<Transaction[]> {
  const query = new URLSearchParams();
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== '') query.set(k, String(v));
    });
  }
  const qs = query.toString();
  return request<Transaction[]>(`/transactions${qs ? `?${qs}` : ''}`);
}

export async function createTransaction(data: {
  account_id: number;
  date: string;
  amount: number;
  category: string;
  description: string;
}): Promise<Transaction> {
  return request<Transaction>('/transactions', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function importTransactionsCSV(file: File, accountId?: string): Promise<{ message: string }> {
  const formData = new FormData();
  formData.append('file', file);
  if (accountId) formData.append('account_id', accountId);

  const res = await fetch(`${API_BASE}/transactions/import`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Import failed');
  }
  return res.json();
}

// ─── Reports ─────────────────────────────────────────────────
export async function getIncomeStatement(month: string, accountId?: string): Promise<IncomeStatement> {
  const qs = accountId ? `&account_id=${accountId}` : '';
  return request<IncomeStatement>(`/reports/income-statement?month=${month}${qs}`);
}

export async function getBalanceSheet(date: string, accountId?: string): Promise<BalanceSheet> {
  const qs = accountId ? `&account_id=${accountId}` : '';
  return request<BalanceSheet>(`/reports/balance-sheet?date=${date}${qs}`);
}

export async function getCashFlow(month: string, accountId?: string): Promise<CashFlow> {
  const qs = accountId ? `&account_id=${accountId}` : '';
  return request<CashFlow>(`/reports/cash-flow?month=${month}${qs}`);
}

// ─── Dashboard ───────────────────────────────────────────────
export async function getDashboardSummary(): Promise<DashboardSummary> {
  return request<DashboardSummary>('/dashboard');
}

export async function getPortfolio(): Promise<Portfolio> {
  return request<Portfolio>('/portfolio');
}

export async function getOptionsPortfolio(accountIds?: number[], asOfDate?: string): Promise<any> {
  const params = new URLSearchParams();
  if (accountIds && accountIds.length > 0) {
    params.set('account_ids', accountIds.join(','));
  }
  if (asOfDate) {
    params.set('as_of_date', asOfDate);
  }
  params.set('_t', Date.now().toString());
  const finalUrl = `/options?${params.toString()}`;
  console.log(`[API] Fetching options portfolio from: ${finalUrl}`);
  return request<any>(finalUrl);
}

export async function getOptionsPrices(openLegs: any[]): Promise<Record<number, number>> {
  return request<Record<number, number>>('/options/prices', {
    method: 'POST',
    body: JSON.stringify({ open_legs: openLegs }),
  });
}

export interface OptionIssue {
  issue_id: string;
  kind: string;
  severity: 'warning' | 'info';
  message: string;
  account_ids: number[];
  transaction_ids: number[];
  position_id: number | null;
  contract: { underlying: string; expiration: string; strike: string; option_type: string } | null;
  quantity: string | null;
  signed_cash: string | null;
  cash_scope: string;
  available_actions: string[];
  provenance: {
    transaction_id: number;
    account_name?: string;
    date?: string;
    category?: string;
    source: string;
    filename?: string | null;
    quantity?: string | null;
    signed_cash?: string;
  }[];
}

export interface OptionIssueList {
  issues: OptionIssue[];
  count: number;
  available_types: string[];
}

export function getOptionIssues(accountIds: number[], type?: string): Promise<OptionIssueList> {
  const params = new URLSearchParams();
  if (accountIds.length) params.set('account_ids', accountIds.join(','));
  if (type) params.set('type', type);
  return request<OptionIssueList>(`/options/issues?${params}`);
}

export interface CloseOptionPayload {
  account_id: number;
  underlying: string;
  expiration: string;
  strike: number;
  opt_type: string;
  close_type: string;
  close_date: string;
  quantity: number;
  close_price?: number;
  fees?: number;
  notes?: string;
}

export async function closeOptionContract(payload: CloseOptionPayload): Promise<any> {
  return request<any>('/options/close', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function dismissUnmatchedOption(transactionId: number): Promise<any> {
  return request<any>('/options/dismiss', {
    method: 'POST',
    body: JSON.stringify({ transaction_id: transactionId }),
  });
}

export interface CandidateLotAllocation {
  leg_id?: number;
  transaction_id?: number;
  quantity: number;
  expiration: string;
  strike: number;
  opt_type: string;
}

export interface MissingOpenLot {
  open_date: string;
  open_price: number;
  open_action?: 'BTO' | 'STO';
  quantity: number;
  fees?: number;
  notes?: string;
}

export interface DirectionInference {
  inferred_direction: 'LONG' | 'SHORT';
  inferred_open_action: 'BTO' | 'STO';
  inferred_close_action: 'STC' | 'BTC';
  confidence: string;
  inference_reason: string;
}

export interface LinkedStockAssignment {
  found: boolean;
  trade?: {
    id: number;
    date: string;
    category: string;
    quantity: number;
    price: number;
    amount: number;
    description: string;
  } | null;
  warning?: string | null;
  expected: {
    action: string;
    shares: number;
    price: number;
    underlying: string;
    date: string;
  };
}

export interface CandidateOpenLot {
  leg_id: number;
  transaction_id: number;
  date: string;
  expiration: string;
  strike: number;
  opt_type: string;
  action: string;
  open_qty: number;
  price: number;
  amount: number;
  description: string;
  name: string;
  is_exact_match: boolean;
  has_multiple_exact_matches: boolean;
}

export interface MatchOptionPayload {
  transaction_id: number;
  mode: 'reconcile_manual' | 'link_open_leg' | 'create_open';
  manual_transaction_ids?: number[];
  allocations?: CandidateLotAllocation[];
  open_lots?: MissingOpenLot[];
  target_expiration?: string;
  target_strike?: number;
  target_opt_type?: string;
  open_date?: string;
  open_price?: number;
  open_action?: 'BTO' | 'STO';
  open_quantity?: number;
  fees?: number;
  notes?: string;
}

export interface MatchCandidatesResponse {
  unmatched_trade: {
    transaction_id: number;
    account_id: number;
    underlying: string;
    date: string;
    category: string;
    amount: number;
    description: string;
    expiration: string;
    strike: number;
    opt_type: string;
    action: string;
    quantity: number;
    raw_signed_quantity?: number | null;
  };
  direction_inference: DirectionInference;
  linked_stock_assignment?: LinkedStockAssignment | null;
  candidate_manual_closes: Array<{
    transaction_id: number;
    leg_id: number;
    date: string;
    category: string;
    amount: number;
    description: string;
    expiration_date: string | null;
    strike_price: number | null;
    option_type: string | null;
    action: string | null;
    quantity: number;
    is_exact_match: boolean;
    has_multiple_exact_matches?: boolean;
  }>;
  candidate_open_lots: CandidateOpenLot[];
  candidate_open_contracts: Array<{
    name: string;
    expiration: string;
    strike: number;
    opt_type: string;
    action: string;
    open_qty: number;
    legs: any[];
  }>;
}

export async function getMatchCandidates(transactionId: number): Promise<MatchCandidatesResponse> {
  return request<MatchCandidatesResponse>(`/options/unmatched/candidates/${transactionId}`);
}

export async function matchOptionContract(payload: MatchOptionPayload): Promise<any> {
  return request<any>('/options/match', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}


// ─── Database ────────────────────────────────────────────────
export async function wipeDatabase(password: string): Promise<{ message: string }> {
  return request<{ message: string }>('/wipe', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

// ─── Admin ───────────────────────────────────────────────────
export async function getAdminStatus(): Promise<{ password_set: boolean }> {
  return request<{ password_set: boolean }>('/admin/status');
}

export async function setAdminPassword(password: string): Promise<{ message: string }> {
  return request<{ message: string }>('/admin/set-password', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export async function verifyAdminPassword(password: string): Promise<{ verified: boolean }> {
  return request<{ verified: boolean }>('/admin/verify', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export async function changeAdminPassword(currentPassword: string, newPassword: string): Promise<{ message: string }> {
  return request<{ message: string }>('/admin/change-password', {
    method: 'POST',
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
}

// ─── CSV Imports & Reverts ──────────────────────────────────
export interface ImportedFile {
  id: number;
  filename: string;
  imported_at: string;
  account_name?: string;
}

export async function getImports(): Promise<ImportedFile[]> {
  return request<ImportedFile[]>('/imports');
}

export async function revertLastImport(): Promise<{ success: boolean; message: string }> {
  return request<{ success: boolean; message: string }>('/imports/last', {
    method: 'DELETE',
  });
}

export async function revertImport(id: number): Promise<{ success: boolean; message: string }> {
  return request<{ success: boolean; message: string }>(`/imports/${id}`, {
    method: 'DELETE',
  });
}

// ─── Database Management ─────────────────────────────────────
export async function getCurrentDatabase(): Promise<DatabaseInfo> {
  return request<DatabaseInfo>('/database/current');
}

export async function listDatabases(): Promise<DatabaseListResponse> {
  return request<DatabaseListResponse>('/database/list');
}

export async function switchDatabase(
  filename: string,
  password?: string
): Promise<{ message: string; database: DatabaseInfo }> {
  return request<{ message: string; database: DatabaseInfo }>('/database/switch', {
    method: 'POST',
    body: JSON.stringify({ filename, password }),
  });
}

export async function renameDatabase(
  filename: string,
  displayName: string
): Promise<{ message: string; database: { filename: string; display_name: string } }> {
  return request<{ message: string; database: { filename: string; display_name: string } }>('/database/rename', {
    method: 'POST',
    body: JSON.stringify({ filename, display_name: displayName }),
  });
}

export async function getDefaultDatabase(): Promise<{ default_db: string; database?: DatabaseInfo }> {
  return request<{ default_db: string; database?: DatabaseInfo }>('/database/default');
}

export async function setDefaultDatabase(
  filename: string
): Promise<{ filename: string; is_default: boolean; message: string }> {
  return request<{ filename: string; is_default: boolean; message: string }>('/database/set-default', {
    method: 'POST',
    body: JSON.stringify({ filename }),
  });
}

export async function resetToDefaultDatabase(
  password?: string
): Promise<{ message: string; database: DatabaseInfo }> {
  return request<{ message: string; database: DatabaseInfo }>('/database/reset-to-default', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export async function createDatabase(
  filename: string,
  displayName?: string,
  copyFromCurrent: boolean = false,
  password?: string,
  setAsDefault: boolean = false
): Promise<{ message: string; database: DatabaseInfo }> {
  return request<{ message: string; database: DatabaseInfo }>('/database/create', {
    method: 'POST',
    body: JSON.stringify({
      filename,
      display_name: displayName,
      copy_from_current: copyFromCurrent,
      password,
      set_as_default: setAsDefault
    }),
  });
}

export async function deleteDatabase(filename: string): Promise<{ message: string }> {
  return request<{ message: string }>('/database/delete', {
    method: 'POST',
    body: JSON.stringify({ filename }),
  });
}

export async function protectDatabase(
  filename: string,
  newPassword: string,
  currentPassword?: string
): Promise<{ filename: string; is_protected: boolean; message: string }> {
  return request<{ filename: string; is_protected: boolean; message: string }>('/database/protect', {
    method: 'POST',
    body: JSON.stringify({ filename, new_password: newPassword, current_password: currentPassword }),
  });
}

export async function unprotectDatabase(
  filename: string,
  currentPassword?: string
): Promise<{ filename: string; is_protected: boolean; message: string }> {
  return request<{ filename: string; is_protected: boolean; message: string }>('/database/unprotect', {
    method: 'POST',
    body: JSON.stringify({ filename, current_password: currentPassword }),
  });
}

export async function verifyDatabasePassword(
  filename: string,
  password: string
): Promise<{ valid: boolean; is_protected: boolean }> {
  return request<{ valid: boolean; is_protected: boolean }>('/database/verify-password', {
    method: 'POST',
    body: JSON.stringify({ filename, password }),
  });
}

export async function uploadDatabase(
  file: File,
  displayName?: string,
  switchNow: boolean = false,
  password?: string,
  setAsDefault: boolean = false
): Promise<{ message: string; database: DatabaseInfo }> {
  const formData = new FormData();
  formData.append('file', file);
  if (displayName) {
    formData.append('display_name', displayName);
  }
  formData.append('switch_now', String(switchNow));
  if (password) {
    formData.append('password', password);
  }
  formData.append('set_as_default', String(setAsDefault));

  const res = await fetch('/api/database/upload', {
    method: 'POST',
    body: formData,
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Database upload failed (${res.status})`);
  }
  return res.json();
}



