// Bill PDF, A4 portrait. Coordinates are ported from reference/make_bill_reference.py
// (PDF points, origin bottom-left — same as ReportLab).
import { PDFDocument, PDFFont, PDFPage, rgb, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { BillDoc, CopyKind } from './types';
import { fmtMoney, fmtMoneyShort, fmtPct, fmtRoundOff, fmtWeight } from './money';
import { fmtBillDate } from './fy';
import { amountInWords } from './words';
import { hsnSummary, makingLabel } from './calc';

export interface PdfAssets {
  regular: Uint8Array;
  bold: Uint8Array;
  boldItalic: Uint8Array;
  italic: Uint8Array;
  /** DejaVu Sans Bold — has the ₹ glyph */
  rupee: Uint8Array;
  /** PNG bytes, or null for no logo */
  logo: Uint8Array | null;
}

const COPY_LABEL: Record<CopyKind, string> = {
  customer: 'ORIGINAL FOR RECIPIENT',
  store: 'DUPLICATE FOR SUPPLIER',
};

export const W = 595.2755905511812;
export const H = 841.8897637795277;
export const L = 40;
export const R = W - 40;
const BLACK = rgb(0, 0, 0);
/** Declaration wrap width; matches the line breaks in the reference bill. */
const DECL_W = 180;

export type F = 'R' | 'B' | 'I' | 'O' | 'D';

export class Pen {
  constructor(private page: PDFPage, private fonts: Record<F, PDFFont>) {}

  width(s: string, f: F, sz: number): number {
    return this.segments(s, f).reduce((w, [seg, ff]) => w + this.fonts[ff].widthOfTextAtSize(seg, sz), 0);
  }

  /** Split text so any ₹ is drawn with the DejaVu font (Liberation lacks it). */
  private segments(s: string, f: F): [string, F][] {
    if (f === 'D' || !s.includes('₹')) return [[s, f]];
    const out: [string, F][] = [];
    for (const part of s.split(/(₹)/)) if (part) out.push([part, part === '₹' ? 'D' : f]);
    return out;
  }

  t(x: number, y: number, s: string, f: F = 'R', sz = 8.5) {
    for (const [seg, ff] of this.segments(s, f)) {
      this.page.drawText(seg, { x, y, size: sz, font: this.fonts[ff], color: BLACK });
      x += this.fonts[ff].widthOfTextAtSize(seg, sz);
    }
  }
  tr(x: number, y: number, s: string, f: F = 'R', sz = 8.5) {
    this.t(x - this.width(s, f, sz), y, s, f, sz);
  }
  tc(x: number, y: number, s: string, f: F = 'R', sz = 8.5) {
    this.t(x - this.width(s, f, sz) / 2, y, s, f, sz);
  }
  /** Draw left-aligned, shrinking the font so the text fits in maxW. */
  tFit(x: number, y: number, s: string, f: F, sz: number, maxW: number) {
    let size = sz;
    while (size > 5 && this.width(s, f, size) > maxW) size -= 0.25;
    this.t(x, y, s, f, size);
  }
  ln(x1: number, y1: number, x2: number, y2: number) {
    this.page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.6, color: BLACK });
  }
  rect(x: number, y: number, w: number, h: number) {
    this.page.drawRectangle({ x, y, width: w, height: h, borderWidth: 0.6, borderColor: BLACK });
  }
  /** Greedy word wrap. Existing line breaks are kept. */
  wrap(text: string, f: F, sz: number, maxW: number): string[] {
    const lines: string[] = [];
    for (const para of text.split(/\r?\n/)) {
      const words = para.trim().split(/\s+/).filter(Boolean);
      if (!words.length) continue;
      let cur = '';
      for (const w of words) {
        const next = cur ? cur + ' ' + w : w;
        if (cur && this.width(next, f, sz) > maxW) {
          lines.push(cur);
          cur = w;
        } else cur = next;
      }
      if (cur) lines.push(cur);
    }
    return lines;
  }
}

/** A new A4 document with the bill fonts embedded. */
export async function newA4(title: string, author: string, date: string, assets: PdfAssets) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(title);
  pdf.setAuthor(author);
  pdf.setCreator('SRJ Billing');
  pdf.setProducer('SRJ Billing');
  const fixed = new Date(date + 'T12:00:00');
  pdf.setCreationDate(fixed);
  pdf.setModificationDate(fixed);
  const fonts: Record<F, PDFFont> = {
    R: await pdf.embedFont(assets.regular, { subset: true }),
    B: await pdf.embedFont(assets.bold, { subset: true }),
    I: await pdf.embedFont(assets.boldItalic, { subset: true }),
    O: await pdf.embedFont(assets.italic, { subset: true }),
    D: await pdf.embedFont(assets.rupee, { subset: true }),
  };
  const page = pdf.addPage([W, H]);
  return { pdf, page, fonts, p: new Pen(page, fonts) };
}

/** Big translucent CANCELLED stamp across the given area (default: the whole page). */
export function stampCancelled(page: PDFPage, fonts: Record<F, PDFFont>, centreY = H / 2, size = 90) {
  page.drawText('CANCELLED', {
    x: W / 2 - size * 2.1,
    y: centreY - size,
    size,
    font: fonts.B,
    color: rgb(0.85, 0.1, 0.1),
    opacity: 0.35,
    rotate: degrees(30),
  });
}

export async function renderBillPdf(doc: BillDoc, copy: CopyKind, assets: PdfAssets): Promise<Uint8Array> {
  const { pdf, page, fonts, p } = await newA4(`Tax Invoice ${doc.invoiceNo}`, doc.shop.name, doc.date, assets);
  const { shop, buyer } = doc;

  // 1. Logo, centred, 60 pt tall
  const lgH = 60;
  if (assets.logo) {
    const img = await pdf.embedPng(assets.logo);
    let w = (lgH * img.width) / img.height;
    let h = lgH;
    if (w > 320) {
      h = (h * 320) / w;
      w = 320;
    }
    page.drawImage(img, { x: W / 2 - w / 2, y: H - 28 - lgH + (lgH - h) / 2, width: w, height: h });
  }
  // 2. Copy label
  p.tr(R, H - 34, COPY_LABEL[copy], 'B', 7.5);
  // 3. Title
  p.tc(W / 2, H - 28 - lgH - 16, 'Tax Invoice', 'B', 11);

  const top = H - 28 - lgH - 20;
  const mid = 300;

  // 4. Header box
  const shopLines: [string, F][] = [
    [shop.name, 'B'],
    ...shop.addressLines.filter((s) => s.trim()).map((s): [string, F] => [s, 'R']),
    [`GSTIN/UIN: ${shop.gstin}`, 'R'],
    [`State Name :  ${shop.state}, Code : ${shop.stateCode}`, 'R'],
    [`Contact : ${shop.contact}`, 'R'],
  ];
  const hb = top - Math.max(92, 11 + (shopLines.length - 1) * 13 + 16);
  p.rect(L, hb, R - L, top - hb);
  p.ln(mid, top, mid, hb);
  p.ln(mid, top - 28, R, top - 28);
  p.ln(430, top, 430, top - 28);
  let y = top - 11;
  for (const [s, f] of shopLines) {
    p.tFit(L + 3, y, s, f, 8.5, mid - L - 6);
    y -= 13;
  }
  p.t(mid + 3, top - 10, 'Invoice No.', 'R', 7.5);
  p.tFit(mid + 3, top - 22, doc.invoiceNo, 'B', 8.5, 430 - mid - 6);
  p.t(433, top - 10, 'Dated', 'R', 7.5);
  p.t(433, top - 22, fmtBillDate(doc.date), 'B');

  // 5. Buyer box
  const buyerName = (buyer.name.trim() || 'Cash') + (buyer.relation && buyer.relativeName.trim() ? ` ${buyer.relation} ${buyer.relativeName.trim()}` : '');
  const buyerLines: string[] = [...p.wrap(buyer.address, 'R', 8.5, mid - L - 6)];
  if (buyer.mobile) buyerLines.push(`Phone No:- ${buyer.mobile}`);
  if (buyer.pan) buyerLines.push(`PAN                     : ${buyer.pan}`);
  else if (buyer.form60) buyerLines.push('PAN                     : Form 60 taken');
  if (buyer.state) buyerLines.push(`State Name          : ${buyer.state}, Code : ${buyer.stateCode}`);
  buyerLines.push(`Place of Supply   : ${shop.state}`);
  const bb = hb - Math.max(90, 35 + (buyerLines.length - 1) * 11 + 11);
  p.rect(L, bb, mid - L, hb - bb);
  p.t(L + 3, hb - 10, 'Buyer (Bill to)', 'R', 7.5);
  p.tFit(L + 3, hb - 23, buyerName, 'B', 9, mid - L - 6);
  let yy = hb - 35;
  for (const s of buyerLines) {
    p.tFit(L + 3, yy, s, 'R', 8.5, mid - L - 6);
    yy -= 11;
  }
  p.ln(mid, hb, mid, bb);
  p.ln(mid, bb, R, bb);

  // 6. Items table
  const cols = [L, 58, 250, 300, 365, 430, 455, R];
  const th = bb;
  const itemsHeight = doc.items.reduce((h, it, i) => h + (i > 0 ? 14 : 0) + (it.makingAmount ? 12 : 0), 0);
  const lastBaseline = th - 36 - itemsHeight - 18 - 20 - 24;
  // Each extra HSN row in the tax summary takes 14 pt; take it from the items table so the page still fits.
  const hsnRows = hsnSummary(doc.items, shop.gstRate);
  const tb = Math.min(th - 275 + 14 * (hsnRows.length - 1), lastBaseline - 28);
  p.rect(L, tb, R - L, th - tb);
  for (const x of cols.slice(1, -1)) p.ln(x, th, x, tb + 18);
  p.ln(L, th - 22, R, th - 22);
  const hdr = ['Sl\nNo.', 'Description of Goods', 'HSN/SAC', 'Quantity', 'Rate', 'per', 'Amount'];
  hdr.forEach((h, i) => {
    const cx = (cols[i] + cols[i + 1]) / 2;
    h.split('\n').forEach((part, j) => p.tc(cx, th - 10 - j * 9, part, 'R', 7.5));
  });
  y = th - 36;
  doc.items.forEach((it, i) => {
    if (i > 0) y -= 14;
    p.t(L + 5, y, String(i + 1));
    p.tFit(62, y, it.description, 'B', 8.5, cols[2] - 62 - 3);
    p.t(253, y, it.hsn);
    p.tr(cols[4] - 3, y, `${fmtWeight(it.weightMg)} Grm`, 'B');
    p.tr(cols[5] - 3, y, fmtMoney(it.ratePerG));
    p.t(433, y, 'Grm');
    p.tr(R - 3, y, fmtMoney(it.metalValue), 'B');
    if (it.makingAmount) {
      y -= 12;
      p.t(72, y, makingLabel(it, fmtPct, fmtMoneyShort), 'O', 8);
      p.tr(R - 3, y, fmtMoney(it.makingAmount), 'B');
    }
  });
  y -= 18;
  p.ln(455, y + 8, R, y + 8);
  p.tr(R - 3, y - 2, fmtMoney(doc.taxable));
  y -= 20;
  for (const [lab, v] of [
    ['C-Gst', fmtMoney(doc.cgst)],
    ['S-Gst', fmtMoney(doc.sgst)],
    ['Round Off', fmtRoundOff(doc.roundOff)],
  ]) {
    p.tr(cols[2] - 5, y, lab, 'I');
    p.tr(R - 3, y, v, 'B');
    y -= 12;
  }
  p.t(62, y + 12, 'Add :', 'O', 8);
  p.ln(L, tb + 18, R, tb + 18);
  p.tr(cols[3] - 5, tb + 6, 'Total');
  p.tr(cols[4] - 3, tb + 6, `${fmtWeight(doc.totalWeightMg)} Grm`, 'B');
  p.tr(R - 3, tb + 5, `₹ ${fmtMoney(doc.grand)}`, 'D', 10);

  // 7. Amount in words
  y = tb - 10;
  p.t(L + 3, y, 'Amount Chargeable (in words)', 'R', 7.5);
  p.tr(R - 3, y, 'E. & O.E', 'O', 7.5);
  p.t(L + 3, y - 12, amountInWords(doc.grand), 'B', 9);

  // 8. HSN tax summary: one row per HSN code, then a Total row
  const ty = y - 20;
  const rowsBottom = ty - 24 - 14 * hsnRows.length;
  const tyb = rowsBottom - 20;
  p.rect(L, tyb, R - L, ty - tyb);
  const tc_ = [L, 200, 260, 290, 345, 375, 430, R];
  tc_.slice(1, -1).forEach((x, k) => {
    const i = k + 1;
    p.ln(x, i === 3 || i === 5 ? ty - 12 : ty, x, tyb);
  });
  p.ln(tc_[2], ty - 12, tc_[6], ty - 12);
  p.ln(L, ty - 24, R, ty - 24);
  p.ln(L, rowsBottom, R, rowsBottom);
  p.tc(120, ty - 15, 'HSN/SAC', 'R', 7.5);
  p.tc(230, ty - 9, 'Taxable', 'R', 7.5);
  p.tc(230, ty - 20, 'Value', 'R', 7.5);
  p.tc(317, ty - 9, 'CGST', 'R', 7.5);
  p.tc(402, ty - 9, 'SGST/UTGST', 'R', 7.5);
  for (const [x, s] of [[275, 'Rate'], [317, 'Amount'], [360, 'Rate'], [402, 'Amount']] as const) p.tc(x, ty - 21, s, 'R', 7.5);
  p.tc((430 + R) / 2, ty - 9, 'Total', 'R', 7.5);
  p.tc((430 + R) / 2, ty - 20, 'Tax Amount', 'R', 7.5);
  const totalTax = doc.cgst + doc.sgst;
  hsnRows.forEach((h, i) => {
    const r = ty - 34 - 14 * i;
    p.t(L + 3, r, h.hsn, 'R', 7.5);
    for (const [x, s] of [
      [257, fmtMoney(h.taxable)],
      [288, fmtPct(doc.cgstRate, true) + '%'],
      [342, fmtMoney(h.cgst)],
      [373, fmtPct(doc.sgstRate, true) + '%'],
      [427, fmtMoney(h.sgst)],
      [R - 3, fmtMoney(h.cgst + h.sgst)],
    ] as const)
      p.tr(x, r, s, 'R', 7.5);
  });
  const r = rowsBottom - 12;
  p.tr(197, r, 'Total', 'B', 7.5);
  for (const [x, s] of [
    [257, fmtMoney(doc.taxable)],
    [342, fmtMoney(doc.cgst)],
    [427, fmtMoney(doc.sgst)],
    [R - 3, fmtMoney(totalTax)],
  ] as const)
    p.tr(x, r, s, 'B', 7.5);

  // 9–10. Tax in words + footer box
  y = tyb - 14;
  p.t(L + 3, y, 'Tax Amount (in words)  :', 'R', 7.5);
  p.tFit(160, y, amountInWords(totalTax), 'B', 9, R - 160 - 3);
  const fb = y - 95;
  p.rect(L, fb, R - L, y + 8 - fb);
  const bx = 270;
  let y2 = y - 14;
  p.t(bx, y2, "Company's Bank Details", 'R', 7.5);
  for (const [lab, v] of [
    ["A/c Holder's Name", shop.bankHolder],
    ['Bank Name', shop.bankName],
    ['A/c No.', shop.bankAccount],
    ['Branch & IFS Code', shop.bankBranchIfsc],
  ]) {
    y2 -= 10;
    p.t(bx, y2, lab, 'R', 7.5);
    p.tFit(bx + 75, y2, ':  ' + v, 'B', 7.5, R - bx - 78);
  }
  p.t(L + 3, fb + 38, 'Company’s PAN', 'R', 7.5);
  p.t(140, fb + 38, ':  ' + shop.pan, 'B', 7.5);
  p.ln(bx - 3, fb + 30, R, fb + 30);
  p.ln(bx - 3, fb, bx - 3, fb + 30);
  p.t(L + 3, fb + 26, 'Declaration', 'R', 7);
  let decSize = 7.5;
  let dec = p.wrap(shop.declaration, 'R', decSize, DECL_W);
  while (dec.length > 3 && decSize > 5) {
    decSize -= 0.5;
    dec = p.wrap(shop.declaration, 'R', decSize, DECL_W);
  }
  const decStep = decSize + 0.5;
  dec.slice(0, 3).forEach((s, i) => p.t(L + 3, fb + 17 - i * decStep, s, 'R', decSize));
  p.tr(R - 3, fb + 21, `for ${shop.name}`, 'B', 7.5);
  p.tr(R - 3, fb + 4, 'Authorised Signatory', 'R', 7);

  // 11.
  p.tc(W / 2, fb - 14, 'This is a Computer Generated Invoice', 'R', 8);

  if (doc.cancelled) stampCancelled(page, fonts);

  return pdf.save({ useObjectStreams: false });
}
