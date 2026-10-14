import { cashPart, needsReference, sumPayments, type Payment } from './calc';
import { fmtMoney } from './money';

/** Sec 269ST: cash of ₹2,00,000 or more in one transaction is not allowed. */
export const CASH_LIMIT = 2_00_000_00;
/** Rule 114B: PAN (or Form 60) required when the bill total is more than ₹2,00,000. */
export const PAN_LIMIT = 2_00_000_00;

export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export const CASH_BLOCK_MSG = 'Cash of ₹2 lakh or more is not allowed (Sec 269ST). Change payment mode.';

export function isCashBlocked(payments: Payment[]): boolean {
  return cashPart(payments) >= CASH_LIMIT;
}

export function panRequired(grand: number): boolean {
  return grand > PAN_LIMIT;
}

export interface BillCheckInput {
  grand: number;
  itemCount: number;
  itemErrors: string[];
  payments: Payment[];
  pan: string;
  form60: boolean;
  mobile: string;
}

/** Returns blocking errors; an empty list means the bill can be saved. */
export function checkBill(b: BillCheckInput): string[] {
  const errs: string[] = [...b.itemErrors];
  if (b.itemCount === 0) errs.push('Add at least one item.');
  if (b.mobile && !/^\d{10}$/.test(b.mobile)) errs.push('Mobile number must be 10 digits.');
  if (isCashBlocked(b.payments)) errs.push(CASH_BLOCK_MSG);
  const paid = sumPayments(b.payments);
  if (paid !== b.grand) {
    errs.push(`Payment parts add up to ₹${fmtMoney(paid)} but the bill total is ₹${fmtMoney(b.grand)}.`);
  }
  if (b.payments.some((p) => p.amount <= 0)) errs.push('Every payment part needs an amount.');
  for (const p of b.payments) {
    if (needsReference(p.mode) && !p.referenceNo?.trim()) errs.push(`Enter the ${p.mode === 'Cheque' ? 'cheque number' : 'UTR / reference number'} for ${p.mode}.`);
  }
  const pan = b.pan.trim().toUpperCase();
  if (pan && !PAN_RE.test(pan)) errs.push('PAN looks wrong. It should look like ABCDE1234F.');
  if (panRequired(b.grand) && !pan && !b.form60) {
    errs.push('Bill is above ₹2 lakh: enter the customer PAN or tick "Form 60 taken" (Rule 114B).');
  }
  return errs;
}
