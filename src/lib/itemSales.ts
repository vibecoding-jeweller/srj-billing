// Item Sales report: which goods sold, how many, how much. Pure (no Tauri) so it can be tested against real SQLite.
// The same item is often typed several ways (Bichiya, Bichhiya, बिछिया), so matching goes through a spelling-variant table.

import type { RecordKind } from './records';

// ---------- spelling variants ----------

/** Canonical word → other ways of writing it. Matching is loose already (see `loose`), so only real differences are listed. */
export const VARIANTS: Record<string, string[]> = {
  bichhiya: ['bichiya', 'bichia', 'bichhia', 'bichuwa', 'bichua', 'bichwa', 'बिछिया', 'बिछुआ', 'बिछुवा'],
  payal: ['pajeb', 'pajeeb', 'pazeb', 'paayal', 'payel', 'पायल', 'पाजेब', 'पाज़ेब'],
  jhumka: ['jhumki', 'jhumke', 'jhumkey', 'झुमका', 'झुमकी', 'झुमके'],
  tops: ['top', 'studs', 'stud', 'टॉप्स', 'टॉप'],
  kada: ['kara', 'kade', 'kare', 'कड़ा', 'कडा', 'कड़े'],
  ring: ['anguthi', 'angoothi', 'angothi', 'अंगूठी', 'अँगूठी'],
  chain: ['chen', 'chene', 'चेन'],
  mangalsutra: ['mangalsootra', 'mangalsutr', 'मंगलसूत्र'],
  bangle: ['bangles', 'chudi', 'choodi', 'churi', 'चूड़ी', 'चूड़ियाँ'],
  earring: ['earrings', 'kundal', 'कुंडल'],
  nath: ['nathni', 'नथ', 'नथनी'],
  pendant: ['pendent', 'locket', 'लॉकेट'],
  kamarbandh: ['kamarband', 'tagdi', 'करधनी', 'kardhani'],
  'maang tikka': ['mangtika', 'mang tikka', 'tikka', 'टीका'],
};

/** Words naming the metal. They are dropped from descriptions when comparing; in a search they filter by metal instead. */
const METAL_WORDS: Record<string, 'GOLD' | 'SILVER'> = {
  gold: 'GOLD', sona: 'GOLD', सोना: 'GOLD', gld: 'GOLD',
  silver: 'SILVER', chandi: 'SILVER', chaandi: 'SILVER', चांदी: 'SILVER', चाँदी: 'SILVER', slv: 'SILVER',
};

/**
 * A forgiving spelling key: lowercase, aspirated "h" dropped (chh → c, jh → j), long vowels shortened
 * (ee → i, oo → u), doubled letters collapsed, "iya" → "ia", and a plural "s" removed.
 * So bichiya, bichhiya and bichia all become "bicia".
 */
export function loose(word: string): string {
  let w = word.toLowerCase().normalize('NFC').replace(/़/g, ''); // Devanagari nukta: ड़ → ड
  if (!/^[a-z0-9]+$/.test(w)) return w; // Hindi (or mixed): compare as typed
  if (/^\d+$/.test(w)) return w;
  w = w
    .replace(/([bcdgjkpt])h+/g, '$1')
    .replace(/ee/g, 'i')
    .replace(/oo/g, 'u')
    .replace(/([a-z])\1+/g, '$1')
    .replace(/([aeiou])y([aeiou])/g, '$1$2');
  if (w.length > 3 && w.endsWith('s')) w = w.slice(0, -1);
  return w;
}

const VARIANT_INDEX: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [canon, vs] of Object.entries(VARIANTS)) {
    const key = canon.split(' ').map(loose).join(' ');
    for (const v of [canon, ...vs]) m.set(v.split(' ').map(loose).join(' '), key);
  }
  return m;
})();

const SPLIT = /[\s\-/,()]+/;

/** Words of a description (or search), each turned into its canonical spelling key. Multi-word variants ("mang tikka") join up. */
export function canonWords(text: string): string[] {
  const raw = text.split(SPLIT).filter(Boolean).map(loose);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const two = i + 1 < raw.length ? VARIANT_INDEX.get(`${raw[i]} ${raw[i + 1]}`) : undefined;
    if (two) {
      out.push(...two.split(' '));
      i++;
    } else out.push(...(VARIANT_INDEX.get(raw[i]) ?? raw[i]).split(' '));
  }
  return out;
}

function metalWord(w: string): 'GOLD' | 'SILVER' | undefined {
  return METAL_WORDS[w.toLowerCase()];
}

/** The description without its metal words, as canonical keys: "Silver Bichiya" → ["bicia"]. */
export function itemKey(description: string): string[] {
  return canonWords(description.split(SPLIT).filter((w) => w && !metalWord(w)).join(' '));
}

/**
 * Matcher for the report's search box. Every typed word must match a word of the description,
 * as in the description search (start of word, or anywhere for 3+ letters), after spelling variants.
 * "gold" / "silver" in the search filter by the item's metal instead, so "gold ring" finds a GOLD22 "Ring".
 */
export function itemMatcher(query: string): (description: string, metal: string) => boolean {
  const words = query.trim().split(SPLIT).filter(Boolean);
  const metal = words.map(metalWord).find(Boolean);
  const rest = words.filter((w) => !metalWord(w));
  // each typed word as its canonical key and as typed, so a half-typed "paje" still finds "Pajeb"
  const tokens = rest.map((w) => [...new Set([...canonWords(w), loose(w)])]);
  const hit = (dw: string[], t: string) => dw.some((w) => w.startsWith(t)) || (t.length >= 3 && dw.some((w) => w.includes(t)));
  return (description, m) => {
    if (metal && !m.startsWith(metal)) return false;
    const plain = description.split(SPLIT).filter((w) => w && !metalWord(w));
    const dw = [...itemKey(description), ...plain.map(loose)];
    return tokens.every((alts) => alts.some((t) => hit(dw, t)));
  };
}

// ---------- "Did you mean …?" ----------

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

const metalOf = (d: string) => d.split(SPLIT).map(metalWord).find(Boolean) ?? '';
const restOf = (d: string) => d.toLowerCase().split(SPLIT).filter((w) => w && !metalWord(w)).join(' ');

/**
 * An existing description that the typed one is probably a misspelling of, or null.
 * Same metal word, and either the same item after spelling variants or at most 2 letters different
 * (1 for short names, 0 under 5 letters, so "Bali" never turns into "Bala").
 * `known` is in preference order: a spelling met before the typed one is suggested, so a rare
 * "Silver Bichiya" still points to "Silver Bichhiya"; reaching the typed text itself first means it's fine.
 */
export function didYouMean(typed: string, known: string[]): string | null {
  const t = typed.trim();
  if (t.length < 4) return null;
  const lower = t.toLowerCase();
  const metal = metalOf(t);
  const rest = restOf(t);
  if (!rest) return null;
  const key = itemKey(t).join(' ');
  const limit = rest.length >= 7 ? 2 : rest.length >= 5 ? 1 : 0;
  for (const k of known) {
    if (k.toLowerCase() === lower) return null; // already the preferred spelling
    if (metalOf(k) !== metal) continue;
    if (itemKey(k).join(' ') === key) return k;
    if (editDistance(rest, restOf(k)) <= limit) return k;
  }
  return null;
}

// ---------- queries ----------

export type ItemMetal = '' | 'GOLD22' | 'GOLD18' | 'SILVER' | 'SILVER925';
export const ITEM_METALS: { id: ItemMetal; label: string }[] = [
  { id: '', label: 'All metals' },
  { id: 'GOLD22', label: 'Gold 22K' },
  { id: 'GOLD18', label: 'Gold 18K' },
  { id: 'SILVER', label: 'Silver' },
  { id: 'SILVER925', label: 'Silver 925' },
];

export interface ItemFilter {
  q: string;
  from: string;
  to: string;
  metal: ItemMetal;
  kind: '' | RecordKind;
}

/** Every item line of every ACTIVE bill and estimate. Cancelled records are never counted. Amount is before GST. */
export const ITEMS_SOURCE = `(
  SELECT 'BILL' AS kind, i.id AS doc_id, i.invoice_no AS no, i.date, json_extract(i.buyer_snapshot,'$.name') AS name,
    it.sl, it.description, it.metal, it.weight_mg, it.metal_value + it.making_amount AS amount
  FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id WHERE i.status = 'ACTIVE'
  UNION ALL
  SELECT 'EST', e.id, e.estimate_no, e.date, json_extract(e.customer_snapshot,'$.name'),
    it.sl, it.description, it.metal, it.weight_mg, it.metal_value + it.making_amount
  FROM estimate_items it JOIN estimates e ON e.id = it.estimate_id WHERE e.status = 'ACTIVE'
)`;

function itemsWhere(f: ItemFilter, extra: string[] = [], args: unknown[] = []) {
  const where = [...extra];
  if (f.from) {
    args.push(f.from);
    where.push(`date >= ?${args.length}`);
  }
  if (f.to) {
    args.push(f.to);
    where.push(`date <= ?${args.length}`);
  }
  if (f.metal) {
    args.push(f.metal);
    where.push(`metal = ?${args.length}`);
  }
  if (f.kind) {
    args.push(f.kind);
    where.push(`kind = ?${args.length}`);
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

/** Step 1: the distinct descriptions sold in the range (small), to be matched in JS against the spelling variants. */
export function descriptionsQuery(f: ItemFilter) {
  const w = itemsWhere(f);
  return { sql: `SELECT description, metal FROM ${ITEMS_SOURCE} ${w.sql} GROUP BY description, metal`, args: w.args };
}

/** Step 2: the item lines for the matched descriptions. */
export function linesQuery(f: ItemFilter, descriptions: string[]) {
  const args: unknown[] = [...descriptions];
  const inList = descriptions.map((_, i) => `?${i + 1}`).join(', ') || 'NULL';
  const w = itemsWhere(f, [`description IN (${inList})`], args);
  return {
    sql: `SELECT kind, doc_id, no, date, name, sl, description, metal, weight_mg, amount FROM ${ITEMS_SOURCE} ${w.sql}
          ORDER BY date DESC, no DESC, sl`,
    args: w.args,
  };
}

export interface ItemLine {
  kind: RecordKind;
  doc_id: number;
  no: string;
  date: string;
  name: string;
  sl: number;
  description: string;
  metal: string;
  weight_mg: number;
  amount: number;
}

export interface ItemGroup {
  description: string;
  metals: string[];
  pieces: number;
  weightMg: number;
  amount: number;
  lines: ItemLine[];
}

export interface ItemSalesResult {
  pieces: number;
  weightMg: number;
  amount: number;
  /** distinct bills + estimates */
  records: number;
  groups: ItemGroup[];
}

/** Which (description, metal) pairs match the search. */
export function matchDescriptions(rows: { description: string; metal: string }[], q: string) {
  const m = itemMatcher(q);
  return rows.filter((r) => m(r.description, r.metal));
}

/** Each item line counts as one piece, so a bill with three rings counts three. Grouped by exact description, biggest first. */
export function summarise(lines: ItemLine[], keep: { description: string; metal: string }[]): ItemSalesResult {
  const ok = new Set(keep.map((k) => `${k.metal}\u0000${k.description}`));
  const groups = new Map<string, ItemGroup>();
  const records = new Set<string>();
  const res: ItemSalesResult = { pieces: 0, weightMg: 0, amount: 0, records: 0, groups: [] };
  for (const l of lines) {
    if (!ok.has(`${l.metal}\u0000${l.description}`)) continue;
    const w = Number(l.weight_mg);
    const a = Number(l.amount);
    let g = groups.get(l.description);
    if (!g) groups.set(l.description, (g = { description: l.description, metals: [], pieces: 0, weightMg: 0, amount: 0, lines: [] }));
    if (!g.metals.includes(l.metal)) g.metals.push(l.metal);
    g.pieces++;
    g.weightMg += w;
    g.amount += a;
    g.lines.push(l);
    res.pieces++;
    res.weightMg += w;
    res.amount += a;
    records.add(`${l.kind}${l.doc_id}`);
  }
  res.records = records.size;
  res.groups = [...groups.values()].sort((a, b) => b.pieces - a.pieces || b.amount - a.amount || a.description.localeCompare(b.description));
  return res;
}

// ---------- export ----------

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const money = (p: number) => (p / 100).toFixed(2);
const grams = (mg: number) => (mg / 1000).toFixed(3);

/** CSV that opens straight in Excel (with a BOM so ₹ and Hindi show correctly). One row per item, then a total. */
export function toCsv(r: ItemSalesResult, metalLabel: (m: string) => string): string {
  const rows: (string | number)[][] = [['Date', 'Type', 'Number', 'Customer', 'Description', 'Metal', 'Weight (g)', 'Amount before GST (Rs)']];
  for (const g of r.groups)
    for (const l of g.lines)
      rows.push([l.date, l.kind === 'BILL' ? 'Bill' : 'Estimate', l.no, l.name ?? '', l.description, metalLabel(l.metal), grams(l.weight_mg), money(l.amount)]);
  rows.push([]);
  rows.push(['Total', `${r.records} bills/estimates`, '', '', `${r.pieces} pieces`, '', grams(r.weightMg), money(r.amount)]);
  return '﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
