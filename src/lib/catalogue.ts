// LUXMÉ 925 catalogue: the shop price list from the Google Sheet, cached in the database.
// Pure parts here (tested); the Tauri calls are passed in, so the "keep the cache when offline" rule is tested too.

export interface CatalogueItem {
  sku: string;
  name: string;
  category: string;
  /** paise, GST-inclusive */
  shop_price: number;
  weight_mg: number | null;
  qty: number | null;
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').replace(/[₹,\s]/g, '');
  return /^\d*\.?\d+$/.test(s) ? Number(s) : null;
};

/** The web app's JSON → rows for the cache. Prices in rupees → paise, weight in grams → mg. Bad rows are dropped. */
export function normaliseCatalogue(json: unknown): CatalogueItem[] {
  const body = json as { ok?: boolean; error?: string; items?: unknown[] } | null;
  if (!body || typeof body !== 'object') throw new Error('The catalogue address did not return catalogue data. Check the URL in Settings.');
  if (body.ok === false) throw new Error(`The sheet script reported an error: ${body.error ?? 'unknown'}`);
  if (!Array.isArray(body.items)) throw new Error('The catalogue address did not return catalogue data. Check the URL in Settings.');
  const out: CatalogueItem[] = [];
  for (const raw of body.items) {
    const r = raw as Record<string, unknown>;
    const sku = String(r.sku ?? '').trim().toUpperCase();
    const price = num(r.shopPrice);
    if (!sku || !price || price <= 0) continue;
    const w = num(r.weight);
    const q = num(r.qty);
    out.push({
      sku,
      name: String(r.name ?? '').trim(),
      category: String(r.category ?? '').trim(),
      shop_price: Math.round(price * 100),
      weight_mg: w && w > 0 ? Math.round(w * 1000) : null,
      qty: q == null ? null : Math.round(q),
    });
  }
  return out;
}

export interface SyncDeps {
  fetchText: (url: string) => Promise<string>;
  replace: (items: CatalogueItem[], syncedAt: string) => Promise<number>;
  /** when the cached copy was made, or null if there is none */
  lastSynced: () => Promise<string | null>;
  now: () => string;
}

export type SyncResult =
  | { ok: true; count: number; syncedAt: string }
  | { ok: false; error: string; /** the cache still in use */ syncedAt: string | null };

/** Fetch → check → replace the cache. Any failure leaves the last cached copy untouched and in use. */
export async function syncCatalogue(url: string, deps: SyncDeps): Promise<SyncResult> {
  try {
    if (!url.trim()) throw new Error('No catalogue URL set in Settings.');
    const text = await deps.fetchText(url);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('The catalogue address did not return catalogue data (is the web app deployed for "Anyone"?).');
    }
    const items = normaliseCatalogue(json);
    const syncedAt = deps.now();
    const count = await deps.replace(items, syncedAt);
    return { ok: true, count, syncedAt };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), syncedAt: await deps.lastSynced().catch(() => null) };
  }
}

/** A typed description that looks like a catalogue code: RNG0005, PYL-12, TR001. */
export const looksLikeSku = (s: string) => /^[A-Za-z]{2,5}-?\d{2,6}$/.test(s.trim());

/** What the description box becomes for a catalogue piece: "Silver 925 Ring". The code is added on the bill. */
export function catalogueDescription(it: Pick<CatalogueItem, 'name' | 'category'>): string {
  const name = it.name || it.category.replace(/s$/i, '') || 'Item';
  return /\b925\b/.test(name) ? name : `Silver 925 ${name.replace(/^silver\s+/i, '')}`;
}

/** "2026-10-30 18:10" → "30 Oct, 6:10 pm" */
export function fmtSynced(s: string | null): string {
  if (!s) return 'never';
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s);
  if (!m) return s;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const h = Number(m[4]);
  return `${Number(m[3])} ${months[Number(m[2]) - 1]}, ${h % 12 || 12}:${m[5]} ${h < 12 ? 'am' : 'pm'}`;
}
