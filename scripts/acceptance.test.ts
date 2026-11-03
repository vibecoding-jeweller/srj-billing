// Acceptance test (§9): builds the sample bill and writes out/acceptance_{customer,store}.pdf
import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBillDoc, buildEstimateDoc, DEFAULT_SETTINGS, shopSnapshot } from '../src/lib/bill';
import { renderEstimatePdf } from '../src/lib/estimatePdf';
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

    // FIXES-PLAN 4a: Shruti's ring + one LUXMÉ RNG0005 at ₹1,499 incl. GST = ₹10,161, round off unchanged
    const rng0005 = { description: 'Silver 925 Ring', metal: 'SILVER925' as const, weightMg: 0, rateInput: 0, makingType: 'FIXED' as const, makingValue: 0, hsn: '7113', pricing: 'FIXED_PRICE' as const, sku: 'RNG0005', qty: 1, unitPrice: 1_499_00 };
    const with925 = buildBillDoc({ ...base, items: [...base.items, rng0005], payments: [{ mode: 'UPI', amount: 10_161_00, referenceNo: '' }] });
    expect(with925.grand).toBe(10_161_00);
    expect(with925.items[1].description).toBe('Silver 925 Ring (RNG0005)');
    writeFileSync(join(root, 'out', 'with_925_customer.pdf'), await renderBillPdf(with925, 'customer', assets));
    const only925 = buildBillDoc({ ...base, items: [rng0005, { ...rng0005, sku: 'PYL0001', description: 'Silver 925 Payal', qty: 2, unitPrice: 2_999_00, weightMg: 18_250 }], payments: [] });
    expect(only925.roundOff).toBe(0);
    expect(only925.grand).toBe(1_499_00 + 2 * 2_999_00);
    writeFileSync(join(root, 'out', 'only_925_customer.pdf'), await renderBillPdf(only925, 'customer', assets));
  });

  it('produces the sample estimate (handwritten pad, 08-Oct-26)', async () => {
    const est = buildEstimateDoc({
      estimateNo: 'EST/26-27/001',
      date: '2026-10-08',
      shop: shopSnapshot(DEFAULT_SETTINGS, ''),
      customer: { name: 'Lakhmichand Sharma', mobile: '9027515504', otherMobile: '9720275804' },
      items: [
        { description: 'Silver Payal', metal: 'SILVER', weightMg: 147_000, rateInput: 2_15_000_00, makingType: 'FIXED', makingValue: 300_00, hsn: '' },
        { description: 'Ladies Ring', metal: 'GOLD22', weightMg: 3_620, rateInput: 1_38_000_00, makingType: 'PCT', makingValue: 900, hsn: '' },
      ],
      paymentMode: 'Cash',
    });
    expect(est.grand).toBe(86_357_00);
    expect(est.items.map((i) => i.description)).toEqual(['Silver Payal', 'Ladies Ring 22kt']);
    const assets: PdfAssets = {
      regular: font('LiberationSans-Regular.ttf'),
      bold: font('LiberationSans-Bold.ttf'),
      boldItalic: font('LiberationSans-BoldItalic.ttf'),
      italic: font('LiberationSans-Italic.ttf'),
      rupee: font('DejaVuSans-Bold.ttf'),
      logo: new Uint8Array(readFileSync(join(root, 'src/assets/logo.png'))),
    };
    mkdirSync(join(root, 'out'), { recursive: true });
    writeFileSync(join(root, 'out', 'sample_estimate.pdf'), await renderEstimatePdf(est, assets));
    const est925 = buildEstimateDoc({
      ...{ estimateNo: 'EST/26-27/003', date: '2026-11-02', shop: shopSnapshot(DEFAULT_SETTINGS, ''), paymentMode: 'Cash' as const },
      customer: { name: 'Pooja Verma', mobile: '', otherMobile: '' },
      items: [
        { description: 'Silver 925 Ring', metal: 'SILVER925', weightMg: 3_500, rateInput: 0, makingType: 'FIXED', makingValue: 0, hsn: '', pricing: 'FIXED_PRICE', sku: 'RNG0005', qty: 2, unitPrice: 1_499_00 },
        { description: 'Silver Payal', metal: 'SILVER', weightMg: 147_000, rateInput: 2_15_000_00, makingType: 'FIXED', makingValue: 300_00, hsn: '' },
      ],
    });
    expect(est925.items[0].metalValue).toBe(2_998_00);
    writeFileSync(join(root, 'out', 'estimate_925.pdf'), await renderEstimatePdf(est925, assets));

    // Same purchase, customer gives old silver worth ₹5,000 and pays the rest in cash
    const ex = buildEstimateDoc({
      estimateNo: 'EST/26-27/002',
      date: '2026-10-08',
      shop: shopSnapshot(DEFAULT_SETTINGS, ''),
      customer: { name: 'Lakhmichand Sharma', mobile: '9027515504', otherMobile: '' },
      items: [
        { description: 'Silver Payal', metal: 'SILVER', weightMg: 147_000, rateInput: 2_15_000_00, makingType: 'FIXED', makingValue: 300_00, hsn: '' },
        { description: 'Ladies Ring', metal: 'GOLD22', weightMg: 3_620, rateInput: 1_38_000_00, makingType: 'PCT', makingValue: 900, hsn: '' },
      ],
      exchanges: [{ description: 'old payal', amount: 5_000_00 }, { description: '', amount: 0 }],
      paymentMode: 'Cash',
    });
    expect(ex.exchanges).toHaveLength(1); // zero lines dropped
    expect(ex.exchangeTotal).toBe(5_000_00);
    expect(ex.grand).toBe(81_357_00); // 86,357.04 − 5,000 = 81,357.04 → 81,357
    writeFileSync(join(root, 'out', 'sample_estimate_exchange.pdf'), await renderEstimatePdf(ex, assets));
  });
});
