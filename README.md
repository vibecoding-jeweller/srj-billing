# SRJ Billing

Billing software for a jewellery store.

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

## 925 silver catalogue (LUXMÉ sheet)

The app reads SKU, Name, ShopSP (GST-inclusive shop price), Weight and Qty from the LUXMÉ Inventory sheet
through a small Apps Script web app (`scripts/luxme-catalogue.gs`). Cost price, OnlineSP and margins never
leave the sheet, so the sheet can stay private.

One-time setup (on any computer, signed in to the Google account that owns the sheet):

1. Open the LUXMÉ Inventory sheet → **Extensions → Apps Script**.
2. Delete whatever is in `Code.gs` and paste the whole of `scripts/luxme-catalogue.gs`. Click **Save**.
3. **Deploy → New deployment**. Click the gear next to "Select type" → **Web app**.
4. Description: `SRJ Billing catalogue`. **Execute as: Me**. **Who has access: Anyone**. Click **Deploy**.
5. Google asks to authorise: choose your account → **Advanced → Go to … (unsafe)** → **Allow**
   (it is your own script; it only reads the sheet).
6. Copy the **Web app URL** (`https://script.google.com/macros/s/…/exec`). Open it in a browser once:
   you should see `{"ok":true,…,"items":[…]}` with no cost columns.
7. In SRJ Billing: **Settings → 925 catalogue URL**, paste, **Save settings**, then **Sync now**.
8. Optional: set the sheet's sharing back to **Restricted**. The web app keeps working.

After editing the script later, use **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**
so the same URL serves the new code.

The app syncs on start and from **Sync now**. Offline or on any error it keeps the last copy
("Catalogue last synced: 30 Oct, 6:10 pm"). Typing a SKU (e.g. `RNG0005`) as the description fills in the
piece at its shop price; anything not in the catalogue can still be typed by hand.

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
