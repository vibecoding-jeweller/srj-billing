// Small helpers for the Customers tab.

/** Birthdays and anniversaries are stored as "MM-DD" (no year needed for greetings). */
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "10-25" → "25 October" */
export function fmtDayMonth(md: string): string {
  const m = /^(?:\d{4}-)?(\d{2})-(\d{2})$/.exec(md);
  return m ? `${Number(m[2])} ${MONTHS[Number(m[1]) - 1]}` : '';
}

/** Days from `today` (YYYY-MM-DD) until the next yearly return of `date` ("MM-DD", or a full YYYY-MM-DD). 0 = today. */
export function daysUntilAnnual(date: string, today: string): number | null {
  const m = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const [ty, tm, td] = today.split('-').map(Number);
  const t = Date.UTC(ty, tm - 1, td);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  let next = Date.UTC(ty, month, day);
  if (next < t) next = Date.UTC(ty + 1, month, day);
  return Math.round((next - t) / 86_400_000);
}

export interface Occasion {
  customerId: number;
  name: string;
  mobile: string;
  kind: 'Birthday' | 'Anniversary';
  inDays: number;
}

/** Birthdays and anniversaries in the next `days` days, soonest first. */
export function upcomingOccasions(
  customers: { id: number; name: string; mobile: string; dob: string; anniversary: string }[],
  today: string,
  days = 7,
): Occasion[] {
  const out: Occasion[] = [];
  for (const c of customers) {
    for (const [kind, d] of [['Birthday', c.dob], ['Anniversary', c.anniversary]] as const) {
      const n = d ? daysUntilAnnual(d, today) : null;
      if (n != null && n <= days) out.push({ customerId: c.id, name: c.name, mobile: c.mobile, kind, inDays: n });
    }
  }
  return out.sort((a, b) => a.inDays - b.inDays || a.name.localeCompare(b.name));
}

// ---------- export ----------

/** What the customer sheet needs from each customer (a CustomerRow fits). */
export interface CustomerSheetRow {
  name: string;
  relation: string;
  relativeName: string;
  mobile: string;
  otherMobile: string;
  address: string;
  state: string;
  pan: string;
  dob: string;
  anniversary: string;
  notes: string;
  bills: number;
  estimates: number;
  /** paise */
  paid: number;
  lastVisit: string | null;
  createdAt: string;
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const CUSTOMER_SHEET_HEADER = [
  'Name',
  'Relation',
  'Relative name',
  'Mobile',
  'Other mobile',
  'Address',
  'State',
  'PAN',
  'Birthday',
  'Anniversary',
  'Bills',
  'Estimates',
  'Total purchases (Rs)',
  'Last visit',
  'Customer since',
  'Notes',
];

/**
 * All customers as a CSV that opens in Excel (UTF-8 with BOM so Hindi names show correctly).
 * Mobiles are written as ="9876543210" so Excel keeps them as text; dates are YYYY-MM-DD.
 */
export function customersCsv(rows: CustomerSheetRow[]): string {
  const phone = (m: string) => (m ? `="${m}"` : '');
  const lines = [CUSTOMER_SHEET_HEADER, ...rows.map((c) => [
    c.name,
    c.relation,
    c.relativeName,
    phone(c.mobile),
    phone(c.otherMobile),
    c.address.split(/\r?\n/).map((l) => l.trim().replace(/,$/, '')).filter(Boolean).join(', '),
    c.state,
    c.pan,
    fmtDayMonth(c.dob),
    fmtDayMonth(c.anniversary),
    c.bills,
    c.estimates,
    (c.paid / 100).toFixed(2),
    c.lastVisit ?? '',
    c.createdAt.slice(0, 10),
    c.notes.replace(/\s*\r?\n\s*/g, ' / '),
  ])];
  return '\uFEFF' + lines.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
