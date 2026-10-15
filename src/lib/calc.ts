import { divRoundHalfUp } from './money';

export type Metal = 'GOLD22' | 'GOLD18' | 'SILVER';
export type MakingType = 'PCT' | 'PER_G' | 'FIXED';

export const METAL_LABEL: Record<Metal, string> = {
  GOLD22: 'Gold 22K',
  GOLD18: 'Gold 18K',
  SILVER: 'Silver',
};

/** Rates are entered per 10 g for gold and per kg for silver. */
export const RATE_UNIT_LABEL: Record<Metal, string> = {
  GOLD22: 'per 10 g',
  GOLD18: 'per 10 g',
  SILVER: 'per kg',
};

/** Milligrams in one rate unit. */
export function rateUnitMg(metal: Metal): bigint {
  return metal === 'SILVER' ? 1_000_000n : 10_000n;
}

export interface ItemInput {
  description: string;
  metal: Metal;
  weightMg: number;
  /** paise per 10 g (gold) or per kg (silver) */
  rateInput: number;
  makingType: MakingType;
  /** PCT: hundredths of a percent (1000 = 10%). PER_G: paise per gram. FIXED: paise. */
  makingValue: number;
  /** HSN code for this item, e.g. 7113 */
  hsn: string;
}

export interface ItemCalc extends ItemInput {
  /** rate per gram in paise, rounded half up (display only when not exact) */
  ratePerG: number;
  metalValue: number;
  makingAmount: number;
}

/** One row of the HSN-wise tax summary. */
export interface HsnRow {
  hsn: string;
  taxable: number;
  cgst: number;
  sgst: number;
}

export interface BillCalc {
  items: ItemCalc[];
  /** in order of first appearance on the bill */
  hsnSummary: HsnRow[];
  totalWeightMg: number;
  taxable: number;
  /** hundredths of a percent, e.g. 150 = 1.50% */
  cgstRate: number;
  sgstRate: number;
  cgst: number;
  sgst: number;
  gross: number;
  grand: number;
  roundOff: number;
}

export function calcItem(it: ItemInput): ItemCalc {
  const unit = rateUnitMg(it.metal);
  const weight = BigInt(it.weightMg);
  const rate = BigInt(it.rateInput);
  // metal_value = round2(weight_g × rate_per_g) computed exactly as weight_mg × rate / mg_per_unit
  const metalValue = divRoundHalfUp(weight * rate, unit);
  const ratePerG = divRoundHalfUp(rate * 1000n, unit);
  let making: bigint;
  switch (it.makingType) {
    case 'PCT':
      making = divRoundHalfUp(metalValue * BigInt(it.makingValue), 10_000n);
      break;
    case 'PER_G':
      making = divRoundHalfUp(weight * BigInt(it.makingValue), 1000n);
      break;
    case 'FIXED':
      making = BigInt(it.makingValue);
      break;
  }
  return { ...it, ratePerG: Number(ratePerG), metalValue: Number(metalValue), makingAmount: Number(making) };
}

/**
 * Tax is worked out per HSN code (taxable value of all items with that code × rate, rounded),
 * so the bill's CGST/SGST always equal the totals of the HSN summary table.
 * @param gstRate total GST in hundredths of a percent (300 = 3%), split equally into CGST and SGST.
 */
export function hsnSummary(items: Pick<ItemCalc, 'hsn' | 'metalValue' | 'makingAmount'>[], gstRate: number): HsnRow[] {
  const groups = new Map<string, bigint>();
  for (const i of items) {
    const key = i.hsn.trim();
    groups.set(key, (groups.get(key) ?? 0n) + BigInt(i.metalValue) + BigInt(i.makingAmount));
  }
  return [...groups].map(([hsn, taxable]) => {
    // Each half rate = gstRate / 2; tax = taxable × half / 10000
    const half = Number(divRoundHalfUp(taxable * BigInt(gstRate), 20_000n));
    return { hsn, taxable: Number(taxable), cgst: half, sgst: half };
  });
}

export function calcBill(items: ItemInput[], gstRate = 300): BillCalc {
  const calc = items.map(calcItem);
  const summary = hsnSummary(calc, gstRate);
  const taxable = summary.reduce((s, r) => s + BigInt(r.taxable), 0n);
  const cgst = summary.reduce((s, r) => s + BigInt(r.cgst), 0n);
  const sgst = summary.reduce((s, r) => s + BigInt(r.sgst), 0n);
  const gross = taxable + cgst + sgst;
  const grand = divRoundHalfUp(gross, 100n) * 100n;
  return {
    items: calc,
    hsnSummary: summary,
    totalWeightMg: calc.reduce((s, i) => s + i.weightMg, 0),
    taxable: Number(taxable),
    cgstRate: gstRate / 2,
    sgstRate: gstRate / 2,
    cgst: Number(cgst),
    sgst: Number(sgst),
    gross: Number(gross),
    grand: Number(grand),
    roundOff: Number(grand - gross),
  };
}

export type PaymentMode = 'Cash' | 'UPI' | 'Card' | 'NEFT' | 'RTGS' | 'Cheque';
export const PAYMENT_MODES: PaymentMode[] = ['Cash', 'UPI', 'Card', 'NEFT', 'RTGS', 'Cheque'];
export const needsReference = (m: PaymentMode) => m === 'NEFT' || m === 'RTGS' || m === 'Cheque';

export interface Payment {
  mode: PaymentMode;
  amount: number; // paise
  referenceNo?: string;
}

export const sumPayments = (p: Payment[]) => p.reduce((s, x) => s + x.amount, 0);
export const cashPart = (p: Payment[]) => p.filter((x) => x.mode === 'Cash').reduce((s, x) => s + x.amount, 0);

/** Making-charge sub-line text for the bill. */
export function makingLabel(it: Pick<ItemInput, 'makingType' | 'makingValue'>, fmtPct: (h: number) => string, fmtMoneyShort: (p: number) => string): string {
  switch (it.makingType) {
    case 'PCT':
      return `Making Charges@${fmtPct(it.makingValue)}%`;
    case 'PER_G':
      return `Making Charges@₹${fmtMoneyShort(it.makingValue)}/g`;
    case 'FIXED':
      return 'Making Charges';
  }
}

export interface EstimateCalc {
  items: ItemCalc[];
  totalWeightMg: number;
  /** Σ (metal value + making) */
  subtotal: number;
  roundOff: number;
  /** subtotal rounded to the nearest rupee (half up) */
  grand: number;
}

/** Estimate (no GST): item amounts added up and rounded to the rupee. */
export function calcEstimate(items: ItemInput[]): EstimateCalc {
  const calc = items.map(calcItem);
  const subtotal = calc.reduce((s, i) => s + i.metalValue + i.makingAmount, 0);
  const grand = Number(divRoundHalfUp(BigInt(subtotal), 100n) * 100n);
  return {
    items: calc,
    totalWeightMg: calc.reduce((s, i) => s + i.weightMg, 0),
    subtotal,
    roundOff: grand - subtotal,
    grand,
  };
}

/** Best metal for a picked description ("Silver Payal" → Silver), else keep the current one. */
export function metalForDescription(desc: string, current: Metal): Metal {
  if (/silver|chandi|चांदी/i.test(desc)) return 'SILVER';
  if (/\b18\s*(k|kt|ct)\b/i.test(desc)) return 'GOLD18';
  if (/\b22\s*(k|kt|ct)\b/i.test(desc)) return 'GOLD22';
  if (/gold|sona|सोना/i.test(desc) && current === 'SILVER') return 'GOLD22';
  return current;
}
