import os
from models.schema import setup_database
from controllers.cli import start_cli
from utils.logger import logger

def show_tutorial():
    print("\n" + "="*60)
    print(" Welcome to your Personal Finance Application! ".center(60, '='))
    print("="*60)
    print("\nHere's a quick overview of what you can do:\n")
    print(" 1. Setup Tracking: Register 'Institutions' and 'Accounts'.")
    print(" 2. Enter Data: Input individual transactions manually.")
    print(" 3. Smart Import: Bulk upload investment CSVs safely.")
    print("    (Built-in duplicate-checking protects your data!)")
    print(" 4. Reports - Income Statement: View monthly income vs expenses.")
    print(" 5. Reports - Balance Sheet: See a point-in-time net worth.")
    print(" 6. Reports - Cash Flow: Track operating & investing flows.")
    print(" 7. Database Wipe: Reset your environment back to zero.")
    print("\n" + "="*60)
    input("Press Enter to continue to the main menu... ")

def main():
    try:
        # Initialization/migration is an explicit separate action, never an open side effect.
        
        # Show tutorial before entering the loop
        show_tutorial()
        
        # Start the controller loop
        start_cli()
    except KeyboardInterrupt:
        print("\\nExiting application. Goodbye!")
        logger.info("Application terminated by user.")
    except Exception as e:
        logger.error(f"Application crashed: {e}")
        print(f"An error occurred. Check finance_app.log for details.")

if __name__ == "__main__":
    main()
