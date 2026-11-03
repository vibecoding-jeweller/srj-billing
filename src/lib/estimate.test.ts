import { describe, expect, it } from 'vitest';
import { calcEstimate, metalForDescription, type ItemInput } from './calc';
import { fmtRoundOff } from './money';
import { fillFromCatalogue, parseRows } from '../components/ItemsEditor';

// The shop's handwritten estimate of 08-Oct-26
const payal: ItemInput = { description: 'Silver Payal', metal: 'SILVER', weightMg: 147_000, rateInput: 2_15_000_00, makingType: 'FIXED', makingValue: 300_00, hsn: '' };
const ladiesRing: ItemInput = { description: 'LR', metal: 'GOLD22', weightMg: 3_620, rateInput: 1_38_000_00, makingType: 'PCT', makingValue: 900, hsn: '' };

describe('estimate (no GST)', () => {
  it('matches the handwritten estimate', () => {
    const e = calcEstimate([payal, ladiesRing]);
    expect(e.items[0].metalValue + e.items[0].makingAmount).toBe(31_905_00); // 147 g × ₹215 + ₹300
    expect(e.items[1].metalValue).toBe(49_956_00); // 3.620 g × ₹13,800
    expect(e.items[1].makingAmount).toBe(4_496_04); // 9%
    expect(e.subtotal).toBe(86_357_04);
    expect(e.grand).toBe(86_357_00);
    expect(fmtRoundOff(e.roundOff)).toBe('(-)0.04');
    expect(e.totalWeightMg).toBe(150_620);
  });

  it('rounds the total half up to the rupee', () => {
    const e = calcEstimate([{ ...payal, weightMg: 1_000, makingValue: 50 }]); // 215.00 + 0.50
    expect(e.grand).toBe(216_00);
    expect(e.roundOff).toBe(50);
  });

  it('old jewellery exchange is taken off before rounding', () => {
    const e = calcEstimate([payal, ladiesRing], [5_000_00, 1_250_50]);
    expect(e.subtotal).toBe(86_357_04);
    expect(e.exchangeTotal).toBe(6_250_50);
    expect(e.grand).toBe(80_107_00); // 80,106.54 → 80,107
    expect(e.roundOff).toBe(46);
  });

  it('empty estimate is zero', () => {
    expect(calcEstimate([]).grand).toBe(0);
  });
});

describe('metal from description', () => {
  it('picks silver, 18K and gold', () => {
    expect(metalForDescription('Silver Payal', 'GOLD22')).toBe('SILVER');
    expect(metalForDescription('Gold Ring 18kt', 'GOLD22')).toBe('GOLD18');
    expect(metalForDescription('Gold Chain', 'SILVER')).toBe('GOLD22');
    expect(metalForDescription('Gold Chain', 'GOLD18')).toBe('GOLD18'); // already gold: keep
    expect(metalForDescription('LR', 'GOLD18')).toBe('GOLD18');
  });
});

describe('item row checks', () => {
  const row = { key: 1, desc: 'Silver Payal', metal: 'SILVER' as const, weight: '147', rate: '215000', makingType: 'PCT' as const, making: '300', hsn: '', pricing: 'WEIGHT' as const, sku: '', qty: '1', price: '' };
  it('flags a making % above 100 (rupees typed with % selected)', () => {
    const r = parseRows([row], null, '7113');
    expect(r.itemErrors[0]).toMatch(/300% looks wrong/);
    expect(r.validItems).toHaveLength(0);
  });
  it('accepts the same 300 as fixed rupees', () => {
    const r = parseRows([{ ...row, makingType: 'FIXED' }], null, '7113');
    expect(r.itemErrors).toEqual([]);
    expect(r.parsed[0].calc!.makingAmount).toBe(300_00);
  });
  it('fixed-price rows: qty × price, weight optional, price required', () => {
    const fp = { ...row, desc: 'Silver 925 Ring', metal: 'SILVER925' as const, pricing: 'FIXED_PRICE' as const, sku: 'rng0005', weight: '', qty: '2', price: '1,499' };
    const ok = parseRows([fp], null, '7113');
    expect(ok.itemErrors).toEqual([]);
    expect(ok.validItems[0]).toMatchObject({ pricing: 'FIXED_PRICE', sku: 'RNG0005', qty: 2, unitPrice: 1_499_00, weightMg: 0, hsn: '7113' });
    expect(ok.parsed[0].calc!.metalValue).toBe(2_998_00);
    expect(parseRows([{ ...fp, price: '' }], null, '7113').itemErrors[0]).toMatch(/enter the price/);
    expect(parseRows([{ ...fp, qty: '0' }], null, '7113').itemErrors[0]).toMatch(/quantity/);
    expect(parseRows([{ ...fp, weight: 'abc' }], null, '7113').itemErrors[0]).toMatch(/weight/);
    // a manual entry (no SKU, not in any catalogue) is never blocked
    expect(parseRows([{ ...fp, sku: '' }], null, '7113').itemErrors).toEqual([]);
  });
  it('a catalogue code fills the row', () => {
    const patch = fillFromCatalogue({ sku: 'RNG0005', name: 'Floral Ring', category: 'Rings', shop_price: 1_499_00, weight_mg: 3500, qty: 2 });
    expect(patch).toMatchObject({ desc: 'Silver 925 Floral Ring', sku: 'RNG0005', metal: 'SILVER925', pricing: 'FIXED_PRICE', price: '1499', qty: '1', weight: '3.500' });
  });
});
