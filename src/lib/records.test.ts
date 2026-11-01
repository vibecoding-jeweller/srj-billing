// Old Bills queries, run against a real SQLite database built from the app's own schema (src-tauri/src/db.rs).
import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  daySummaryQuery,
  fmtDayHeader,
  foldSummary,
  groupByDate,
  listRecordsQuery,
  PAGE_SIZE,
  presetRange,
  summaryQuery,
  type RecordFilter,
} from './records';

/** The schema and every migration, taken straight from db.rs so the test can't drift from the app. */
function appSchema(): string {
  const rs = readFileSync(join(__dirname, '../../src-tauri/src/db.rs'), 'utf8');
  const blocks = [...rs.matchAll(/const (SCHEMA|MIGRATION_V\d+): &str = r#"([\s\S]*?)"#;/g)];
  expect(blocks.map((b) => b[1])).toContain('SCHEMA');
  return blocks.map((b) => b[2]).join('\n');
}

// SQLite's numbered parameters (?1, ?2) take an array in node:sqlite via spread
const run = (db: DatabaseSync, q: { sql: string; args: unknown[] }) =>
  db.prepare(q.sql).all(...(q.args as (string | number)[])) as Record<string, unknown>[];

const all: RecordFilter = { q: '', from: '', to: '', kind: '', showCancelled: false };
let db: DatabaseSync;
// what the seed put in, for checking the SQL totals independently
const seeded: { kind: 'BILL' | 'EST'; date: string; total: number; exchange: number; active: boolean; name: string }[] = [];

beforeAll(() => {
  db = new DatabaseSync(':memory:');
  db.exec(appSchema());
  const inv = db.prepare(
    `INSERT INTO invoices (invoice_no, fy, seq, date, buyer_snapshot, shop_snapshot, taxable, cgst, sgst, round_off, grand_total, status, cancel_reason)
     VALUES (?, '26-27', ?, ?, ?, '{}', 0, 0, 0, 0, ?, ?, ?)`,
  );
  const pay = db.prepare(`INSERT INTO payments (invoice_id, mode, amount) VALUES (?, 'UPI', ?)`);
  const est = db.prepare(
    `INSERT INTO estimates (estimate_no, fy, seq, date, customer_snapshot, shop_snapshot, subtotal, round_off, grand_total, payment_mode, exchange_total, status, cancel_reason)
     VALUES (?, '26-27', ?, ?, ?, '{}', 0, 0, ?, 'Cash', ?, ?, ?)`,
  );
  // 400 bills and 250 estimates spread over 40 days of October 2026, every 9th one cancelled
  for (let i = 1; i <= 650; i++) {
    const kind = i <= 400 ? 'BILL' : 'EST';
    const seq = kind === 'BILL' ? i : i - 400;
    const date = `2026-10-${String(1 + (i % 31)).padStart(2, '0')}`;
    const total = (1000 + i * 37) * 100;
    const exchange = kind === 'EST' && i % 5 === 0 ? 500_00 : 0;
    const active = i % 9 !== 0;
    const name = i % 50 === 0 ? 'Shruti Mohan Uniyal' : `Customer ${i}`;
    const snap = JSON.stringify({ name, mobile: `90000${String(i).padStart(5, '0')}`, otherMobile: '' });
    if (kind === 'BILL') {
      const r = inv.run(`SR/26-27/${String(seq).padStart(3, '0')}`, seq, date, snap, total, active ? 'ACTIVE' : 'CANCELLED', active ? null : 'test');
      pay.run(Number(r.lastInsertRowid), total);
    } else {
      est.run(`EST/26-27/${String(seq).padStart(3, '0')}`, seq, date, snap, total, exchange, active ? 'ACTIVE' : 'CANCELLED', active ? null : 'test');
    }
    seeded.push({ kind, date, total, exchange, active, name });
  }
});

const expected = (pred: (s: (typeof seeded)[number]) => boolean) => {
  const act = seeded.filter((s) => s.active && pred(s));
  const sum = (k: string) => act.filter((s) => s.kind === k).reduce((a, s) => a + s.total, 0);
  return {
    bills: { n: act.filter((s) => s.kind === 'BILL').length, total: sum('BILL') },
    estimates: { n: act.filter((s) => s.kind === 'EST').length, total: sum('EST'), exchange: act.reduce((a, s) => a + s.exchange, 0) },
    cancelled: seeded.filter((s) => !s.active && pred(s)).length,
  };
};

describe('Old Bills totals come from SQL over the whole filter', () => {
  it('equals the sum of all 600+ matching records, not just the first page', () => {
    const s = foldSummary(run(db, summaryQuery(all)) as never);
    expect(s).toEqual(expected(() => true));
    expect(s.bills.n + s.estimates.n + s.cancelled).toBe(650);
    // while the list itself only loads one page
    expect(run(db, listRecordsQuery(all)).length).toBe(PAGE_SIZE);
  });

  it('respects date range, type and search, using the same WHERE as the list', () => {
    const f: RecordFilter = { ...all, from: '2026-10-05', to: '2026-10-12', kind: 'EST' };
    const s = foldSummary(run(db, summaryQuery(f)) as never);
    expect(s).toEqual(expected((x) => x.kind === 'EST' && x.date >= '2026-10-05' && x.date <= '2026-10-12'));
    const listed = [];
    for (let off = 0; ; off += PAGE_SIZE) {
      const page = run(db, listRecordsQuery(f, off));
      listed.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    expect(listed.length).toBe(s.estimates.n);
    expect(listed.reduce((a, r) => a + Number(r.grand_total), 0)).toBe(s.estimates.total);

    const byName = foldSummary(run(db, summaryQuery({ ...all, q: 'shruti' })) as never);
    expect(byName).toEqual(expected((x) => x.name === 'Shruti Mohan Uniyal'));
  });

  it('day headers add up to the totals', () => {
    const f: RecordFilter = { ...all, from: '2026-10-01', to: '2026-10-31' };
    const days = run(db, daySummaryQuery(f));
    const s = foldSummary(run(db, summaryQuery(f)) as never);
    expect(days.reduce((a, d) => a + Number(d.n), 0)).toBe(s.bills.n + s.estimates.n);
    expect(days.reduce((a, d) => a + Number(d.total), 0)).toBe(s.bills.total + s.estimates.total);
  });

  it('paging returns every record exactly once, newest first', () => {
    const seen = new Set<string>();
    let prev = '9999-99-99';
    for (let off = 0; ; off += PAGE_SIZE) {
      const page = run(db, listRecordsQuery(all, off));
      for (const r of page) {
        seen.add(`${r.kind}${r.id}`);
        expect(String(r.date) <= prev).toBe(true);
        prev = String(r.date);
      }
      if (page.length < PAGE_SIZE) break;
    }
    expect(seen.size).toBe(seeded.filter((s) => s.active).length);
  });
});

describe('cancelled filter', () => {
  it('hides cancelled records by default', () => {
    const rows = run(db, listRecordsQuery(all, 0, 10_000));
    expect(rows.every((r) => r.status === 'ACTIVE')).toBe(true);
    expect(rows.length).toBe(seeded.filter((s) => s.active).length);
  });
  it('shows them when switched on, but never counts them in sales', () => {
    const f = { ...all, showCancelled: true };
    const rows = run(db, listRecordsQuery(f, 0, 10_000));
    expect(rows.length).toBe(650);
    expect(rows.filter((r) => r.status === 'CANCELLED').length).toBe(seeded.filter((s) => !s.active).length);
    expect(foldSummary(run(db, summaryQuery(f)) as never)).toEqual(foldSummary(run(db, summaryQuery(all)) as never));
  });
});

describe('date presets', () => {
  it('Today is just today', () => {
    expect(presetRange('today', '2026-11-01')).toEqual({ from: '2026-11-01', to: '2026-11-01' });
  });
  it('Yesterday crosses month and year ends', () => {
    expect(presetRange('yesterday', '2026-11-01')).toEqual({ from: '2026-10-31', to: '2026-10-31' });
    expect(presetRange('yesterday', '2027-01-01')).toEqual({ from: '2026-12-31', to: '2026-12-31' });
    expect(presetRange('yesterday', '2028-03-01')).toEqual({ from: '2028-02-29', to: '2028-02-29' });
  });
  it('This week starts on Monday', () => {
    expect(presetRange('week', '2026-11-01')).toEqual({ from: '2026-10-26', to: '2026-11-01' }); // Sunday
    expect(presetRange('week', '2026-10-26')).toEqual({ from: '2026-10-26', to: '2026-10-26' }); // Monday
  });
  it('This month and This FY', () => {
    expect(presetRange('month', '2026-11-17')).toEqual({ from: '2026-11-01', to: '2026-11-17' });
    expect(presetRange('fy', '2026-11-01')).toEqual({ from: '2026-04-01', to: '2026-11-01' });
    expect(presetRange('fy', '2027-03-31')).toEqual({ from: '2026-04-01', to: '2027-03-31' });
    expect(presetRange('fy', '2027-04-01')).toEqual({ from: '2027-04-01', to: '2027-04-01' });
  });
});

describe('grouping and headers', () => {
  it('groups by date keeping order', () => {
    const g = groupByDate([{ date: '2026-11-01', id: 1 }, { date: '2026-11-01', id: 2 }, { date: '2026-10-31', id: 3 }]);
    expect(g.map((x) => [x.date, x.rows.length])).toEqual([['2026-11-01', 2], ['2026-10-31', 1]]);
  });
  it('formats the day header', () => {
    expect(fmtDayHeader('2026-11-01')).toBe('Sun, 1 Nov 2026');
  });
});
