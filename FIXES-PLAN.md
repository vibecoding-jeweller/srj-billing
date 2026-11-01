# SRJ Billing: Fixes Plan v2 (Old Bills, Customers, 925 Silver, Item Sales)

> Claude Code: read this whole file and `PLAN.md` first. Do the work **one step at a time, in the order below**. After each step: run all tests, `npx tauri dev`, and stop so I can check before moving on.
> Never weaken GST rules: **saved GST invoices stay locked** (cancel only). Every DB change goes through `migrate()` in `src-tauri/src/db.rs` with a new version, and gets a test in the style of `upgrades_a_version_1_database_without_losing_data`.

---

## What the code does today (root causes)

| # | Problem | Root cause in code |
|---|---|---|
| 1 | Old Bills is cluttered with all-time records | `OldBills.tsx` loads with empty `from`/`to`, so it shows every bill and estimate ever made. `listRecords()` in `api.ts` has `LIMIT 500`. |
| 1b | **Hidden bug:** totals are wrong once there are more than 500 records | The totals bar adds up only the rows that loaded (`rows.filter(...)`), not everything matching the filter. Sales figures will silently go wrong as the data grows. |
| 2 | Can't edit an estimate's name or mobile | The `estimates_only_cancel` trigger in `db.rs` blocks any change to `customer_snapshot` and `customer_id`. That rule is right for GST invoices but too strict for estimates. |
| 3 | Cancelled records clutter the list | No filter for status. Cancelled rows are always shown, struck through. |
| 4 | No way to see sales of one item (e.g. bichiya) over a period | No report screen. The data already exists in `invoice_items` and `estimate_items`, but the description is free text, so "Bichiya", "Silver Bichhiya" and "bichiya 925" are different strings. |
| 5 | Can't bill 925 silver at a fixed price | `calc.ts` only prices by weight × rate (`Metal = GOLD22 \| GOLD18 \| SILVER`). There's no fixed-price item, no quantity, no GST-inclusive pricing, and no SKU. |
| 6 | Overall UX | Three text links per row, no detail view, no day grouping, no quick date presets. |

---

## Step 1: Old Bills list (problems 1, 1b, 3)

**Goal:** opening Old Bills shows **today only**, with clean totals, and only what matters.

1. **Quick date presets** shown as chips above the list: `Today` (default) · `Yesterday` · `This week` · `This month` · `This FY` · `Custom…` (shows the From/To pickers). Remember the last chosen preset for the session only. Always reopen on `Today`.
2. **Show cancelled** toggle, **off by default**. When off, add `status = 'ACTIVE'` to the query. When on, cancelled rows appear greyed with a red CANCELLED badge. Use strikethrough only on the amount, not the whole row.
3. **Totals from SQL, not from loaded rows.** Add `summaryRecords(filter)`, which returns the count and sum per kind plus exchange total over the **whole** filter, using the same WHERE clause as `listRecords`. Put the shared WHERE-building code in one helper so the two can never drift apart.
4. **Paging instead of a hard 500 cap:** load 100 rows, then show a "Load more" button. Remove the "Showing the latest 500" warning.
5. **Group by date:** a sticky date header row ("Sun, 1 Nov 2026 · 7 sales · ₹1,24,500") above each day's records.
6. **Row click opens a side panel**, replacing the three links per row. The panel shows:
   - number, date, type badge, customer, mobile(s)
   - items table (description, weight/qty, amount)
   - payments
   - buttons: **Reprint** · **Store copy / Open PDF** · **Edit customer** (estimates only, see Step 2) · **Cancel** (danger, at the bottom)

   Keyboard: ↑/↓ moves through rows, `Enter` opens the panel, `Esc` closes it.

**Tests:**
- the summary equals the sum over the full filter with 600+ seeded records
- the cancelled filter works
- the Today preset gives the right date range

## Step 2: Edit customer on estimates only (problem 2)

1. **New migration:** replace the `estimates_only_cancel` trigger so an estimate update is allowed when **only** `customer_snapshot` and/or `customer_id` change (everything else must stay identical). The existing status ACTIVE→CANCELLED path stays as it is. **Invoices are not touched.**
2. **New table:** `estimate_edits(id, estimate_id, field, old_value, new_value, edited_at)`. Every edit writes a row. It's never shown on the PDF, but keeps an audit trail.
3. **New Rust command** `update_estimate_customer(id, name, mobile, other_mobile)`, in one transaction:
   - validate 10-digit mobiles
   - update the snapshot
   - upsert the customer by mobile (re-link `customer_id`)
   - write audit rows
4. **UI:** the "Edit customer" button in the Step 1 panel, shown for estimates only (including cancelled ones? **No**, active only). It's a small modal with Name, Mobile and Other mobile. After saving, regenerate the estimate PDF in the bills folder and call `backupNow()`.
5. **GST invoices:** the panel shows no edit button. Show the hint: "GST bills can't be edited. Cancel and make a new bill."

**Tests:**
- editing an estimate's customer works and adds audit rows
- editing any other column of an estimate is still blocked
- editing an invoice is still blocked

## Step 3: Item Sales report (problem 4)

**New screen: Reports → Item sales.**
- Filters: **search words** (e.g. `bichiya`), date presets (same chips as Step 1), metal (All / Gold 22K / Gold 18K / Silver / Silver 925), include Bills / Estimates / both. Cancelled records are always excluded.
- **Matching:** reuse the keyword logic from `src/lib/search.ts`, where every typed word must match. Also match a **spelling-variant table** so `bichiya`, `bichhiya`, `bichia` and `बिछिया` all match. Seed common variants (bichiya/bichhiya, payal/pajeb, jhumki/jhumka, tops/studs, kada/kara). Normalise to lowercase and drop the "gold"/"silver" prefix when comparing.
- **Result, top cards:** pieces sold · total weight (g) · total sale value (₹) · number of bills.
- **Result, table grouped by exact description:** shows which spellings were counted, with count, weight and amount. Each row expands to list the bills it came from, and clicking one opens the record panel from Step 1.
- **Export to Excel/CSV** button for the current result.
- **Prevent future mess:** in `DescriptionInput`, when the typed text is close to an existing description (edit distance ≤ 2 or a variant match), show "Did you mean **Silver Bichhiya**?" so new bills reuse one spelling.

**Tests:**
- variant matching
- cancelled records excluded
- date range inclusive
- multi-item bills counted per item

## Step 4: 925 Silver at fixed price, with LUXMÉ sheet lookup (problem 5)

### 4a. Fixed-price items in the calc engine
- Add metal `SILVER925` (label "Silver 925", HSN 7113).
- Add item pricing mode **`FIXED_PRICE`**, next to the existing weight-based pricing. Fields: `sku` (optional), `qty` (default 1), `unitPrice` (paise, **GST-inclusive** on bills), `weightMg` (optional; shown on the bill if entered, otherwise blank).
- **GST-inclusive back-calculation** (bills only), done on the bill total so the customer pays **exactly** the tag price:
  ```
  incl     = Σ (qty × unitPrice) for fixed-price items
  tax      = round2(incl × 3 / 103)
  cgst_fp  = round2(tax / 2); sgst_fp = tax − cgst_fp
  taxable  = incl − tax
  ```
  Add these to the normal weight-based taxable/CGST/SGST of the same bill. The round-off then stays at 0 for an all-925 bill.
- **Estimates:** no GST, so line amount = qty × unitPrice.
- **Bill PDF row:** description `Silver 925 Ring (RNG0005)`, Quantity `1 Pc` (or `3.500 Grm` if weight was entered), Rate = taxable unit value, per = `Pc`, Amount = taxable value. There's no making sub-line for fixed-price items.
- **Acceptance test:** 1 × RNG0005 at ₹1,499 (incl. GST) gives tax 43.66, CGST 21.83, SGST 21.83, taxable 1,455.34, **grand ₹1,499.00, round off 0.00**. Also test a mixed bill (Shruti's gold ring + RNG0005) where the grand total = 8,662 + 1,499 = **₹10,161**.

### 4b. SKU lookup from the LUXMÉ Inventory Google Sheet
The sheet has one tab per category (Rings, Payal, Others, Bracelets, Chain, Pendant, Set, Earrings, ToeRings). **Column positions differ between tabs**, and some tabs repeat headers (`PricingMode`, `PurchasePrice`) or have blank ones. So **always read by header name, never by column position**, and take the first column with each name. Ignore tabs without `SKU` and `ShopSP` headers (`*_Results`, `Meta`).

Fields to use:
- `SKU`
- `Name`
- `ShopSP` (shop price, GST-inclusive). **Never use `OnlineSP` or `CP`.**
- `Weight`
- `Qty`
- tab name as the category

**How to connect (recommended):** a small **Google Apps Script web app** inside the sheet that returns only `[{sku, name, category, shopPrice, weight, qty}]` as JSON.
- **Why not read the sheet directly:** the link is "anyone with the link can view", which also exposes purchase cost (`CP`) and margins. The script exposes only the selling price, so the sheet can go back to private.
- Write the script as `scripts/luxme-catalogue.gs` and give me step-by-step deploy instructions: Extensions → Apps Script → Deploy → Web app → Execute as me → Anyone.
- Settings gets a **"925 catalogue URL"** field.

**In the app:**
- New table: `catalogue(sku PK, name, category, shop_price, weight_mg, qty, synced_at)`.
- **Sync:** on app start and from a "Sync now" button in Settings. If offline or the sync fails, keep the last cached copy and show "Catalogue last synced: 30 Oct, 6:10 pm".
- **On New Bill / Estimate:** typing a SKU (e.g. `RNG0005`) in the description box fills in name, metal = Silver 925, mode = Fixed price, unit price = ShopSP and weight. The price stays editable on the row.
- **Not found / offline:** the user enters SKU, description and price by hand. A manual entry is never blocked.
- Store `sku` on `invoice_items` and `estimate_items` (new nullable column). The Step 3 report can then filter by SKU or category exactly.
- **Later:** mark the piece sold in the sheet (Qty − 1) via a `doPost` on the same script. **Do not build this now.**

**Tests:**
- header-name parsing with shuffled, duplicate and blank columns (use the real header rows from the sheet as fixtures)
- falls back to the cache when the fetch fails
- the 4a acceptance test

## Step 5: UX polish (problem 6)

- **Customers page:**
  - the same row-click side panel pattern
  - history list uses the Step 1 record panel
  - totals are computed in SQL
  - search by name, mobile or other mobile
  - visit count, last visit, lifetime value
  - "New bill for this customer" button that prefills New Bill
- **Big-number readability:** amounts right-aligned with tabular numbers. ₹ totals at 18px+ on the totals bar.
- **Empty states with an action:** for example, "No sales today. Press **N** for a new bill."
- **Global shortcuts:** `N` new bill · `E` new estimate · `O` old bills · `/` focus search. Show a small shortcut hint in the footer.
- **Speed:** add indexes for the Step 3 report queries (`invoice_items(invoice_id)`, `estimate_items(estimate_id)`, `lower(description)`). Make sure the Old Bills list query stays under 50 ms with 20,000 seeded records (write a seed script for this).
- **Scalability note (do not build yet):** the frontend currently sends raw SQL through `db_select`/`db_execute`. That's fine for one PC, but before multi-user or cloud sync, these must move into typed Rust commands. Add a TODO in the README.

---

## Order and release

Steps 1 → 2 → 3 → 4 → 5, one commit each, with a clear message. Bump the app version after Step 4 so the shop PC auto-updates. Before releasing, check the shop PC upgrade path: back up the DB, then run the migration test against a copy of a real DB.
