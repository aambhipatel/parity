# Public tests

From the project root, install the Python requirements and run:

```sh
python -B scripts/test_isolated.py
```

These tests use invented accounts, contracts, amounts and dates. They create
disposable databases and CSV inputs during execution; no financial data files
ship with the source. The runner copies the code, redirects temporary storage,
mocks quote providers and blocks socket connections. Direct discovery outside
the runner raises an error. No live database, account selection or network
access is required.

The suite covers database lifecycle and missing-file behavior, accounting and
event attribution, structured issues and account filters, import targeting and
duplicate rejection. Source AST fingerprints guard accounting calculations;
these are hashes of application code, not a database, registry or private response.

Build the frontend separately:

```sh
cd frontend
npm ci
npm run build
```

Build outputs, dependency directories, runtime logs, databases and test scratch
storage must stay outside a publication export or remain untracked.
