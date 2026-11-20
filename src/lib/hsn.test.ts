import { describe, expect, it } from 'vitest';
import { DEFAULT_HSN_AUTO as D, hsnFor } from './hsn';

describe('HSN auto-fill', () => {
  it('jewellery by metal', () => {
    expect(hsnFor('Gold Ring 22kt', 'GOLD22', D, '7113')).toBe('711319');
    expect(hsnFor('Mangalsutra', 'GOLD18', D, '7113')).toBe('711319');
    expect(hsnFor('Silver Payal', 'SILVER', D, '7113')).toBe('711311');
    expect(hsnFor('Silver 925 Ring (RNG0005)', 'SILVER925', D, '7113')).toBe('711311');
  });
  it('articles and coins, any spelling', () => {
    expect(hsnFor('Chandi Gilaas', 'SILVER', D, '7113')).toBe('711411');
    expect(hsnFor('Silver Plates', 'SILVER', D, '7113')).toBe('711411');
    expect(hsnFor('Ganesh Murti', 'SILVER', D, '7113')).toBe('711411');
    expect(hsnFor('Gold Coin 10g', 'GOLD22', D, '7113')).toBe('7118');
    expect(hsnFor('Silver sikka', 'SILVER', D, '7113')).toBe('7118');
    expect(hsnFor('Pooja Thali', 'GOLD22', D, '7113')).toBe('711419');
  });
  it('does not misfire on look-alike words', () => {
    expect(hsnFor('Bindiya', 'SILVER', D, '7113')).toBe('711311'); // not "diya"
    expect(hsnFor('Platinum band', 'GOLD22', D, '7113')).toBe('711319'); // not "plate"
  });
  it('off, or a bad code, falls back to the default HSN', () => {
    expect(hsnFor('Gold Coin', 'GOLD22', { ...D, enabled: false }, '7113')).toBe('7113');
    expect(hsnFor('Gold Ring', 'GOLD22', { ...D, gold: '' }, '7113')).toBe('7113');
    expect(hsnFor('Gold Ring', 'GOLD22', undefined, '7113')).toBe('7113');
  });
});
