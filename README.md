# SRJ Billing

Offline desktop billing for jewellers (Tauri v2 + React + TypeScript + SQLite). See `PLAN.md` for the spec. Phase 1 is built.

## Develop (Mac)

Node and Rust were installed into your home folder only (your shell profile was not changed), so add them to `PATH` first:

```bash
export PATH=~/.local/node/bin:~/.cargo/bin:$PATH
```

```bash
npm install
```

```bash
npx tauri dev
```

To try things out without touching your real bills, point the app at a throwaway data folder:

```bash
SRJ_DATA_DIR=/tmp/srj-test ./src-tauri/target/debug/srj-billing
```

## Tests

```bash
npm test
```

```bash
cd src-tauri && cargo test
```

`npm test` also runs the §9 acceptance test and writes `out/acceptance_customer.pdf` and `out/acceptance_store.pdf`.

## Windows installer

`.github/workflows/windows.yml` runs the tests and builds the `.msi` and `.exe` on every push to `main`. Download them from the run's **Artifacts** section on GitHub.

## Where things live

| What | Where |
|---|---|
| Money / weight maths (integer paise & mg) | `src/lib/money.ts`, `src/lib/calc.ts` |
| Amount in words | `src/lib/words.ts` |
| FY, invoice number format, dates | `src/lib/fy.ts` |
| 269ST cash block, PAN rule, save checks | `src/lib/validate.ts` |
| Bill PDF (ported from `reference/make_bill_reference.py`) | `src/lib/pdf.ts` |
| PDF save / print / reopen | `src/lib/output.ts` |
| Database, invoice numbering transaction, backup | `src-tauri/src/db.rs`, `src-tauri/src/lib.rs` |
| Screens | `src/screens/` |

Database: `srj-billing.db` in the app data folder (`%APPDATA%\in.srjewellers.billing` on Windows).
Backup: after each bill, after a cancellation and when the app closes, the database (as a consistent snapshot) and any new PDFs are copied into the Backup folder chosen in Settings.
