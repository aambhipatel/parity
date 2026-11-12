# Repairing seeded synthetic option data

The FIFO engine matches linked legs by position/account and exact expiration,
strike and option type. It consumes opposing opening lots in date order and
allocates recorded net cash proportionally. Fees are already represented in net
cash and must not be deducted twice. This repair does not change that engine,
its accounting AST fingerprints, or any mutation endpoint.

An anonymizer that independently scales strikes and quantities for each
contract can destroy a corporate action: the pre-split and post-split identities
must instead share a compatible quantity scale and inverse strike ratio.
Rebuilding descriptions from unsigned leg quantities can also lose signed
transfer information used by the legacy importer.

`scripts/repair_scrambled_options.py` is an offline utility for the specific
seeded transformation format supplied with the synthetic-data investigation.
It is not a generic financial database repair or importer. It requires the
verified seed, preserved contract-group insertion order, whole source contract
quantities, single-leg transactions, and the supported demo labels. It rejects
complex/ambiguous split histories and cannot manufacture missing openings.

Run against a standalone synthetic copy with no SQLite sidecars:

```powershell
python -B scripts/repair_scrambled_options.py --input PATH_TO_SYNTHETIC_DB --output NEW_OUTPUT_PATH --seed VERIFIED_SEED --expected-sha256 VERIFIED_INPUT_HASH
```

The input is read-only. The output must not already exist. The tool copies the
SQLite database, applies precondition-checked changes atomically, verifies
integrity and foreign keys, and prints a receipt. Keep that receipt outside Git.
It refuses a database named finance.db and rejects non-demo account/symbol
labels. Do not point it at a real financial database.

The seed replay retains dimensionless quantity factors only; it does not restore
original private strikes, premiums, or account data. A split family is placed on
a common synthetic quantity scale while keeping synthetic cash and fees. The
earlier synthetic strike is derived from the later synthetic strike and the
recorded split quantity delta. Already consistent families are unchanged.

The legacy importer writes TRANSFER_OUT for a negative description quantity and
TRANSFER_IN for a positive quantity. These codes alone are not reliable evidence
of economic outgoing/incoming direction. For the known scrambler's descriptions,
the utility restores that signed representation, preserving the stored action.
It creates no opening transaction and does not invent transferred cost basis.
Real transfer direction and historical basis require broker evidence; any
zero-basis transferred close remains explicitly unknown-basis accounting.

Passing an expiration date does not establish a worthless expiration. Realized
results require recorded closing/expiration/assignment events. Report staged,
unconfirmed expirations separately from recorded realized P/L and active targets.
The legacy UI headline includes staged expiration amounts; use the internal
matched-event analysis for a confirmed-versus-unconfirmed reconciliation.

Run the public invented-data regression suite from the repository root:

```powershell
python -B scripts/test_isolated.py
```

Tests cover split-scale repair, signed transfers and unknown basis, full/partial
FIFO closes, multiple lots/closes, account and contract isolation, chronological
limits, genuine missing/excess closes, net cash and fees, remaining targets,
recorded expirations/assignments, duplicate imports, repeat-safe processing and
atomic repair rollback. No private reference pack is required.
