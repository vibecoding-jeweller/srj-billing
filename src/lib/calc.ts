import { divRoundHalfUp } from './money';

export type Metal = 'GOLD22' | 'GOLD18' | 'SILVER' | 'SILVER925';
export type MakingType = 'PCT' | 'PER_G' | 'FIXED';
/** WEIGHT: weight × rate + making. FIXED_PRICE: qty × tag price (GST-inclusive on bills), e.g. LUXMÉ 925 pieces. */
export type Pricing = 'WEIGHT' | 'FIXED_PRICE';

export const METAL_LABEL: Record<Metal, string> = {
  GOLD22: 'Gold 22K',
  GOLD18: 'Gold 18K',
  SILVER: 'Silver',
  SILVER925: 'Silver 925',
};

/** Rates are entered per 10 g for gold and per kg for silver. */
export const RATE_UNIT_LABEL: Record<Metal, string> = {
  GOLD22: 'per 10 g',
  GOLD18: 'per 10 g',
  SILVER: 'per kg',
  SILVER925: 'per kg',
};

export const isSilver = (m: Metal) => m === 'SILVER' || m === 'SILVER925';

/** Milligrams in one rate unit. */
export function rateUnitMg(metal: Metal): bigint {
  return isSilver(metal) ? 1_000_000n : 10_000n;
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
  /** default WEIGHT */
  pricing?: Pricing;
  /** catalogue code, e.g. RNG0005 */
  sku?: string;
  /** FIXED_PRICE: number of pieces (default 1) */
  qty?: number;
  /** FIXED_PRICE: paise per piece, GST-inclusive on bills */
  unitPrice?: number;
}

export interface ItemCalc extends ItemInput {
  /** WEIGHT: rate per gram in paise, rounded half up. FIXED_PRICE: value of one piece (before GST on bills). */
  ratePerG: number;
  /** WEIGHT: metal value. FIXED_PRICE: line value (before GST on bills, so the table adds up to the taxable value). */
  metalValue: number;
  makingAmount: number;
}

export const isFixedPrice = (it: Pick<ItemInput, 'pricing'>) => it.pricing === 'FIXED_PRICE';
export const qtyOf = (it: Pick<ItemInput, 'qty'>) => Math.max(1, it.qty ?? 1);
/** qty × tag price: what the customer pays for a fixed-price line. */
export const inclusiveOf = (it: Pick<ItemInput, 'qty' | 'unitPrice'>) => qtyOf(it) * (it.unitPrice ?? 0);

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

/** One item on its own. A fixed-price item is valued at its tag price here (right for estimates); calcBill takes the GST out. */
export function calcItem(it: ItemInput): ItemCalc {
  if (isFixedPrice(it)) {
    return { ...it, qty: qtyOf(it), makingType: 'FIXED', makingValue: 0, rateInput: 0, ratePerG: it.unitPrice ?? 0, metalValue: inclusiveOf(it), makingAmount: 0 };
  }
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
 * GST taken out of a tag price, so the customer pays exactly the tag:
 * tax = round2(incl × rate / (100 + rate)), CGST = round2(tax / 2), SGST = the rest.
 */
export function inclusiveTax(incl: number, gstRate: number) {
  const tax = divRoundHalfUp(BigInt(incl) * BigInt(gstRate), BigInt(10_000 + gstRate));
  const cgst = divRoundHalfUp(tax, 2n);
  return { taxable: incl - Number(tax), tax: Number(tax), cgst: Number(cgst), sgst: Number(tax - cgst) };
}

type TaxItem = Pick<ItemCalc, 'hsn' | 'metalValue' | 'makingAmount'> & Pick<ItemInput, 'pricing' | 'qty' | 'unitPrice'>;

/**
 * Tax is worked out per HSN code, so the bill's CGST/SGST always equal the totals of the HSN summary table.
 * Weight-priced items: taxable value of all items with that code × rate, rounded.
 * Fixed-price items: the GST inside their tag prices (all of that code together), see inclusiveTax.
 * @param gstRate total GST in hundredths of a percent (300 = 3%), split equally into CGST and SGST.
 */
export function hsnSummary(items: TaxItem[], gstRate: number): HsnRow[] {
  const groups = new Map<string, { weight: bigint; incl: number }>();
  for (const i of items) {
    const key = i.hsn.trim();
    const g = groups.get(key) ?? { weight: 0n, incl: 0 };
    if (isFixedPrice(i)) g.incl += inclusiveOf(i);
    else g.weight += BigInt(i.metalValue) + BigInt(i.makingAmount);
    groups.set(key, g);
  }
  return [...groups].map(([hsn, g]) => {
    // Each half rate = gstRate / 2; tax = taxable × half / 10000
    const half = Number(divRoundHalfUp(g.weight * BigInt(gstRate), 20_000n));
    const fp = inclusiveTax(g.incl, gstRate);
    return { hsn, taxable: Number(g.weight) + fp.taxable, cgst: half + fp.cgst, sgst: half + fp.sgst };
  });
}

/**
 * Fixed-price lines on a bill show their value before GST. The GST is taken out per HSN code (see hsnSummary),
 * then shared across the lines in proportion, the last line taking any odd paisa, so the lines add up exactly.
 */
function fixedPriceTaxable(calc: ItemCalc[], gstRate: number): ItemCalc[] {
  const byHsn = new Map<string, number[]>();
  calc.forEach((it, i) => {
    if (isFixedPrice(it)) byHsn.set(it.hsn.trim(), [...(byHsn.get(it.hsn.trim()) ?? []), i]);
  });
  const out = [...calc];
  for (const idx of byHsn.values()) {
    const incl = idx.reduce((s, i) => s + inclusiveOf(calc[i]), 0);
    const { taxable } = inclusiveTax(incl, gstRate);
    let left = taxable;
    idx.forEach((i, k) => {
      const it = calc[i];
      const line = k === idx.length - 1 ? left : incl ? Number(divRoundHalfUp(BigInt(inclusiveOf(it)) * BigInt(taxable), BigInt(incl))) : 0;
      left -= line;
      out[i] = { ...it, metalValue: line, ratePerG: Number(divRoundHalfUp(BigInt(line), BigInt(qtyOf(it)))) };
    });
  }
  return out;
}

export function calcBill(items: ItemInput[], gstRate = 300): BillCalc {
  const calc = fixedPriceTaxable(items.map(calcItem), gstRate);
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
  /** old jewellery taken in exchange (money only) */
  exchangeTotal: number;
  roundOff: number;
  /** what the customer pays: (subtotal − exchange) rounded to the nearest rupee (half up) */
  grand: number;
}

/** Estimate (no GST): item amounts added up, old-jewellery exchange taken off, rounded to the rupee. */
export function calcEstimate(items: ItemInput[], exchangeAmounts: number[] = []): EstimateCalc {
  const calc = items.map(calcItem);
  const subtotal = calc.reduce((s, i) => s + i.metalValue + i.makingAmount, 0);
  const exchangeTotal = exchangeAmounts.reduce((s, a) => s + a, 0);
  const net = subtotal - exchangeTotal;
  const grand = Number(divRoundHalfUp(BigInt(net), 100n) * 100n);
  return {
    items: calc,
    totalWeightMg: calc.reduce((s, i) => s + i.weightMg, 0),
    subtotal,
    exchangeTotal,
    roundOff: grand - net,
    grand,
  };
}

/** Best metal for a picked description ("Silver Payal" → Silver), else keep the current one. */
export function metalForDescription(desc: string, current: Metal): Metal {
  if (/\b925\b/.test(desc)) return 'SILVER925';
  if (/silver|chandi|चांदी/i.test(desc)) return current === 'SILVER925' ? current : 'SILVER';
  if (/\b18\s*(k|kt|ct)\b/i.test(desc)) return 'GOLD18';
  if (/\b22\s*(k|kt|ct)\b/i.test(desc)) return 'GOLD22';
  if (/gold|sona|सोना/i.test(desc) && isSilver(current)) return 'GOLD22';
  return current;
}
