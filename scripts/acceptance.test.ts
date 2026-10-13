// Acceptance test (§9): builds the sample bill and writes out/acceptance_{customer,store}.pdf
import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBillDoc, DEFAULT_SETTINGS, shopSnapshot } from '../src/lib/bill';
import { renderBillPdf, type PdfAssets } from '../src/lib/pdf';
import { amountInWords } from '../src/lib/words';

const root = join(__dirname, '..');
const font = (f: string) => new Uint8Array(readFileSync(join(root, 'src/assets/fonts', f)));

describe('acceptance test', () => {
  it('produces the sample bill', async () => {
    const base: Parameters<typeof buildBillDoc>[0] = {
      invoiceNo: 'SR/26-27/001',
      date: '2026-10-10',
      shop: shopSnapshot(DEFAULT_SETTINGS, ''),
      buyer: {
        mobile: '7060329291',
        name: 'Shruti Mohan Uniyal',
        relation: 'D/o',
        relativeName: 'Sanjay Mohan Uniyal',
        address: 'House No 132, Jhanda Moholla,\nDehradun, Uttarakhand - 248001',
        state: 'Uttarakhand',
        stateCode: '05',
        pan: '',
        form60: false,
      },
      items: [{ description: 'Gold Ring 22kt', metal: 'GOLD22', weightMg: 550, rateInput: 139_000_00, makingType: 'PCT', makingValue: 1000, hsn: '7113' }],
      payments: [{ mode: 'UPI' as const, amount: 8_662_00, referenceNo: '' }],
    };
    const doc = buildBillDoc(base);
    expect(doc.items[0].metalValue).toBe(7_645_00);
    expect(doc.items[0].makingAmount).toBe(764_50);
    expect(doc.taxable).toBe(8_409_50);
    expect(doc.cgst).toBe(126_14);
    expect(doc.sgst).toBe(126_14);
    expect(doc.roundOff).toBe(22);
    expect(doc.grand).toBe(8_662_00);
    expect(amountInWords(doc.grand)).toBe('INR Eight Thousand Six Hundred Sixty Two Only');
    expect(amountInWords(doc.cgst + doc.sgst)).toBe('INR Two Hundred Fifty Two and Twenty Eight paise Only');
    expect(doc.shop.state).toBe('Uttar Pradesh'); // place of supply
    expect(doc.items[0].hsn).toBe('7113');

    const assets: PdfAssets = {
      regular: font('LiberationSans-Regular.ttf'),
      bold: font('LiberationSans-Bold.ttf'),
      boldItalic: font('LiberationSans-BoldItalic.ttf'),
      italic: font('LiberationSans-Italic.ttf'),
      rupee: font('DejaVuSans-Bold.ttf'),
      logo: new Uint8Array(readFileSync(join(root, 'src/assets/logo.png'))),
    };
    mkdirSync(join(root, 'out'), { recursive: true });
    for (const copy of ['customer', 'store'] as const) {
      const bytes = await renderBillPdf(doc, copy, assets);
      expect(bytes.length).toBeGreaterThan(1000);
      writeFileSync(join(root, 'out', `acceptance_${copy}.pdf`), bytes);
    }

    // Mixed HSN codes: item rows show their own HSN and the tax table gets one row per code.
    const mixed = buildBillDoc({
      ...base,
      items: [
        { description: 'Gold Ring 22kt', metal: 'GOLD22', weightMg: 550, rateInput: 139_000_00, makingType: 'PCT', makingValue: 1000, hsn: '7113' },
        { description: 'Silver Glass', metal: 'SILVER', weightMg: 120_000, rateInput: 95_000_00, makingType: 'PER_G', makingValue: 10_00, hsn: '7114' },
        { description: 'Silver Payal', metal: 'SILVER', weightMg: 45_230, rateInput: 95_000_00, makingType: 'FIXED', makingValue: 300_00, hsn: '' },
      ],
    });
    expect(mixed.items.map((i) => i.hsn)).toEqual(['7113', '7114', '7113']); // blank falls back to the default
    writeFileSync(join(root, 'out', 'mixed_hsn_customer.pdf'), await renderBillPdf(mixed, 'customer', assets));
  });
});
