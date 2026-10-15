// Estimate receipt: printed on the top half of an A4 sheet, with a dashed cut line.
// No GST. Follows the shop's handwritten estimate pad: weight @ rate + making = amount.
import { rgb } from 'pdf-lib';
import type { EstimateDoc } from './types';
import { METAL_LABEL } from './calc';
import { fmtMoney, fmtMoneyShort, fmtPct, fmtRoundOff, fmtWeight } from './money';
import { fmtBillDate } from './fy';
import { amountInWords } from './words';
import { H, L, R, W, newA4, stampCancelled, type PdfAssets } from './pdf';

export async function renderEstimatePdf(doc: EstimateDoc, assets: PdfAssets): Promise<Uint8Array> {
  const { pdf, page, fonts, p } = await newA4(`Estimate ${doc.estimateNo}`, doc.shop.name, doc.date, assets);
  const { shop, customer } = doc;

  // Header: logo, ESTIMATE, shop name, address, phone
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
  const tag = 'ESTIMATE';
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
  y -= 2;
  p.ln(L, y, R, y);

  // Number, date, customer
  y -= 15;
  p.t(L, y, 'Estimate No. :', 'R', 8.5);
  p.t(L + 62, y, doc.estimateNo, 'B', 9);
  p.tr(R, y, fmtBillDate(doc.date), 'B', 9);
  p.tr(R - p.width(fmtBillDate(doc.date), 'B', 9) - 4, y, 'Date :', 'R', 8.5);
  y -= 15;
  p.t(L, y, 'Name :', 'R', 8.5);
  p.tFit(L + 62, y, customer.name, 'B', 10, R - L - 62);
  const phones = [customer.mobile, customer.otherMobile].filter(Boolean).join(', ');
  if (phones) {
    y -= 13;
    p.t(L, y, 'Mobile :', 'R', 8.5);
    p.t(L + 62, y, phones, 'R', 9);
  }

  // Items table
  const cols = [L, 62, 250, 315, 400, 480, R];
  const tt = y - 10;
  const rowH = 24;
  const tb = tt - 18 - doc.items.length * rowH - 2;
  p.rect(L, tb, R - L, tt - tb);
  p.ln(L, tt - 18, R, tt - 18);
  for (const x of cols.slice(1, -1)) p.ln(x, tt, x, tb);
  ['Sl', 'Description', 'Weight (g)', 'Rate', 'Making', 'Amount'].forEach((h, i) => p.tc((cols[i] + cols[i + 1]) / 2, tt - 12, h, 'R', 7.5));
  doc.items.forEach((it, i) => {
    const ry = tt - 18 - 12 - i * rowH;
    p.tc((cols[0] + cols[1]) / 2, ry, String(i + 1));
    p.tFit(cols[1] + 4, ry, it.description, 'B', 9, cols[2] - cols[1] - 8);
    p.t(cols[1] + 4, ry - 9, METAL_LABEL[it.metal], 'O', 7);
    p.tr(cols[3] - 4, ry, fmtWeight(it.weightMg), 'B');
    p.tr(cols[4] - 4, ry, `${fmtMoneyShort(it.rateInput)}/${it.metal === 'SILVER' ? 'kg' : '10g'}`);
    p.tr(cols[4] - 4, ry - 9, `metal ${fmtMoney(it.metalValue)}`, 'O', 7);
    const mk = it.makingType === 'PCT' ? `${fmtPct(it.makingValue)}%` : it.makingType === 'PER_G' ? `₹${fmtMoneyShort(it.makingValue)}/g` : `₹${fmtMoneyShort(it.makingValue)}`;
    if (it.makingAmount) {
      p.tr(cols[5] - 4, ry, mk);
      if (it.makingType !== 'FIXED') p.tr(cols[5] - 4, ry - 9, fmtMoney(it.makingAmount), 'O', 7);
    } else p.tr(cols[5] - 4, ry, '—');
    p.tr(R - 4, ry, fmtMoney(it.metalValue + it.makingAmount), 'B');
  });

  // Totals
  y = tb - 14;
  p.t(L, y, `Total weight : ${fmtWeight(doc.totalWeightMg)} g`, 'R', 8.5);
  p.tr(cols[5] - 4, y, 'Sub total', 'R', 8.5);
  p.tr(R - 4, y, fmtMoney(doc.subtotal));
  y -= 12;
  p.t(L, y, `Payment : ${doc.paymentMode}`, 'R', 8.5);
  p.tr(cols[5] - 4, y, 'Round off', 'R', 8.5);
  p.tr(R - 4, y, fmtRoundOff(doc.roundOff));
  y -= 6;
  p.ln(cols[4], y, R, y);
  y -= 14;
  const totalText = `₹ ${fmtMoney(doc.grand)}`;
  p.tr(R - 4, y, totalText, 'D', 12);
  p.tr(R - 4 - p.width(totalText, 'D', 12) - 10, y, 'Total', 'B', 11);
  p.tFit(L, y, amountInWords(doc.grand), 'B', 8.5, cols[4] - L - 8);

  // Footer
  y -= 24;
  p.t(L, y, 'This is an estimate only, not a tax invoice.', 'O', 7.5);
  p.tr(R, y, `for ${shop.name}`, 'B', 8.5);

  // Cut line in the middle of the sheet when the estimate fits in the top half
  if (y > H / 2 + 12) {
    page.drawLine({ start: { x: 20, y: H / 2 }, end: { x: W - 20, y: H / 2 }, thickness: 0.5, dashArray: [4, 3], color: rgb(0.55, 0.55, 0.55) });
  }
  if (doc.cancelled) stampCancelled(page, fonts, (H - 22 + y) / 2 + 30, 60);

  return pdf.save({ useObjectStreams: false });
}
