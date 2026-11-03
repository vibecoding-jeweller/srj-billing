// Item Sales report, run against a real SQLite database built from the app's own schema (src-tauri/src/db.rs).
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  descriptionsQuery,
  didYouMean,
  itemMatcher,
  linesQuery,
  matchDescriptions,
  summarise,
  toCsv,
  type ItemFilter,
  type ItemLine,
} from './itemSales';
import { BASE_DESCRIPTIONS } from './search';

function appSchema(): string {
  const rs = readFileSync(join(__dirname, '../../src-tauri/src/db.rs'), 'utf8');
  return [...rs.matchAll(/const (SCHEMA|MIGRATION_V\d+): &str = r#"([\s\S]*?)"#;/g)].map((b) => b[2]).join('\n');
}

const run = (db: DatabaseSync, q: { sql: string; args: unknown[] }) =>
  db.prepare(q.sql).all(...(q.args as (string | number)[])) as Record<string, unknown>[];

describe('spelling variants', () => {
  const m = itemMatcher('bichiya');
  it.each(['Silver Bichiya', 'Silver Bichhiya', 'silver bichia', 'बिछिया', 'Bichhiya (pair)', 'SILVER BICHUA'])('bichiya finds %s', (d) => {
    expect(m(d, 'SILVER')).toBe(true);
  });
  it('and not other goods', () => {
    expect(m('Silver Payal', 'SILVER')).toBe(false);
    expect(m('Gold Ring', 'GOLD22')).toBe(false);
  });
  it('seeded pairs match both ways', () => {
    for (const [a, b] of [['payal', 'Silver Pajeb'], ['pajeb', 'Silver Payal'], ['jhumki', 'Gold Jhumka'], ['jhumka', 'Gold Jhumki'], ['tops', 'Gold Studs'], ['studs', 'Gold Tops'], ['kada', 'Silver Kara'], ['kara', 'Gold Kada'], ['पायल', 'Silver Payal']])
      expect(itemMatcher(a)(b, b.startsWith('Gold') ? 'GOLD22' : 'SILVER')).toBe(true);
  });
  it('half-typed words still work, and every word must match', () => {
    expect(itemMatcher('bich')('Silver Bichhiya', 'SILVER')).toBe(true);
    expect(itemMatcher('paje')('Silver Pajeb', 'SILVER')).toBe(true);
    expect(itemMatcher('ladies ring')('Gold Ladies Ring', 'GOLD22')).toBe(true);
    expect(itemMatcher('ladies ring')('Gold Gents Ring', 'GOLD22')).toBe(false);
  });
  it('"gold" / "silver" filter by the metal, not the words', () => {
    expect(itemMatcher('gold ring')('Ring', 'GOLD18')).toBe(true);
    expect(itemMatcher('gold ring')('Silver Ring', 'SILVER')).toBe(false);
    expect(itemMatcher('silver')('Bichhiya', 'SILVER')).toBe(true);
    expect(itemMatcher('')('Anything', 'GOLD22')).toBe(true);
  });
});

describe('did you mean', () => {
  const known = ['Silver Bichhiya', 'Silver Payal', 'Gold Ring', 'Gold Ladies Ring', 'Gold Kada', 'Gold Bali'];
  it('suggests the one spelling already in use', () => {
    expect(didYouMean('Silver Bichiya', known)).toBe('Silver Bichhiya');
    expect(didYouMean('silver bichia', known)).toBe('Silver Bichhiya');
    expect(didYouMean('Silver Pajeb', known)).toBe('Silver Payal');
    expect(didYouMean('Gold Ladis Ring', known)).toBe('Gold Ladies Ring');
    expect(didYouMean('Gold Kara', known)).toBe('Gold Kada');
  });
  it('stays quiet when it is already right, too short, or a different metal or item', () => {
    expect(didYouMean('gold ring', known)).toBeNull();
    expect(didYouMean('Rin', known)).toBeNull();
    expect(didYouMean('Silver Ring', known)).toBeNull(); // not "Gold Ring"
    expect(didYouMean('Gold Bala', known)).toBeNull(); // short names need an exact variant
    expect(didYouMean('Gold Necklace Set', known)).toBeNull();
  });
  it('points a rare spelling to the preferred one, but not the other way', () => {
    expect(didYouMean('Silver Bichiya', ['Silver Bichhiya', 'Silver Bichiya'])).toBe('Silver Bichhiya');
    expect(didYouMean('Silver Bichhiya', ['Silver Bichhiya', 'Silver Bichiya'])).toBeNull();
  });
  it('works with the built-in list', () => {
    expect(didYouMean('Silver Bichhia', BASE_DESCRIPTIONS)).toBe('Silver Bichhiya');
    expect(didYouMean('Gold Mangalsootra', BASE_DESCRIPTIONS)).toBe('Gold Mangalsutra');
  });
});

describe('report over a real database', () => {
  let db: DatabaseSync;
  const all: ItemFilter = { q: '', from: '', to: '', metal: '', kind: '' };

  beforeAll(() => {
    db = new DatabaseSync(':memory:');
    db.exec(appSchema());
    let invSeq = 0;
    let estSeq = 0;
    const inv = db.prepare(
      `INSERT INTO invoices (invoice_no, fy, seq, date, buyer_snapshot, shop_snapshot, taxable, cgst, sgst, round_off, grand_total, status)
       VALUES (?, '26-27', ?, ?, ?, '{}', 0, 0, 0, 0, 0, ?)`,
    );
    const invItem = db.prepare(
      `INSERT INTO invoice_items (invoice_id, sl, description, metal, weight_mg, rate_input, rate_per_g, metal_value, making_type, making_value, making_amount, hsn)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, 'FIXED', 0, ?, '7113')`,
    );
    const est = db.prepare(
      `INSERT INTO estimates (estimate_no, fy, seq, date, customer_snapshot, shop_snapshot, subtotal, round_off, grand_total, payment_mode, status)
       VALUES (?, '26-27', ?, ?, ?, '{}', 0, 0, 0, 'Cash', ?)`,
    );
    const estItem = db.prepare(
      `INSERT INTO estimate_items (estimate_id, sl, description, metal, weight_mg, rate_input, rate_per_g, metal_value, making_type, making_value, making_amount)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, 'FIXED', 0, ?)`,
    );
    type It = [description: string, metal: string, weightMg: number, value: number, making: number];
    const bill = (date: string, items: It[], status = 'ACTIVE') => {
      invSeq++;
      const id = Number(inv.run(`SR/26-27/${invSeq}`, invSeq, date, JSON.stringify({ name: `Buyer ${invSeq}` }), status).lastInsertRowid);
      items.forEach((it, i) => invItem.run(id, i + 1, ...it));
    };
    const estimate = (date: string, items: It[], status = 'ACTIVE') => {
      estSeq++;
      const id = Number(est.run(`EST/26-27/${estSeq}`, estSeq, date, JSON.stringify({ name: `Cust ${estSeq}` }), status).lastInsertRowid);
      items.forEach((it, i) => estItem.run(id, i + 1, ...it));
    };

    // one bill with three bichhiya lines under three spellings, plus a payal
    bill('2026-10-01', [
      ['Silver Bichiya', 'SILVER', 10_000, 1000_00, 200_00],
      ['Silver Bichhiya', 'SILVER', 12_000, 1200_00, 200_00],
      ['बिछिया', 'SILVER', 8_000, 800_00, 100_00],
      ['Silver Payal', 'SILVER', 50_000, 5000_00, 500_00],
    ]);
    estimate('2026-10-15', [['Silver Bichia', 'SILVER', 9_000, 900_00, 100_00]]);
    bill('2026-10-31', [['silver bichhiya', 'SILVER', 11_000, 1100_00, 0]]); // last day of range
    bill('2026-11-01', [['Silver Bichhiya', 'SILVER', 99_000, 9900_00, 0]]); // just outside
    bill('2026-09-30', [['Silver Bichhiya', 'SILVER', 99_000, 9900_00, 0]]); // just outside
    bill('2026-10-10', [['Silver Bichhiya', 'SILVER', 77_000, 7700_00, 0]], 'CANCELLED');
    estimate('2026-10-11', [['Silver Bichhiya', 'SILVER', 66_000, 6600_00, 0]], 'CANCELLED');
    bill('2026-10-05', [['Gold Ring', 'GOLD22', 4_000, 24000_00, 2000_00], ['Gold Ring', 'GOLD22', 3_000, 18000_00, 1500_00]]);
  });

  const report = (f: ItemFilter) => {
    const keep = matchDescriptions(run(db, descriptionsQuery(f)) as never, f.q);
    const lines = run(db, linesQuery(f, [...new Set(keep.map((k) => k.description))])) as unknown as ItemLine[];
    return summarise(lines, keep);
  };
  const oct: ItemFilter = { ...all, from: '2026-10-01', to: '2026-10-31' };

  it('counts every spelling, each line as a piece, inclusive dates, no cancelled records', () => {
    const r = report({ ...oct, q: 'bichiya' });
    // 3 lines on the first bill + 1 estimate + 1 bill on the 31st
    expect(r.pieces).toBe(5);
    expect(r.records).toBe(3);
    expect(r.weightMg).toBe(10_000 + 12_000 + 8_000 + 9_000 + 11_000);
    expect(r.amount).toBe(1200_00 + 1400_00 + 900_00 + 1000_00 + 1100_00);
    expect(r.groups.map((g) => g.description).sort()).toEqual(['Silver Bichhiya', 'Silver Bichia', 'Silver Bichiya', 'silver bichhiya', 'बिछिया'].sort());
  });

  it('date range includes both ends', () => {
    expect(report({ ...all, q: 'bichhiya', from: '2026-10-31', to: '2026-10-31' }).pieces).toBe(1);
    expect(report({ ...all, q: 'bichhiya', from: '2026-09-30', to: '2026-11-01' }).pieces).toBe(7);
  });

  it('cancelled bills and estimates are always left out', () => {
    const r = report({ ...all, q: 'bichhiya' });
    expect(r.pieces).toBe(7);
    expect(r.groups.flatMap((g) => g.lines).some((l) => l.weight_mg === 77_000 || l.weight_mg === 66_000)).toBe(false);
  });

  it('a bill with several items counts each one, and only the matching ones', () => {
    const rings = report({ ...oct, q: 'ring' });
    expect(rings.pieces).toBe(2);
    expect(rings.records).toBe(1);
    expect(rings.amount).toBe(24000_00 + 2000_00 + 18000_00 + 1500_00);
    expect(report({ ...oct, q: 'payal' }).pieces).toBe(1);
  });

  it('bills / estimates and metal filters', () => {
    expect(report({ ...oct, q: 'bichiya', kind: 'EST' }).pieces).toBe(1);
    expect(report({ ...oct, q: 'bichiya', kind: 'BILL' }).pieces).toBe(4);
    expect(report({ ...oct, metal: 'GOLD22' }).pieces).toBe(2);
    expect(report({ ...oct, metal: 'SILVER925' }).pieces).toBe(0);
    expect(report(oct).pieces).toBe(8);
  });

  it('exports a CSV that Excel opens', () => {
    const csv = toCsv(report({ ...oct, q: 'ring' }), (m) => m);
    expect(csv.startsWith('﻿Date,Type,')).toBe(true);
    expect(csv).toContain('2026-10-05,Bill,SR/26-27/');
    expect(csv).toContain(',Gold Ring,GOLD22,4.000,26000.00');
    expect(csv.trim().split('\r\n').pop()).toBe('Total,1 bills/estimates,,,2 pieces,,7.000,45500.00,');
  });

  it('925 pieces: exact SKU and sheet category', () => {
    db.exec(`INSERT INTO catalogue (sku, name, category, shop_price, synced_at) VALUES ('RNG0005', 'Floral Ring', 'Rings', 149900, 'x'), ('PYL0001', 'Payal', 'Payal', 299900, 'x')`);
    const id = Number(
      db.prepare(`INSERT INTO invoices (invoice_no, fy, seq, date, buyer_snapshot, shop_snapshot, taxable, cgst, sgst, round_off, grand_total) VALUES ('SR/26-27/925', '26-27', 925, '2026-10-20', '{}', '{}', 0, 0, 0, 0, 0)`).run().lastInsertRowid,
    );
    const ins = db.prepare(
      `INSERT INTO invoice_items (invoice_id, sl, description, metal, weight_mg, rate_input, rate_per_g, metal_value, making_type, making_value, making_amount, hsn, pricing, sku, qty, unit_price)
       VALUES (?, ?, ?, 'SILVER925', 0, 0, 0, ?, 'FIXED', 0, 0, '7113', 'FIXED_PRICE', ?, 1, ?)`,
    );
    ins.run(id, 1, 'Silver 925 Floral Ring (RNG0005)', 145534, 'RNG0005', 149900);
    ins.run(id, 2, 'Silver 925 Floral Ring (RNG0005)', 145534, 'RNG0005', 149900);
    ins.run(id, 3, 'Silver 925 Payal (PYL0001)', 291165, 'PYL0001', 299900);
    expect(report({ ...oct, sku: 'rng0005' }).pieces).toBe(2);
    expect(report({ ...oct, category: 'Payal' }).pieces).toBe(1);
    expect(report({ ...oct, metal: 'SILVER925' }).amount).toBe(145534 * 2 + 291165);
    expect(report({ ...oct, q: 'RNG0005' }).pieces).toBe(2); // the code is part of the printed description too
  });
});
