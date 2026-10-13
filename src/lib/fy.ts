// Dates are local calendar dates as "YYYY-MM-DD" strings.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function todayISO(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parts(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}

/** Financial year (April–March) as "26-27". */
export function financialYear(iso: string): string {
  const { y, m } = parts(iso);
  const start = m >= 4 ? y : y - 1;
  return `${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** "SR/26-27/001" — at least 3 digits, grows beyond 999. */
export function formatInvoiceNo(prefix: string, fy: string, seq: number): string {
  return `${prefix}/${fy}/${String(seq).padStart(3, '0')}`;
}

/** Next sequence number for a bill dated `iso`, given the last saved bill's FY and seq (if any). */
export function nextSeq(iso: string, last: { fy: string; seq: number } | null, startSeq = 1): number {
  if (!last || last.fy !== financialYear(iso)) return startSeq;
  return last.seq + 1;
}

/** "10-Oct-26" */
export function fmtBillDate(iso: string): string {
  const { y, m, d } = parts(iso);
  return `${String(d).padStart(2, '0')}-${MONTHS[m - 1]}-${String(y % 100).padStart(2, '0')}`;
}

/** Month folder name: "10-Oct" */
export function monthFolder(iso: string): string {
  const { m } = parts(iso);
  return `${String(m).padStart(2, '0')}-${MONTHS[m - 1]}`;
}

/** "SR/26-27/001" -> "SR-26-27-001" */
export function invoiceFileStem(invoiceNo: string): string {
  return invoiceNo.replace(/[\\/:*?"<>|]/g, '-');
}
