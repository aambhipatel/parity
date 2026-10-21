import sys
from services.crud import (
    get_or_create_institution, get_or_create_account, add_transaction,
    list_institutions, list_accounts, wipe_database
)
from services.data_import import import_transactions_from_csv
from services.financial import get_income_statement, get_balance_sheet, get_cash_flow_statement
from utils.formatting import print_table, print_financial_statement

def print_menu():
    print("\\n=== Personal Finance Application ===")
    print("1. Add institution")
    print("2. Add account")
    print("3. Add transactions")
    print("4. Import transactions (CSV)")
    print("5. Generate Income Statement")
    print("6. Generate Balance Sheet")
    print("7. Generate Cash Flow Statement")
    print("8. Exit")
    print("9. Wipe Database")
    print("====================================")

def add_institution_menu():
    name = input("Enter institution name: ").strip()
    if name:
        inst_id = get_or_create_institution(name)
        print(f"-> Institution '{name}' saved (ID: {inst_id}).")
    else:
        print("-> Invalid name.")

def add_account_menu():
    print("\\n-- Available Institutions --")
    insts = list_institutions()
    if not insts:
        print("No institutions found. Please add one first.")
        return
    print_table(["ID", "Name"], insts)
    
    try:
        inst_id = int(input("Enter Institution ID: ").strip())
    except ValueError:
        print("-> Invalid ID.")
        return
        
    name = input("Enter Account Name: ").strip()
    print("Account Types: checking, savings, credit card, investment, loan")
    acc_type = input("Enter Account Type: ").strip().lower()
    
    if acc_type not in ('checking', 'savings', 'credit card', 'investment', 'loan'):
        print("-> Invalid account type.")
        return
        
    acc_id = get_or_create_account(inst_id, name, acc_type)
    print(f"-> Account '{name}' created (ID: {acc_id}).")

def add_transaction_menu():
    print("\\n-- Available Accounts --")
    accs = list_accounts()
    if not accs:
        print("No accounts found. Please add one first.")
        return
    print_table(["ID", "Institution", "Account", "Type"], accs)
    
    try:
        acc_id = int(input("Enter Account ID: ").strip())
        date = input("Enter Date (YYYY-MM-DD): ").strip()
        amount_str = input("Enter Amount (positive=income, negative=expense): ").strip()
        amount = float(amount_str)
    except ValueError:
        print("-> Invalid input values.")
        return
        
    cat = input("Enter Category: ").strip()
    desc = input("Enter Description (optional): ").strip()
    
    add_transaction(acc_id, date, amount, cat, desc)
    print("-> Transaction added successfully.")

def import_csv_menu():
    filepath = input("Enter absolute path to CSV file: ").strip()
    
    custom_mapping = {}
    print("\nDo you want to provide custom column names mapping?")
    print("Required columns for investment CSV: date, amount, category(action)")
    ans = input("Enter 'y' to add custom mappings or 'n' to skip: ").strip().lower()
    
    if ans == 'y':
        while True:
            actual_name = input("Enter the actual column name in your CSV (or type 'done' to finish): ").strip()
            if actual_name.lower() == 'done':
                break
            target_name = input("Enter the required column name to map to (e.g. 'amount'): ").strip()
            if actual_name and target_name:
                custom_mapping[actual_name] = target_name
                print(f"Mapped '{actual_name}' -> '{target_name}'")
                
    success, msg = import_transactions_from_csv(filepath, custom_mapping=custom_mapping if custom_mapping else None)
    print(f"-> {msg}")

def income_statement_menu():
    ym = input("Enter Year-Month (YYYY-MM): ").strip()
    data = get_income_statement(ym)
    
    sections = [
        ("Income", list(data['income'].items())),
        ("Expenses", list(data['expenses'].items()))
    ]
    totals = [
        ("Total Income", data['total_income']),
        ("Total Expenses", data['total_expenses']),
        ("Net Income", data['net_income'])
    ]
    print_financial_statement(f"Income Statement ({ym})", sections, totals)

def balance_sheet_menu():
    date = input("Enter As-Of Date (YYYY-MM-DD): ").strip()
    data = get_balance_sheet(date)
    
    sections = [
        ("Assets", [(k.title(), v) for k, v in data['assets'].items()]),
        ("Liabilities", [(k.title(), v) for k, v in data['liabilities'].items()])
    ]
    totals = [
        ("Total Assets", data['total_assets']),
        ("Total Liabilities", data['total_liabilities']),
        ("Equity", data['equity'])
    ]
    print_financial_statement(f"Balance Sheet (as of {date})", sections, totals)

def cash_flow_menu():
    ym = input("Enter Year-Month (YYYY-MM): ").strip()
    data = get_cash_flow_statement(ym)
    
    sections = [
        ("Cash Flows", [
            ("Operating Activities", data['operating']),
            ("Investing Activities", data['investing']),
            ("Financing Activities", data['financing'])
        ])
    ]
    totals = [
        ("Net Cash Flow", data['total_net_flow'])
    ]
    print_financial_statement(f"Cash Flow Statement ({ym})", sections, totals)

def start_cli():
    while True:
        print_menu()
        choice = input("Select an option (1-8): ").strip()
        
        if choice == '1':
            add_institution_menu()
        elif choice == '2':
            add_account_menu()
        elif choice == '3':
            add_transaction_menu()
        elif choice == '4':
            import_csv_menu()
        elif choice == '5':
            income_statement_menu()
        elif choice == '6':
            balance_sheet_menu()
        elif choice == '7':
            cash_flow_menu()
        elif choice == '8':
            print("Exiting application. Goodbye!")
            sys.exit(0)
        elif choice == '9':
            ans = input("WARNING: This will delete ALL data! Are you sure? (yes/no): ").strip().lower()
            if ans == 'yes':
                wipe_database()
                print("-> Database wiped successfully.")
            else:
                print("-> Operation cancelled.")
        else:
            print("-> Invalid choice. Please try again.")
