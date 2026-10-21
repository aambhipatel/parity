import os
import hashlib
from datetime import datetime
from flask import Flask, request, jsonify
from flask_cors import CORS
from models.schema import setup_database
from models.database import get_db_connection, get_admin_password_hash, set_admin_password_hash
from services.crud import (
    list_institutions, get_or_create_institution,
    list_accounts, get_or_create_account,
    add_transaction, wipe_database, revert_imported_file
)
from services.financial import (
    get_income_statement, get_balance_sheet, get_cash_flow_statement
)
from services.data_import import import_transactions_from_csv
from services.portfolio import get_portfolio

app = Flask(__name__)
# In production, specify origins for better security.
CORS(app)

# Opening the server must not initialize, migrate, or repair existing storage.
# Initialize explicitly with python -m models.schema (or its migration command).


@app.before_request
def require_database_for_data_reads():
    """Give the UI a useful missing-file error before any database-backed read."""
    prefixes = ('/api/institutions', '/api/accounts', '/api/transactions', '/api/imports',
                '/api/reports', '/api/portfolio', '/api/options', '/api/dashboard')
    if request.method == 'GET' and request.path.startswith(prefixes):
        from models.database import require_existing_database, DatabaseNotFoundError
        try:
            require_existing_database()
        except DatabaseNotFoundError as error:
            return jsonify({'error': str(error)}), 404

# ─── Institutions ────────────────────────────────────────────
@app.route('/api/institutions', methods=['GET'])
def get_institutions():
    try:
        institutions = list_institutions()
        # Convert list of tuples to list of dicts
        return jsonify([{"id": i[0], "name": i[1]} for i in institutions])
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/institutions', methods=['POST'])
def post_institution():
    data = request.json
    if not data or 'name' not in data:
        return jsonify({"error": "Name is required"}), 400
    try:
        inst_id = get_or_create_institution(data['name'])
        return jsonify({"id": inst_id, "name": data['name']})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ─── Accounts ────────────────────────────────────────────────
@app.route('/api/accounts', methods=['GET'])
def get_accounts():
    try:
        accounts = list_accounts()
        # accounts: list of (account_id, inst_name, acc_name, type)
        # We need balances too for the frontend
        res = []
        # Reuse balance sheet logic or simple query
        today = datetime.now().strftime('%Y-%m-%d')
        balances = get_balance_sheet(today)['assets']
        balances.update(get_balance_sheet(today)['liabilities'])
        
        # Need per-account balances
        with get_db_connection() as conn:
            query = "SELECT account_id, SUM(amount) as bal FROM transactions GROUP BY account_id"
            acc_balances = {row['account_id']: (row['bal'] or 0.0) for row in conn.execute(query).fetchall()}
            
        # Aggregate options unrealized target P/L and past expiration P/L by account
        as_of_date = request.args.get('as_of_date')
        from services.options import get_options_portfolio
        opt_portfolio = get_options_portfolio(as_of_date=as_of_date)
        acc_unrealized = {}
        acc_past_exp = {}
        acc_has_past_exp = {}
        for pos in opt_portfolio.get('positions', []):
            acc_id = pos.get('account_id')
            unrealized = pos.get('unrealized_pl', 0.0)
            past_exp = pos.get('past_expiration_pl', 0.0)
            acc_unrealized[acc_id] = acc_unrealized.get(acc_id, 0.0) + unrealized
            acc_past_exp[acc_id] = acc_past_exp.get(acc_id, 0.0) + past_exp
            if pos.get('status') == 'Past Expiration' or any(s.get('status') == 'Past Expiration' for s in pos.get('sub_strategies', [])):
                acc_has_past_exp[acc_id] = True
            
        for acc in accounts:
            res.append({
                "id": acc[0],
                "institution_name": acc[1],
                "name": acc[2],
                "type": acc[3],
                "balance": acc_balances.get(acc[0], 0.0),
                "unrealized_pl_target": acc_unrealized.get(acc[0], 0.0),
                "past_expiration_pl": acc_past_exp.get(acc[0], 0.0),
                "has_past_expiration": acc_has_past_exp.get(acc[0], False)
            })
        return jsonify(res)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/accounts', methods=['POST'])
def post_account():
    data = request.json
    required = ['institution_id', 'name', 'type']
    if not all(k in data for k in required):
        return jsonify({"error": "Missing fields"}), 400
    try:
        acc_id = get_or_create_account(data['institution_id'], data['name'], data['type'])
        return jsonify({"id": acc_id, "name": data['name'], "type": data['type']})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/accounts/<int:account_id>', methods=['DELETE'])
def delete_account_route(account_id):
    try:
        from services.crud import delete_account
        delete_account(account_id)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/accounts/<int:account_id>', methods=['PUT'])
def update_account_route(account_id):
    data = request.json
    if not data or 'name' not in data:
        return jsonify({"error": "Missing 'name' field"}), 400
    try:
        from services.crud import update_account_name
        update_account_name(account_id, data['name'])
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ─── Transactions ────────────────────────────────────────────
@app.route('/api/transactions', methods=['GET'])
def get_transactions():
    try:
        # Simplified listing, can add filters later
        query = """
            SELECT t.id, t.account_id, a.name as account_name, t.date, t.amount, t.category, t.description
            FROM transactions t
            JOIN accounts a ON t.account_id = a.id
            ORDER BY t.date DESC
        """
        params = []
        with get_db_connection() as conn:
            rows = conn.execute(query, params).fetchall()
            res = [dict(row) for row in rows]
        return jsonify(res)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/transactions', methods=['POST'])
def post_transaction():
    data = request.json
    required = ['account_id', 'date', 'amount', 'category', 'description']
    if not all(k in data for k in required):
        return jsonify({"error": "Missing fields"}), 400
    try:
        success = add_transaction(
            data['account_id'], data['date'], 
            float(data['amount']), data['category'], 
            data['description']
        )
        return jsonify({"success": success})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/transactions/import', methods=['POST'])
def import_csv():
    if 'file' not in request.files:
        return jsonify({"error": "No file part"}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "No selected file"}), 400
        
    account_id = request.form.get('account_id')
    force_account_id = int(account_id) if account_id else None
        
    temp_path = os.path.join("/tmp", file.filename)
    if not os.path.exists("/tmp"):
        os.makedirs("/tmp")
    file.save(temp_path)
    
    try:
        success, message = import_transactions_from_csv(temp_path, force_account_id=force_account_id)
        os.remove(temp_path)
        if success:
            return jsonify({"message": message})
        else:
            return jsonify({"error": message}), 400
    except Exception as e:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        return jsonify({"error": str(e)}), 500

# ─── CSV Imports & Reverts ──────────────────────────────────
@app.route('/api/imports', methods=['GET'])
def get_imports():
    try:
        with get_db_connection() as conn:
            query = """
                SELECT f.id, f.filename, f.imported_at, a.name as account_name
                FROM imported_files f
                LEFT JOIN transactions t ON f.id = t.imported_file_id
                LEFT JOIN accounts a ON t.account_id = a.id
                GROUP BY f.id
                ORDER BY f.id DESC
            """
            rows = conn.execute(query).fetchall()
            res = [dict(row) for row in rows]
        return jsonify(res)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/imports/last', methods=['DELETE'])
def delete_last_import():
    try:
        with get_db_connection() as conn:
            # Find the last imported file
            last_file = conn.execute("SELECT id, filename FROM imported_files ORDER BY id DESC LIMIT 1").fetchone()
            
        if not last_file:
            return jsonify({"error": "No imported CSV files found to revert."}), 404
            
        revert_imported_file(last_file['id'])
        return jsonify({"success": True, "message": f"Successfully reverted CSV file: {last_file['filename']}"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/imports/<int:import_id>', methods=['DELETE'])
def delete_specific_import(import_id):
    try:
        revert_imported_file(import_id)
        return jsonify({"success": True, "message": "Successfully reverted CSV file."})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ─── Reports ─────────────────────────────────────────────────
@app.route('/api/reports/income-statement', methods=['GET'])
def income_statement():
    month = request.args.get('month') # YYYY-MM
    account_id = request.args.get('account_id')
    if not month:
        return jsonify({"error": "Month is required"}), 400
    return jsonify(get_income_statement(month, int(account_id) if account_id else None))

@app.route('/api/reports/balance-sheet', methods=['GET'])
def balance_sheet():
    date = request.args.get('date') # YYYY-MM-DD
    account_id = request.args.get('account_id')
    if not date:
        date = datetime.now().strftime('%Y-%m-%d')
    return jsonify(get_balance_sheet(date, int(account_id) if account_id else None))

@app.route('/api/reports/cash-flow', methods=['GET'])
def cash_flow():
    month = request.args.get('month') # YYYY-MM
    account_id = request.args.get('account_id')
    if not month:
        return jsonify({"error": "Month is required"}), 400
    return jsonify(get_cash_flow_statement(month, int(account_id) if account_id else None))

@app.route('/api/portfolio', methods=['GET'])
def portfolio():
    try:
        return jsonify(get_portfolio())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/options', methods=['GET'])
def options_portfolio():
    try:
        from services.options import get_options_portfolio
        account_ids_str = request.args.get('account_ids')
        as_of_date = request.args.get('as_of_date')
        account_ids = None
        if account_ids_str:
            account_ids = [int(x.strip()) for x in account_ids_str.split(',') if x.strip()]
        return jsonify(get_options_portfolio(account_ids, as_of_date=as_of_date))
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/options/issues', methods=['GET'])
def options_issues():
    from datetime import date
    from services.option_issue_list import get_option_issue_list, ISSUE_TYPES
    try:
        raw = request.args.get('account_ids')
        account_ids = None
        if raw is not None:
            parts = raw.split(',')
            if not all(p.strip().isdigit() and int(p.strip()) > 0 for p in parts):
                return jsonify(error='account_ids must be comma-separated positive integers'), 400
            account_ids = sorted(set(int(p.strip()) for p in parts))
        raw_types = request.args.get('type')
        types = raw_types.split(',') if raw_types is not None else None
        if types is not None and any(t not in ISSUE_TYPES for t in types):
            return jsonify(error='Unknown issue type', available_types=list(ISSUE_TYPES)), 400
        as_of_date = request.args.get('as_of_date')
        if as_of_date is not None:
            try:
                if date.fromisoformat(as_of_date).isoformat() != as_of_date:
                    raise ValueError()
            except ValueError:
                return jsonify(error='as_of_date must be YYYY-MM-DD'), 400
        return jsonify(get_option_issue_list(account_ids, types, as_of_date))
    except Exception as e:
        return jsonify(error=str(e)), 500


@app.route('/api/options/prices', methods=['POST'])
def options_prices():
    try:
        from services.options import fetch_options_prices
        data = request.json
        if not data or 'open_legs' not in data:
            return jsonify({"error": "Missing open_legs"}), 400
        prices = fetch_options_prices(data['open_legs'])
        return jsonify(prices)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/options/close', methods=['POST'])
def close_option():
    try:
        from services.options import manually_close_option_contract
        data = request.json
        if not data:
            return jsonify({"error": "No JSON payload provided"}), 400
            
        required_fields = ['account_id', 'underlying', 'expiration', 'strike', 'opt_type', 'close_type', 'close_date', 'quantity']
        for field in required_fields:
            if field not in data:
                return jsonify({"error": f"Missing required field: '{field}'"}), 400
                
        result = manually_close_option_contract(
            account_id=int(data['account_id']),
            underlying=str(data['underlying']),
            expiration=str(data['expiration']),
            strike=float(data['strike']),
            opt_type=str(data['opt_type']),
            close_type=str(data['close_type']),
            close_date=str(data['close_date']),
            quantity=float(data['quantity']),
            close_price=float(data.get('close_price', 0.0) or 0.0),
            fees=float(data.get('fees', 0.0) or 0.0),
            notes=str(data.get('notes', '') or '')
        )
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/options/dismiss', methods=['POST'])
def dismiss_option():
    try:
        from services.options import dismiss_unmatched_option
        data = request.json or {}
        tx_id = data.get('transaction_id')
        if not tx_id:
            return jsonify({"error": "Missing transaction_id"}), 400
        result = dismiss_unmatched_option(int(tx_id))
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/options/dismiss-duplicate', methods=['POST'])
def dismiss_duplicate():
    try:
        from services.options import dismiss_duplicate_pair
        data = request.json or {}
        tx1_id = data.get('tx1_id')
        tx2_id = data.get('tx2_id')
        if not tx1_id or not tx2_id:
            return jsonify({"error": "Missing tx1_id or tx2_id"}), 400
        result = dismiss_duplicate_pair(int(tx1_id), int(tx2_id))
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/options/undismiss-duplicate', methods=['POST'])
def undismiss_duplicate():
    try:
        from services.options import undismiss_duplicate_pair
        data = request.json or {}
        tx1_id = data.get('tx1_id')
        tx2_id = data.get('tx2_id')
        if not tx1_id or not tx2_id:
            return jsonify({"error": "Missing tx1_id or tx2_id"}), 400
        result = undismiss_duplicate_pair(int(tx1_id), int(tx2_id))
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/options/unmatched/candidates/<int:tx_id>', methods=['GET'])
def get_option_match_candidates(tx_id):
    try:
        from services.options import get_match_candidates
        candidates = get_match_candidates(tx_id)
        if "error" in candidates:
            return jsonify(candidates), 404
        return jsonify(candidates)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/options/match', methods=['POST'])
def match_option():
    try:
        from services.options import match_unmatched_option
        data = request.json or {}
        tx_id = data.get('transaction_id')
        mode = data.get('mode')
        if not tx_id or not mode:
            return jsonify({"error": "Missing transaction_id or mode"}), 400

        result = match_unmatched_option(
            transaction_id=int(tx_id),
            mode=str(mode),
            manual_transaction_ids=data.get('manual_transaction_ids'),
            allocations=data.get('allocations'),
            open_lots=data.get('open_lots'),
            target_expiration=data.get('target_expiration'),
            target_strike=data.get('target_strike'),
            target_opt_type=data.get('target_opt_type'),
            open_date=data.get('open_date'),
            open_price=data.get('open_price'),
            open_action=data.get('open_action'),
            open_quantity=data.get('open_quantity'),
            fees=data.get('fees', 0.0),
            notes=data.get('notes', '')
        )
        if "error" in result:
            return jsonify(result), 400
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500



# ─── Dashboard Summary ───────────────────────────────────────
@app.route('/api/dashboard', methods=['GET'])
def dashboard():
    try:
        today = datetime.now().strftime('%Y-%m-%d')
        month = datetime.now().strftime('%Y-%m')
        
        bs = get_balance_sheet(today)
        is_stmt = get_income_statement(month)
        
        # Recent transactions
        with get_db_connection() as conn:
            rows = conn.execute("SELECT t.*, a.name as account_name FROM transactions t JOIN accounts a ON t.account_id = a.id ORDER BY date DESC LIMIT 8").fetchall()
            recent = [dict(r) for r in rows]
            
        # History for charts: 6 months rolling
        history_is = []
        history_nw = []
        
        now = datetime.now()
        for i in range(5, -1, -1):
            y, m = now.year, now.month
            m -= i
            while m <= 0:
                m += 12
                y -= 1
            ym = f"{y}-{m:02d}"
            
            # Using the 28th as a safe approximation for "end of month" for balance sheet logic
            last_day = f"{ym}-28"
            
            hist_is_stmt = get_income_statement(ym)
            hist_bs = get_balance_sheet(last_day)
            
            history_is.append({
                "month": ym, 
                "income": hist_is_stmt['total_income'], 
                "expenses": hist_is_stmt['total_expenses']
            })
            
            history_nw.append({
                "month": ym, 
                "value": hist_bs['equity']
            })
        
        as_of_date = request.args.get('as_of_date')
        from services.options import get_options_portfolio
        opt_port = get_options_portfolio(as_of_date=as_of_date)
        total_target_pl = opt_port.get('total_unrealized_pl', 0.0)
        total_past_exp_pl = opt_port.get('total_past_expiration_pl', 0.0)
        has_past_exp = (abs(total_past_exp_pl) > 0.001) or any(
            p.get('status') == 'Past Expiration' or any(s.get('status') == 'Past Expiration' for s in p.get('sub_strategies', []))
            for p in opt_port.get('positions', [])
        )

        return jsonify({
            "total_assets": bs['total_assets'],
            "total_liabilities": bs['total_liabilities'],
            "net_worth": bs['equity'],
            "monthly_income": is_stmt['total_income'],
            "monthly_expenses": is_stmt['total_expenses'],
            "recent_transactions": recent,
            "net_worth_history": history_nw,
            "income_expense_history": history_is,
            "options_target_pl": total_target_pl,
            "options_past_expiration_pl": total_past_exp_pl,
            "has_past_expiration": has_past_exp
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/wipe', methods=['POST'])
def wipe():
    data = request.json or {}
    password = data.get('password', '').strip()
    
    # Verify admin password before allowing wipe
    stored_hash = get_admin_password_hash()
    if not stored_hash:
        return jsonify({"error": "Admin password not set. Please set it first via the Admin panel."}), 403
    
    pw_hash = hashlib.sha256(password.encode()).hexdigest()
    if pw_hash != stored_hash:
        return jsonify({"error": "Incorrect admin password."}), 401
    
    try:
        wipe_database()
        return jsonify({"message": "Database wiped successfully."})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ─── Admin ────────────────────────────────────────────────────
@app.route('/api/admin/status', methods=['GET'])
def admin_status():
    """Check if an admin password has been set."""
    pw_hash = get_admin_password_hash()
    return jsonify({"password_set": bool(pw_hash)})

@app.route('/api/admin/set-password', methods=['POST'])
def admin_set_password():
    """Set the initial admin password. Only works if no password exists yet."""
    data = request.json or {}
    password = data.get('password', '').strip()
    
    if not password or len(password) < 4:
        return jsonify({"error": "Password must be at least 4 characters."}), 400
    
    existing = get_admin_password_hash()
    if existing:
        return jsonify({"error": "Admin password already set. Use change-password instead."}), 409
    
    pw_hash = hashlib.sha256(password.encode()).hexdigest()
    set_admin_password_hash(pw_hash)
    
    return jsonify({"message": "Admin password set successfully."})

@app.route('/api/admin/verify', methods=['POST'])
def admin_verify():
    """Verify the admin password."""
    data = request.json or {}
    password = data.get('password', '').strip()
    
    stored_hash = get_admin_password_hash()
    if not stored_hash:
        return jsonify({"error": "No admin password set."}), 404
    
    pw_hash = hashlib.sha256(password.encode()).hexdigest()
    if pw_hash == stored_hash:
        return jsonify({"verified": True})
    else:
        return jsonify({"verified": False, "error": "Incorrect password."}), 401

@app.route('/api/admin/change-password', methods=['POST'])
def admin_change_password():
    """Change admin password. Requires current password."""
    data = request.json or {}
    current = data.get('current_password', '').strip()
    new_pw = data.get('new_password', '').strip()
    
    if not new_pw or len(new_pw) < 4:
        return jsonify({"error": "New password must be at least 4 characters."}), 400
    
    stored_hash = get_admin_password_hash()
    if not stored_hash:
        return jsonify({"error": "No admin password set."}), 404
    
    current_hash = hashlib.sha256(current.encode()).hexdigest()
    if current_hash != stored_hash:
        return jsonify({"error": "Current password is incorrect."}), 401
    
    new_hash = hashlib.sha256(new_pw.encode()).hexdigest()
    set_admin_password_hash(new_hash)
    
    return jsonify({"message": "Password changed successfully."})

@app.route('/api/admin/migrations', methods=['GET'])
def get_admin_migrations():
    """Inspect versioned database migrations status."""
    try:
        from models.schema import get_migration_status
        status = get_migration_status()
        return jsonify(status), (404 if status.get('error') else 200)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/admin/migrations/apply', methods=['POST'])
def apply_admin_migrations():
    """Apply pending versioned database migrations with explicit user confirmation and backup."""
    try:
        from models.schema import run_versioned_migrations
        data = request.json or {}
        confirm = bool(data.get('confirm', False))
        res = run_versioned_migrations(user_confirmed=confirm)
        return jsonify(res), (404 if res.get('error') else 200)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ─── Database Management ─────────────────────────────────────
@app.route('/api/database/current', methods=['GET'])
def get_current_db():
    try:
        from models.database import get_active_db_info
        return jsonify(get_active_db_info())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/database/list', methods=['GET'])
def list_databases():
    try:
        from models.database import list_available_databases
        dbs = list_available_databases()
        return jsonify({"databases": dbs})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/database/switch', methods=['POST'])
def switch_db():
    data = request.json or {}
    filename = data.get('filename')
    password = data.get('password')
    if not filename:
        return jsonify({"error": "Filename is required"}), 400
    try:
        from models.database import switch_database, DatabasePasswordRequiredError
        res = switch_database(filename, password=password)
        return jsonify({"message": f"Switched to {filename}", "database": res})
    except DatabasePasswordRequiredError as dpre:
        return jsonify({"error": str(dpre), "requires_password": True}), 401
    except ValueError as ve:
        return jsonify({"error": str(ve)}), 400
    except FileNotFoundError as fnfe:
        return jsonify({"error": str(fnfe)}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/database/rename', methods=['POST'])
def rename_db():
    data = request.json or {}
    filename = data.get('filename')
    display_name = data.get('display_name')
    if not filename or not display_name:
        return jsonify({"error": "Both filename and display_name are required"}), 400
    try:
        from models.database import set_database_name
        res = set_database_name(filename, display_name)
        return jsonify({"message": "Database renamed successfully", "database": res})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/database/default', methods=['GET'])
def get_default_db():
    try:
        from models.database import get_default_database, list_available_databases
        def_name = get_default_database()
        dbs = list_available_databases()
        match = next((d for d in dbs if d['filename'] == def_name), None)
        return jsonify({"default_db": def_name, "database": match})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/database/set-default', methods=['POST'])
def set_default_db():
    data = request.json or {}
    filename = data.get('filename')
    if not filename:
        return jsonify({"error": "Filename is required"}), 400
    try:
        from models.database import set_default_database
        res = set_default_database(filename)
        return jsonify(res)
    except FileNotFoundError as fnfe:
        return jsonify({"error": str(fnfe)}), 404
    except ValueError as ve:
        return jsonify({"error": str(ve)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/database/reset-to-default', methods=['POST'])
def reset_default_db():
    data = request.json or {}
    password = data.get('password')
    try:
        from models.database import reset_to_default_database, DatabasePasswordRequiredError
        res = reset_to_default_database(password=password)
        return jsonify({"message": f"Switched to default database {res['filename']}", "database": res})
    except DatabasePasswordRequiredError as dpre:
        return jsonify({"error": str(dpre), "requires_password": True}), 401
    except ValueError as ve:
        return jsonify({"error": str(ve)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/database/create', methods=['POST'])
def create_db():
    data = request.json or {}
    filename = data.get('filename', '').strip()
    display_name = data.get('display_name', '').strip()
    copy_from_current = bool(data.get('copy_from_current', False))
    password = data.get('password')
    set_as_default = bool(data.get('set_as_default', False))
    if not filename:
        return jsonify({"error": "Filename is required"}), 400
    try:
        from models.database import create_database
        res = create_database(
            filename,
            display_name=display_name,
            copy_from_current=copy_from_current,
            password=password,
            set_as_default=set_as_default
        )
        return jsonify({"message": "Database created successfully", "database": res})
    except ValueError as ve:
        return jsonify({"error": str(ve)}), 400
    except FileExistsError as fee:
        return jsonify({"error": str(fee)}), 409
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/database/delete', methods=['POST'])
def delete_db():
    data = request.json or {}
    filename = data.get('filename')
    if not filename:
        return jsonify({"error": "Filename is required"}), 400
    try:
        from models.database import delete_database
        res = delete_database(filename)
        return jsonify(res)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/database/protect', methods=['POST'])
def protect_db():
    data = request.json or {}
    filename = data.get('filename')
    new_password = data.get('new_password')
    current_password = data.get('current_password')
    if not filename:
        return jsonify({"error": "Filename is required"}), 400
    if not new_password or len(new_password) < 4:
        return jsonify({"error": "New password must be at least 4 characters long."}), 400
    try:
        from models.database import set_database_password
        res = set_database_password(filename, new_password, current_password)
        return jsonify(res)
    except ValueError as ve:
        return jsonify({"error": str(ve)}), 400
    except FileNotFoundError as fnfe:
        return jsonify({"error": str(fnfe)}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/database/unprotect', methods=['POST'])
def unprotect_db():
    data = request.json or {}
    filename = data.get('filename')
    current_password = data.get('current_password')
    if not filename:
        return jsonify({"error": "Filename is required"}), 400
    try:
        from models.database import remove_database_password
        res = remove_database_password(filename, current_password)
        return jsonify(res)
    except ValueError as ve:
        return jsonify({"error": str(ve)}), 400
    except FileNotFoundError as fnfe:
        return jsonify({"error": str(fnfe)}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/database/verify-password', methods=['POST'])
def verify_db_password():
    data = request.json or {}
    filename = data.get('filename')
    password = data.get('password', '')
    if not filename:
        return jsonify({"error": "Filename is required"}), 400
    try:
        from models.database import verify_database_password, is_database_protected
        is_prot = is_database_protected(filename)
        if not is_prot:
            return jsonify({"valid": True, "is_protected": False})
        valid = verify_database_password(filename, password)
        return jsonify({"valid": valid, "is_protected": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/database/upload', methods=['POST'])
def upload_db():
    if 'file' not in request.files:
        return jsonify({"error": "No file uploaded. Please select a .db file."}), 400
    file = request.files['file']
    if not file or file.filename == '':
        return jsonify({"error": "No file selected."}), 400
        
    display_name = request.form.get('display_name', '').strip()
    switch_now = request.form.get('switch_now', 'false').lower() in ('true', '1', 'yes')
    password = request.form.get('password')
    set_as_default = request.form.get('set_as_default', 'false').lower() in ('true', '1', 'yes')
    
    try:
        from models.database import upload_database
        res = upload_database(
            file.stream,
            original_filename=file.filename,
            display_name=display_name if display_name else None,
            switch_now=switch_now,
            password=password if password else None,
            set_as_default=set_as_default
        )
        return jsonify({
            "message": f"Database '{res['filename']}' uploaded successfully.",
            "database": res
        })
    except ValueError as ve:
        return jsonify({"error": str(ve)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500

_summary_cache = {}

@app.route('/api/company/summary/<ticker>', methods=['GET'])
def get_company_summary(ticker):
    if ticker in _summary_cache:
        return jsonify({"ticker": ticker, "summary": _summary_cache[ticker]})
    try:
        import yfinance as yf
        tk = yf.Ticker(ticker)
        summary = tk.info.get("longBusinessSummary", "No summary available.")
        _summary_cache[ticker] = summary
        return jsonify({"ticker": ticker, "summary": summary})
    except Exception as e:
        # Fallback in case of error
        return jsonify({"ticker": ticker, "summary": "Error fetching summary."}), 200

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
