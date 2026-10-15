// Thin wrappers over the Rust commands (src-tauri/src/lib.rs).
import { invoke } from '@tauri-apps/api/core';
import type { MakingType, Metal, PaymentMode } from './calc';
import { DEFAULT_SETTINGS } from './bill';
import type { BillDoc, Buyer, DailyRates, EstimateCustomer, EstimateDoc, Settings, ShopSnapshot } from './types';
import defaultLogoUrl from '../assets/logo.png?url';

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

export async function findCustomer(mobile: string): Promise<Omit<Buyer, 'form60'> | null> {
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
  items: {
    description: string;
    metal: Metal;
    weight_mg: number;
    rate_input: number;
    rate_per_g: number;
    metal_value: number;
    making_type: MakingType;
    making_value: number;
    making_amount: number;
    hsn: string;
  }[];
  payments: { mode: PaymentMode; amount: number; reference_no: string }[];
}

export const saveInvoice = (invoice: NewInvoicePayload) =>
  invoke<{ id: number; invoice_no: string; seq: number }>('save_invoice', { invoice });

export const cancelInvoice = (id: number, reason: string) => invoke<number>('cancel_invoice', { id, reason });

export type RecordKind = 'BILL' | 'EST';

/** One row in Old Bills: a GST bill or an estimate. */
export interface RecordRow {
  kind: RecordKind;
  id: number;
  no: string;
  date: string;
  name: string;
  mobile: string;
  grand_total: number;
  status: 'ACTIVE' | 'CANCELLED';
  cancel_reason: string | null;
  modes: string | null;
}

/** Bills and estimates together, newest first, with the same filters applied to both. */
export async function listRecords(f: { q: string; from: string; to: string; kind: '' | RecordKind }): Promise<RecordRow[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.q.trim()) {
    const like = `%${f.q.trim()}%`;
    args.push(like);
    where.push(`(no LIKE ?${args.length} OR name LIKE ?${args.length} OR mobile LIKE ?${args.length} OR other_mobile LIKE ?${args.length})`);
  }
  if (f.from) {
    args.push(f.from);
    where.push(`date >= ?${args.length}`);
  }
  if (f.to) {
    args.push(f.to);
    where.push(`date <= ?${args.length}`);
  }
  if (f.kind) {
    args.push(f.kind);
    where.push(`kind = ?${args.length}`);
  }
  return select<RecordRow>(
    `SELECT kind, id, no, date, name, mobile, grand_total, status, cancel_reason, modes FROM (
       SELECT 'BILL' AS kind, i.id, i.invoice_no AS no, i.date, i.created_at,
         json_extract(i.buyer_snapshot,'$.name') AS name, json_extract(i.buyer_snapshot,'$.mobile') AS mobile,
         '' AS other_mobile, i.grand_total, i.status, i.cancel_reason,
         (SELECT group_concat(mode, ' + ') FROM payments p WHERE p.invoice_id = i.id) AS modes
       FROM invoices i
       UNION ALL
       SELECT 'EST', e.id, e.estimate_no, e.date, e.created_at,
         json_extract(e.customer_snapshot,'$.name'), json_extract(e.customer_snapshot,'$.mobile'),
         json_extract(e.customer_snapshot,'$.otherMobile'), e.grand_total, e.status, e.cancel_reason, e.payment_mode
       FROM estimates e
     ) ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY date DESC, created_at DESC, id DESC LIMIT 500`,
    args,
  );
}

/** Descriptions used on earlier bills and estimates, most used first (for the description search). */
export async function pastDescriptions(): Promise<string[]> {
  const rows = await select<{ d: string }>(
    `SELECT description AS d FROM (SELECT description FROM invoice_items UNION ALL SELECT description FROM estimate_items)
     GROUP BY lower(description) ORDER BY COUNT(*) DESC LIMIT 300`,
  );
  return rows.map((r) => r.d);
}

// ---------- estimates ----------

export interface NewEstimatePayload {
  date: string;
  fy: string;
  prefix: string;
  customer: { mobile: string; name: string } | null;
  customer_snapshot: EstimateCustomer;
  shop_snapshot: ShopSnapshot;
  logo: { hash: string; data_url: string } | null;
  subtotal: number;
  round_off: number;
  grand_total: number;
  payment_mode: PaymentMode;
  items: {
    description: string;
    metal: Metal;
    weight_mg: number;
    rate_input: number;
    rate_per_g: number;
    metal_value: number;
    making_type: MakingType;
    making_value: number;
    making_amount: number;
  }[];
}

export const saveEstimate = (estimate: NewEstimatePayload) =>
  invoke<{ id: number; estimate_no: string; seq: number }>('save_estimate', { estimate });

export const cancelEstimate = (id: number, reason: string) => invoke<number>('cancel_estimate', { id, reason });

export async function getEstimateDoc(id: number): Promise<{ doc: EstimateDoc; logo: string }> {
  const [e] = await select<Row>('SELECT * FROM estimates WHERE id = ?1', [id]);
  if (!e) throw new Error('Estimate not found');
  const items = await select<Row>('SELECT * FROM estimate_items WHERE estimate_id = ?1 ORDER BY sl', [id]);
  const shop = JSON.parse(String(e.shop_snapshot)) as ShopSnapshot;
  const logoRow = shop.logoHash ? await select<{ data_url: string }>('SELECT data_url FROM logos WHERE hash = ?1', [shop.logoHash]) : [];
  const n = (v: unknown) => Number(v);
  const doc: EstimateDoc = {
    estimateNo: String(e.estimate_no),
    date: String(e.date),
    shop,
    customer: JSON.parse(String(e.customer_snapshot)) as EstimateCustomer,
    items: items.map((r) => ({
      description: String(r.description),
      metal: r.metal as Metal,
      weightMg: n(r.weight_mg),
      rateInput: n(r.rate_input),
      ratePerG: n(r.rate_per_g),
      metalValue: n(r.metal_value),
      makingType: r.making_type as MakingType,
      makingValue: n(r.making_value),
      makingAmount: n(r.making_amount),
      hsn: '',
    })),
    totalWeightMg: items.reduce((s, r) => s + n(r.weight_mg), 0),
    subtotal: n(e.subtotal),
    roundOff: n(e.round_off),
    grand: n(e.grand_total),
    paymentMode: e.payment_mode as PaymentMode,
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
    items: items.map((r) => ({
      description: String(r.description),
      metal: r.metal as Metal,
      weightMg: n(r.weight_mg),
      rateInput: n(r.rate_input),
      ratePerG: n(r.rate_per_g),
      metalValue: n(r.metal_value),
      makingType: r.making_type as MakingType,
      makingValue: n(r.making_value),
      makingAmount: n(r.making_amount),
      hsn: String(r.hsn),
    })),
    totalWeightMg: items.reduce((s, r) => s + n(r.weight_mg), 0),
    taxable: n(inv.taxable),
    cgstRate: shop.gstRate / 2,
    sgstRate: shop.gstRate / 2,
    cgst: n(inv.cgst),
    sgst: n(inv.sgst),
    roundOff: n(inv.round_off),
    grand: n(inv.grand_total),
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
