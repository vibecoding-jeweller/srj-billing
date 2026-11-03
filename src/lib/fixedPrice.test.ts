// Step 4a: 925 silver sold at a fixed, GST-inclusive tag price.
import { describe, expect, it } from 'vitest';
import { buildBillDoc, buildEstimateDoc, DEFAULT_SETTINGS, shopSnapshot } from './bill';
import { calcBill, hsnSummary, inclusiveTax, type ItemInput } from './calc';

const shop = shopSnapshot(DEFAULT_SETTINGS, '');
const buyer = { mobile: '', name: '', relation: '' as const, relativeName: '', address: '', state: 'Uttar Pradesh', stateCode: '09', pan: '', form60: false };
const rng0005: ItemInput = {
  description: 'Silver 925 Ring',
  metal: 'SILVER925',
  weightMg: 0,
  rateInput: 0,
  makingType: 'FIXED',
  makingValue: 0,
  hsn: '7113',
  pricing: 'FIXED_PRICE',
  sku: 'rng0005',
  qty: 1,
  unitPrice: 1_499_00,
};
const shrutiRing: ItemInput = { description: 'Gold Ring 22kt', metal: 'GOLD22', weightMg: 550, rateInput: 139_000_00, makingType: 'PCT', makingValue: 1000, hsn: '7113' };
const bill = (items: ItemInput[]) => buildBillDoc({ invoiceNo: 'SR/26-27/001', date: '2026-11-02', shop, buyer, items, payments: [] });

describe('fixed-price items (GST inside the tag price)', () => {
  it('acceptance: 1 × RNG0005 at ₹1,499 incl. GST', () => {
    const d = bill([rng0005]);
    expect(d.cgst + d.sgst).toBe(43_66);
    expect(d.cgst).toBe(21_83);
    expect(d.sgst).toBe(21_83);
    expect(d.taxable).toBe(1_455_34);
    expect(d.grand).toBe(1_499_00);
    expect(d.roundOff).toBe(0);
    const row = d.items[0];
    expect(row.description).toBe('Silver 925 Ring (RNG0005)');
    expect(row.sku).toBe('RNG0005');
    expect(row.metalValue).toBe(1_455_34); // Amount column = taxable value
    expect(row.ratePerG).toBe(1_455_34); // Rate = taxable value of one piece
    expect(row.makingAmount).toBe(0);
  });

  it("acceptance: mixed bill, Shruti's gold ring + RNG0005 = ₹10,161", () => {
    const d = bill([shrutiRing, rng0005]);
    expect(d.grand).toBe(8_662_00 + 1_499_00);
    expect(d.taxable).toBe(8_409_50 + 1_455_34);
    expect(d.cgst).toBe(126_14 + 21_83);
    expect(d.sgst).toBe(126_14 + 21_83);
    // the HSN table still adds up to the bill
    const h = hsnSummary(d.items, shop.gstRate);
    expect(h).toEqual([{ hsn: '7113', taxable: d.taxable, cgst: d.cgst, sgst: d.sgst }]);
    // the gold ring is unchanged
    expect(d.items[0].metalValue).toBe(7_645_00);
    expect(d.items[0].makingAmount).toBe(764_50);
  });

  it('the customer always pays exactly the tag prices, for any prices and quantities', () => {
    for (let p = 99_00; p <= 5_000_00; p += 137_17) {
      for (const qty of [1, 2, 3, 7]) {
        const items: ItemInput[] = [{ ...rng0005, unitPrice: p, qty }, { ...rng0005, sku: 'PYL0001', unitPrice: p + 1_00, qty: 1 }];
        const d = calcBill(items, 300);
        const incl = p * qty + p + 1_00;
        expect(d.taxable + d.cgst + d.sgst).toBe(incl);
        // lines add up to the taxable value, and the halves differ by at most a paisa
        expect(d.items.reduce((s, i) => s + i.metalValue, 0)).toBe(d.taxable);
        expect(Math.abs(d.cgst - d.sgst)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('odd paisa: CGST is rounded half up, SGST takes the rest', () => {
    expect(inclusiveTax(1_00, 300)).toEqual({ taxable: 97, tax: 3, cgst: 2, sgst: 1 });
  });

  it('quantity: 3 × ₹499', () => {
    const d = bill([{ ...rng0005, qty: 3, unitPrice: 499_00 }]);
    expect(d.grand).toBe(1_497_00);
    expect(d.items[0].qty).toBe(3);
    expect(d.items[0].ratePerG * 3).toBeCloseTo(d.items[0].metalValue, -1);
  });

  it('estimates have no GST: line = qty × price', () => {
    const e = buildEstimateDoc({
      estimateNo: 'EST/26-27/001',
      date: '2026-11-02',
      shop,
      customer: { name: '', mobile: '', otherMobile: '' },
      items: [{ ...rng0005, qty: 2 }, shrutiRing],
      paymentMode: 'Cash',
    });
    expect(e.items[0].metalValue).toBe(2_998_00);
    expect(e.subtotal).toBe(2_998_00 + 7_645_00 + 764_50);
    expect(e.items[0].description).toBe('Silver 925 Ring (RNG0005)');
  });
});
