import re
import yfinance as yf
from models.database import get_db_connection
from utils.logger import logger

def get_portfolio():
    """
    Parses transactions in 'investment' accounts to determine current holdings.
    Fetches real-time prices using yfinance.
    Returns a dictionary with portfolio summary and a list of holdings.
    """
    from services.options import parse_option_symbol

    query = """
        SELECT t.id, t.amount, t.category, t.description, t.date
        FROM transactions t
        JOIN accounts a ON t.account_id = a.id
        LEFT JOIN option_legs ol ON t.id = ol.transaction_id
        WHERE a.type = 'investment' AND ol.id IS NULL
    """
    
    holdings = {}
    
    # Regex to extract Sym, Qty, and Price from description
    # Expected format: "Sym: SYMBOL | Security description | Qty: QUANTITY | Price: PRICE"
    sym_re = re.compile(r"Sym:\s*([A-Za-z0-9\.\-]+)")
    qty_re = re.compile(r"Qty:\s*(-?[\d\.,]+)")
    
    with get_db_connection() as conn:
        rows = conn.execute(query).fetchall()
        
    first_trade_date = None
    
    for row in rows:
        desc = row['description']
        if not desc:
            continue
            
        sym_match = sym_re.search(desc)
        qty_match = qty_re.search(desc)
        
        if not sym_match or not qty_match:
            continue

        # Exclude option transactions: check if Sym contains a full option token
        sym_token_match = re.search(r"Sym:\s*([^\|]+)", desc)
        if sym_token_match and parse_option_symbol(sym_token_match.group(1).strip()):
            continue
            
        sym = sym_match.group(1).upper()
        
        try:
            qty = float(qty_match.group(1).replace(',', ''))
        except ValueError:
            continue
            
        cat = str(row['category']).strip().lower()
        amount = float(row['amount'])
        is_transfer = (('transfer' in cat) or ('security transfer' in desc.lower())) and not any(a in cat for a in ['buy', 'sell', 'div'])
        
        t_date_str = str(row['date']).strip()
        if " as of " in t_date_str:
            t_date_str = t_date_str.split(" as of ")[0].strip()
            
        try:
            import pandas as pd
            t_date_iso = pd.to_datetime(t_date_str).strftime('%Y-%m-%d')
            if t_date_iso == 'NaT':
                t_date_iso = ""
        except Exception:
            t_date_iso = t_date_str
            
        if first_trade_date is None or (t_date_iso and t_date_iso < first_trade_date):
            first_trade_date = t_date_iso
        
        if sym not in holdings:
            holdings[sym] = {'shares': 0.0, 'total_cost': 0.0, 'realized_profit': 0.0, 'min_shares': 0.0}
            
        if is_transfer:
            if qty > 0:
                # Stock transferred IN: adds shares to portfolio without fabricating dollar cost
                holdings[sym]['shares'] += qty
                holdings[sym]['total_cost'] += abs(amount)
            elif qty < 0:
                # Stock transferred OUT: removes shares from inventory without realizing profit/loss
                remove_qty = min(abs(qty), holdings[sym]['shares'])
                if holdings[sym]['shares'] > 0:
                    ratio = remove_qty / holdings[sym]['shares']
                    holdings[sym]['total_cost'] -= holdings[sym]['total_cost'] * ratio
                holdings[sym]['shares'] -= remove_qty
                # Track minimum shares (can go negative if transfer out exceeds inventory)
                holdings[sym]['min_shares'] = min(holdings[sym]['min_shares'], holdings[sym]['shares'])
            continue

        # Determine if Buy or Sell
        # Generally, amount < 0 implies cash leaving (buy), amount > 0 implies cash arriving (sell)
        is_buy = ('buy' in cat) or (amount < 0 and 'sell' not in cat and 'div' not in cat)
        is_sell = ('sell' in cat) or (amount > 0 and 'buy' not in cat and 'div' not in cat)
        
        if is_buy:
            holdings[sym]['shares'] += qty
            holdings[sym]['total_cost'] += abs(amount) # Accumulate absolute cost
        elif is_sell:
            cost_basis_sold = 0.0
            if holdings[sym]['shares'] > 0:
                # Reduce cost basis proportionally to the shares being sold
                ratio = qty / holdings[sym]['shares']
                # Safeguard against selling more than we have
                ratio = min(ratio, 1.0)
                cost_basis_sold = holdings[sym]['total_cost'] * ratio
                holdings[sym]['total_cost'] -= cost_basis_sold
            
            # Amount is positive when selling (cash arriving)
            profit_from_sale = amount - cost_basis_sold
            holdings[sym]['realized_profit'] += profit_from_sale
            holdings[sym]['shares'] -= qty
            # Track minimum shares to detect incomplete cost basis (sells before buys)
            holdings[sym]['min_shares'] = min(holdings[sym]['min_shares'], holdings[sym]['shares'])
            
    # Filter out empty positions (less than 0.001 shares)
    active_holdings = {sym: data for sym, data in holdings.items() if data['shares'] > 0.001}
    
    # Also include fully sold positions if they have realized profit
    realized_results = []
    total_realized_profit = 0.0
    for sym, data in holdings.items():
        if data['realized_profit'] != 0.0:
            total_realized_profit += data['realized_profit']
            # incomplete_basis: True when the share count ever went negative during processing,
            # meaning opening lots were sold before they were imported. The P/L is computed
            # against $0 cost basis for those shares, making the figure unreliable.
            incomplete = data.get('min_shares', 0.0) < -0.001
            realized_results.append({
                "ticker": sym,
                "realized_profit": data['realized_profit'],
                "incomplete_basis": incomplete,
            })

    if not active_holdings and not realized_results:
        return {"total_value": 0, "total_cost": 0, "total_profit": 0, "total_realized_profit": 0, "first_trade_date": first_trade_date, "holdings": [], "realized_gains": []}
        
    tickers = list(active_holdings.keys())
    prices = {}
    
    for t in tickers:
        try:
            ticker_obj = yf.Ticker(t)
            # Fetch last 5 days to ensure we get a recent close even on weekends/holidays
            hist = ticker_obj.history(period="5d")
            if not hist.empty:
                prices[t] = float(hist['Close'].iloc[-1])
            else:
                prices[t] = 0.0
                logger.warning(f"No pricing data found for ticker {t}")
        except Exception as e:
            logger.error(f"Error fetching yfinance data for {t}: {e}")
            prices[t] = 0.0
            
    results = []
    total_value = 0.0
    total_cost = 0.0
    
    for sym, data in active_holdings.items():
        shares = data['shares']
        cost = max(data['total_cost'], 0.0) # Prevent negative cost from bad data
        avg_price = cost / shares if shares > 0 else 0
        
        curr_price = prices.get(sym, 0.0)
        curr_value = curr_price * shares
        profit = curr_value - cost
        profit_pct = (profit / cost * 100) if cost > 0 else 0
        
        total_value += curr_value
        total_cost += cost
        
        results.append({
            "ticker": sym,
            "shares": shares,
            "avg_price": avg_price,
            "current_price": curr_price,
            "current_value": curr_value,
            "profit": profit,
            "profit_pct": profit_pct,
            # incomplete_basis: cost basis is unreliable if share count ever went negative,
            # meaning the position was at least partially opened before import history begins.
            "incomplete_basis": data.get('min_shares', 0.0) < -0.001,
        })
            
    return {
        "total_value": total_value,
        "total_cost": total_cost,
        "total_profit": total_value - total_cost,
        "total_realized_profit": total_realized_profit,
        "first_trade_date": first_trade_date,
        "holdings": sorted(results, key=lambda x: x['current_value'], reverse=True),
        "realized_gains": sorted(realized_results, key=lambda x: x['realized_profit'], reverse=True)
    }
