import { describe, expect, it } from 'vitest';
import { amountInWords, numberToWordsIndian } from './words';

describe('Indian number to words', () => {
  it('acceptance test values', () => {
    expect(amountInWords(8_662_00)).toBe('INR Eight Thousand Six Hundred Sixty Two Only');
    expect(amountInWords(252_28)).toBe('INR Two Hundred Fifty Two and Twenty Eight paise Only');
  });
  it('lakh and crore', () => {
    expect(numberToWordsIndian(1_00_000)).toBe('One Lakh');
    expect(numberToWordsIndian(2_50_075)).toBe('Two Lakh Fifty Thousand Seventy Five');
    expect(numberToWordsIndian(1_23_45_678)).toBe('One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight');
    expect(numberToWordsIndian(100_00_00_000)).toBe('One Hundred Crore');
  });
  it('small numbers', () => {
    expect(numberToWordsIndian(0)).toBe('Zero');
    expect(numberToWordsIndian(7)).toBe('Seven');
    expect(numberToWordsIndian(15)).toBe('Fifteen');
    expect(numberToWordsIndian(40)).toBe('Forty');
    expect(numberToWordsIndian(101)).toBe('One Hundred One');
    expect(numberToWordsIndian(1000)).toBe('One Thousand');
  });
  it('paise only', () => {
    expect(amountInWords(5)).toBe('INR Zero and Five paise Only');
    expect(amountInWords(100_00)).toBe('INR One Hundred Only');
  });
});
