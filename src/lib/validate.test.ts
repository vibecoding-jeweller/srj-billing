import { describe, expect, it } from 'vitest';
import { CASH_BLOCK_MSG, checkBill, isCashBlocked, panRequired } from './validate';
import type { Payment } from './calc';

const base = { itemCount: 1, itemErrors: [], pan: '', form60: false, mobile: '7060329291' };

describe('Sec 269ST cash block', () => {
  it('blocks cash of exactly ₹2,00,000', () => {
    expect(isCashBlocked([{ mode: 'Cash', amount: 2_00_000_00 }])).toBe(true);
  });
  it('allows cash just below ₹2,00,000', () => {
    expect(isCashBlocked([{ mode: 'Cash', amount: 1_99_999_99 }])).toBe(false);
  });
  it('counts only the cash part of a split payment', () => {
    const p: Payment[] = [
      { mode: 'Cash', amount: 1_50_000_00 },
      { mode: 'UPI', amount: 3_00_000_00 },
    ];
    expect(isCashBlocked(p)).toBe(false);
  });
  it('adds up several cash parts', () => {
    const p: Payment[] = [
      { mode: 'Cash', amount: 1_50_000_00 },
      { mode: 'Cash', amount: 50_000_00 },
      { mode: 'Card', amount: 10_000_00 },
    ];
    expect(isCashBlocked(p)).toBe(true);
    const errs = checkBill({ ...base, grand: 2_10_000_00, payments: p, pan: 'ABCDE1234F' });
    expect(errs).toContain(CASH_BLOCK_MSG);
  });
  it('does not block a large non-cash bill', () => {
    const errs = checkBill({ ...base, grand: 5_00_000_00, payments: [{ mode: 'RTGS', amount: 5_00_000_00, referenceNo: 'UTR123' }], pan: 'ABCDE1234F' });
    expect(errs).toEqual([]);
  });
});

describe('other save checks', () => {
  it('PAN required above ₹2 lakh unless Form 60', () => {
    expect(panRequired(2_00_000_00)).toBe(false);
    expect(panRequired(2_00_000_01)).toBe(true);
    const p: Payment[] = [{ mode: 'UPI', amount: 2_50_000_00 }];
    expect(checkBill({ ...base, grand: 2_50_000_00, payments: p }).length).toBe(1);
    expect(checkBill({ ...base, grand: 2_50_000_00, payments: p, form60: true })).toEqual([]);
    expect(checkBill({ ...base, grand: 2_50_000_00, payments: p, pan: 'abcde1234f' })).toEqual([]);
  });
  it('split parts must add up to the total', () => {
    const errs = checkBill({ ...base, grand: 8_662_00, payments: [{ mode: 'UPI', amount: 8_000_00 }, { mode: 'Cash', amount: 600_00 }] });
    expect(errs[0]).toMatch(/add up/);
  });
  it('cheque needs a number', () => {
    const errs = checkBill({ ...base, grand: 100_00, payments: [{ mode: 'Cheque', amount: 100_00 }] });
    expect(errs[0]).toMatch(/cheque number/);
  });
});
