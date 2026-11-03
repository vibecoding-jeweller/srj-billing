// LUXMÉ catalogue: the Apps Script's header parsing (loaded straight from scripts/luxme-catalogue.gs),
// the app's checks, and keeping the cached copy when a sync fails.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { catalogueDescription, fmtSynced, looksLikeSku, normaliseCatalogue, syncCatalogue, type CatalogueItem, type SyncDeps } from './catalogue';

type Tab = { name: string; values: unknown[][] };
const gs: { parseLuxmeTab: (n: string, v: unknown[][]) => Record<string, unknown>[]; buildLuxmeCatalogue: (t: Tab[]) => Record<string, unknown>[] } = (() => {
  const ctx: Record<string, unknown> = {};
  runInNewContext(readFileSync(join(__dirname, '../../scripts/luxme-catalogue.gs'), 'utf8'), ctx);
  return ctx as never;
})();

// Header rows in the shapes the sheet has: columns in a different order on each tab, repeated
// PricingMode / PurchasePrice, blank headers, a title row above the header, and non-stock tabs.
// TODO: swap in the exact header rows copied from the LUXMÉ Inventory sheet.
const TABS: Tab[] = [
  {
    name: 'Rings',
    values: [
      ['SKU', 'Name', 'Weight', 'CP', 'PricingMode', 'ShopSP', 'OnlineSP', 'Qty', 'PricingMode', 'PurchasePrice', '', 'PurchasePrice'],
      ['RNG0005', 'Floral Ring', 3.5, 610, 'Markup', 1499, 1799, 2, 'X', 600, 'note', 999],
      ['rng0006', 'Band Ring', '', 420, 'Markup', '₹1,099.00', 1299, 1, '', '', '', ''],
      ['', '', '', '', '', '', '', '', '', '', '', ''], // blank row
      ['RNG0007', 'No price yet', 2, 300, '', '', 999, 1, '', '', '', ''],
    ],
  },
  {
    name: 'Payal',
    values: [
      ['Name', '', 'Qty', 'OnlineSP', 'Shop SP', 'CP', 'Weight (g)', 'sku'],
      ['Ghungroo Payal', 'x', 4, 3299, 2999, 1500, '18.25 g', 'PYL0001'],
    ],
  },
  {
    name: 'ToeRings',
    values: [
      ['LUXMÉ toe rings — updated 28 Oct', '', '', ''],
      ['ShopSP', 'SKU', 'Name', 'Qty'],
      [499, 'TR0001', 'Plain Bichhiya', 6],
    ],
  },
  { name: 'Others', values: [['SKU', 'Name', 'ShopSP'], ['RNG0005', 'Duplicate of a ring', 1]] },
  { name: 'Rings_Results', values: [['SKU', 'Score', 'CP'], ['RNG0005', 9, 610]] },
  { name: 'Meta', values: [['Key', 'Value'], ['version', 3]] },
];

describe('Apps Script: columns by header name', () => {
  const items = gs.buildLuxmeCatalogue(TABS);
  it('reads every stock tab, whatever its column order', () => {
    expect(items.map((i) => i.sku)).toEqual(['RNG0005', 'RNG0006', 'PYL0001', 'TR0001']);
  });
  it('takes ShopSP (never OnlineSP or CP), the first of repeated headers, and the tab as category', () => {
    expect(items[0]).toEqual({ sku: 'RNG0005', name: 'Floral Ring', category: 'Rings', shopPrice: 1499, weight: 3.5, qty: 2 });
    expect(items[1]).toEqual({ sku: 'RNG0006', name: 'Band Ring', category: 'Rings', shopPrice: 1099, weight: null, qty: 1 });
    expect(items[2]).toEqual({ sku: 'PYL0001', name: 'Ghungroo Payal', category: 'Payal', shopPrice: 2999, weight: 18.25, qty: 4 });
    expect(items[3]).toEqual({ sku: 'TR0001', name: 'Plain Bichhiya', category: 'ToeRings', shopPrice: 499, weight: null, qty: 6 });
  });
  it('never sends cost columns', () => {
    expect(JSON.stringify(items)).not.toMatch(/610|420|1500|600|CP|Purchase|Online/);
  });
  it('skips tabs without SKU and ShopSP, rows without a price, and a SKU seen on an earlier tab', () => {
    expect(gs.parseLuxmeTab('Meta', TABS[5].values)).toEqual([]);
    expect(gs.parseLuxmeTab('Rings_Results', TABS[4].values)).toEqual([]);
    expect(items.some((i) => i.sku === 'RNG0007')).toBe(false);
    expect(items.find((i) => i.sku === 'RNG0005')?.name).toBe('Floral Ring');
  });
});

describe('app: catalogue data', () => {
  it('turns rupees into paise and grams into mg', () => {
    const rows = normaliseCatalogue({ ok: true, items: gs.buildLuxmeCatalogue(TABS) });
    expect(rows[0]).toEqual({ sku: 'RNG0005', name: 'Floral Ring', category: 'Rings', shop_price: 1_499_00, weight_mg: 3500, qty: 2 });
    expect(rows[2].weight_mg).toBe(18_250);
  });
  it('rejects things that are not catalogue data', () => {
    expect(() => normaliseCatalogue(null)).toThrow();
    expect(() => normaliseCatalogue({ ok: false, error: 'boom' })).toThrow(/boom/);
    expect(() => normaliseCatalogue({ html: '<html>' })).toThrow();
  });
  it('helpers', () => {
    expect(looksLikeSku('RNG0005')).toBe(true);
    expect(looksLikeSku(' rng0005 ')).toBe(true);
    expect(looksLikeSku('Gold Ring')).toBe(false);
    expect(catalogueDescription({ name: 'Floral Ring', category: 'Rings' })).toBe('Silver 925 Floral Ring');
    expect(catalogueDescription({ name: '', category: 'Rings' })).toBe('Silver 925 Ring');
    expect(catalogueDescription({ name: 'Silver Payal', category: 'Payal' })).toBe('Silver 925 Payal');
    expect(fmtSynced('2026-10-30 18:10')).toBe('30 Oct, 6:10 pm');
    expect(fmtSynced(null)).toBe('never');
  });
});

describe('sync keeps the cache when it fails', () => {
  const setup = (fetchText: SyncDeps['fetchText']) => {
    let cache: CatalogueItem[] = [{ sku: 'OLD1', name: 'Cached', category: 'Rings', shop_price: 100_00, weight_mg: null, qty: 1 }];
    let syncedAt: string | null = '2026-10-30 18:10';
    const deps: SyncDeps = {
      fetchText,
      replace: async (items, at) => {
        if (!items.length) throw new Error('empty');
        cache = items;
        syncedAt = at;
        return items.length;
      },
      lastSynced: async () => syncedAt,
      now: () => '2026-11-02 10:00',
    };
    return { deps, cache: () => cache };
  };

  it('offline: keeps the old copy and says when it was made', async () => {
    const s = setup(async () => {
      throw new Error('Could not reach the catalogue (offline?)');
    });
    const r = await syncCatalogue('https://script.google.com/macros/s/x/exec', s.deps);
    expect(r).toEqual({ ok: false, error: 'Could not reach the catalogue (offline?)', syncedAt: '2026-10-30 18:10' });
    expect(s.cache()[0].sku).toBe('OLD1');
  });
  it('a sign-in page instead of JSON (not deployed for Anyone): keeps the old copy', async () => {
    const s = setup(async () => '<!doctype html><title>Sign in</title>');
    const r = await syncCatalogue('https://x', s.deps);
    expect(r.ok).toBe(false);
    expect(s.cache()[0].sku).toBe('OLD1');
  });
  it('an empty catalogue: keeps the old copy', async () => {
    const s = setup(async () => JSON.stringify({ ok: true, items: [] }));
    expect((await syncCatalogue('https://x', s.deps)).ok).toBe(false);
    expect(s.cache()[0].sku).toBe('OLD1');
  });
  it('success: replaces it', async () => {
    const s = setup(async () => JSON.stringify({ ok: true, items: gs.buildLuxmeCatalogue(TABS) }));
    expect(await syncCatalogue('https://x', s.deps)).toEqual({ ok: true, count: 4, syncedAt: '2026-11-02 10:00' });
    expect(s.cache().map((c) => c.sku)).toEqual(['RNG0005', 'RNG0006', 'PYL0001', 'TR0001']);
  });
});
