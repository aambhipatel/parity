# Local application usage

Install Python dependencies from requirements.txt and the frontend dependencies
from its lockfile. For a new installation only, explicitly initialize a database
with python -m models.schema. Start python server.py, then run npm run dev from
frontend. The frontend development server proxies /api to the local backend.

Existing compatible legacy databases can open without a migration ledger. Reading
or switching to a missing database returns an error and does not create a file.
Database creation, migration previews and confirmed migration application are
explicit maintenance operations. Confirmed migrations create a backup first.

Create institutions and accounts on the Accounts page. Import CSV opens a file
selector and targets the chosen existing account. The importer supports compatible
broker formats and reports missing columns and duplicate imports. No CSV files
are distributed with this source.

The options dashboard includes performance charts, fees, account filters and a
read-only Needs Review list. Issues retain the legacy warning strings. The list
shows quantity, signed cash and provenance. Historical realized results follow
matched closing events; display cents reconcile to headline totals. Transferred
contracts with incomplete basis and unmatched closes require review.

Manual close and matching are existing accounting actions. Deleting an unmatched
transaction is destructive and changes totals; it is different from hiding a
duplicate warning. Review the confirmation text before using those controls.

Institution suggestions and broker-specific parsing labels identify application
support, not preloaded user accounts. Quote/company lookups use external services.
This local development application has password gates for some maintenance
actions; the SQLite files are not encrypted by those gates.
