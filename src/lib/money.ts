// All money is integer paise. All weights are integer milligrams.
// Never use floating point for money: parse from strings, compute with BigInt where products can be large.

/** Divide a/b rounding half up. Both must be non-negative (b > 0). */
export function divRoundHalfUp(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error('divisor must be positive');
  if (a < 0n) return -divRoundHalfUp(-a, b);
  return (a * 2n + b) / (b * 2n);
}

/** Parse a decimal string ("1,39,000", "126.5", "0.550") into an integer scaled by 10^scale. Returns null if invalid. */
export function parseScaled(input: string, scale: number): number | null {
  const s = input.replace(/[,\s₹]/g, '').trim();
  if (s === '') return null;
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return null;
  const whole = m[1] || '0';
  const frac = m[2] ?? '';
  if (frac.length > scale) return null;
  const v = BigInt(whole) * 10n ** BigInt(scale) + BigInt((frac + '0'.repeat(scale)).slice(0, scale) || '0');
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(v);
}

export const parsePaise = (s: string) => parseScaled(s, 2);
export const parseMg = (s: string) => parseScaled(s, 3);

/** Indian digit grouping: 1234567 -> "12,34,567" */
export function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const parts: string[] = [];
  while (rest.length > 2) {
    parts.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) parts.unshift(rest);
  return parts.join(',') + ',' + last3;
}

/** Format paise as "8,662.00" (Indian grouping). Negative values get a leading "-". */
export function fmtMoney(paise: number): string {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  return (neg ? '-' : '') + groupIndian(String(rupees)) + '.' + String(p).padStart(2, '0');
}

/** Format paise without decimals when whole: 13900000 -> "1,39,000"; 13900050 -> "1,39,000.50" */
export function fmtMoneyShort(paise: number): string {
  return paise % 100 === 0 ? groupIndian(String(Math.abs(paise) / 100)) : fmtMoney(paise);
}

/** Format paise for an input box: no grouping, decimals only if needed. */
export function paiseToInput(paise: number | null | undefined): string {
  if (paise == null) return '';
  return paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2);
}

/** Format milligrams as grams with 3 decimals: 550 -> "0.550" */
export function fmtWeight(mg: number): string {
  return Math.floor(mg / 1000) + '.' + String(mg % 1000).padStart(3, '0');
}

/** Round-off display: "0.22" or "(-)0.80" */
export function fmtRoundOff(paise: number): string {
  return paise < 0 ? '(-)' + fmtMoney(-paise) : fmtMoney(paise);
}

/** Percent stored as hundredths of a percent: 1000 -> "10", 1250 -> "12.5", 150 -> "1.50" (fixed2) */
export function fmtPct(hundredths: number, fixed2 = false): string {
  const s = (hundredths / 100).toFixed(2);
  return fixed2 ? s : s.replace(/\.?0+$/, '');
}
