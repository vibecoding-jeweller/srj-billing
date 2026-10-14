# SRJ Billing — Build Plan

A very simple, offline, installable desktop billing app for **S.R. Jewellers, Bulandshahr** (gold & silver jewellery retail).
Primary user: the shop owner (not tech-savvy). Built on a MacBook, used on the shop's **Windows 10/11 PC** with an **A4 printer**.
Later goal: sell to other jewellers in the market, so nothing shop-specific may be hard-coded.

> Claude Code: read this whole file before writing code. Build **Phase 1 only**, then stop and show me.
> Reference files in `/reference`:
> - `sample_bill.pdf`: the exact output the app must produce for the test case in §9
> - `make_bill_reference.py`: a working ReportLab script that generated that PDF (use its layout and coordinates as the spec)
> - `logo.png`: the store logo for the bill header

---

## 1. Principles (do not break these)

1. **Simple beats complete.** The main screen must be usable by someone who has never used billing software. Big fonts, few fields, one primary button.
2. **Opens instantly, works with no internet.** Nothing loads from the web at runtime.
3. **Keyboard-first.** `Enter` moves to the next field. The whole bill can be made without a mouse.
4. **Money math is exact.** Use integer paise (or a decimal library) internally. Never use floating point for money.
5. **Saved bills are never edited or deleted.** A saved bill can only be marked **Cancelled** with a reason, and its number is never reused. This is a GST requirement.
6. **Shop details come from Settings**, never from code (name, address, GSTIN, PAN, bank, logo, invoice prefix, state).

## 2. Tech stack

- **Tauri v2** desktop app (small, fast installer). Frontend: **React + TypeScript + Vite**.
- **SQLite** via `tauri-plugin-sql` for local data, stored in the app data folder.
- **PDF generation:** in the frontend with `pdf-lib` or `jsPDF`, reproducing the reference layout exactly. Embed a TTF font that has the ₹ glyph (e.g. Noto Sans or DejaVu Sans Bold) for the total amount.
- **Windows installer:** a GitHub Actions workflow on `windows-latest` that builds the `.msi`/`.exe` on every push to `main` and uploads it as an artifact. I develop on a Mac, so the Windows build must come from CI.
- **Backup ("sync to Drive"):** no Google API. In Settings, the user picks a **Backup folder**, which will be inside the *Google Drive for desktop* folder. After every saved bill, and on app close, copy the SQLite DB and the new PDFs into that folder. Google Drive syncs it automatically whenever internet is available.

## 3. Screens (Phase 1 = exactly 3)

### 3.1 New Bill (the home screen)
Top bar: **Today's rates** shown as chips (Gold 22K / Gold 18K per 10 g, Silver per kg). Click a chip to edit. If rates weren't set today, ask for them once when the app opens.

Form, top to bottom:
1. **Mobile number.** On 10 digits, look up the customer. If found, auto-fill everything below and show "Repeat customer ✓".
2. **Name**, **Relation** (S/o · D/o · W/o · none) + **relative's name** (optional), **Address** (one multi-line box), **State** (default: shop state).
3. **Items table**, one row per item (start with one row, plus a "+ Add item" link):
   - Description (free text with suggestions: Gold Ring, Gold Chain, Earrings, Silver Payal…)
   - Metal/Purity: `Gold 22K` | `Gold 18K` | `Silver` (picks today's rate automatically, but it can be overridden on the row)
   - Weight (g, 3 decimals)
   - Making type: `%` | `₹/g` | `₹ fixed`, then the making value
   - Row amount (auto)
4. **Payment mode:** Cash | UPI | Card | NEFT | RTGS | Cheque.
   - If NEFT / RTGS / Cheque is chosen, show a **Reference no.** field (UTR or cheque number).
   - A small **"+ Split payment"** link adds more mode+amount rows. Parts must add up exactly to the grand total before saving.
5. **Live summary panel** (right side, large): Taxable value, CGST, SGST, Round off, **Grand Total**.
6. One big button: **Save & Print** (shortcut `Ctrl+P`).

Validation and warnings:
- **Cash ≥ ₹2,00,000** (cash part only) → blocking warning: "Cash of ₹2 lakh or more is not allowed (Sec 269ST). Change payment mode." Block the save.
- **Bill total > ₹2,00,000** → PAN field becomes required (Rule 114B). If the customer has no PAN, allow ticking "Form 60 taken".
- If the name is empty, default the buyer to "Cash".

### 3.2 Old Bills
- Table: Invoice no · Date · Customer · Mobile · Total · Payment mode · Status.
- Search by name, mobile or invoice no. Filter by date range.
- Actions per row: **Reprint** (customer copy), **Open store copy**, **Cancel bill** (asks for a reason; the bill stays in the list marked CANCELLED).

### 3.3 Settings
- Shop: name, address lines, GSTIN, PAN, state + state code, contact number, logo (upload PNG/SVG).
- Bank: account holder, bank name, account no., branch & IFSC.
- Invoice: prefix (default `SR`), next number (editable only while there are no bills in the current financial year).
- Tax: GST rate (default 3% = 1.5% CGST + 1.5% SGST), HSN for jewellery (default `7113`).
- Folders: **Bills folder** (where PDFs are saved) and **Backup folder** (Google Drive).
- Declaration text (default from template).

## 4. Invoice numbering

- Format: `{PREFIX}/{FY}/{NNN}`, e.g. `SR/26-27/001`.
- Financial year runs April–March. On the first bill on or after 1 April, the counter resets to 001.
- 3 digits minimum, growing past 999 if needed (`1000`).
- Numbers are assigned **only at save**, inside a DB transaction. No gaps and no duplicates.

## 5. Calculation rules (exact)

For each item:
```
rate_per_g      = gold: rate_per_10g / 10     silver: rate_per_kg / 1000
metal_value     = round2(weight_g × rate_per_g)
making_amount   = %     → round2(metal_value × pct / 100)
                  ₹/g   → round2(weight_g × making_per_g)
                  fixed → making_fixed
```
For the bill:
```
taxable   = Σ (metal_value + making_amount)
cgst      = round2(taxable × 1.5%)
sgst      = round2(taxable × 1.5%)
gross     = taxable + cgst + sgst
grand     = round to nearest whole rupee (half up)
round_off = grand − gross          (show sign: "0.22" or "(-)0.80")
```
- Place of supply is **always the shop's state** (over-the-counter sale), so it's always CGST + SGST, never IGST, even if the buyer is from another state.
- **Amount in words:** Indian system (Thousand, Lakh, Crore), e.g. "INR Eight Thousand Six Hundred Sixty Two Only".
- **Tax in words:** with paise, e.g. "INR Two Hundred Fifty Two and Twenty Eight paise Only".

## 6. Bill PDF layout (A4 portrait)

Reproduce `reference/sample_bill.pdf` exactly. Port the coordinates from `make_bill_reference.py`. Top to bottom:

1. **Logo**, centred, about 60 pt tall.
2. **Copy label** at top-right, small bold caps: `ORIGINAL FOR RECIPIENT` or `DUPLICATE FOR SUPPLIER`.
3. "Tax Invoice" centred, bold.
4. **Header box:** left has shop name (bold), address, GSTIN/UIN, State Name + code, Contact. Right has "Invoice No." and "Dated" (`dd-Mon-yy`, e.g. `10-Oct-26`).
5. **Buyer box (Bill to):** name with relation in bold (e.g. "Shruti Mohan Uniyal D/o Sanjay Mohan Uniyal"), address lines, Phone No, (PAN if present), State Name + code, Place of Supply.
6. **Items table** with columns: Sl No. | Description of Goods | HSN/SAC | Quantity | Rate | per | Amount.
   - Each item: one bold row (description, HSN, `0.550 Grm`, rate per g, `Grm`, metal value), followed by an italic sub-line "Making Charges@10%" (or "@₹500/g", or "Making Charges") with the making amount in the Amount column.
   - After the items: a rule above the subtotal (taxable), then right-aligned italic bold labels **C-Gst**, **S-Gst**, **Round Off** with their amounts. "Add :" sits at the left of that block.
   - Footer row: "Total", total weight, and **₹ grand total** (bold, larger).
7. "Amount Chargeable (in words)" with "E. & O.E" on the right, then the amount in words (bold).
8. **HSN tax summary table:** HSN/SAC | Taxable Value | CGST Rate/Amount | SGST/UTGST Rate/Amount | Total Tax Amount, followed by a bold Total row.
9. "Tax Amount (in words)" (bold).
10. **Footer box:** left has Company's PAN, Declaration text. Right has Company's Bank Details (4 lines), then "for S.R. Jewellers" (bold) and "Authorised Signatory".
11. "This is a Computer Generated Invoice", centred below.

Fonts: Liberation Sans or Arial (regular, bold, bold italic). Body 8.5 pt, labels 7.5 pt. Line width 0.6 pt.

**Files saved per bill**, in `{Bills folder}/{FY}/{MM-Mon}/`:
- `SR-26-27-001_customer.pdf` (ORIGINAL FOR RECIPIENT). **This is the only copy that gets printed.**
- `SR-26-27-001_store.pdf` (DUPLICATE FOR SUPPLIER). Saved only.

Printing: after saving, open the system print dialog for the customer PDF. Silent printing is not required.

## 7. Data model (SQLite)

```
settings(key TEXT PK, value TEXT)                       -- all §3.3 fields as JSON values
daily_rates(date TEXT PK, gold22_per10g, gold18_per10g, silver_per_kg)   -- paise
customers(id PK, mobile TEXT UNIQUE, name, relation, relative_name,
          address, state, state_code, pan, created_at, updated_at)
invoices(id PK, invoice_no TEXT UNIQUE, fy TEXT, seq INT, date TEXT,
         customer_id FK, buyer_snapshot JSON,           -- frozen copy of buyer details at time of bill
         taxable, cgst, sgst, round_off, grand_total,   -- paise
         status TEXT CHECK(status IN ('ACTIVE','CANCELLED')),
         cancel_reason, created_at)
invoice_items(id PK, invoice_id FK, sl INT, description, metal TEXT,
              weight_mg INT, rate_per_g, metal_value,
              making_type TEXT, making_value, making_amount, hsn)
payments(id PK, invoice_id FK, mode TEXT, amount, reference_no)
```
Every invoice stores a **snapshot** of buyer and shop details, so reprints never change when settings or customer records change later.

## 8. Phases

| Phase | Scope |
|---|---|
| **1 (build now)** | Settings, New Bill, Old Bills, PDF (both copies), invoice numbering, payment modes + split + reference no., 269ST cash block, PAN rule, Drive backup copy, Windows CI build |
| 2 | Customer list and history; **Old gold purchase slip** (separate voucher, own number series `SR/OG/26-27/001`; fields: weight, purity/tunch %, rate, amount, payment) |
| 3 | Reports: daily/monthly sales, payment-mode split, GST summary (B2C), Excel/CSV export for the CA |
| Later | HUID, gross/net weight, stone charges, wastage %, Hindi UI toggle, multi-user with cloud DB, licensing for resale |

## 9. Acceptance test (Phase 1 is done when this passes)

**Input:**
- Date 10-Oct-2026. Gold 22K rate ₹1,39,000 per 10 g.
- Customer: Shruti Mohan Uniyal, D/o Sanjay Mohan Uniyal, House No 132, Jhanda Moholla, Dehradun, Uttarakhand - 248001, mobile 7060329291, state Uttarakhand (05).
- Item: Gold Ring 22kt, 0.550 g, making 10%. Payment: UPI.

**Expected output:**

| Field | Value |
|---|---|
| Metal value | 7,645.00 |
| Making @10% | 764.50 |
| Taxable | 8,409.50 |
| CGST 1.5% | 126.14 |
| SGST 1.5% | 126.14 |
| Round off | 0.22 |
| **Grand total** | **₹ 8,662.00** |
| Amount in words | INR Eight Thousand Six Hundred Sixty Two Only |
| Tax in words | INR Two Hundred Fifty Two and Twenty Eight paise Only |
| Place of Supply | Uttar Pradesh |

The customer PDF must match `reference/sample_bill.pdf` visually, plus the "ORIGINAL FOR RECIPIENT" label.

Also write **unit tests** for:
- the calculation engine (all 3 making types, silver per kg, multi-item, split payment sum)
- Indian number-to-words
- FY rollover of invoice numbers (31-Mar → 1-Apr)
- the 269ST cash block

## 10. Shop defaults (seed data for Settings)

```
Name: S.R. Jewellers
Address: Lal Kuan, Sarrafa Bazar, Bulandshahr
GSTIN/UIN: 09AIPPV2929L1ZB
State: Uttar Pradesh, Code 09
Contact: 9760012800
PAN: AIPPV2929L
Bank: A/c holder S.R. Jewellers · IndusInd Bank C/a A/c No:- 259760012801 · A/c No. 259760012801 · D.M. Road, Bsr & INDB0002099
Invoice prefix: SR
Declaration: We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.
```
