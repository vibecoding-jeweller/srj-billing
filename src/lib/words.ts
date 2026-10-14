const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below100(n: number): string {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
}

function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? ONES[h] + ' Hundred' : '', r ? below100(r) : ''].filter(Boolean).join(' ');
}

/** Whole number to words in the Indian system (Thousand, Lakh, Crore). 0 -> "Zero". */
export function numberToWordsIndian(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error('expected a non-negative integer');
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  n %= 10_000_000;
  const lakh = Math.floor(n / 100_000);
  n %= 100_000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (crore) parts.push(numberToWordsIndian(crore) + ' Crore');
  if (lakh) parts.push(below100(lakh) + ' Lakh');
  if (thousand) parts.push(below100(thousand) + ' Thousand');
  if (n) parts.push(below1000(n));
  return parts.join(' ');
}

/** "INR Eight Thousand Six Hundred Sixty Two Only" (paise ignored unless non-zero). */
export function amountInWords(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const p = paise % 100;
  let s = 'INR ' + numberToWordsIndian(rupees);
  if (p) s += ' and ' + numberToWordsIndian(p) + ' paise';
  return s + ' Only';
}
