from models.database import get_db_connection

def get_income_statement(year_month: str, account_id: int = None):
    """
    year_month format: 'YYYY-MM'
    Returns:
    {
        'income': {category: amount},
        'expenses': {category: amount},
        'total_income': float,
        'total_expenses': float,
        'net_income': float
    }
    """
    query = """
        SELECT category, SUM(amount) as total
        FROM transactions
        WHERE strftime('%Y-%m', date) = ?
    """
    params = [year_month]
    if account_id is not None:
        query += " AND account_id = ?"
        params.append(account_id)
    query += " GROUP BY category"

    income, expenses = {}, {}
    net = 0.0

    with get_db_connection() as conn:
        rows = conn.execute(query, params).fetchall()
        for r in rows:
            cat = r['category']
            tot = r['total']
            if tot > 0:
                income[cat] = tot
            elif tot < 0:
                # Store as positive value for display
                expenses[cat] = abs(tot)
            net += tot

    return {
        'income': income,
        'expenses': expenses,
        'total_income': sum(income.values()),
        'total_expenses': sum(expenses.values()),
        'net_income': net
    }

def get_balance_sheet(date_as_of: str, account_id: int = None):
    """
    Point-in-time calculation of balances per account type.
    Assets: checking, savings, investment
    Liabilities: credit card, loan
    """
    query = """
        SELECT a.type, a.name, SUM(t.amount) as balance
        FROM accounts a
        LEFT JOIN transactions t ON a.id = t.account_id
        WHERE (t.date <= ? OR t.date IS NULL)
    """
    params = [date_as_of]
    if account_id is not None:
        query += " AND a.id = ?"
        params.append(account_id)
    query += " GROUP BY a.id"

    assets = {'checking': 0, 'savings': 0, 'investment': 0}
    liabilities = {'credit card': 0, 'loan': 0}
    
    with get_db_connection() as conn:
        rows = conn.execute(query, params).fetchall()
        for r in rows:
            acc_type = r['type'].lower()
            bal = r['balance'] or 0.0
            
            if acc_type in assets:
                assets[acc_type] += bal
            elif acc_type in liabilities:
                liabilities[acc_type] -= bal # Liab normally negative balances, so subtract to make positive, but keep sign for overpayments

    total_assets = sum(assets.values())
    total_liabilities = sum(liabilities.values())
    equity = total_assets - total_liabilities

    return {
        'assets': assets,
        'liabilities': liabilities,
        'total_assets': total_assets,
        'total_liabilities': total_liabilities,
        'equity': equity
    }

def get_cash_flow_statement(year_month: str, account_id: int = None):
    """
    Groups cash flows into Operating, Investing, Financing.
    Basic heuristic based on category string or signs.
    """
    # Heuristic rules:
    investing_keywords = ['stock', 'crypto', 'investment', '401k', 'brokerage']
    financing_keywords = ['loan', 'mortgage', 'credit card', 'dividend', 'interest']
    
    query = """
        SELECT t.category, a.type as account_type, SUM(t.amount) as net_flow
        FROM transactions t
        JOIN accounts a ON t.account_id = a.id
        WHERE strftime('%Y-%m', t.date) = ?
    """
    params = [year_month]
    if account_id is not None:
        query += " AND t.account_id = ?"
        params.append(account_id)
    query += " GROUP BY t.category, a.type"

    operating, investing, financing = 0.0, 0.0, 0.0
    
    with get_db_connection() as conn:
        rows = conn.execute(query, params).fetchall()
        for r in rows:
            cat = r['category'].lower()
            acc_type = (r['account_type'] or '').lower()
            flow = r['net_flow']
            
            is_financing = any(k in cat for k in financing_keywords)
            is_investing = (acc_type == 'investment') or any(k in cat for k in investing_keywords)
            
            if is_financing:
                financing += flow
            elif is_investing:
                investing += flow
            else:
                operating += flow
                
    total_flow = operating + investing + financing
    
    return {
        'operating': operating,
        'investing': investing,
        'financing': financing,
        'total_net_flow': total_flow
    }
