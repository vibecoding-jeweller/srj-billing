/** Common goods, offered while typing a description. Past descriptions are added at runtime. */
export const BASE_DESCRIPTIONS = [
  'Gold Ring', 'Gold Ladies Ring', 'Gold Gents Ring', 'Gold Couple Rings', 'Gold Chain', 'Gold Earrings', 'Gold Tops',
  'Gold Jhumki', 'Gold Bali', 'Gold Bangles', 'Gold Kada', 'Gold Bracelet', 'Gold Pendant', 'Gold Pendant Set',
  'Gold Mangalsutra', 'Gold Necklace', 'Gold Necklace Set', 'Gold Nose Pin', 'Gold Nath', 'Gold Locket',
  'Gold Maang Tikka', 'Gold Coin',
  'Silver Payal', 'Silver Bichhiya', 'Silver Chain', 'Silver Ring', 'Silver Kada', 'Silver Bracelet', 'Silver Coin',
  'Silver Glass', 'Silver Thali', 'Silver Katori', 'Silver Spoon', 'Silver Idol', 'Silver Kamarbandh',
];

/** Case-insensitive de-duplication, keeping the first spelling seen. */
export function uniqueDescriptions(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of lists.flat()) {
    const t = s.trim();
    const k = t.toLowerCase();
    if (t && !seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}

/**
 * Keyword search for the description box.
 * Every typed word must match: the start of a word in the suggestion ("ri" → "Gold Ring"),
 * or, for 3+ letters, anywhere inside it ("ring" → "Gold Earrings"). Start-of-word matches rank first.
 */
export function searchSuggestions(query: string, list: string[], limit = 15): string[] {
  const q = query.trim().toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const scored: [number, string][] = [];
  for (const s of list) {
    const lower = s.toLowerCase();
    if (lower === q) continue;
    const words = lower.split(/[\s\-/,()]+/);
    let score = 0;
    let ok = true;
    for (const t of tokens) {
      if (words.some((w) => w.startsWith(t))) continue;
      if (t.length >= 3 && lower.includes(t)) {
        score += 1;
        continue;
      }
      ok = false;
      break;
    }
    if (ok) scored.push([score, s]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length || a[1].localeCompare(b[1]));
  return scored.slice(0, limit).map(([, s]) => s);
}

/** Split text into [text, isMatch] parts for highlighting the typed words. */
export function highlightParts(text: string, query: string): [string, boolean][] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const lower = text.toLowerCase();
  const marks = new Array(text.length).fill(false);
  for (const t of tokens) {
    let i = lower.indexOf(t);
    // prefer a match at the start of a word
    for (let j = i; j !== -1; j = lower.indexOf(t, j + 1)) {
      if (j === 0 || /[\s\-/,()]/.test(lower[j - 1])) {
        i = j;
        break;
      }
    }
    if (i >= 0) for (let k = i; k < i + t.length; k++) marks[k] = true;
  }
  const parts: [string, boolean][] = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts[parts.length - 1];
    if (last && last[1] === marks[i]) last[0] += text[i];
    else parts.push([text[i], marks[i]]);
  }
  return parts;
}
