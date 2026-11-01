// Old Bills: one source of truth for the filter, so the list, the totals and the day headers can never drift apart.
// Pure (no Tauri) so it can be tested against a real SQLite database.

export type RecordKind = 'BILL' | 'EST';

export interface RecordFilter {
  q: string;
  /** YYYY-MM-DD, '' = no limit */
  from: string;
  to: string;
  kind: '' | RecordKind;
  showCancelled: boolean;
}

/** Bills and estimates as one table with the same columns. */
export const RECORDS_SOURCE = `(
  SELECT 'BILL' AS kind, i.id, i.invoice_no AS no, i.date, i.created_at,
    json_extract(i.buyer_snapshot,'$.name') AS name, json_extract(i.buyer_snapshot,'$.mobile') AS mobile,
    '' AS other_mobile, i.grand_total, i.status, i.cancel_reason,
    (SELECT group_concat(mode, ' + ') FROM payments p WHERE p.invoice_id = i.id) AS modes, 0 AS exchange
  FROM invoices i
  UNION ALL
  SELECT 'EST', e.id, e.estimate_no, e.date, e.created_at,
    json_extract(e.customer_snapshot,'$.name'), json_extract(e.customer_snapshot,'$.mobile'),
    json_extract(e.customer_snapshot,'$.otherMobile'), e.grand_total, e.status, e.cancel_reason,
    e.payment_mode || CASE WHEN e.exchange_total > 0 THEN ' + old jewellery' ELSE '' END, e.exchange_total
  FROM estimates e
)`;

/** WHERE clause for a filter. `activeOnly` forces status = ACTIVE (used for totals). */
export function recordsWhere(f: RecordFilter, activeOnly = false): { sql: string; args: unknown[] } {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.q.trim()) {
    args.push(`%${f.q.trim()}%`);
    const n = args.length;
    where.push(`(no LIKE ?${n} OR name LIKE ?${n} OR mobile LIKE ?${n} OR other_mobile LIKE ?${n})`);
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
  if (activeOnly || !f.showCancelled) where.push(`status = 'ACTIVE'`);
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

export const PAGE_SIZE = 100;

export function listRecordsQuery(f: RecordFilter, offset = 0, limit = PAGE_SIZE) {
  const w = recordsWhere(f);
  return {
    sql: `SELECT kind, id, no, date, name, mobile, other_mobile, grand_total, status, cancel_reason, modes, exchange
          FROM ${RECORDS_SOURCE} ${w.sql}
          ORDER BY date DESC, created_at DESC, id DESC LIMIT ${Math.max(1, Math.floor(limit))} OFFSET ${Math.max(0, Math.floor(offset))}`,
    args: w.args,
  };
}

/** Totals over the WHOLE filter (not just the loaded page). Cancelled records are never counted in sales. */
export function summaryQuery(f: RecordFilter) {
  const w = recordsWhere({ ...f, showCancelled: true });
  return {
    sql: `SELECT kind, status, COUNT(*) AS n, COALESCE(SUM(grand_total), 0) AS total, COALESCE(SUM(exchange), 0) AS exchange
          FROM ${RECORDS_SOURCE} ${w.sql} GROUP BY kind, status`,
    args: w.args,
  };
}

/** Per-day sales for the date headers ("Sun, 1 Nov 2026 · 7 sales · ₹1,24,500"), active records only. */
export function daySummaryQuery(f: RecordFilter) {
  const w = recordsWhere(f, true);
  return {
    sql: `SELECT date, COUNT(*) AS n, COALESCE(SUM(grand_total), 0) AS total FROM ${RECORDS_SOURCE} ${w.sql} GROUP BY date`,
    args: w.args,
  };
}

export interface RecordsSummary {
  bills: { n: number; total: number };
  estimates: { n: number; total: number; exchange: number };
  cancelled: number;
}

export function foldSummary(rows: { kind: string; status: string; n: number; total: number; exchange: number }[]): RecordsSummary {
  const s: RecordsSummary = { bills: { n: 0, total: 0 }, estimates: { n: 0, total: 0, exchange: 0 }, cancelled: 0 };
  for (const r of rows) {
    if (r.status !== 'ACTIVE') s.cancelled += Number(r.n);
    else if (r.kind === 'BILL') s.bills = { n: Number(r.n), total: Number(r.total) };
    else s.estimates = { n: Number(r.n), total: Number(r.total), exchange: Number(r.exchange) };
  }
  return s;
}

// ---------- date presets ----------

export type Preset = 'today' | 'yesterday' | 'week' | 'month' | 'fy' | 'custom';

export const PRESETS: { id: Preset; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
  { id: 'fy', label: 'This FY' },
  { id: 'custom', label: 'Custom…' },
];

function iso(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Date range for a preset, given today's date (YYYY-MM-DD). Weeks start on Monday; the FY starts on 1 April. */
export function presetRange(p: Exclude<Preset, 'custom'>, today: string): { from: string; to: string } {
  const [y, m, d] = today.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  switch (p) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const yd = iso(new Date(t.getTime() - 86_400_000));
      return { from: yd, to: yd };
    }
    case 'week': {
      const back = (t.getUTCDay() + 6) % 7; // days since Monday
      return { from: iso(new Date(t.getTime() - back * 86_400_000)), to: today };
    }
    case 'month':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'fy':
      return { from: `${m >= 4 ? y : y - 1}-04-01`, to: today };
  }
}

/** Group rows (already sorted newest first) by date, keeping order. */
export function groupByDate<T extends { date: string }>(rows: T[]): { date: string; rows: T[] }[] {
  const out: { date: string; rows: T[] }[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.date === r.date) last.rows.push(r);
    else out.push({ date: r.date, rows: [r] });
  }
  return out;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11-01" → "Sun, 1 Nov 2026" */
export function fmtDayHeader(dateIso: string): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAYS[dow]}, ${d} ${MONTHS[m - 1]} ${y}`;
}
