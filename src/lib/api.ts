// Thin wrappers over the Rust commands (src-tauri/src/lib.rs).
import { invoke } from '@tauri-apps/api/core';
import type { ItemCalc, MakingType, Metal, PaymentMode, Pricing } from './calc';
import { DEFAULT_SETTINGS } from './bill';
import type { BillDoc, Buyer, DailyRates, EstimateCustomer, EstimateDoc, Settings, ShopSnapshot } from './types';
import defaultLogoUrl from '../assets/logo.png?url';
import { daySummaryQuery, foldSummary, listRecordsQuery, RECORDS_SOURCE, summaryQuery, type RecordFilter, type RecordKind, type RecordsSummary } from './records';
import { looksLikeSku, syncCatalogue, type CatalogueItem, type SyncResult } from './catalogue';
import { descriptionsQuery, linesQuery, matchDescriptions, summarise, type ItemFilter, type ItemLine, type ItemSalesResult } from './itemSales';

type Row = Record<string, unknown>;

export const select = <T = Row>(sql: string, args: unknown[] = []) => invoke<T[]>('db_select', { sql, args });
export const execute = (sql: string, args: unknown[] = []) =>
  invoke<{ rows_affected: number; last_insert_id: number }>('db_execute', { sql, args });

// ---------- settings ----------

async function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });
}

export async function loadSettings(): Promise<Settings> {
  const rows = await select<{ key: string; value: string }>('SELECT key, value FROM settings');
  if (rows.length === 0) {
    // First run: seed defaults.
    const seeded: Settings = {
      ...DEFAULT_SETTINGS,
      billsFolder: await invoke<string>('default_bills_folder'),
      logo: await blobToDataUrl(await (await fetch(defaultLogoUrl)).blob()),
    };
    await saveSettings(seeded);
    return seeded;
  }
  const s: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    try {
      s[r.key] = JSON.parse(r.value);
    } catch {
      /* ignore bad value, keep default */
    }
  }
  return s as unknown as Settings;
}

export async function saveSettings(s: Partial<Settings>): Promise<void> {
  for (const [k, v] of Object.entries(s)) {
    await execute('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
      k,
      JSON.stringify(v),
    ]);
  }
}

// ---------- rates ----------

export async function getRates(date: string): Promise<DailyRates | null> {
  const r = await select<{ date: string; gold22_per10g: number; gold18_per10g: number; silver_per_kg: number }>(
    'SELECT * FROM daily_rates WHERE date = ?1',
    [date],
  );
  return r[0] ? { date: r[0].date, gold22: r[0].gold22_per10g, gold18: r[0].gold18_per10g, silver: r[0].silver_per_kg } : null;
}

export async function getLatestRates(): Promise<DailyRates | null> {
  const r = await select<{ date: string }>('SELECT date FROM daily_rates ORDER BY date DESC LIMIT 1');
  return r[0] ? getRates(r[0].date) : null;
}

export async function setRates(r: DailyRates): Promise<void> {
  await execute(
    `INSERT INTO daily_rates (date, gold22_per10g, gold18_per10g, silver_per_kg) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(date) DO UPDATE SET gold22_per10g = excluded.gold22_per10g, gold18_per10g = excluded.gold18_per10g,
       silver_per_kg = excluded.silver_per_kg`,
    [r.date, r.gold22, r.gold18, r.silver],
  );
}

// ---------- customers ----------

export async function findCustomer(mobile: string): Promise<(Omit<Buyer, 'form60'> & { otherMobile: string }) | null> {
  const r = await select<Row>('SELECT * FROM customers WHERE mobile = ?1', [mobile]);
  if (!r[0]) return null;
  const c = r[0] as Record<string, string>;
  return {
    mobile: c.mobile,
    name: c.name,
    relation: c.relation as Buyer['relation'],
    relativeName: c.relative_name,
    address: c.address,
    state: c.state,
    stateCode: c.state_code,
    pan: c.pan,
    otherMobile: c.other_mobile ?? '',
  };
}

// ---------- invoices ----------

export async function countBillsInFy(fy: string): Promise<number> {
  const r = await select<{ n: number }>('SELECT COUNT(*) AS n FROM invoices WHERE fy = ?1', [fy]);
  return r[0]?.n ?? 0;
}

export async function lastSeqInFy(fy: string): Promise<number | null> {
  const r = await select<{ s: number | null }>('SELECT MAX(seq) AS s FROM invoices WHERE fy = ?1', [fy]);
  return r[0]?.s ?? null;
}

/** One item line as the Rust side saves it. */
export interface ItemPayload {
  description: string;
  metal: Metal;
  weight_mg: number;
  rate_input: number;
  rate_per_g: number;
  metal_value: number;
  making_type: MakingType;
  making_value: number;
  making_amount: number;
  hsn?: string;
  pricing: Pricing;
  sku: string | null;
  qty: number;
  unit_price: number;
}

export const itemPayload = (it: ItemCalc, withHsn: boolean): ItemPayload => ({
  description: it.description,
  metal: it.metal,
  weight_mg: it.weightMg,
  rate_input: it.rateInput,
  rate_per_g: it.ratePerG,
  metal_value: it.metalValue,
  making_type: it.makingType,
  making_value: it.makingValue,
  making_amount: it.makingAmount,
  ...(withHsn ? { hsn: it.hsn } : {}),
  pricing: it.pricing ?? 'WEIGHT',
  sku: it.sku?.trim() || null,
  qty: it.qty ?? 1,
  unit_price: it.unitPrice ?? 0,
});

/** A saved item row back into an item (rows saved before version 0.3 read as weight-priced). */
function rowToItem(r: Row, hsn: string): ItemCalc {
  const n = (v: unknown) => Number(v);
  const fixed = r.pricing === 'FIXED_PRICE';
  return {
    description: String(r.description),
    metal: r.metal as Metal,
    weightMg: n(r.weight_mg),
    rateInput: n(r.rate_input),
    ratePerG: n(r.rate_per_g),
    metalValue: n(r.metal_value),
    makingType: r.making_type as MakingType,
    makingValue: n(r.making_value),
    makingAmount: n(r.making_amount),
    hsn,
    ...(fixed ? { pricing: 'FIXED_PRICE' as const, qty: n(r.qty ?? 1), unitPrice: n(r.unit_price ?? 0) } : {}),
    ...(r.sku ? { sku: String(r.sku) } : {}),
  };
}

export interface NewInvoicePayload {
  date: string;
  fy: string;
  prefix: string;
  start_seq: number | null;
  customer: {
    mobile: string;
    name: string;
    relation: string;
    relative_name: string;
    address: string;
    state: string;
    state_code: string;
    pan: string;
  } | null;
  buyer_snapshot: Buyer;
  shop_snapshot: ShopSnapshot;
  logo: { hash: string; data_url: string } | null;
  taxable: number;
  cgst: number;
  sgst: number;
  round_off: number;
  grand_total: number;
  items: ItemPayload[];
  /** received now; may be less than the total when the customer pays part */
  payments: { mode: PaymentMode; amount: number; reference_no: string }[];
  discount: number;
}

export const saveInvoice = (invoice: NewInvoicePayload) =>
  invoke<{ id: number; invoice_no: string; seq: number }>('save_invoice', { invoice });

export const cancelInvoice = (id: number, reason: string) => invoke<number>('cancel_invoice', { id, reason });

export type { RecordKind, RecordFilter, RecordsSummary } from './records';

/** One row in Old Bills: a GST bill or an estimate. */
export interface RecordRow {
  kind: RecordKind;
  id: number;
  no: string;
  date: string;
  name: string;
  mobile: string;
  other_mobile?: string;
  grand_total: number;
  status: 'ACTIVE' | 'CANCELLED';
  cancel_reason: string | null;
  modes: string | null;
  /** old jewellery taken in exchange (estimates only) */
  exchange: number;
  /** balance still to be paid (0 = paid in full) */
  due: number;
}

/** One page of bills and estimates, newest first. */
export const listRecords = (f: RecordFilter, offset = 0) => {
  const q = listRecordsQuery(f, offset);
  return select<RecordRow>(q.sql, q.args);
};

/** Counts and totals over the whole filter (same WHERE as the list). */
export async function summaryRecords(f: RecordFilter): Promise<RecordsSummary> {
  const q = summaryQuery(f);
  return foldSummary(await select<{ kind: string; status: string; n: number; total: number; exchange: number }>(q.sql, q.args));
}

/** Sales count and total for each day in the filter, for the date headers. */
export async function daySummaries(f: RecordFilter): Promise<Map<string, { n: number; total: number }>> {
  const q = daySummaryQuery(f);
  const rows = await select<{ date: string; n: number; total: number }>(q.sql, q.args);
  return new Map(rows.map((r) => [r.date, { n: Number(r.n), total: Number(r.total) }]));
}

/** Descriptions used on earlier bills and estimates, most used first (for the description search). */
export async function pastDescriptions(): Promise<string[]> {
  const rows = await select<{ d: string }>(
    `SELECT description AS d FROM (SELECT description FROM invoice_items UNION ALL SELECT description FROM estimate_items)
     GROUP BY lower(description) ORDER BY COUNT(*) DESC LIMIT 300`,
  );
  return rows.map((r) => r.d);
}

// ---------- part payments ----------

export interface Dues {
  total: number;
  paid: number;
  balance: number;
  cash: number;
}

export const getDues = (kind: RecordKind, id: number) => invoke<Dues>('dues', { kind, id });

export interface NewReceiptPayload {
  kind: RecordKind;
  doc_id: number;
  date: string;
  fy: string;
  prefix: string;
  amount: number;
  mode: PaymentMode;
  reference_no: string;
}

export const saveReceipt = (receipt: NewReceiptPayload) =>
  invoke<{ id: number; receipt_no: string; balance: number }>('save_receipt', { receipt });

export interface ReceiptRow {
  id: number;
  receipt_no: string;
  date: string;
  amount: number;
  mode: PaymentMode;
  reference_no: string;
}

/** Later payments against one bill or estimate, oldest first. */
export const listReceipts = (kind: RecordKind, id: number) =>
  select<ReceiptRow>('SELECT id, receipt_no, date, amount, mode, reference_no FROM receipts WHERE kind = ?1 AND doc_id = ?2 ORDER BY id', [kind, id]);

// ---------- estimates ----------

export interface NewEstimatePayload {
  date: string;
  fy: string;
  prefix: string;
  customer: { mobile: string; name: string; other_mobile: string } | null;
  customer_snapshot: EstimateCustomer;
  shop_snapshot: ShopSnapshot;
  logo: { hash: string; data_url: string } | null;
  subtotal: number;
  round_off: number;
  grand_total: number;
  payment_mode: PaymentMode;
  items: ItemPayload[];
  exchanges: { description: string; amount: number }[];
  discount: number;
  /** null = paid in full */
  paid_now: number | null;
}

export const saveEstimate = (estimate: NewEstimatePayload) =>
  invoke<{ id: number; estimate_no: string; seq: number }>('save_estimate', { estimate });

export const cancelEstimate = (id: number, reason: string) => invoke<number>('cancel_estimate', { id, reason });

export async function getEstimateDoc(id: number): Promise<{ doc: EstimateDoc; logo: string }> {
  const [e] = await select<Row>('SELECT * FROM estimates WHERE id = ?1', [id]);
  if (!e) throw new Error('Estimate not found');
  const items = await select<Row>('SELECT * FROM estimate_items WHERE estimate_id = ?1 ORDER BY sl', [id]);
  const exchanges = await select<{ description: string; amount: number }>(
    'SELECT description, amount FROM estimate_exchanges WHERE estimate_id = ?1 ORDER BY sl',
    [id],
  );
  const shop = JSON.parse(String(e.shop_snapshot)) as ShopSnapshot;
  const logoRow = shop.logoHash ? await select<{ data_url: string }>('SELECT data_url FROM logos WHERE hash = ?1', [shop.logoHash]) : [];
  const n = (v: unknown) => Number(v);
  const doc: EstimateDoc = {
    estimateNo: String(e.estimate_no),
    date: String(e.date),
    shop,
    customer: JSON.parse(String(e.customer_snapshot)) as EstimateCustomer,
    items: items.map((r) => rowToItem(r, '')),
    totalWeightMg: items.reduce((s, r) => s + n(r.weight_mg), 0),
    subtotal: n(e.subtotal),
    exchanges: exchanges.map((x) => ({ description: String(x.description ?? ''), amount: n(x.amount) })),
    exchangeTotal: n(e.exchange_total ?? 0),
    roundOff: n(e.round_off),
    grand: n(e.grand_total),
    discount: n(e.discount ?? 0),
    paymentMode: e.payment_mode as PaymentMode,
    paidNow: e.paid_now == null ? null : n(e.paid_now),
    cancelled: e.status === 'CANCELLED',
  };
  return { doc, logo: logoRow[0]?.data_url ?? '' };
}

/** Rebuild the full bill from the frozen snapshot, so reprints never change. */
export async function getInvoiceDoc(id: number): Promise<{ doc: BillDoc; logo: string }> {
  const [inv] = await select<Row>('SELECT * FROM invoices WHERE id = ?1', [id]);
  if (!inv) throw new Error('Bill not found');
  const items = await select<Row>('SELECT * FROM invoice_items WHERE invoice_id = ?1 ORDER BY sl', [id]);
  const pays = await select<Row>('SELECT * FROM payments WHERE invoice_id = ?1 ORDER BY id', [id]);
  const shop = JSON.parse(String(inv.shop_snapshot)) as ShopSnapshot;
  const buyer = JSON.parse(String(inv.buyer_snapshot)) as Buyer;
  const logoRow = shop.logoHash ? await select<{ data_url: string }>('SELECT data_url FROM logos WHERE hash = ?1', [shop.logoHash]) : [];
  const n = (v: unknown) => Number(v);
  const doc: BillDoc = {
    invoiceNo: String(inv.invoice_no),
    date: String(inv.date),
    shop,
    buyer,
    items: items.map((r) => rowToItem(r, String(r.hsn))),
    totalWeightMg: items.reduce((s, r) => s + n(r.weight_mg), 0),
    taxable: n(inv.taxable),
    cgstRate: shop.gstRate / 2,
    sgstRate: shop.gstRate / 2,
    cgst: n(inv.cgst),
    sgst: n(inv.sgst),
    roundOff: n(inv.round_off),
    grand: n(inv.grand_total),
    discount: n(inv.discount ?? 0),
    payments: pays.map((p) => ({ mode: p.mode as PaymentMode, amount: n(p.amount), referenceNo: String(p.reference_no ?? '') })),
    cancelled: inv.status === 'CANCELLED',
  };
  return { doc, logo: logoRow[0]?.data_url ?? '' };
}

// ---------- files ----------

function toBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

export const writeFile = (path: string, bytes: Uint8Array) => invoke<void>('write_file', { path, dataB64: toBase64(bytes) });
export const fileExists = (path: string) => invoke<boolean>('file_exists', { path });
export const openPath = (path: string) => invoke<void>('open_path', { path });
export const backupNow = () => invoke<string>('backup_now');
export const printWindow = () => invoke<void>('print_window');

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- customers (CRM) ----------

export interface Customer {
  id: number;
  mobile: string;
  otherMobile: string;
  name: string;
  relation: Buyer['relation'];
  relativeName: string;
  address: string;
  state: string;
  stateCode: string;
  pan: string;
  /** YYYY-MM-DD, or '' */
  dob: string;
  anniversary: string;
  notes: string;
}

export interface CustomerRow extends Customer {
  bills: number;
  estimates: number;
  /** money paid on active bills and estimates, in paise */
  paid: number;
  lastVisit: string | null;
  createdAt: string;
}

const toCustomer = (r: Row): Customer => ({
  id: Number(r.id),
  mobile: String(r.mobile ?? ''),
  otherMobile: String(r.other_mobile ?? ''),
  name: String(r.name ?? ''),
  relation: (r.relation ?? '') as Buyer['relation'],
  relativeName: String(r.relative_name ?? ''),
  address: String(r.address ?? ''),
  state: String(r.state ?? ''),
  stateCode: String(r.state_code ?? ''),
  pan: String(r.pan ?? ''),
  dob: String(r.dob ?? ''),
  anniversary: String(r.anniversary ?? ''),
  notes: String(r.notes ?? ''),
});

/** Customers with their visit counts and totals (cancelled bills and estimates not counted). */
export async function listCustomers(q: string): Promise<CustomerRow[]> {
  const like = `%${q.trim()}%`;
  const rows = await select<Row>(
    `SELECT c.*,
       (SELECT COUNT(*) FROM invoices i WHERE i.customer_id = c.id AND i.status = 'ACTIVE') AS bills,
       (SELECT COUNT(*) FROM estimates e WHERE e.customer_id = c.id AND e.status = 'ACTIVE') AS estimates,
       (SELECT COALESCE(SUM(grand_total), 0) FROM invoices i WHERE i.customer_id = c.id AND i.status = 'ACTIVE')
         + (SELECT COALESCE(SUM(grand_total), 0) FROM estimates e WHERE e.customer_id = c.id AND e.status = 'ACTIVE') AS paid,
       (SELECT MAX(d) FROM (SELECT MAX(date) AS d FROM invoices i WHERE i.customer_id = c.id
                            UNION ALL SELECT MAX(date) FROM estimates e WHERE e.customer_id = c.id)) AS last_visit
     FROM customers c
     WHERE ?1 = '%%' OR c.name LIKE ?1 OR c.mobile LIKE ?1 OR c.other_mobile LIKE ?1 OR c.address LIKE ?1 OR c.notes LIKE ?1
     ORDER BY COALESCE(last_visit, c.created_at) DESC, c.name
     LIMIT 1000`,
    [like],
  );
  return rows.map((r) => ({
    ...toCustomer(r),
    bills: Number(r.bills),
    estimates: Number(r.estimates),
    paid: Number(r.paid),
    lastVisit: (r.last_visit as string | null) ?? null,
    createdAt: String(r.created_at ?? ''),
  }));
}

/** Insert (id 0) or update a customer. The mobile number must be unique. */
export async function saveCustomer(c: Customer): Promise<number> {
  const args = [c.mobile, c.otherMobile, c.name, c.relation, c.relativeName, c.address, c.state, c.stateCode, c.pan, c.dob, c.anniversary, c.notes];
  try {
    if (c.id) {
      await execute(
        `UPDATE customers SET mobile = ?1, other_mobile = ?2, name = ?3, relation = ?4, relative_name = ?5, address = ?6,
           state = ?7, state_code = ?8, pan = ?9, dob = ?10, anniversary = ?11, notes = ?12,
           updated_at = datetime('now','localtime')
         WHERE id = ?13`,
        [...args, c.id],
      );
      return c.id;
    }
    const r = await execute(
      `INSERT INTO customers (mobile, other_mobile, name, relation, relative_name, address, state, state_code, pan, dob, anniversary, notes)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      args,
    );
    return r.last_insert_id;
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new Error(`Another customer already has mobile ${c.mobile}.`);
    throw e;
  }
}

/** Only customers with no bills or estimates can be deleted (saved bills keep their customer). */
export async function deleteCustomer(id: number): Promise<void> {
  const [r] = await select<{ n: number }>(
    'SELECT (SELECT COUNT(*) FROM invoices WHERE customer_id = ?1) + (SELECT COUNT(*) FROM estimates WHERE customer_id = ?1) AS n',
    [id],
  );
  if (r && r.n > 0) throw new Error('This customer has bills or estimates, so they cannot be deleted.');
  await execute('DELETE FROM customers WHERE id = ?1', [id]);
}

/** A customer's bills and estimates, newest first. */
export async function customerHistory(id: number): Promise<RecordRow[]> {
  return select<RecordRow>(
    `SELECT * FROM (
       SELECT 'BILL' AS kind, i.id, i.invoice_no AS no, i.date, i.created_at, json_extract(i.buyer_snapshot,'$.name') AS name,
         json_extract(i.buyer_snapshot,'$.mobile') AS mobile, i.grand_total, i.status, i.cancel_reason,
         (SELECT group_concat(mode, ' + ') FROM payments p WHERE p.invoice_id = i.id) AS modes, 0 AS exchange
       FROM invoices i WHERE i.customer_id = ?1
       UNION ALL
       SELECT 'EST', e.id, e.estimate_no, e.date, e.created_at, json_extract(e.customer_snapshot,'$.name'),
         json_extract(e.customer_snapshot,'$.mobile'), e.grand_total, e.status, e.cancel_reason,
         e.payment_mode || CASE WHEN e.exchange_total > 0 THEN ' + old jewellery' ELSE '' END, e.exchange_total
       FROM estimates e WHERE e.customer_id = ?1
     ) ORDER BY date DESC, created_at DESC`,
    [id],
  );
}

// ---------- estimate customer correction (estimates only; GST bills stay locked) ----------

export interface FieldEdit {
  field: string;
  old_value: string;
  new_value: string;
}

/** Correct the name / mobiles on an active estimate. Returns what changed (written to the audit trail). */
export const updateEstimateCustomer = (id: number, name: string, mobile: string, otherMobile: string) =>
  invoke<FieldEdit[]>('update_estimate_customer', { id, name, mobile, otherMobile });

/** Audit trail of customer corrections on an estimate, oldest first. */
export const estimateEdits = (id: number) =>
  select<FieldEdit & { edited_at: string }>('SELECT field, old_value, new_value, edited_at FROM estimate_edits WHERE estimate_id = ?1 ORDER BY id', [id]);

// ---------- reports ----------

/** Item Sales: match descriptions (with spelling variants) in JS, then fetch just those item lines. */
export async function itemSales(filter: ItemFilter): Promise<ItemSalesResult> {
  // a catalogue code searches that exact SKU
  const f = looksLikeSku(filter.q) ? { ...filter, sku: filter.q, q: '' } : filter;
  const d = descriptionsQuery(f);
  const keep = matchDescriptions(await select<{ description: string; metal: string }>(d.sql, d.args), f.q);
  if (!keep.length) return summarise([], []);
  const l = linesQuery(f, [...new Set(keep.map((k) => k.description))]);
  return summarise(await select<ItemLine>(l.sql, l.args), keep);
}

/** One bill or estimate as an Old Bills row (for opening its panel from elsewhere). */
export async function getRecord(kind: RecordKind, id: number): Promise<RecordRow | null> {
  const rows = await select<RecordRow>(
    `SELECT kind, id, no, date, name, mobile, other_mobile, grand_total, status, cancel_reason, modes, exchange
     FROM ${RECORDS_SOURCE} WHERE kind = ?1 AND id = ?2`,
    [kind, id],
  );
  return rows[0] ?? null;
}

// ---------- 925 catalogue ----------

export const fetchCatalogue = (url: string) => invoke<string>('fetch_catalogue', { url });
export const replaceCatalogue = (items: CatalogueItem[], syncedAt: string) => invoke<number>('replace_catalogue', { items, syncedAt });

export async function catalogueCategories(): Promise<string[]> {
  const r = await select<{ c: string }>("SELECT DISTINCT category AS c FROM catalogue WHERE category <> '' ORDER BY c");
  return r.map((x) => x.c);
}

export async function catalogueLastSynced(): Promise<string | null> {
  const r = await select<{ at: string | null }>('SELECT MAX(synced_at) AS at FROM catalogue');
  return r[0]?.at ?? null;
}

/** The cached catalogue, by SKU. */
export async function loadCatalogue(): Promise<Map<string, CatalogueItem>> {
  const rows = await select<CatalogueItem>('SELECT sku, name, category, shop_price, weight_mg, qty FROM catalogue');
  return new Map(rows.map((r) => [r.sku, r]));
}

const localStamp = () => {
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const runCatalogueSync = (url: string): Promise<SyncResult> =>
  syncCatalogue(url, { fetchText: fetchCatalogue, replace: replaceCatalogue, lastSynced: catalogueLastSynced, now: localStamp });
