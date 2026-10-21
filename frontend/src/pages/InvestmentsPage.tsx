import { Card, CardTitle, CardValue } from '../components/Card';
import { DataTable } from '../components/DataTable';
import { LoadingSpinner, ErrorMessage } from '../components/StatusIndicators';
import { useAsync } from '../hooks/useAsync';
import { getPortfolio } from '../services/api';
import { formatCurrency } from '../utils/helpers';
import type { PortfolioHolding, RealizedGain } from '../types';

export function InvestmentsPage() {
  const { data, loading, error, refetch } = useAsync(() => getPortfolio(), []);

  if (loading) return <LoadingSpinner message="Loading investments..." />;
  if (error || !data) return <ErrorMessage message={error || 'Failed to load portfolio'} onRetry={refetch} />;

  const columns = [
    {
      header: 'Ticker',
      accessor: (h: PortfolioHolding) => (
        <span className="font-bold text-text-primary px-2 py-1 bg-surface-lighter rounded-md uppercase">
          {h.ticker}
        </span>
      ),
    },
    {
      header: 'Shares',
      accessor: (h: PortfolioHolding) => h.shares.toLocaleString(undefined, { maximumFractionDigits: 4 }),
    },
    {
      header: 'Avg Cost',
      accessor: (h: PortfolioHolding) => formatCurrency(h.avg_price),
      className: 'text-right',
    },
    {
      header: 'Current Price',
      accessor: (h: PortfolioHolding) => formatCurrency(h.current_price),
      className: 'text-right',
    },
    {
      header: 'Market Value',
      accessor: (h: PortfolioHolding) => <span className="font-semibold text-text-primary">{formatCurrency(h.current_value)}</span>,
      className: 'text-right',
    },
    {
      header: 'Profit/Loss',
      accessor: (h: PortfolioHolding) => (
        <div className="flex flex-col items-end gap-0.5">
          <span className={`font-semibold ${h.profit >= 0 ? 'text-success-400' : 'text-danger-400'}`}>
            {h.profit >= 0 ? '+' : ''}{formatCurrency(h.profit)}
          </span>
          <span className={`text-xs ${h.profit_pct >= 0 ? 'text-success-500' : 'text-danger-500'}`}>
            {h.profit_pct >= 0 ? '+' : ''}{h.profit_pct.toFixed(2)}%
          </span>
          {h.incomplete_basis && (
            <span
              className="text-[10px] font-semibold text-amber-400/80"
              title="Cost basis is partial — some lots predate imported history. Unrealized P/L may be understated."
            >
              ⚠ partial basis
            </span>
          )}
        </div>
      ),
      className: 'text-right',
    },
  ];

  const realizedColumns = [
    {
      header: 'Ticker',
      accessor: (h: RealizedGain) => (
        <span className="font-bold text-text-primary px-2 py-1 bg-surface-lighter rounded-md uppercase">
          {h.ticker}
        </span>
      ),
    },
    {
      header: 'Realized Profit',
      accessor: (h: RealizedGain) => (
        <span className={`font-bold ${h.realized_profit >= 0 ? 'text-success-400' : 'text-danger-400'}`}>
          {h.realized_profit >= 0 ? '+' : ''}{formatCurrency(h.realized_profit)}
        </span>
      ),
      className: 'text-right',
    },
    {
      header: 'Basis',
      accessor: (h: RealizedGain) => h.incomplete_basis ? (
        <span
          className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-400 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded"
          title="Opening lots for this position predate imported transaction history. Realized P/L is computed against $0 cost basis and may be significantly overstated."
        >
          ⚠ Incomplete
        </span>
      ) : (
        <span className="text-[11px] text-success-400/70">Complete</span>
      ),
      className: 'text-right',
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Investments</h1>
          <p className="text-text-secondary text-sm mt-1">
            Real-time portfolio tracking and performance.
            {data.first_trade_date && (
              <span className="ml-2 px-2 py-0.5 bg-surface-lighter rounded text-text-muted text-xs">
                Tracking since {data.first_trade_date}
              </span>
            )}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-5">
        <Card>
          <CardTitle>Total Market Value</CardTitle>
          <CardValue className="text-text-primary">{formatCurrency(data.total_value)}</CardValue>
        </Card>
        <Card>
          <CardTitle>Total Cost Basis</CardTitle>
          <CardValue className="text-text-secondary">{formatCurrency(data.total_cost)}</CardValue>
        </Card>
        <Card>
          <CardTitle>Unrealized Profit/Loss</CardTitle>
          <CardValue className={data.total_profit >= 0 ? 'text-success-400' : 'text-danger-400'}>
            {data.total_profit >= 0 ? '+' : ''}{formatCurrency(data.total_profit)}
          </CardValue>
        </Card>
        <Card>
          <CardTitle>Total Realized Gains</CardTitle>
          <CardValue className={data.total_realized_profit >= 0 ? 'text-success-400' : 'text-danger-400'}>
            {data.total_realized_profit >= 0 ? '+' : ''}{formatCurrency(data.total_realized_profit)}
          </CardValue>
        </Card>
      </div>

      <Card className="!p-0 overflow-hidden">
        <div className="p-4 border-b border-border">
          <h2 className="text-base font-semibold text-text-primary">Current Holdings</h2>
        </div>
        <DataTable
          columns={columns}
          data={data.holdings}
          keyField="ticker"
          emptyMessage="No active holdings found. Try importing a standard brokerage CSV with accurate quantity and price."
        />
      </Card>
      {data.realized_gains && data.realized_gains.length > 0 && (() => {
        const incompleteCount = data.realized_gains.filter((g: RealizedGain) => g.incomplete_basis).length;
        return (
          <Card className="!p-0 overflow-hidden mt-6">
            <div className="p-4 border-b border-border flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-text-primary">Realized Gains (Sold Positions)</h2>
              {incompleteCount > 0 && (
                <span
                  className="text-xs font-semibold text-amber-400 bg-amber-500/10 border border-amber-500/30 px-2 py-1 rounded"
                  title="Some tickers show realized P/L computed against $0 cost basis because their opening lots predate imported history. These figures may be significantly overstated."
                >
                  ⚠ {incompleteCount} ticker{incompleteCount > 1 ? 's' : ''} with incomplete cost basis
                </span>
              )}
            </div>
            <DataTable
              columns={realizedColumns}
              data={data.realized_gains}
              keyField="ticker"
              emptyMessage="No realized gains found."
            />
          </Card>
        );
      })()}
    </div>
  );
}
