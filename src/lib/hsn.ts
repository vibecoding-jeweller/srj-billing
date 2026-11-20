// HSN auto-fill: the HSN code for an item from its metal and description.
// Codes (GST 3%): gold jewellery 711319, silver jewellery 711311 (Silver 925 too),
// silver/gold articles such as utensils and idols 711411 / 711419, coins 7118.
import { isSilver, type Metal } from './calc';
import { loose } from './itemSales';

export type HsnMetal = 'ANY' | 'GOLD' | 'SILVER';

export interface HsnRule {
  /** shown in Settings only, e.g. "Silver articles" */
  label: string;
  /** comma-separated words; any spelling close to one of them matches */
  words: string;
  metal: HsnMetal;
  hsn: string;
}

export interface HsnAuto {
  enabled: boolean;
  /** jewellery of gold (22K / 18K) */
  gold: string;
  /** jewellery of silver, Silver 925 included */
  silver: string;
  /** checked in order before the metal codes; the first match wins */
  rules: HsnRule[];
}

const ARTICLE_WORDS =
  'glass, gilas, katori, thali, plate, bowl, spoon, chammach, lota, idol, murti, diya, deepak, kalash, pooja, puja, utensil, bartan, tray, tumbler, frame, chhatra';

export const DEFAULT_HSN_AUTO: HsnAuto = {
  enabled: true,
  gold: '711319',
  silver: '711311',
  rules: [
    { label: 'Coins', words: 'coin, sikka, सिक्का, ginni, guinea', metal: 'ANY', hsn: '7118' },
    { label: 'Silver articles (utensils, idols…)', words: ARTICLE_WORDS, metal: 'SILVER', hsn: '711411' },
    { label: 'Gold articles (utensils, idols…)', words: ARTICLE_WORDS, metal: 'GOLD', hsn: '711419' },
  ],
};

export const HSN_RE = /^\d{4,8}$/;

const tokens = (s: string) => s.split(/[\s\-/,()]+/).filter(Boolean).map(loose);

/** Does the description contain one of the rule's words? "Chandi Gilaas" matches "gilas"; "Plates" matches "plate". */
function matches(descTokens: string[], words: string): boolean {
  const ws = words.split(',').map((w) => w.trim()).filter(Boolean).map(loose);
  return ws.some((w) => descTokens.some((t) => t === w || (w.length >= 4 && t.startsWith(w))));
}

/** HSN for an item; `fallback` (Settings → default HSN) when auto-fill is off. */
export function hsnFor(description: string, metal: Metal, cfg: HsnAuto | undefined, fallback: string): string {
  if (!cfg?.enabled) return fallback;
  const t = tokens(description);
  const silver = isSilver(metal);
  for (const r of cfg.rules) {
    if (r.metal === 'SILVER' && !silver) continue;
    if (r.metal === 'GOLD' && silver) continue;
    if (HSN_RE.test(r.hsn) && matches(t, r.words)) return r.hsn;
  }
  const code = silver ? cfg.silver : cfg.gold;
  return HSN_RE.test(code) ? code : fallback;
}
