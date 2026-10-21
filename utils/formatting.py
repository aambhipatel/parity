def format_currency(value):
    """Format float as US currency string."""
    if value is None:
        value = 0.0
    return f"${value:,.2f}"

def print_table(headers, rows):
    """
    Simple table formatter.
    headers: list of strings
    rows: list of tuple or list corresponding to columns
    """
    if not rows:
        print("No data available.")
        return

    # Calculate max column widths
    col_widths = [len(str(h)) for h in headers]
    for row in rows:
        for i, item in enumerate(row):
            col_widths[i] = max(col_widths[i], len(str(item)))

    # Print headers
    header_str = " | ".join(str(h).ljust(col_widths[i]) for i, h in enumerate(headers))
    print(header_str)
    print("-" * len(header_str))

    # Print rows
    for row in rows:
        row_str = " | ".join(str(item).ljust(col_widths[i]) for i, item in enumerate(row))
        print(row_str)

def print_financial_statement(title, sections, totals):
    """
    Helper to print structured financial statements.
    sections: list of tuples (subtitle, list_of_tuples(item_name, item_value))
    totals: list of tuples (total_name, total_value)
    """
    print("\n" + "=" * 40)
    print(f"{title.center(40)}")
    print("=" * 40)

    for subtitle, items in sections:
        if subtitle:
            print(f"\n[ {subtitle} ]")
        for name, value in items:
            print(f"{name:<25} {format_currency(value):>14}")

    if totals:
        print("-" * 40)
        for total_name, total_val in totals:
            print(f"{total_name:<25} {format_currency(total_val):>14}")
    print("=" * 40 + "\n")
