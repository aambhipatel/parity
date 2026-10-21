export interface Institution {
  id: number;
  name: string;
}

export type AccountType = 'checking' | 'savings' | 'credit card' | 'investment' | 'loan';

export interface Account {
  id: number;
  institution_name: string;
  name: string;
  type: AccountType;
  balance: number;
  unrealized_pl_target?: number;
  past_expiration_pl?: number;
  has_past_expiration?: boolean;
}

export interface Transaction {
  id: number;
  account_id: number;
  account_name: string;
  date: string;
  amount: number;
  category: string;
  description: string;
}

export interface IncomeStatement {
  income: Record<string, number>;
  expenses: Record<string, number>;
  total_income: number;
  total_expenses: number;
  net_income: number;
}

export interface BalanceSheet {
  assets: Record<string, number>;
  liabilities: Record<string, number>;
  total_assets: number;
  total_liabilities: number;
  equity: number;
}

export interface CashFlow {
  operating: number;
  investing: number;
  financing: number;
  total_net_flow: number;
}

export interface DashboardSummary {
  total_assets: number;
  total_liabilities: number;
  net_worth: number;
  monthly_income: number;
  monthly_expenses: number;
  recent_transactions: Transaction[];
  net_worth_history: { month: string; value: number }[];
  income_expense_history: { month: string; income: number; expenses: number }[];
  options_target_pl?: number;
  options_past_expiration_pl?: number;
  has_past_expiration?: boolean;
}

export interface PortfolioHolding {
  ticker: string;
  shares: number;
  avg_price: number;
  current_price: number;
  current_value: number;
  profit: number;
  profit_pct: number;
  incomplete_basis?: boolean;
}

export interface RealizedGain {
  ticker: string;
  realized_profit: number;
  incomplete_basis?: boolean;
}

export interface Portfolio {
  total_value: number;
  total_cost: number;
  total_profit: number;
  total_realized_profit: number;
  first_trade_date: string | null;
  holdings: PortfolioHolding[];
  realized_gains: RealizedGain[];
}

export interface DatabaseInfo {
  filename: string;
  display_name: string;
  full_path?: string;
  size_bytes: number;
  modified_at: string | null;
  is_active: boolean;
  is_default?: boolean;
  is_protected?: boolean;
  accounts_count?: number;
  transactions_count?: number;
  positions_count?: number;
}

export interface DatabaseListResponse {
  databases: DatabaseInfo[];
}

export interface WeeklyPerformanceRecord {
  monday_date: string;
  sunday_date: string;
  closed_realized_pl: number;
  expired_realized_pl: number;
  total_realized_pl: number;
  future_target_pl: number;
  net_pl: number;
  display_closed_realized_pl?: number;
  display_expired_realized_pl?: number;
  display_total_realized_pl?: number;
  display_future_target_pl?: number;
  display_net_pl?: number;
  trade_count: number;
  closed_trade_count: number;
  expired_trade_count: number;
  open_trade_count: number;
  is_future: boolean;
  by_ticker?: Record<string, {
    closed_realized_pl: number;
    expired_realized_pl: number;
    total_realized_pl: number;
    future_target_pl: number;
    trade_count: number;
  }>;
}

export interface MonthlyPerformanceRecord {
  month_key: string;
  closed_realized_pl: number;
  expired_realized_pl: number;
  total_realized_pl: number;
  future_target_pl: number;
  net_pl: number;
  display_closed_realized_pl?: number;
  display_expired_realized_pl?: number;
  display_total_realized_pl?: number;
  display_future_target_pl?: number;
  display_net_pl?: number;
  trade_count: number;
  closed_trade_count: number;
  expired_trade_count: number;
  open_trade_count: number;
  is_future: boolean;
  by_ticker?: Record<string, {
    closed_realized_pl: number;
    expired_realized_pl: number;
    total_realized_pl: number;
    future_target_pl: number;
    trade_count: number;
  }>;
}

export interface OptionsPortfolioData {
  positions: any[];
  combined_realized_pl: number;
  closed_realized_pl: number;
  expired_realized_pl: number;
  total_realized_pl: number;
  total_unrealized_pl: number;
  total_past_expiration_pl: number;
  past_expiration_count: number;
  realized_plus_target_pl: number;
  display_combined_realized_pl?: number;
  display_closed_realized_pl?: number;
  display_expired_realized_pl?: number;
  display_total_realized_pl?: number;
  display_total_unrealized_pl?: number;
  display_realized_plus_target_pl?: number;
  unmatched_closes_amount: number;
  unmatched_closes_abs_amount?: number;
  unmatched_closes_count: number;
  unmatched_closes_total_count: number;
  total_unmatched_closes_pl: number;
  unmatched_closes_label?: string;
  realized_pl_note?: string | null;
  total_cost_basis: number;
  options_fees: number;
  stock_fees: number;
  total_fees: number;
  win_rate: number;
  total_closed: number;
  weekly_targets?: Record<string, any>;
  weekly_performance?: WeeklyPerformanceRecord[];
  monthly_performance?: MonthlyPerformanceRecord[];
  data_quality_warnings?: string[];
}

