import { describe, expect, it } from 'vitest';
import { calcBill, calcItem, cashPart, sumPayments, type ItemInput } from './calc';
import { divRoundHalfUp, fmtMoney, fmtRoundOff, parseMg, parsePaise } from './money';

const ring: ItemInput = {
  description: 'Gold Ring 22kt',
  metal: 'GOLD22',
  weightMg: 550,
  rateInput: 139_000_00, // ₹1,39,000 per 10 g
  makingType: 'PCT',
  makingValue: 1000, // 10%
  hsn: '7113',
};

describe('calculation engine', () => {
  it('matches the acceptance test (§9)', () => {
    const b = calcBill([ring]);
    expect(b.items[0].ratePerG).toBe(13_900_00);
    expect(b.items[0].metalValue).toBe(7_645_00);
    expect(b.items[0].makingAmount).toBe(764_50);
    expect(b.taxable).toBe(8_409_50);
    expect(b.cgst).toBe(126_14);
    expect(b.sgst).toBe(126_14);
    expect(b.roundOff).toBe(22);
    expect(b.grand).toBe(8_662_00);
    expect(b.cgstRate).toBe(150);
  });

  it('making as ₹ per gram', () => {
    const it_ = calcItem({ ...ring, weightMg: 5_125, makingType: 'PER_G', makingValue: 500_00, hsn: '7113' });
    expect(it_.metalValue).toBe(71_237_50); // 5.125 × 13,900
    expect(it_.makingAmount).toBe(2_562_50); // 5.125 × 500
  });

  it('making as fixed rupees', () => {
    const it_ = calcItem({ ...ring, makingType: 'FIXED', makingValue: 350_00, hsn: '7113' });
    expect(it_.makingAmount).toBe(350_00);
  });

  it('percentage making with fractional percent rounds half up', () => {
    // 7,645.00 × 12.5% = 955.625 -> 955.63
    expect(calcItem({ ...ring, makingValue: 1250, hsn: '7113' }).makingAmount).toBe(955_63);
  });

  it('silver is priced per kg', () => {
    const s = calcItem({ description: 'Silver Payal', metal: 'SILVER', weightMg: 45_230, rateInput: 95_000_00, makingType: 'PER_G', makingValue: 15_00, hsn: '7113' });
    expect(s.ratePerG).toBe(95_00);
    expect(s.metalValue).toBe(4_296_85); // 45.230 × 95
    expect(s.makingAmount).toBe(678_45); // 45.230 × 15
  });

  it('silver rate that is not a whole paise per gram stays exact', () => {
    // ₹95,123/kg = ₹95.123/g; 10.000 g -> ₹951.23
    const s = calcItem({ description: 'x', metal: 'SILVER', weightMg: 10_000, rateInput: 95_123_00, makingType: 'FIXED', makingValue: 0, hsn: '7113' });
    expect(s.metalValue).toBe(951_23);
  });

  it('gold 18K uses its own rate per 10 g', () => {
    const g = calcItem({ ...ring, metal: 'GOLD18', rateInput: 1_05_000_00, weightMg: 2_000 });
    expect(g.metalValue).toBe(21_000_00);
  });

  it('multi-item bill sums before tax and rounds the total', () => {
    const b = calcBill([
      ring,
      { description: 'Gold Chain', metal: 'GOLD22', weightMg: 10_000, rateInput: 139_000_00, makingType: 'PER_G', makingValue: 400_00, hsn: '7113' },
      { description: 'Silver Payal', metal: 'SILVER', weightMg: 45_230, rateInput: 95_000_00, makingType: 'FIXED', makingValue: 200_00, hsn: '7113' },
    ]);
    // 8,409.50 + (1,39,000 + 4,000) + (4,296.85 + 200) = 1,55,906.35
    expect(b.taxable).toBe(1_55_906_35);
    expect(b.cgst).toBe(2_338_60); // 2338.595 -> 2338.60
    expect(b.sgst).toBe(2_338_60);
    expect(b.gross).toBe(1_60_583_55);
    expect(b.grand).toBe(1_60_584_00);
    expect(b.roundOff).toBe(45);
    expect(b.totalWeightMg).toBe(55_780);
  });

  it('negative round off', () => {
    // ₹9,994 per 10 g × 1 g
    const b = calcBill([{ ...ring, makingType: 'FIXED', makingValue: 0, weightMg: 1000, rateInput: 9_994_00 }]);
    // metal 999.40, tax 14.99 each -> 1029.38 -> 1029, round off -0.38
    expect(b.grand).toBe(1_029_00);
    expect(b.roundOff).toBe(-38);
    expect(fmtRoundOff(b.roundOff)).toBe('(-)0.38');
  });

  it('tax is worked out per HSN and the bill totals match the HSN table', () => {
    const b = calcBill([
      { ...ring, makingType: 'FIXED', makingValue: 0, weightMg: 1000, rateInput: 1_000_50 }, // 100.05, HSN 7113
      { ...ring, makingType: 'FIXED', makingValue: 0, weightMg: 1000, rateInput: 1_000_50, hsn: '7114' }, // 100.05
      { ...ring, makingType: 'FIXED', makingValue: 0, weightMg: 1000, rateInput: 1_000_50 }, // 100.05, HSN 7113 again
    ]);
    expect(b.hsnSummary).toEqual([
      { hsn: '7113', taxable: 200_10, cgst: 3_00, sgst: 3_00 }, // 200.10 × 1.5% = 3.0015
      { hsn: '7114', taxable: 100_05, cgst: 1_50, sgst: 1_50 }, // 100.05 × 1.5% = 1.50075
    ]);
    expect(b.taxable).toBe(300_15);
    expect(b.cgst).toBe(4_50);
    expect(b.sgst).toBe(4_50);
    expect(b.grand).toBe(309_00); // 309.15 -> 309
  });

  it('split payment sum and cash part', () => {
    const p = [
      { mode: 'Cash' as const, amount: 50_000_00 },
      { mode: 'UPI' as const, amount: 1_10_584_00 },
      { mode: 'Cash' as const, amount: 1_000_00 },
    ];
    expect(sumPayments(p)).toBe(1_61_584_00);
    expect(cashPart(p)).toBe(51_000_00);
  });
});

describe('money helpers', () => {
  it('parses without floats', () => {
    expect(parsePaise('1,39,000')).toBe(139_000_00);
    expect(parsePaise('0.1')).toBe(10);
    expect(parsePaise('12.345')).toBeNull();
    expect(parsePaise('abc')).toBeNull();
    expect(parseMg('0.55')).toBe(550);
    expect(parseMg('.5')).toBe(500);
    expect(parseMg('10')).toBe(10_000);
  });
  it('formats in Indian grouping', () => {
    expect(fmtMoney(8_662_00)).toBe('8,662.00');
    expect(fmtMoney(1_23_45_678_90)).toBe('1,23,45,678.90');
    expect(fmtMoney(5)).toBe('0.05');
  });
  it('rounds half up', () => {
    expect(divRoundHalfUp(5n, 10n)).toBe(1n);
    expect(divRoundHalfUp(4n, 10n)).toBe(0n);
    expect(divRoundHalfUp(15n, 10n)).toBe(2n);
  });
});
