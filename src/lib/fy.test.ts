import { describe, expect, it } from 'vitest';
import { financialYear, fmtBillDate, formatInvoiceNo, invoiceFileStem, monthFolder, nextSeq } from './fy';

describe('financial year and invoice numbers', () => {
  it('FY runs April to March', () => {
    expect(financialYear('2026-10-10')).toBe('26-27');
    expect(financialYear('2027-03-31')).toBe('26-27');
    expect(financialYear('2027-04-01')).toBe('27-28');
    expect(financialYear('2099-12-31')).toBe('99-00');
  });

  it('counter resets on the first bill on or after 1 April', () => {
    const last = { fy: '26-27', seq: 245 };
    expect(nextSeq('2027-03-31', last)).toBe(246);
    expect(formatInvoiceNo('SR', financialYear('2027-03-31'), nextSeq('2027-03-31', last))).toBe('SR/26-27/246');
    expect(nextSeq('2027-04-01', last)).toBe(1);
    expect(formatInvoiceNo('SR', financialYear('2027-04-01'), nextSeq('2027-04-01', last))).toBe('SR/27-28/001');
    // first bill made weeks after 1 April still resets
    expect(nextSeq('2027-05-20', last)).toBe(1);
  });

  it('first bill ever starts at 1 (or the configured start)', () => {
    expect(nextSeq('2026-10-10', null)).toBe(1);
    expect(nextSeq('2026-10-10', null, 301)).toBe(301);
  });

  it('pads to 3 digits and grows past 999', () => {
    expect(formatInvoiceNo('SR', '26-27', 7)).toBe('SR/26-27/007');
    expect(formatInvoiceNo('SR', '26-27', 999)).toBe('SR/26-27/999');
    expect(formatInvoiceNo('SR', '26-27', 1000)).toBe('SR/26-27/1000');
  });

  it('dates and file names', () => {
    expect(fmtBillDate('2026-10-10')).toBe('10-Oct-26');
    expect(monthFolder('2026-10-10')).toBe('10-Oct');
    expect(invoiceFileStem('SR/26-27/001')).toBe('SR-26-27-001');
  });
});
