import { describe, expect, it } from 'vitest';
import { BASE_DESCRIPTIONS, highlightParts, searchSuggestions, uniqueDescriptions } from './search';

describe('description search', () => {
  it('"ri" shows all the rings, and only rings', () => {
    const r = searchSuggestions('ri', BASE_DESCRIPTIONS);
    expect(r).toEqual(expect.arrayContaining(['Gold Ring', 'Gold Ladies Ring', 'Gold Gents Ring', 'Gold Couple Rings', 'Silver Ring']));
    expect(r.every((s) => /\bri/i.test(s))).toBe(true);
    expect(r).not.toContain('Gold Earrings');
  });
  it('3+ letters also match inside words, ranked after word starts', () => {
    const r = searchSuggestions('ring', BASE_DESCRIPTIONS);
    expect(r).toContain('Gold Earrings');
    expect(r.indexOf('Gold Ring')).toBeLessThan(r.indexOf('Gold Earrings'));
  });
  it('every word must match, any order, any case', () => {
    expect(searchSuggestions('SIL ri', BASE_DESCRIPTIONS)).toEqual(['Silver Ring']);
    expect(searchSuggestions('ring silver', BASE_DESCRIPTIONS)).toEqual(['Silver Ring']);
  });
  it('nothing typed, or nothing found', () => {
    expect(searchSuggestions('  ', BASE_DESCRIPTIONS)).toEqual([]);
    expect(searchSuggestions('xyz', BASE_DESCRIPTIONS)).toEqual([]);
  });
  it('past descriptions are merged without duplicates', () => {
    expect(uniqueDescriptions(['Gold Ring', 'Silver Payal'], ['gold ring', 'Gold Ring 22kt', ' '])).toEqual(['Gold Ring', 'Silver Payal', 'Gold Ring 22kt']);
  });
  it('highlights the typed part', () => {
    expect(highlightParts('Gold Earrings Ring', 'ri')).toEqual([['Gold Earrings ', false], ['Ri', true], ['ng', false]]);
  });
});
