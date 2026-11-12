// Payment receipt for a later payment against a bill or estimate. Top half of an A4 sheet, like the estimate.
import { rgb } from 'pdf-lib';
import type { ReceiptDoc } from './types';
import { fmtMoney } from './money';
import { fmtBillDate } from './fy';
import { amountInWords } from './words';
import { H, L, R, W, newA4, type PdfAssets } from './pdf';

export async function renderReceiptPdf(doc: ReceiptDoc, assets: PdfAssets): Promise<Uint8Array> {
  const { pdf, page, p } = await newA4(`Receipt ${doc.receiptNo}`, doc.shop.name, doc.date, assets);
  const { shop } = doc;

  let y = H - 22;
  const lgH = 42;
  if (assets.logo) {
    const img = await pdf.embedPng(assets.logo);
    let w = (lgH * img.width) / img.height;
    let h = lgH;
    if (w > 220) {
      h = (h * 220) / w;
      w = 220;
    }
    page.drawImage(img, { x: W / 2 - w / 2, y: y - lgH + (lgH - h) / 2, width: w, height: h });
    y -= lgH + 14;
  } else y -= 10;
  const tag = 'PAYMENT RECEIPT';
  const tagW = p.width(tag, 'B', 10) + 16;
  page.drawRectangle({ x: W / 2 - tagW / 2, y: y - 4, width: tagW, height: 15, borderWidth: 0.8, borderColor: rgb(0, 0, 0) });
  p.tc(W / 2, y, tag, 'B', 10);
  y -= 20;
  p.tc(W / 2, y, shop.name, 'B', 14);
  y -= 13;
  const addr = shop.addressLines.join(', ');
  if (addr) {
    p.tc(W / 2, y, addr, 'R', 8.5);
    y -= 11;
  }
  if (shop.contact) {
    p.tc(W / 2, y, `Ph. ${shop.contact}`, 'R', 8.5);
    y -= 11;
  }
  if (doc.against.kind === 'BILL' && shop.gstin) {
    p.tc(W / 2, y, `GSTIN: ${shop.gstin}`, 'R', 8.5);
    y -= 11;
  }
  y -= 2;
  p.ln(L, y, R, y);

  y -= 16;
  p.t(L, y, 'Receipt No. :', 'R', 8.5);
  p.t(L + 70, y, doc.receiptNo, 'B', 9);
  p.tr(R, y, fmtBillDate(doc.date), 'B', 9);
  p.tr(R - p.width(fmtBillDate(doc.date), 'B', 9) - 4, y, 'Date :', 'R', 8.5);
  y -= 15;
  p.t(L, y, 'Received from :', 'R', 8.5);
  p.tFit(L + 70, y, `${doc.customerName || 'Cash'}${doc.mobile ? `  (${doc.mobile})` : ''}`, 'B', 10, R - L - 70);
  y -= 15;
  p.t(L, y, 'Against :', 'R', 8.5);
  p.t(L + 70, y, `${doc.against.kind === 'BILL' ? 'Tax Invoice' : 'Estimate'} ${doc.against.no} dated ${fmtBillDate(doc.against.date)}`, 'B', 9);
  y -= 15;
  p.t(L, y, 'Paid by :', 'R', 8.5);
  p.t(L + 70, y, doc.mode + (doc.referenceNo ? `  (Ref. ${doc.referenceNo})` : ''), 'B', 9);

  // Amount box
  y -= 14;
  const bh = 34;
  p.rect(L, y - bh, R - L, bh);
  p.t(L + 8, y - 21, 'Amount received', 'B', 11);
  p.tr(R - 8, y - 22, `₹ ${fmtMoney(doc.amount)}`, 'D', 14);
  y -= bh + 13;
  p.tFit(L, y, amountInWords(doc.amount), 'O', 8.5, R - L);

  // Account summary
  y -= 20;
  const rows: [string, string, boolean][] = [
    [doc.against.kind === 'BILL' ? 'Bill total' : 'Estimate total', fmtMoney(doc.total), false],
    ['Received earlier', fmtMoney(doc.paidBefore), false],
    ['Received now', fmtMoney(doc.amount), false],
    ['Balance due', fmtMoney(doc.balance), true],
  ];
  const lx = R - 220;
  for (const [lab, v, bold] of rows) {
    if (bold) {
      p.ln(lx, y + 9, R, y + 9);
    }
    p.t(lx, y, lab, bold ? 'B' : 'R', 9);
    p.tr(R - 4, y, `₹ ${v}`, bold ? 'D' : 'R', bold ? 10 : 9);
    y -= 13;
  }
  if (doc.balance === 0) p.t(L, y + 13, 'Paid in full. Thank you.', 'B', 9);

  y -= 18;
  p.t(L, y, 'This receipt is for a payment only; it is not a tax invoice.', 'O', 7.5);
  p.tr(R, y, `for ${shop.name}`, 'B', 8.5);
  y -= 22;
  p.tr(R, y, 'Authorised Signatory', 'R', 7);

  if (y > H / 2 + 12) {
    page.drawLine({ start: { x: 20, y: H / 2 }, end: { x: W - 20, y: H / 2 }, thickness: 0.5, dashArray: [4, 3], color: rgb(0.55, 0.55, 0.55) });
  }
  return pdf.save({ useObjectStreams: false });
}
