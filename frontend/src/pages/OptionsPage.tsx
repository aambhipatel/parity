import { useState, useMemo, useEffect } from 'react';
import { Card, CardTitle } from '../components/Card';
import { LoadingSpinner, ErrorMessage } from '../components/StatusIndicators';
import { useAsync } from '../hooks/useAsync';
import { getOptionsPortfolio, getAccounts, dismissUnmatchedOption } from '../services/api';
import { formatCurrency, formatDate } from '../utils/helpers';
import { Tooltip } from '../components/Tooltip';
import { CompanyTooltip } from '../components/CompanyTooltip';
import {
  TrendingUp,
  Clock,
  ChevronDown,
  ChevronRight,
  DollarSign,
  HelpCircle,
  Calendar,
  Layers,
  Activity,
  AlertTriangle,
  XCircle,
  Trash2,
  Link2
} from 'lucide-react';
import { PayoffModal } from '../components/PayoffModal';
import { CloseOptionModal, type CloseOptionTarget } from '../components/CloseOptionModal';
import { MatchOptionModal, type MatchOptionTarget } from '../components/MatchOptionModal';
import { OptionNeedsReview } from '../components/OptionNeedsReview';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, Cell, ReferenceLine, LabelList
} from 'recharts';

const getStrategyHint = (strategy: string) => {
  if (strategy.includes('Short') || strategy.includes('Naked')) return 'Option sold to collect premium. Obligated if assigned.';
  if (strategy.includes('Long')) return 'Option bought for leverage or hedging. Defined risk limited to premium paid.';
  if (strategy.includes('Vertical Spread')) return 'Two legs, same expiration, different strikes. Defined directional play.';
  if (strategy.includes('Calendar Spread')) return 'Two legs, same strike, different expirations. Time decay play.';
  if (strategy.includes('Diagonal Spread')) return 'Two legs, different strikes, different expirations. Directional and time play.';
  if (strategy.includes('Iron Condor')) return 'Four legs, two spreads. Market neutral play for range-bound price action.';
  if (strategy.includes('Straddle') || strategy.includes('Strangle')) return 'Selling/Buying both sides. Volatility play.';
  return 'Option contract trade.';
};

const getMondayDateStr = (dateStr: string): string => {
  if (!dateStr || !dateStr.includes('-')) return dateStr;
  const d = new Date(dateStr + 'T12:00:00');
  if (isNaN(d.getTime())) return dateStr;
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  const yyyy = monday.getFullYear();
  const mm = String(monday.getMonth() + 1).padStart(2, '0');
  const dd = String(monday.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const getSundayDateStr = (mondayStr: string): string => {
  if (!mondayStr || !mondayStr.includes('-')) return '';
  const d = new Date(mondayStr + 'T12:00:00');
  if (isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + 6);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

export function OptionsPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { data: accountsData } = useAsync(getAccounts, []);
  const [selectedAccounts, setSelectedAccounts] = useState<number[]>([]);

  // Stable key from sorted selected account IDs
  const accountsKey = useMemo(() => {
    return [...selectedAccounts].sort((a, b) => a - b).join(',');
  }, [selectedAccounts]);

  useEffect(() => {
    let cancelled = false;
    const fetchPortfolio = async () => {
      setLoading(true);
      try {
        const ids = accountsKey ? accountsKey.split(',').map(Number) : [];
        const result = await getOptionsPortfolio(ids.length > 0 ? ids : undefined);
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load options data');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    fetchPortfolio();
    return () => { cancelled = true; };
  }, [accountsKey]);

  const refetch = () => {
    const ids = accountsKey ? accountsKey.split(',').map(Number) : [];
    getOptionsPortfolio(ids.length > 0 ? ids : undefined)
      .then(result => { setData(result); setError(null); })
      .catch(err => setError(err instanceof Error ? err.message : 'Failed'));
  };

  const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({});
  const [chartType, setChartType] = useState<'line' | 'bar'>('bar');
  const [timeframe, setTimeframe] = useState<'all' | 'ytd' | 'weekly' | '12w' | '30d_weekly' | '30d' | '7d'>('all');
  const [selectedFilter, setSelectedFilter] = useState<{ type: 'month' | 'week' | 'day'; key: string } | null>(null);
  const selectedWeek = selectedFilter?.type === 'week' ? selectedFilter.key : 'all';
  const setSelectedWeek = (val: string) => {
    if (val === 'all') {
      setSelectedFilter(null);
    } else {
      setSelectedFilter({ type: 'week', key: val });
    }
  };
  const [tradeStatusFilter, setTradeStatusFilter] = useState<'closed' | 'open' | 'all'>('all');
  const [positionFilter, setPositionFilter] = useState<'all' | 'open' | 'closed' | 'needs_review'>('all');
  const [selectedStrategy, setSelectedStrategy] = useState<string>('all');
  const [selectedPayoffStrategy, setSelectedPayoffStrategy] = useState<{ underlying: string; subStrategy: any } | null>(null);
  const [selectedCloseTarget, setSelectedCloseTarget] = useState<CloseOptionTarget | null>(null);
  const [selectedMatchTarget, setSelectedMatchTarget] = useState<MatchOptionTarget | null>(null);
  const [showHints, setShowHints] = useState(true);
  const [selectedTicker, setSelectedTicker] = useState<string>('all');

  const uniqueTickers = useMemo(() => {
    if (!data?.positions) return [];
    const tickers = new Set<string>();
    data.positions.forEach((p: any) => {
      if (p.underlying) {
        tickers.add(p.underlying.toUpperCase());
      }
    });
    return Array.from(tickers).sort();
  }, [data]);

  const uniqueStrategies = useMemo(() => {
    if (!data?.positions) return [];
    const strategies = new Set<string>();
    data.positions.forEach((p: any) => {
      p.sub_strategies?.forEach((sub: any) => {
        if (sub.name) {
          strategies.add(sub.name);
        }
      });
    });
    return Array.from(strategies).sort();
  }, [data]);

  const expiredOpenStats = useMemo(() => {
    if (!data?.positions) return { count: 0, positionsCount: 0 };
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    let count = 0;
    let positionsCount = 0;
    data.positions.forEach((p: any) => {
      let posHasExpired = false;
      p.sub_strategies?.forEach((sub: any) => {
        const isStaleOpen = sub.status === 'Open' && sub.expiration && sub.expiration < todayStr;
        const isUnmatched = sub.is_unmatched || sub.name?.includes('(Needs Review)');
        if (isStaleOpen || isUnmatched) {
          count++;
          posHasExpired = true;
        }
      });
      if (posHasExpired) positionsCount++;
    });
    return { count, positionsCount };
  }, [data]);

  const availableWeeks = useMemo(() => {
    if (data?.weekly_performance && data.weekly_performance.length > 0) {
      return [...data.weekly_performance]
        .sort((a: any, b: any) => b.monday_date.localeCompare(a.monday_date))
        .map((w: any) => ({
          mondayDate: w.monday_date,
          sundayDate: w.sunday_date,
          realizedPl: w.display_total_realized_pl !== undefined ? w.display_total_realized_pl : w.total_realized_pl,
          tradeCount: w.trade_count
        }));
    }
    if (!data?.positions) return [];
    const weekMap: Record<string, { mondayDate: string; sundayDate: string; realizedPl: number; tradeCount: number }> = {};

    data.positions.forEach((p: any) => {
      p.sub_strategies?.forEach((sub: any) => {
        if (sub.status === 'Closed' && sub.legs && sub.legs.length > 0) {
          const sortedLegs = [...sub.legs].sort((a: any, b: any) => a.date.localeCompare(b.date));
          const closeDate = sortedLegs[sortedLegs.length - 1].date;
          const monday = getMondayDateStr(closeDate);
          const sunday = getSundayDateStr(monday);

          if (!weekMap[monday]) {
            weekMap[monday] = {
              mondayDate: monday,
              sundayDate: sunday,
              realizedPl: 0,
              tradeCount: 0
            };
          }
          weekMap[monday].realizedPl += (sub.realized_pl || 0);
          weekMap[monday].tradeCount += 1;
        }
      });
    });

    return Object.values(weekMap).sort((a, b) => b.mondayDate.localeCompare(a.mondayDate));
  }, [data]);

  const formatFilterLabel = (filter: { type: 'month' | 'week' | 'day'; key: string }) => {
    if (filter.type === 'month') {
      const parts = filter.key.split('-');
      if (parts.length >= 2) {
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const mIdx = Number(parts[1]) - 1;
        return `Month: ${monthNames[mIdx] || parts[1]} ${parts[0]}`;
      }
      return `Month: ${filter.key}`;
    }
    if (filter.type === 'week') {
      return `Week: ${formatDate(filter.key)}`;
    }
    return `Day: ${formatDate(filter.key)}`;
  };

  const formatFilterHeader = (filter: { type: 'month' | 'week' | 'day'; key: string }) => {
    if (filter.type === 'month') {
      const parts = filter.key.split('-');
      if (parts.length >= 2) {
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        const mIdx = Number(parts[1]) - 1;
        return `Month of ${monthNames[mIdx] || parts[1]} ${parts[0]}`;
      }
      return `Month of ${filter.key}`;
    }
    if (filter.type === 'week') {
      const sunday = getSundayDateStr(filter.key);
      const rangeText = sunday ? ` (${filter.key} – ${sunday})` : '';
      return `Week of ${formatDate(filter.key)}${rangeText}`;
    }
    return `Day: ${formatDate(filter.key)}`;
  };

  const toggleAccount = (accountId: number) => {
    setSelectedAccounts(prev =>
      prev.includes(accountId)
        ? prev.filter(id => id !== accountId)
        : [...prev, accountId]
    );
  };

  const toggleRow = (id: number) => {
    setExpandedRows(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const chartData = useMemo(() => {
    if (!data?.positions) return [];

    const isDaily = timeframe === '30d' || timeframe === '7d';
    const isWeekly = timeframe === 'weekly' || timeframe === '12w' || timeframe === '30d_weekly';

    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const currentMonth = todayStr.substring(0, 7);
    const nowMonday = getMondayDateStr(todayStr);

    const aggregated: Record<string, { realized: number; unrealized: number; isFuture: boolean }> = {};

    // 1. Weekly view using backend weekly_performance
    if (isWeekly && data?.weekly_performance && data.weekly_performance.length > 0) {
      data.weekly_performance.forEach((w: any) => {
        const mon = w.monday_date;
        const weekDate = new Date(mon + 'T12:00:00');

        if (timeframe === '12w' && (now.getTime() - weekDate.getTime()) > (12 * 7 * 24 * 60 * 60 * 1000)) return;
        if (timeframe === '30d_weekly' && (now.getTime() - weekDate.getTime()) > (30 * 24 * 60 * 60 * 1000)) return;

        let rVal = 0;
        let uVal = 0;
        if (selectedTicker !== 'all') {
          const tData = w.by_ticker?.[selectedTicker];
          if (!tData) return;
          rVal = tData.total_realized_pl || 0;
          uVal = tData.future_target_pl || 0;
        } else {
          rVal = (w.display_total_realized_pl !== undefined ? w.display_total_realized_pl : w.total_realized_pl) || 0;
          uVal = (w.display_future_target_pl !== undefined ? w.display_future_target_pl : w.future_target_pl) || 0;
        }

        if (tradeStatusFilter === 'closed') uVal = 0;
        if (tradeStatusFilter === 'open') rVal = 0;

        if (rVal === 0 && uVal === 0) return;

        aggregated[mon] = {
          realized: rVal,
          unrealized: uVal,
          isFuture: w.is_future ?? (mon > nowMonday)
        };
      });
    }
    // 2. Monthly / YTD view using backend monthly_performance
    else if (!isDaily && data?.monthly_performance && data.monthly_performance.length > 0) {
      data.monthly_performance.forEach((m: any) => {
        const mKey = m.month_key;
        if (timeframe === 'ytd' && !mKey.startsWith(now.getFullYear().toString())) return;

        let rVal = 0;
        let uVal = 0;
        if (selectedTicker !== 'all') {
          const tData = m.by_ticker?.[selectedTicker];
          if (!tData) return;
          rVal = tData.total_realized_pl || 0;
          uVal = tData.future_target_pl || 0;
        } else {
          rVal = (m.display_total_realized_pl !== undefined ? m.display_total_realized_pl : m.total_realized_pl) || 0;
          uVal = (m.display_future_target_pl !== undefined ? m.display_future_target_pl : m.future_target_pl) || 0;
        }

        if (tradeStatusFilter === 'closed') uVal = 0;
        if (tradeStatusFilter === 'open') rVal = 0;

        if (rVal === 0 && uVal === 0) return;

        aggregated[mKey] = {
          realized: rVal,
          unrealized: uVal,
          isFuture: m.is_future ?? (mKey > currentMonth)
        };
      });
    }
    // 3. Daily view (or fallback): aggregate from sub-strategies including Past Expiration
    else {
      data.positions.forEach((p: any) => {
        if (selectedTicker !== 'all' && p.underlying.toUpperCase() !== selectedTicker) return;

        p.sub_strategies?.forEach((sub: any) => {
          if (sub.status === 'Closed') {
            if (tradeStatusFilter === 'open') return;
            const lastDate = sub.close_date || (sub.legs && sub.legs.length > 0 ? [...sub.legs].sort((a: any, b: any) => a.date.localeCompare(b.date)).pop()?.date : sub.expiration);
            if (!lastDate) return;
            const tradeDate = new Date(lastDate + 'T12:00:00');

            if (timeframe === '7d' && (now.getTime() - tradeDate.getTime()) > (7 * 24 * 60 * 60 * 1000)) return;
            if (timeframe === '30d' && (now.getTime() - tradeDate.getTime()) > (30 * 24 * 60 * 60 * 1000)) return;

            const key = isDaily ? lastDate : (isWeekly ? getMondayDateStr(lastDate) : lastDate.substring(0, 7));
            if (!aggregated[key]) aggregated[key] = { realized: 0, unrealized: 0, isFuture: key > todayStr };
            aggregated[key].realized += (sub.realized_pl || 0);
          } else if (sub.status === 'Past Expiration') {
            if (tradeStatusFilter === 'open') return;
            const expDate = sub.expiration;
            if (!expDate) return;
            const tradeDate = new Date(expDate + 'T12:00:00');

            if (timeframe === '7d' && (now.getTime() - tradeDate.getTime()) > (7 * 24 * 60 * 60 * 1000)) return;
            if (timeframe === '30d' && (now.getTime() - tradeDate.getTime()) > (30 * 24 * 60 * 60 * 1000)) return;

            const key = isDaily ? expDate : (isWeekly ? getMondayDateStr(expDate) : expDate.substring(0, 7));
            if (!aggregated[key]) aggregated[key] = { realized: 0, unrealized: 0, isFuture: false };
            aggregated[key].realized += (sub.past_expiration_pl || 0);
          } else if (sub.status === 'Open' && sub.expiration && sub.expiration >= todayStr) {
            if (tradeStatusFilter === 'closed') return;
            const expDate = sub.expiration;
            const key = isDaily ? expDate : (isWeekly ? getMondayDateStr(expDate) : expDate.substring(0, 7));
            if (!aggregated[key]) aggregated[key] = { realized: 0, unrealized: 0, isFuture: true };
            aggregated[key].unrealized += (sub.unrealized_pl || 0);
          }
        });
      });
    }

    const sortedKeys = Object.keys(aggregated).sort();
    let cumulative = 0;

    return sortedKeys.map(key => {
      const entry = aggregated[key];
      const netPeriod = entry.realized + entry.unrealized;
      cumulative += netPeriod;

      let displayLabel = key;
      if (isWeekly) {
        const parts = key.split('-');
        displayLabel = `Wk ${parts[1]}/${parts[2]}`;
      } else if (isDaily) {
        const parts = key.split('-');
        displayLabel = `${parts[1]}/${parts[2]}`;
      } else {
        const parts = key.split('-');
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const mIdx = Number(parts[1]) - 1;
        displayLabel = `${monthNames[mIdx] || parts[1]} '${parts[0].slice(2)}`;
      }

      let isFuture = entry.isFuture;
      if (isFuture === undefined) {
        if (isWeekly) isFuture = key > nowMonday;
        else if (isDaily) isFuture = key > todayStr;
        else isFuture = key > currentMonth;
      }

      return {
        label: key,
        displayLabel,
        value: netPeriod,
        realized: entry.realized,
        unrealized: entry.unrealized,
        cumulative,
        isFuture
      };
    });
  }, [data, timeframe, tradeStatusFilter, selectedTicker]);

  const extractLabelFromEvent = (state: any): string | undefined => {
    if (!state) return undefined;
    if (state.activePayload && state.activePayload.length > 0) {
      const p = state.activePayload[0].payload;
      if (p && p.label) return p.label;
    }
    if (typeof state.activeTooltipIndex === 'number' && chartData[state.activeTooltipIndex]) {
      return chartData[state.activeTooltipIndex].label;
    }
    if (state.payload && state.payload.label) {
      return state.payload.label;
    }
    if (state.activeLabel) {
      const match = chartData.find(d => d.label === state.activeLabel || d.displayLabel === state.activeLabel);
      if (match) return match.label;
      return state.activeLabel;
    }
    return undefined;
  };

  const handleChartClick = (rawLabel: string | undefined) => {
    if (!rawLabel) return;

    // Resolve rawLabel against chartData to guarantee the canonical ISO key (e.g. "2026-09-07" instead of display "Wk 09/07")
    const match = chartData.find(d => d.label === rawLabel || d.displayLabel === rawLabel);
    const label = match ? match.label : rawLabel;

    let type: 'month' | 'week' | 'day';
    if (timeframe === '30d' || timeframe === '7d') {
      type = 'day';
    } else if (timeframe === 'weekly' || timeframe === '12w' || timeframe === '30d_weekly') {
      type = 'week';
    } else {
      type = 'month';
    }

    if (selectedFilter && selectedFilter.key === label) {
      setSelectedFilter(null);
    } else {
      setSelectedFilter({ type, key: label });
    }
  };

  const yDomain = useMemo(() => {
    if (!chartData || chartData.length === 0) {
      return { minBarVal: 'auto', maxBarVal: 'auto', minLineVal: 'auto', maxLineVal: 'auto' };
    }

    const barVals = chartData.map((d: any) => d.value);
    const lineVals = chartData.map((d: any) => d.cumulative);

    const getTightBounds = (vals: number[], isBar: boolean) => {
      let min = Math.min(...vals);
      let max = Math.max(...vals);

      if (min === max) {
        min = min >= 0 ? Math.max(0, min * 0.8) : min * 1.2;
        max = max >= 0 ? (max === 0 ? 100 : max * 1.2) : max * 0.8;
      }

      const diff = Math.abs(max - min) || 100;
      let paddedMin = min < 0 ? min - diff * 0.15 : (isBar && min < diff * 0.5 ? 0 : Math.max(0, min - diff * 0.15));
      let paddedMax = max > 0 ? max + diff * 0.15 : (isBar && max > -diff * 0.5 ? 0 : Math.min(0, max + diff * 0.15));

      return { min: Math.floor(paddedMin), max: Math.ceil(paddedMax) };
    };

    const barBounds = getTightBounds(barVals, true);
    const lineBounds = getTightBounds(lineVals, false);

    return {
      minBarVal: barBounds.min,
      maxBarVal: barBounds.max,
      minLineVal: lineBounds.min,
      maxLineVal: lineBounds.max,
    };
  }, [chartData]);

  const matchesTimeframe = (dateStr: string, tf: string, filter: { type: 'month' | 'week' | 'day'; key: string } | null) => {
    if (filter) {
      if (filter.type === 'month') {
        return dateStr.startsWith(filter.key);
      }
      if (filter.type === 'week') {
        const sundayStr = getSundayDateStr(filter.key);
        return dateStr >= filter.key && dateStr <= sundayStr;
      }
      if (filter.type === 'day') {
        return dateStr === filter.key;
      }
    }
    if (tf === 'all' || tf === 'weekly') return true;
    const tradeDate = new Date(dateStr + 'T12:00:00');
    const now = new Date();
    if (tf === 'ytd') return dateStr.startsWith(now.getFullYear().toString());
    if (tf === '12w') return (now.getTime() - tradeDate.getTime()) <= (12 * 7 * 24 * 60 * 60 * 1000);
    if (tf === '30d' || tf === '30d_weekly') return (now.getTime() - tradeDate.getTime()) <= (30 * 24 * 60 * 60 * 1000);
    if (tf === '7d') return (now.getTime() - tradeDate.getTime()) <= (7 * 24 * 60 * 60 * 1000);
    return true;
  };

  const displayPositions = useMemo(() => {
    if (!data?.positions) return [];

    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    return data.positions.map((p: any) => {
      const matchingSubStrategies = p.sub_strategies?.filter((sub: any) => {
        if (positionFilter === 'open' && sub.status !== 'Open') return false;
        if (positionFilter === 'closed' && sub.status !== 'Closed' && sub.status !== 'Transferred Out') return false;
        if (positionFilter === 'needs_review') {
          const isStaleOpen = sub.status === 'Open' && sub.expiration && sub.expiration < todayStr;
          const isUnmatched = sub.is_unmatched || sub.name?.includes('(Needs Review)');
          if (!isStaleOpen && !isUnmatched) return false;
        }
        if (selectedStrategy !== 'all' && sub.name !== selectedStrategy) return false;

        if ((sub.status === 'Closed' || sub.status === 'Transferred Out') && sub.legs && sub.legs.length > 0) {
          const sortedLegs = [...sub.legs].sort((a: any, b: any) => a.date.localeCompare(b.date));
          const lastDate = sortedLegs[sortedLegs.length - 1].date;
          return matchesTimeframe(lastDate, timeframe, selectedFilter);
        }
        if ((sub.status === 'Open' || sub.status === 'Past Expiration') && sub.expiration) {
          return matchesTimeframe(sub.expiration, timeframe, selectedFilter);
        }
        return selectedFilter === null;
      }) || [];

      if (matchingSubStrategies.length === 0) return null;

      const tfRealizedPl = matchingSubStrategies.reduce(
        (sum: number, s: any) => sum + (s.status === 'Closed' ? (s.realized_pl || 0) : 0),
        0
      );

      const tfUnrealizedPl = matchingSubStrategies.reduce(
        (sum: number, s: any) => sum + (s.status === 'Open' ? (s.unrealized_pl || 0) : 0),
        0
      );

      const tfPastExpirationPl = matchingSubStrategies.reduce(
        (sum: number, s: any) => sum + (s.past_expiration_pl || 0),
        0
      );

      return {
        ...p,
        sub_strategies: matchingSubStrategies,
        realized_pl: tfRealizedPl,
        unrealized_pl: tfUnrealizedPl,
        past_expiration_pl: tfPastExpirationPl
      };
    }).filter(Boolean).filter((p: any) => {
      if (selectedTicker !== 'all') return p.underlying.toUpperCase() === selectedTicker;
      return true;
    });
  }, [data, positionFilter, selectedTicker, selectedStrategy, timeframe, selectedFilter]);

  const totalFilteredRealizedPl = useMemo(() => {
    if (!displayPositions) return 0;
    return displayPositions.reduce((sum: number, p: any) => sum + (p.realized_pl || 0), 0);
  }, [displayPositions]);

  const totalFilteredPastExpirationPl = useMemo(() => {
    if (!displayPositions) return 0;
    return displayPositions.reduce((sum: number, p: any) => sum + (p.past_expiration_pl || 0), 0);
  }, [displayPositions]);

  const totalFilteredClosedExpiredPl = useMemo(() => {
    if (!displayPositions) return 0;
    return displayPositions.reduce((sum: number, p: any) => {
      const pExpired = p.sub_strategies?.reduce((sSum: number, s: any) => {
        if (s.status === 'Closed') {
          const hasExpiredLeg = s.legs?.some((l: any) =>
            l.action === 'EXPIRED' ||
            l.action === 'EXPIRATION' ||
            l.category?.toLowerCase()?.includes('expired') ||
            l.description?.toLowerCase()?.includes('expired')
          );
          if (hasExpiredLeg) return sSum + (s.realized_pl || 0);
        }
        return sSum;
      }, 0) || 0;
      return sum + pExpired;
    }, 0);
  }, [displayPositions]);

  const filteredTradeCount = useMemo(() => {
    if (!displayPositions) return 0;
    let count = 0;
    displayPositions.forEach((p: any) => {
      p.sub_strategies?.forEach((s: any) => {
        if (s.status === 'Closed' || s.status === 'Transferred Out') count++;
      });
    });
    return count;
  }, [displayPositions]);

  const renderPosition = (pos: any) => {
    const posUnrealizedPl = pos.unrealized_pl || 0;

    return (
    <div key={pos.id} className="w-full">
      {/* Position Header Row */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={Boolean(expandedRows[pos.id])}
        aria-label={`Toggle details for ${pos.underlying} position`}
        className="w-full flex items-center justify-between p-4 hover:bg-surface-lighter cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500/40"
        onClick={() => toggleRow(pos.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleRow(pos.id);
          }
        }}
      >
        <div className="flex items-center gap-4 w-1/3">
          <div className="w-8 h-8 rounded-lg bg-surface flex items-center justify-center border border-border">
            {expandedRows[pos.id] ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </div>
          <div>
            <CompanyTooltip ticker={pos.underlying}>
              <h4 className="font-bold text-text-primary text-lg cursor-help border-b border-dashed border-text-secondary/50 inline-block mr-2">{pos.underlying}</h4>
            </CompanyTooltip>
            <Tooltip enabled={showHints} content="The number of active trade cycles (unclosed expirations) for this ticker">
              <span
                className="text-xs text-text-secondary px-2 py-0.5 rounded bg-surface border border-border cursor-help"
              >
                {pos.strategy}
              </span>
            </Tooltip>
            <span className="text-[10px] font-medium text-primary-400 px-2 py-0.5 rounded bg-primary-500/10 border border-primary-500/20 uppercase tracking-tight ml-2">
              {pos.account_name}
            </span>
            {pos.warnings?.map((w: string, idx: number) => (
              <span key={idx} className="text-[10px] font-semibold text-warning-400 bg-warning-500/10 border border-warning-500/20 px-1.5 py-0.5 rounded ml-2">
                ⚠️ {w}
              </span>
            ))}
          </div>
        </div>

        <div className="w-1/3 text-center flex flex-col items-center gap-1">
          <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-semibold ${pos.status === 'Open' ? 'bg-primary-500/10 text-primary-400' : 'bg-surface text-text-secondary border border-border'
            }`}>
            {pos.status}
          </span>
          {pos.status === 'Open' && (() => {
            const now = new Date();
            const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            
            const reviewCount = pos.sub_strategies?.filter((s: any) => {
              const isStaleOpen = s.status === 'Open' && s.expiration && s.expiration < todayStr;
              const isUnmatched = s.is_unmatched || s.name?.includes('(Needs Review)');
              return isStaleOpen || isUnmatched;
            }).length || 0;

            const soonCount = pos.sub_strategies?.filter((s: any) => {
              if (s.status !== 'Open' || !s.expiration) return false;
              const expDate = s.expiration;
              if (expDate < todayStr) return false;
              const exp = new Date(expDate + 'T23:59:59');
              const diff = exp.getTime() - now.getTime();
              const days = diff / (1000 * 60 * 60 * 24);
              return days >= 0 && days <= 7;
            }).length || 0;

            return (
              <div className="flex flex-col items-center gap-1">
                {reviewCount > 0 && (
                  <span className="text-[10px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded-full flex items-center gap-1">
                    <AlertTriangle size={10} />
                    {reviewCount} Needs Review
                  </span>
                )}
                {soonCount > 0 && (
                  <span className="text-[10px] font-bold text-warning-400 flex items-center gap-1 animate-pulse">
                    <Clock size={10} />
                    {soonCount} expiring soon
                  </span>
                )}
              </div>
            );
          })()}
        </div>

        <div className="w-1/3 text-right">
          <p className="text-xs text-text-muted mb-1 flex items-center justify-end gap-2">
            <span className="text-danger-400 border border-danger-500/20 bg-danger-500/10 px-1.5 py-0.5 rounded text-[10px]">
              Fees: {formatCurrency(pos.total_fees)}
            </span>
            Realized P/L
          </p>
          <Tooltip enabled={showHints} content="Total net premium for this ticker (Total Credits - Total Debits - Total Fees)">
            <p
              className={`font-bold cursor-help ${pos.realized_pl >= 0
                ? 'text-success-400'
                : 'text-danger-400'
                }`}
            >
              {formatCurrency(pos.realized_pl)}
            </p>
          </Tooltip>
          
          {pos.status === 'Open' && (
            <div className="mt-2 pt-2 border-t border-border/50 flex flex-col items-end w-full">
              <div className="flex items-center justify-between w-full mb-1">
                <span />
                <div className="flex items-center gap-2">
                  <Tooltip enabled={showHints} content="Maximum profit from open option contracts if they all expire worthless (net premium kept: credits from short legs minus debits paid for long legs, net of fees).">
                    <p className="text-[10px] text-text-muted uppercase tracking-wider cursor-help border-b border-dotted border-text-muted/50">Unrealized Target P/L</p>
                  </Tooltip>
                </div>
              </div>
              
              <p className={`text-sm font-bold ${posUnrealizedPl >= 0 ? 'text-success-400' : 'text-danger-400'}`}>
                {formatCurrency(posUnrealizedPl)}
              </p>
              {pos.warnings?.filter((w: string) => w.includes('cost basis') || w.includes('Transferred')).map((w: string, idx: number) => (
                <span key={idx} className="mt-1 text-[10px] font-semibold text-warning-400 bg-warning-500/10 border border-warning-500/20 px-1.5 py-0.5 rounded">
                  ⚠️ {w}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Expanded Trade Tree (Legs) */}
      {expandedRows[pos.id] && (
        <div className="bg-surface border-t border-b border-border/50 p-4 pl-16">
          {pos.sub_strategies?.map((sub: any, i: number) => (
            <div key={i} className="mb-6 last:mb-2">
              <h5 className="text-xs font-bold text-text-primary uppercase mb-3 flex flex-wrap items-center gap-3">
                <Tooltip enabled={showHints} content={getStrategyHint(sub.name)}>
                  <span
                    className="bg-primary-500/20 text-primary-400 px-2.5 py-1 rounded-md tracking-wider cursor-help flex items-center gap-1.5"
                  >
                    <Layers size={12} />
                    {sub.name}
                  </span>
                </Tooltip>
                <span className="text-text-muted border-l border-border pl-3 flex items-center gap-1.5">
                  <Calendar size={12} className="text-text-muted" />
                  Exp: {formatDate(sub.expiration)}
                </span>
                {sub.status === 'Open' && (() => {
                  const expDate = new Date(sub.expiration + 'T23:59:59');
                  const now = new Date();
                  const diffDays = Math.ceil((expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
                  const isExpiringSoon = diffDays >= 0 && diffDays <= 7;
                  const isExpiredPast = diffDays < 0;

                  return (
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 border ${
                        isExpiredPast
                          ? 'bg-danger-500/10 text-danger-400 border-danger-500/30'
                          : isExpiringSoon
                          ? 'bg-warning-500/15 text-warning-400 border-warning-500/30 animate-pulse'
                          : 'bg-surface-lighter text-text-secondary border-border'
                      }`}
                      title={`${diffDays} calendar days remaining until expiration`}
                    >
                      {isExpiringSoon ? <Clock size={10} /> : null}
                      {isExpiredPast ? 'Expired' : `${diffDays} DTE`}
                    </span>
                  );
                })()}
                {sub.status === 'Transferred Out' && (
                  <span
                    className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-blue-500/10 text-blue-400 border border-blue-500/30"
                  >
                    Transferred Out
                  </span>
                )}
                {sub.warning && (
                  <span
                    className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-warning-500/15 text-warning-400 border border-warning-500/30"
                    title={sub.warning}
                  >
                    {sub.warning}
                  </span>
                )}
                <span
                  className={`border-l border-border pl-3 font-semibold ${
                    sub.is_unmatched
                      ? 'text-amber-400 text-xs'
                      : sub.status === 'Open'
                      ? sub.unrealized_pl >= 0
                        ? 'text-success-400'
                        : 'text-danger-400'
                      : sub.status === 'Transferred Out'
                      ? 'text-text-secondary'
                      : sub.realized_pl >= 0
                      ? 'text-success-400'
                      : 'text-danger-400'
                  }`}
                >
                  {sub.is_unmatched
                    ? 'Closes with no opening trade in imported history (excluded from realized P/L)'
                    : sub.status === 'Open'
                    ? `Target: ${formatCurrency(sub.unrealized_pl)}`
                    : sub.status === 'Transferred Out'
                    ? 'Transferred ($0.00)'
                    : `P/L: ${formatCurrency(sub.realized_pl)}`}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  {sub.status === 'Open' && (() => {
                    const isUnmatchedClose = sub.name.includes('(Needs Review)') || (sub.legs && sub.legs.length > 0 && sub.legs.every((l: any) => ['BTC', 'STC'].includes(l.action)));
                    if (isUnmatchedClose) {
                      const firstLeg = sub.legs[0];
                      return (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedMatchTarget({
                                transactionId: firstLeg.transaction_id,
                                underlying: pos.underlying,
                                expiration: firstLeg.expiration || sub.expiration,
                                strike: firstLeg.strike || sub.strike || 0,
                                optType: firstLeg.type || sub.opt_type || 'C',
                                action: firstLeg.action || sub.action || 'BTC',
                                quantity: firstLeg.quantity || Number(sub.open_qty) || 1,
                                date: firstLeg.date || '',
                                description: firstLeg.description || '',
                                accountId: pos.account_id,
                                accountName: pos.account_name,
                              });
                            }}
                            className="px-2.5 py-1 rounded bg-primary-500/10 hover:bg-primary-500/20 text-primary-400 hover:text-primary-300 border border-primary-500/20 text-[11px] font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                            title="Manually match, reconcile with manual close, or link this trade"
                          >
                            <Link2 size={12} />
                            <span>Match Trade</span>
                          </button>
                          <button
                            type="button"
                            onClick={async (e) => {
                              e.stopPropagation();
                              if (window.confirm(`Delete orphaned closing transaction for ${pos.underlying} ${sub.name}? This will remove the unattached close record (Transaction ID: ${firstLeg.transaction_id}). Deletion changes unmatched cash, net cash, win rate and closed count.`)) {
                                try {
                                  await dismissUnmatchedOption(firstLeg.transaction_id);
                                  refetch();
                                } catch (err: any) {
                                  alert(err.message || 'Failed to delete transaction');
                                }
                              }
                            }}
                            className="px-2 py-1 rounded bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 hover:text-amber-300 border border-amber-500/20 text-[11px] font-semibold flex items-center gap-1 transition-colors cursor-pointer"
                            title="Delete this unmatched closing transaction"
                          >
                            <Trash2 size={12} />
                            <span>Delete transaction</span>
                          </button>
                        </div>
                      );
                    }

                    // Aggregate legs by unique contract identity (strike, type, action, expiration)
                    const aggregatedLegsMap = new Map<string, any>();
                    if (sub.legs) {
                      for (const leg of sub.legs) {
                        const key = `${leg.strike}_${leg.type}_${leg.action}_${leg.expiration || sub.expiration}`;
                        if (aggregatedLegsMap.has(key)) {
                          const existing = aggregatedLegsMap.get(key);
                          existing.quantity = (existing.quantity || 0) + (leg.quantity || 0);
                          existing.amount = (existing.amount || 0) + (leg.amount || 0);
                          existing.fees = (existing.fees || 0) + (leg.fees || 0);
                        } else {
                          aggregatedLegsMap.set(key, { ...leg });
                        }
                      }
                    }
                    const aggregatedLegs = Array.from(aggregatedLegsMap.values());
                    const firstLeg = aggregatedLegs[0] || sub.legs?.[0];

                    const spreadQty = (aggregatedLegs.length > 1)
                      ? Math.min(...aggregatedLegs.map((l: any) => l.quantity || 1))
                      : (sub.open_qty || firstLeg?.quantity || 1);

                    return (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedCloseTarget({
                            account_id: pos.account_id,
                            account_name: pos.account_name,
                            underlying: pos.underlying,
                            expiration: sub.expiration,
                            strike: firstLeg?.strike || 0,
                            opt_type: firstLeg?.type || 'C',
                            action: firstLeg?.action || 'STO',
                            available_qty: spreadQty,
                            strategy_name: sub.name,
                            all_legs: aggregatedLegs.map((l: any) => ({
                              account_id: pos.account_id,
                              account_name: pos.account_name,
                              underlying: pos.underlying,
                              expiration: l.expiration || sub.expiration,
                              strike: l.strike,
                              opt_type: l.type,
                              action: l.action,
                              available_qty: l.quantity || 1
                            }))
                          });
                        }}
                        className="px-2 py-1 rounded bg-danger-500/10 hover:bg-danger-500/20 text-danger-400 hover:text-danger-300 border border-danger-500/20 text-[11px] font-semibold flex items-center gap-1 transition-colors cursor-pointer"
                        title="Manually record a close (expired, assigned, exercised, or market fill) for this trade"
                      >
                        <XCircle size={12} />
                        <span>Close Trade</span>
                      </button>
                    );
                  })()}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedPayoffStrategy({ underlying: pos.underlying, subStrategy: sub });
                    }}
                    className="px-2 py-1 rounded bg-primary-500/10 hover:bg-primary-500/20 text-primary-400 hover:text-primary-300 border border-primary-500/20 text-[11px] font-semibold flex items-center gap-1 transition-colors cursor-pointer"
                    title="View expiration payoff curve, breakeven strikes, and risk parameters"
                  >
                    <Activity size={12} />
                    <span>Payoff Curve</span>
                  </button>
                </div>
              </h5>
              <div className="space-y-2">
                {sub.legs.map((leg: any) => (
                  <div key={leg.id} className="flex items-center justify-between text-sm py-2 px-3 rounded-lg bg-surface-card border border-border/50">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <span className="text-text-secondary font-mono w-24 text-xs shrink-0">{formatDate(leg.date)}</span>
                      <Tooltip enabled={showHints} content={leg.action.includes('B') ? 'Buy (Debit / Cost)' : 'Sell (Credit / Premium)'}>
                        <span
                          className={`font-bold cursor-help shrink-0 ${leg.action.includes('B') ? 'text-info-400' : 'text-warning-400'}`}
                        >
                          {leg.action}
                        </span>
                      </Tooltip>
                      <span className="font-mono text-[11px] font-semibold px-1.5 py-0.5 rounded bg-surface-lighter text-text-secondary border border-border/40 shrink-0">
                        {Number(leg.quantity)}x
                      </span>
                      <span className="font-medium text-text-primary truncate">
                        ${leg.strike} {leg.type}
                      </span>
                    </div>

                    <div className="flex items-center gap-3 text-right">
                      {leg.fees > 0 && (
                        <span className="text-[10px] text-danger-400/80 mr-1">
                          Fee: {formatCurrency(leg.fees)}
                        </span>
                      )}
                      <span className={`font-medium ${leg.amount >= 0 ? 'text-success-400' : 'text-text-primary'}`}>
                        {formatCurrency(leg.amount)}
                        <span className="text-[10px] ml-1.5 opacity-60 font-bold">
                          {leg.amount >= 0 ? 'CR' : 'DB'}
                        </span>
                      </span>
                      {sub.status === 'Open' && !['BTC', 'STC'].includes(leg.action) && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedCloseTarget({
                              account_id: pos.account_id,
                              account_name: pos.account_name,
                              underlying: pos.underlying,
                              expiration: leg.expiration || sub.expiration,
                              strike: leg.strike,
                              opt_type: leg.type,
                              action: leg.action,
                              available_qty: leg.quantity || 1,
                              strategy_name: sub.name
                            });
                          }}
                          className="p-1 rounded hover:bg-danger-500/10 text-text-muted hover:text-danger-400 transition-colors cursor-pointer"
                          title={`Manually close this ${Number(leg.quantity)}x ${leg.strike} ${leg.type} leg`}
                        >
                          <XCircle size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {pos.notes && (
            <div className="mt-4 p-3 rounded-lg bg-surface-card border border-border/50 text-sm text-text-secondary">
              <span className="font-semibold text-text-primary mr-2">Journal:</span>
              {pos.notes}
            </div>
          )}
        </div>
      )}
    </div>
  );
  };

  if (loading) return <LoadingSpinner message="Loading options portfolio..." />;
  if (error) return <ErrorMessage message={error} onRetry={refetch} />;
  if (!data) return null;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Options Dashboard Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-border/50">
        <h1 className="text-3xl font-extrabold text-text-primary tracking-tight">Options Dashboard</h1>

        <div className="flex items-center gap-3 self-start sm:self-center">
          <button
            onClick={() => setShowHints(!showHints)}
            className={`flex items-center gap-2 px-3 py-2 rounded-xl border transition-all text-xs font-bold uppercase tracking-wider cursor-pointer ${
              showHints ? 'bg-primary-500/15 border-primary-500/30 text-primary-300 shadow-sm' : 'bg-surface-card border-border text-text-muted hover:text-text-secondary'
            }`}
            title="Toggle explanatory tooltips and strategy guides"
          >
            <HelpCircle size={15} />
            <span>{showHints ? 'Hints: ON' : 'Hints: OFF'}</span>
          </button>
        </div>
      </div>

      {/* Account Filters Bar */}
      {accountsData && accountsData.length > 0 && (() => {
        const filteredAccounts = (accountsData as any[]).filter((acc: any) => acc.type !== 'credit card');
        if (filteredAccounts.length === 0) return null;
        return (
          <div className="p-3.5 bg-surface-card rounded-2xl border border-border/70 flex flex-wrap items-center justify-between gap-3 shadow-sm">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-text-muted">Account Filter:</span>
              <button
                type="button"
                onClick={() => setSelectedAccounts([])}
                className={`px-2.5 py-1 rounded-lg border text-xs font-bold transition-all cursor-pointer ${
                  selectedAccounts.length === 0
                    ? 'bg-primary-500/20 border-primary-500/50 text-primary-300 shadow-sm'
                    : 'bg-surface hover:bg-surface-lighter border-border text-text-muted hover:text-text-secondary'
                }`}
              >
                All Accounts {selectedAccounts.length === 0 && '✓'}
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {filteredAccounts.map((acc: any) => {
                const isSelected = selectedAccounts.includes(acc.id);
                return (
                  <button
                    key={acc.id}
                    type="button"
                    onClick={() => toggleAccount(acc.id)}
                    className={`px-3 py-1 rounded-lg border text-xs font-medium transition-all cursor-pointer flex items-center gap-1.5 ${
                      isSelected
                        ? 'bg-primary-500/20 border-primary-500/50 text-primary-200 font-semibold shadow-sm'
                        : 'bg-surface hover:bg-surface-lighter border-border text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${isSelected ? 'bg-primary-400' : 'bg-text-muted'}`} />
                    <span>{acc.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Notice for CSV-only import with unmatched closes */}
      {data.total_unmatched_closes_pl > 0 && (
        <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg flex items-center gap-2 text-xs text-amber-300">
          <span className="font-bold uppercase tracking-wider text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
            Notice
          </span>
          <span>
            {data.realized_pl_note || `Realized P/L excludes ${formatCurrency(data.total_unmatched_closes_pl)} in closing trades with no opening trade in the imported file.`}
          </span>
        </div>
      )}

      {/* Data Quality Warnings Banner */}
      {data.data_quality_warnings && data.data_quality_warnings.length > 0 && (
        <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg flex flex-col gap-1 text-xs text-amber-300">
          <div className="flex items-center gap-2">
            <span className="font-bold uppercase tracking-wider text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 flex items-center gap-1">
              <AlertTriangle size={12} className="text-amber-400" />
              Data Quality Warning
            </span>
          </div>
          <div className="flex flex-col gap-0.5 pl-1 mt-0.5">
            {data.data_quality_warnings.map((w: string, idx: number) => (
              <span key={idx} className="text-amber-200">
                • {w}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Analytics Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="!p-5 bg-surface-card border border-success-500/25 relative overflow-hidden group hover:border-success-500/50 transition-all shadow-sm">
          <div className="absolute top-0 left-0 right-0 h-1 bg-success-500" />
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <Tooltip enabled={showHints} content="Unified Realized P/L from all closed option trades and expired contracts (Closed Trades + Expired)">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-success-400 cursor-help border-b border-dotted border-success-500/40 w-fit">
                    Realized P/L
                  </p>
                </Tooltip>
                {(Math.abs(data.unmatched_closes_amount || data.total_unmatched_closes_pl || 0) > 0.001) && (
                  <span
                    className="text-[10px] font-semibold text-amber-400 bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.5 rounded cursor-help"
                    title={data.realized_pl_note || `Excludes ${formatCurrency(data.unmatched_closes_amount ?? data.total_unmatched_closes_pl)} across ${data.unmatched_closes_count || 2} unmatched closing trades awaiting review`}
                  >
                    ⚠️ {formatCurrency(data.unmatched_closes_amount ?? data.total_unmatched_closes_pl)} ({data.unmatched_closes_count || 2} unmatched)
                  </span>
                )}
              </div>
              <h3 className={`text-2xl sm:text-3xl font-extrabold tracking-tight tabular-nums ${(data.display_combined_realized_pl ?? (data.combined_realized_pl ?? (data.total_realized_pl + (data.total_past_expiration_pl || 0)))) >= 0 ? 'text-success-400' : 'text-danger-400'}`}>
                {formatCurrency(data.display_combined_realized_pl ?? (data.combined_realized_pl ?? (data.total_realized_pl + (data.total_past_expiration_pl || 0))))}
              </h3>
              <p className="text-[11px] text-text-muted font-medium flex items-center gap-1.5 flex-wrap">
                <span>Closed: {formatCurrency(data.display_closed_realized_pl ?? (data.closed_realized_pl ?? data.total_realized_pl))}</span>
                <span>·</span>
                <span>Expired: {formatCurrency(data.display_expired_realized_pl ?? (data.expired_realized_pl ?? (data.total_past_expiration_pl || 0)))}</span>
              </p>
              {(data.total_past_expiration_pl != null && data.total_past_expiration_pl !== 0) && (
                <div className="pt-0.5">
                  <span
                    className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-300 bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.5 rounded cursor-help"
                    title="Past expiration contracts awaiting broker confirmation"
                  >
                    <Clock size={10} className="text-amber-400" />
                    {formatCurrency(data.total_past_expiration_pl)} awaiting broker confirmation
                  </span>
                </div>
              )}
            </div>
            <div className="p-3 rounded-xl bg-success-500/10 text-success-400 border border-success-500/20 group-hover:scale-105 transition-transform">
              <TrendingUp size={20} />
            </div>
          </div>
        </Card>

        <Card className="!p-5 bg-surface-card border border-border hover:border-primary-500/40 relative overflow-hidden group transition-all shadow-sm">
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <Tooltip enabled={showHints} content="Absolute maximum profit target if all current active open positions expire worthless or reach defined target">
                <p className="text-[11px] font-bold uppercase tracking-wider text-primary-400 cursor-help border-b border-dotted border-border w-fit">
                  Unrealized Target
                </p>
              </Tooltip>
              <h3 className={`text-2xl sm:text-3xl font-extrabold tracking-tight tabular-nums ${(data.display_total_unrealized_pl ?? data.total_unrealized_pl) >= 0 ? 'text-success-400' : 'text-danger-400'}`}>
                {formatCurrency(data.display_total_unrealized_pl ?? data.total_unrealized_pl)}
              </h3>
              <p className="text-[11px] text-text-muted font-medium">
                Forward potential cashflow
              </p>
            </div>
            <div className="p-3 rounded-xl bg-primary-500/10 text-primary-400 border border-primary-500/20 group-hover:scale-105 transition-transform">
              <Activity size={20} />
            </div>
          </div>
        </Card>

        <Card className="!p-5 bg-surface-card border border-border hover:border-primary-500/40 relative overflow-hidden group transition-all shadow-sm">
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <Tooltip enabled={showHints} content="Combined total of all closed trade realized P/L, expired contracts, and active open trade target profits">
                <p className="text-[11px] font-bold uppercase tracking-wider text-text-secondary cursor-help border-b border-dotted border-border w-fit">
                  Realized + Target
                </p>
              </Tooltip>
              <h3 className={`text-2xl sm:text-3xl font-extrabold tracking-tight tabular-nums ${(data.display_realized_plus_target_pl ?? (data.realized_plus_target_pl ?? ((data.combined_realized_pl ?? (data.total_realized_pl + (data.total_past_expiration_pl || 0))) + data.total_unrealized_pl))) >= 0 ? 'text-success-400' : 'text-danger-400'}`}>
                {formatCurrency(data.display_realized_plus_target_pl ?? (data.realized_plus_target_pl ?? ((data.combined_realized_pl ?? (data.total_realized_pl + (data.total_past_expiration_pl || 0))) + data.total_unrealized_pl)))}
              </h3>
              <p className="text-[11px] text-text-muted font-medium">
                {formatCurrency(data.display_combined_realized_pl ?? (data.combined_realized_pl ?? (data.total_realized_pl + (data.total_past_expiration_pl || 0))))} realized + {formatCurrency(data.display_total_unrealized_pl ?? data.total_unrealized_pl)} target
              </p>
            </div>
            <div className="p-3 rounded-xl bg-surface-lighter text-text-primary border border-border group-hover:scale-105 transition-transform">
              <TrendingUp size={20} />
            </div>
          </div>
        </Card>

        <Card className="!p-5 bg-surface-card border border-border hover:border-danger-500/40 relative overflow-hidden group transition-all shadow-sm">
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <Tooltip enabled={showHints} content="Total brokerage fees paid across options and stock sell transactions.">
                <p className="text-[11px] font-bold uppercase tracking-wider text-danger-400 cursor-help border-b border-dotted border-border w-fit">
                  Total Fees
                </p>
              </Tooltip>
              <h3 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-danger-400 tabular-nums">
                {formatCurrency(data.total_fees)}
              </h3>
              <p className="text-[11px] text-text-muted font-medium">
                {data.options_fees != null && data.stock_fees != null && data.stock_fees > 0
                  ? `${formatCurrency(data.options_fees)} options · ${formatCurrency(data.stock_fees)} stock`
                  : 'Brokerage transaction costs'}
              </p>
            </div>
            <div className="p-3 rounded-xl bg-danger-500/10 text-danger-400 border border-danger-500/20 group-hover:scale-105 transition-transform">
              <DollarSign size={20} />
            </div>
          </div>
        </Card>
      </div>

      {/* Customizable Visualizations */}
      <Card className="!p-5 bg-surface-card border border-border/80 shadow-sm">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between mb-4 gap-3 pb-3 border-b border-border/40">
          <div className="flex items-center gap-3">
            <Tooltip enabled={showHints} content="Accumulated realized P/L from closed trades and future target earnings plotted on upcoming expiration dates.">
              <CardTitle className="cursor-help border-b border-dotted border-text-secondary/30 whitespace-nowrap">Performance Analytics</CardTitle>
            </Tooltip>
          </div>

          <div className="flex items-center gap-2 flex-nowrap overflow-x-auto py-0.5 no-scrollbar">
            {/* Ticker Filter Select for Chart */}
            {uniqueTickers.length > 0 && (
              <select
                value={selectedTicker}
                onChange={(e) => setSelectedTicker(e.target.value)}
                className={`px-2.5 py-1.5 rounded-lg border text-xs focus:outline-none transition-colors shrink-0 ${
                  selectedTicker !== 'all'
                    ? 'bg-primary-500/20 border-primary-500/50 text-primary-300 font-semibold'
                    : 'bg-surface border-border text-text-primary'
                }`}
                title="Filter analytics chart to a specific underlying ticker"
              >
                <option value="all">All Tickers</option>
                {uniqueTickers.map(ticker => (
                  <option key={ticker} value={ticker}>{ticker}</option>
                ))}
              </select>
            )}

            {/* Trade Status Filter */}
            <select
              value={tradeStatusFilter}
              onChange={(e) => setTradeStatusFilter(e.target.value as any)}
              className="px-2.5 py-1.5 rounded-lg bg-surface border border-border text-xs text-text-primary focus:outline-none shrink-0"
              title="Filter by Realized (Closed), Future Target (Open), or All"
            >
              <option value="all">Realized & Target</option>
              <option value="closed">Realized Only</option>
              <option value="open">Target Only</option>
            </select>

            {/* Timeframe Select */}
            <select
              value={timeframe}
              onChange={(e) => {
                setTimeframe(e.target.value as any);
                setSelectedFilter(null);
              }}
              className="px-2.5 py-1.5 rounded-lg bg-surface border border-border text-xs text-text-primary focus:outline-none shrink-0"
              title="Aggregation timeframe"
            >
              <option value="all">Monthly</option>
              <option value="weekly">Weekly</option>
              <option value="ytd">YTD</option>
              <option value="12w">12 Weeks</option>
              <option value="30d_weekly">30d (W)</option>
              <option value="30d">30d (D)</option>
              <option value="7d">7 Days</option>
            </select>

            {/* Week Picker Dropdown */}
            {availableWeeks.length > 0 && (
              <select
                value={selectedWeek}
                onChange={(e) => setSelectedWeek(e.target.value)}
                className={`px-2.5 py-1.5 rounded-lg border text-xs focus:outline-none transition-colors shrink-0 ${
                  selectedWeek !== 'all'
                    ? 'bg-primary-500/20 border-primary-500/50 text-primary-300 font-semibold'
                    : 'bg-surface border-border text-text-primary'
                }`}
                title="Select a specific calendar week to filter realized P/L"
              >
                <option value="all">📅 All Weeks</option>
                {availableWeeks.map(w => (
                  <option key={w.mondayDate} value={w.mondayDate}>
                    Wk {formatDate(w.mondayDate)} ({formatCurrency(w.realizedPl)})
                  </option>
                ))}
              </select>
            )}

            {/* Segmented Chart Type Toggle */}
            <div className="flex items-center bg-surface rounded-lg p-0.5 border border-border shrink-0">
              <button
                type="button"
                onClick={() => setChartType('bar')}
                className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-all cursor-pointer ${
                  chartType === 'bar'
                    ? 'bg-primary-500/20 text-primary-300 shadow-xs'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
                title="Bar Chart Distribution"
              >
                Bar
              </button>
              <button
                type="button"
                onClick={() => setChartType('line')}
                className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-all cursor-pointer ${
                  chartType === 'line'
                    ? 'bg-primary-500/20 text-primary-300 shadow-xs'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
                title="Cumulative Curve"
              >
                Curve
              </button>
            </div>
          </div>
        </div>

        {/* Legend when showing both Realized and Future Unrealized */}
        <div className="flex flex-wrap items-center gap-4 mb-4 text-xs text-text-muted">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500 inline-block" /> Realized Profit
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-rose-500 inline-block" /> Realized Loss
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-primary-500 border border-primary-400/50 inline-block" /> Future Target
          </span>
          <div className="ml-auto flex items-center gap-2">
            {selectedFilter && (
              <span className="text-primary-300 font-semibold flex items-center gap-1 bg-primary-500/10 px-2.5 py-0.5 rounded-md border border-primary-500/20 text-xs">
                📅 {formatFilterLabel(selectedFilter)}
                <button
                  onClick={() => setSelectedFilter(null)}
                  className="text-text-muted hover:text-text-primary ml-1 cursor-pointer"
                  title="Clear period filter"
                >
                  ✕
                </button>
              </span>
            )}
            {selectedTicker !== 'all' && (
              <span className="text-primary-300 font-semibold flex items-center gap-1 bg-primary-500/10 px-2.5 py-0.5 rounded-md border border-primary-500/20 text-xs">
                Filtered: {selectedTicker}
                <button
                  onClick={() => setSelectedTicker('all')}
                  className="text-text-muted hover:text-text-primary ml-1 cursor-pointer"
                  title="Clear ticker filter"
                >
                  ✕
                </button>
              </span>
            )}
          </div>
        </div>

        <div className="h-[300px] w-full">
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              {chartType === 'line' ? (
                <LineChart
                  data={chartData}
                  margin={{ top: 20, right: 20, left: 10, bottom: 5 }}
                  onClick={(state: any) => handleChartClick(extractLabelFromEvent(state))}
                  style={{ cursor: 'pointer' }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#232b38" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tickFormatter={(val) => chartData.find((d: any) => d.label === val)?.displayLabel || val}
                    stroke="#94a3b8"
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                    tickMargin={10}
                  />
                  <YAxis
                    stroke="#94a3b8"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    width={85}
                    domain={[yDomain.minLineVal, yDomain.maxLineVal]}
                    tickCount={7}
                    tickFormatter={(v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v)}
                  />
                  <RechartsTooltip
                    contentStyle={{ backgroundColor: '#13171f', border: '1px solid #232b38', borderRadius: '8px', color: '#f8fafc' }}
                    itemStyle={{ color: '#f8fafc' }}
                    labelStyle={{ color: '#94a3b8', fontWeight: 'bold' }}
                    formatter={(value: any, _: any, item: any) => {
                      const payload = item?.payload;
                      const parts: [string, string][] = [];
                      if (payload?.realized !== 0 && payload?.realized !== undefined) {
                        parts.push([formatCurrency(Number(payload.realized)), 'Realized P/L']);
                      }
                      if (payload?.unrealized !== 0 && payload?.unrealized !== undefined) {
                        parts.push([formatCurrency(Number(payload.unrealized)), 'Future Target P/L']);
                      }
                      return [formatCurrency(Number(value)), 'Cumulative P/L'];
                    }}
                    labelFormatter={(label, payload) => {
                      const rawKey = payload?.[0]?.payload?.label || label;
                      const isFuture = payload?.[0]?.payload?.isFuture;
                      const prefix = isFuture ? '🔮 Future Expiration: ' : '';
                      const isFiltered = selectedFilter?.key === rawKey;
                      const actionHint = isFiltered ? ' (Click to clear filter)' : ' (Click to filter)';
                      if (rawKey && rawKey.length === 7) {
                        const [yr, mo] = rawKey.split('-');
                        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
                        const mIdx = Number(mo) - 1;
                        return `${prefix}${monthNames[mIdx] || mo} ${yr}${actionHint}`;
                      } else if (timeframe === 'weekly' || timeframe === '12w' || timeframe === '30d_weekly') {
                        return `${prefix}Week of ${formatDate(rawKey)}${actionHint}`;
                      }
                      return `${prefix}${formatDate(rawKey)}${actionHint}`;
                    }}
                  />
                  <ReferenceLine y={0} stroke="#64748b" strokeWidth={2} strokeDasharray="5 5" />
                  <Line
                    type="monotone"
                    dataKey="cumulative"
                    stroke="#3b82f6"
                    strokeWidth={2.5}
                    dot={(props: any) => {
                      const isSelected = selectedFilter !== null && selectedFilter.key === props.payload?.label;
                      return (
                        <circle
                          key={`dot-${props.index}`}
                          cx={props.cx}
                          cy={props.cy}
                          r={isSelected ? 6 : 4}
                          fill={isSelected ? '#38bdf8' : '#3b82f6'}
                          stroke={isSelected ? '#ffffff' : '#13171f'}
                          strokeWidth={isSelected ? 2 : 1.5}
                          style={{ cursor: 'pointer' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleChartClick(props.payload?.label);
                          }}
                        />
                      );
                    }}
                    activeDot={{ r: 8, fill: '#38bdf8', stroke: '#ffffff', strokeWidth: 2 }}
                  >
                    <LabelList
                      dataKey="cumulative"
                      position="top"
                      offset={10}
                      formatter={(val: any) => formatCurrency(Number(val))}
                      style={{ fill: '#94a3b8', fontSize: 10, fontWeight: 600 }}
                    />
                  </Line>
                </LineChart>
              ) : (
                <BarChart
                  data={chartData}
                  margin={{ top: 25, right: 20, left: 10, bottom: 5 }}
                  onClick={(state: any) => handleChartClick(extractLabelFromEvent(state))}
                  style={{ cursor: 'pointer' }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#232b38" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tickFormatter={(val) => chartData.find((d: any) => d.label === val)?.displayLabel || val}
                    stroke="#94a3b8"
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                    tickMargin={10}
                  />
                  <YAxis
                    stroke="#94a3b8"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    width={85}
                    domain={[yDomain.minBarVal, yDomain.maxBarVal]}
                    tickCount={7}
                    tickFormatter={(v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v)}
                  />
                  <RechartsTooltip
                    contentStyle={{ backgroundColor: '#13171f', border: '1px solid #232b38', borderRadius: '8px', color: '#f8fafc' }}
                    itemStyle={{ color: '#f8fafc' }}
                    labelStyle={{ color: '#94a3b8', fontWeight: 'bold' }}
                    formatter={(value: any, _: any, item: any) => {
                      const payload = item?.payload;
                      const details: string[] = [];
                      if (payload?.realized) {
                        details.push(`Realized: ${formatCurrency(payload.realized)}`);
                      }
                      if (payload?.unrealized) {
                        details.push(`Future Target: ${formatCurrency(payload.unrealized)}`);
                      }
                      const subtitle = details.length > 0 ? ` (${details.join(' | ')})` : '';
                      return [
                        `${formatCurrency(Number(value))}${subtitle}`,
                        payload?.isFuture && payload?.unrealized ? 'Future Target P/L' : 'Period P/L'
                      ];
                    }}
                    labelFormatter={(label, payload) => {
                      const rawKey = payload?.[0]?.payload?.label || label;
                      const isFuture = payload?.[0]?.payload?.isFuture;
                      const prefix = isFuture ? '🔮 Future Expiration: ' : '';
                      const isFiltered = selectedFilter?.key === rawKey;
                      const actionHint = isFiltered ? ' (Click to clear filter)' : ' (Click to filter)';
                      if (rawKey && rawKey.length === 7) {
                        const [yr, mo] = rawKey.split('-');
                        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
                        const mIdx = Number(mo) - 1;
                        return `${prefix}${monthNames[mIdx] || mo} ${yr}${actionHint}`;
                      } else if (timeframe === 'weekly' || timeframe === '12w' || timeframe === '30d_weekly') {
                        return `${prefix}Week of ${formatDate(rawKey)}${actionHint}`;
                      }
                      return `${prefix}${formatDate(rawKey)}${actionHint}`;
                    }}
                    cursor={{ fill: '#232b38', opacity: 0.4 }}
                  />
                  <ReferenceLine y={0} stroke="#64748b" strokeWidth={2} />
                  <Bar
                    dataKey="value"
                    radius={[4, 4, 0, 0]}
                    onClick={(entry: any) => handleChartClick(entry?.label || entry?.payload?.label)}
                    style={{ cursor: 'pointer' }}
                  >
                    {chartData.map((entry: any, index: number) => {
                      const isSelected = selectedFilter !== null && selectedFilter.key === entry.label;
                      let baseFill: string;
                      if (entry.unrealized !== 0 && entry.realized === 0) {
                        baseFill = entry.unrealized >= 0 ? '#3b82f6' : '#f43f5e';
                      } else if (entry.unrealized !== 0 && entry.realized !== 0) {
                        baseFill = '#60a5fa';
                      } else {
                        baseFill = entry.realized >= 0 ? '#10b981' : '#f43f5e';
                      }

                      return (
                        <Cell
                          key={`cell-${index}`}
                          fill={isSelected ? '#38bdf8' : baseFill}
                          stroke={isSelected ? '#ffffff' : entry.isFuture ? '#60a5fa' : 'none'}
                          strokeDasharray={isSelected ? undefined : entry.isFuture ? '2 2' : undefined}
                          strokeWidth={isSelected ? 2 : entry.isFuture ? 1 : 0}
                          opacity={selectedFilter ? (isSelected ? 1 : 0.45) : 1}
                          style={{ cursor: 'pointer' }}
                          onClick={(e: any) => {
                            e?.stopPropagation?.();
                            handleChartClick(entry.label);
                          }}
                        />
                      );
                    })}
                    <LabelList
                      dataKey="value"
                      content={(props: any) => {
                        const { x, y, width, height, value, index } = props;
                        if (value === undefined || value === null || isNaN(value)) return null;
                        const numVal = Number(value);
                        const isPositive = numVal >= 0;
                        const labelY = isPositive ? Math.max(10, y - 10) : y + height + 14;
                        const entry = chartData[index];
                        const isFuture = entry?.isFuture;

                        return (
                          <text
                            x={x + width / 2}
                            y={labelY}
                            fill={isFuture ? '#93c5fd' : isPositive ? '#34d399' : '#fb7185'}
                            textAnchor="middle"
                            fontSize={10}
                            fontWeight={600}
                          >
                            {formatCurrency(numVal)}
                          </text>
                        );
                      }}
                    />
                  </Bar>
                </BarChart>
              )}
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex items-center justify-center text-text-muted text-sm">
              No positions to display for this filter.
            </div>
          )}
        </div>
      </Card>

      {/* Positions List */}
      <OptionNeedsReview accountsKey={accountsKey} revision={data} />

      <Card className="!p-0 overflow-hidden bg-surface-card border border-border/80 shadow-sm">
        {/* Tier 1 Command Bar: Header & Primary View Filter Tabs */}
        <div className="p-4 border-b border-border/60 bg-surface-lighter/40 flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
          <div className="flex items-center gap-3 flex-wrap">
            <CardTitle>Trade Positions</CardTitle>
            <div className="h-4 w-px bg-border hidden sm:block" />
            <div className="flex items-center gap-2.5 text-xs flex-wrap">
              <div className="flex items-center gap-1.5">
                <span className="text-text-muted">Realized P/L:</span>
                <span className={`font-bold tabular-nums ${(totalFilteredRealizedPl + totalFilteredPastExpirationPl) >= 0 ? 'text-success-400' : 'text-danger-400'}`}>
                  {formatCurrency(totalFilteredRealizedPl + totalFilteredPastExpirationPl)}
                </span>
              </div>
              <div className="h-3 w-px bg-border hidden sm:block" />
              <div className="flex items-center gap-1.5 text-text-muted">
                <span>Closed:</span>
                <span className={`font-semibold tabular-nums ${totalFilteredRealizedPl >= 0 ? 'text-success-400' : 'text-danger-400'}`}>
                  {formatCurrency(totalFilteredRealizedPl)}
                </span>
                <span>·</span>
                <span>Expired:</span>
                <span className={`font-semibold tabular-nums ${totalFilteredPastExpirationPl >= 0 ? 'text-success-400' : 'text-danger-400'}`}>
                  {formatCurrency(totalFilteredPastExpirationPl)}
                </span>
              </div>
            </div>
          </div>

          {/* Primary View Filter Tabs */}
          <div className="flex items-center gap-1 bg-surface rounded-xl p-1 border border-border/80 w-full sm:w-auto overflow-x-auto">
            {[
              { value: 'all', label: 'All Trades' },
              { value: 'open', label: 'Open Only' },
              { value: 'closed', label: 'Closed Only' },
              ...(expiredOpenStats.count > 0 ? [{ value: 'needs_review', label: `⚠️ Needs Review (${expiredOpenStats.count})` }] : []),
            ].map(opt => (
              <button
                key={opt.value}
                onClick={() => setPositionFilter(opt.value as any)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer whitespace-nowrap ${
                  positionFilter === opt.value
                    ? opt.value === 'needs_review'
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
                      : 'bg-primary-500/20 text-primary-300 border border-primary-500/40 shadow-sm'
                    : 'text-text-muted hover:text-text-secondary border border-transparent'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Tier 2 Secondary Precision Filter Strip */}
        <div className="px-4 py-2.5 bg-surface/60 border-b border-border/50 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-2.5 w-full sm:w-auto">
            {/* Ticker Filter Select */}
            {uniqueTickers.length > 0 && (
              <select
                value={selectedTicker}
                onChange={(e) => setSelectedTicker(e.target.value)}
                className="px-2.5 py-1.5 rounded-lg bg-surface-card border border-border text-xs text-text-primary focus:outline-none"
                title="Filter by underlying ticker"
              >
                <option value="all">All Tickers</option>
                {uniqueTickers.map(ticker => (
                  <option key={ticker} value={ticker}>{ticker}</option>
                ))}
              </select>
            )}

            {/* Strategy Filter Select */}
            {uniqueStrategies.length > 0 && (
              <select
                value={selectedStrategy}
                onChange={(e) => setSelectedStrategy(e.target.value)}
                className={`px-2.5 py-1.5 rounded-lg border text-xs focus:outline-none transition-colors ${
                  selectedStrategy !== 'all'
                    ? 'bg-primary-500/20 border-primary-500/50 text-primary-300 font-semibold'
                    : 'bg-surface-card border-border text-text-primary'
                }`}
                title="Filter by strategy type"
              >
                <option value="all">All Strategies</option>
                {uniqueStrategies.map(strat => (
                  <option key={strat} value={strat}>{strat}</option>
                ))}
              </select>
            )}

            {/* Timeframe Select */}
            <select
              value={timeframe}
              onChange={(e) => {
                setTimeframe(e.target.value as any);
                setSelectedFilter(null);
              }}
              className="px-2.5 py-1.5 rounded-lg bg-surface-card border border-border text-xs text-text-primary focus:outline-none"
            >
              <option value="all">All Time</option>
              <option value="ytd">Year to Date</option>
              <option value="12w">Last 12 Weeks</option>
              <option value="30d">Last 30 Days</option>
              <option value="7d">Last 7 Days</option>
            </select>

            {/* Week Picker Dropdown */}
            {availableWeeks.length > 0 && (
              <select
                value={selectedWeek}
                onChange={(e) => {
                  setSelectedWeek(e.target.value);
                }}
                className={`px-2.5 py-1.5 rounded-lg border text-xs focus:outline-none transition-colors ${
                  selectedWeek !== 'all'
                    ? 'bg-primary-500/20 border-primary-500/50 text-primary-300 font-semibold'
                    : 'bg-surface-card border-border text-text-primary'
                }`}
                title="Filter trade positions by specific calendar week"
              >
                <option value="all">📅 Select Week (All)</option>
                {availableWeeks.map(w => (
                  <option key={w.mondayDate} value={w.mondayDate}>
                    Week of {formatDate(w.mondayDate)} ({formatCurrency(w.realizedPl)})
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="text-text-muted text-[11px] font-medium ml-auto">
            Showing {displayPositions.length} position{displayPositions.length !== 1 ? 's' : ''}
          </div>
        </div>

        {/* Stale/Expired Open Alert Banner */}
        {expiredOpenStats.count > 0 && positionFilter !== 'needs_review' && (
          <div className="px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 text-amber-300 font-medium">
              <AlertTriangle size={14} className="text-amber-400 flex-shrink-0" />
              <span>
                <strong>{expiredOpenStats.count} trade position{expiredOpenStats.count > 1 ? 's' : ''} across {expiredOpenStats.positionsCount} ticker{expiredOpenStats.positionsCount > 1 ? 's' : ''}</strong> require review (past expiration without broker confirmation, or closes with no opening trade in imported history). Excluded from realized and projected P/L.
              </span>
            </div>
            <button
              onClick={() => setPositionFilter('needs_review')}
              className="px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/30 text-[11px] font-semibold transition-colors cursor-pointer"
            >
              Filter Needs Review ({expiredOpenStats.count})
            </button>
          </div>
        )}

        {/* Active Filter Banner */}
        {selectedFilter && (
          <div className="px-4 py-2.5 bg-primary-500/10 border-b border-primary-500/20 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 font-semibold text-primary-400">
                <Calendar size={14} />
                <span>{formatFilterHeader(selectedFilter)}</span>
              </div>
              <span className="text-border hidden sm:inline">|</span>
              <div className="flex items-center gap-1.5">
                <span className="text-text-muted">Filtered Realized P/L:</span>
                <span className={`font-bold text-sm tabular-nums ${totalFilteredRealizedPl >= 0 ? 'text-success-400' : 'text-danger-400'}`}>
                  {formatCurrency(totalFilteredRealizedPl)}
                </span>
              </div>
              <span className="text-border hidden sm:inline">|</span>
              <div
                className="flex items-center gap-1.5"
                title={totalFilteredClosedExpiredPl !== 0 ? `Past Expiration: ${formatCurrency(totalFilteredPastExpirationPl)} | Closed Expired: ${formatCurrency(totalFilteredClosedExpiredPl)}` : 'P/L from expired option contracts'}
              >
                <span className="text-text-muted">Expired Trades P/L:</span>
                <span className={`font-bold text-sm tabular-nums ${totalFilteredPastExpirationPl >= 0 ? 'text-success-400' : 'text-danger-400'}`}>
                  {formatCurrency(totalFilteredPastExpirationPl)}
                </span>
              </div>
              {totalFilteredPastExpirationPl !== 0 && (
                <>
                  <span className="text-border hidden sm:inline">|</span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-text-muted">Combined P/L:</span>
                    <span className={`font-bold text-sm tabular-nums ${(totalFilteredRealizedPl + totalFilteredPastExpirationPl) >= 0 ? 'text-success-400' : 'text-danger-400'}`}>
                      {formatCurrency(totalFilteredRealizedPl + totalFilteredPastExpirationPl)}
                    </span>
                  </div>
                </>
              )}
              {selectedTicker !== 'all' && (
                <>
                  <span className="text-border hidden sm:inline">|</span>
                  <span className="text-text-secondary">
                    {selectedTicker} Total: <span className={`font-bold tabular-nums ${(totalFilteredRealizedPl + totalFilteredPastExpirationPl) >= 0 ? 'text-success-400' : 'text-danger-400'}`}>{formatCurrency(totalFilteredRealizedPl + totalFilteredPastExpirationPl)}</span>
                  </span>
                </>
              )}
              <span className="text-border hidden sm:inline">|</span>
              <span className="text-text-muted">
                {filteredTradeCount} closed trade cycle{filteredTradeCount !== 1 ? 's' : ''}
              </span>
              {selectedFilter?.type === 'week' && data.weekly_targets?.[selectedFilter.key]?.indicator && (
                <>
                  <span className="text-border hidden sm:inline">|</span>
                  <span className="text-[11px] font-semibold text-amber-300 bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 rounded-md flex items-center gap-1">
                    ⚠️ {data.weekly_targets[selectedFilter.key].indicator}
                  </span>
                </>
              )}
            </div>
            <button
              onClick={() => setSelectedFilter(null)}
              className="px-2.5 py-1 rounded bg-surface hover:bg-surface-lighter border border-border text-primary-400 hover:text-primary-300 transition-colors text-xs font-semibold cursor-pointer"
            >
              ✕ Clear Filter
            </button>
          </div>
        )}

        {(() => {
          const countSource = selectedTicker !== 'all'
            ? data.positions.filter((p: any) => p.underlying.toUpperCase() === selectedTicker)
            : data.positions;

          const openCount = countSource.filter((p: any) => p.status === 'Open').length;
          const closedCount = countSource.filter((p: any) => p.status === 'Closed').length;

          return displayPositions.length > 0 ? (
            <>
              <div className="px-4 py-2 bg-surface-lighter/30 border-b border-border flex items-center justify-between text-xs text-text-muted">
                <div className="flex gap-4">
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-primary-400"></span>
                    {openCount} Active
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-text-muted"></span>
                    {closedCount} Closed
                  </span>
                </div>
                {(positionFilter !== 'all' || selectedTicker !== 'all' || timeframe !== 'all' || selectedFilter !== null) && (
                  <span className="text-text-secondary">
                    Showing {displayPositions.length} of {data.positions.length}
                  </span>
                )}
              </div>
              <div className="divide-y divide-border">
                {displayPositions.map(renderPosition)}
              </div>
              {/* Aggregate Table Footer */}
              <div className="p-4 bg-surface-lighter/50 border-t border-border flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs">
                <div className="text-text-muted">
                  <span className="font-semibold text-text-primary">Table Totals:</span> {displayPositions.length} position{displayPositions.length !== 1 ? 's' : ''}
                  {displayPositions.length !== data.positions.length && ` (filtered from ${data.positions.length})`}
                </div>
                <div className="flex items-center gap-4 flex-wrap">
                  <div className="flex items-center gap-1.5">
                    <span className="text-text-muted">Realized P/L:</span>
                    <span className={`font-bold tabular-nums ${(totalFilteredRealizedPl + totalFilteredPastExpirationPl) >= 0 ? 'text-success-400' : 'text-danger-400'}`}>
                      {formatCurrency(totalFilteredRealizedPl + totalFilteredPastExpirationPl)}
                    </span>
                    <span className="text-text-muted text-[11px]">
                      (Closed: {formatCurrency(totalFilteredRealizedPl)} · Expired: {formatCurrency(totalFilteredPastExpirationPl)})
                    </span>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="p-8 text-center text-text-muted">
              {data.positions.length === 0
                ? 'No options positions found. Import a CSV to begin tracking.'
                : `No ${positionFilter === 'open' ? 'active' : 'closed'} positions found.`}
            </div>
          );
        })()}
      </Card>

      {/* Payoff & Breakeven Diagram Modal */}
      {selectedPayoffStrategy && (
        <PayoffModal
          open={Boolean(selectedPayoffStrategy)}
          onClose={() => setSelectedPayoffStrategy(null)}
          underlying={selectedPayoffStrategy.underlying}
          subStrategy={selectedPayoffStrategy.subStrategy}
        />
      )}

      {/* Manual Contract Close Modal */}
      {selectedCloseTarget && (
        <CloseOptionModal
          open={Boolean(selectedCloseTarget)}
          onClose={() => setSelectedCloseTarget(null)}
          target={selectedCloseTarget}
          onSuccess={() => {
            // Refetch options portfolio to reflect newly closed status & realized P/L immediately
            refetch();
          }}
        />
      )}

      {/* Manual Match & Reconcile Modal */}
      {selectedMatchTarget && (
        <MatchOptionModal
          open={Boolean(selectedMatchTarget)}
          onClose={() => setSelectedMatchTarget(null)}
          target={selectedMatchTarget}
          onSuccess={() => {
            // Refetch options portfolio to reflect newly matched status & realized P/L immediately
            refetch();
          }}
        />
      )}
    </div>
  );
}
