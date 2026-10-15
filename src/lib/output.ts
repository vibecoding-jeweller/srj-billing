// Turning a BillDoc into saved PDFs and a printout.
import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import regularUrl from '../assets/fonts/LiberationSans-Regular.ttf?url';
import boldUrl from '../assets/fonts/LiberationSans-Bold.ttf?url';
import boldItalicUrl from '../assets/fonts/LiberationSans-BoldItalic.ttf?url';
import italicUrl from '../assets/fonts/LiberationSans-Italic.ttf?url';
import rupeeUrl from '../assets/fonts/DejaVuSans-Bold.ttf?url';
import { renderBillPdf, type PdfAssets } from './pdf';
import { renderEstimatePdf } from './estimatePdf';
import type { BillDoc, CopyKind, EstimateDoc } from './types';
import { financialYear, invoiceFileStem, monthFolder } from './fy';
import { fileExists, openPath, printWindow, writeFile } from './api';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

let fontCache: Omit<PdfAssets, 'logo'> | null = null;

async function bytes(url: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

async function fonts() {
  if (!fontCache) {
    const [regular, bold, boldItalic, italic, rupee] = await Promise.all([regularUrl, boldUrl, boldItalicUrl, italicUrl, rupeeUrl].map(bytes));
    fontCache = { regular, bold, boldItalic, italic, rupee };
  }
  return fontCache;
}

export function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  const bin = atob(m[1]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function makePdf(doc: BillDoc, copy: CopyKind, logoDataUrl: string): Promise<Uint8Array> {
  return renderBillPdf(doc, copy, { ...(await fonts()), logo: dataUrlToBytes(logoDataUrl) });
}

export function joinPath(base: string, ...parts: string[]): string {
  const sep = base.includes('\\') ? '\\' : '/';
  return [base.replace(/[\\/]+$/, ''), ...parts].join(sep);
}

export async function makeEstimatePdf(doc: EstimateDoc, logoDataUrl: string): Promise<Uint8Array> {
  return renderEstimatePdf(doc, { ...(await fonts()), logo: dataUrlToBytes(logoDataUrl) });
}

/** {Bills folder}/Estimates/{FY}/{MM-Mon}/EST-26-27-001.pdf */
export function estimatePath(billsFolder: string, estimateNo: string, date: string): string {
  return joinPath(billsFolder, 'Estimates', financialYear(date), monthFolder(date), `${invoiceFileStem(estimateNo)}.pdf`);
}

export async function saveEstimatePdf(doc: EstimateDoc, logo: string, billsFolder: string) {
  const bytes = await makeEstimatePdf(doc, logo);
  const path = estimatePath(billsFolder, doc.estimateNo, doc.date);
  await writeFile(path, bytes);
  return { path, bytes };
}

/** Open an estimate's PDF, re-creating it if lost; cancelled ones open as a stamped copy. */
export async function openEstimate(doc: EstimateDoc, logo: string, billsFolder: string) {
  const path = estimatePath(billsFolder, doc.estimateNo, doc.date);
  if (doc.cancelled) {
    const stamped = path.replace(/\.pdf$/, '_CANCELLED.pdf');
    await writeFile(stamped, await makeEstimatePdf(doc, logo));
    return openPath(stamped);
  }
  if (!(await fileExists(path))) await writeFile(path, await makeEstimatePdf(doc, logo));
  return openPath(path);
}

/** {Bills folder}/{FY}/{MM-Mon}/SR-26-27-001_customer.pdf */
export function billPath(billsFolder: string, invoiceNo: string, date: string, copy: CopyKind): string {
  return joinPath(billsFolder, financialYear(date), monthFolder(date), `${invoiceFileStem(invoiceNo)}_${copy}.pdf`);
}

/** Writes both copies; returns their paths. */
export async function saveBillPdfs(doc: BillDoc, logo: string, billsFolder: string) {
  const customer = await makePdf(doc, 'customer', logo);
  const store = await makePdf(doc, 'store', logo);
  const paths = {
    customer: billPath(billsFolder, doc.invoiceNo, doc.date, 'customer'),
    store: billPath(billsFolder, doc.invoiceNo, doc.date, 'store'),
  };
  await writeFile(paths.customer, customer);
  await writeFile(paths.store, store);
  return { paths, customer };
}

/** Make sure a copy exists on disk (re-creating it from the saved bill if it was lost), then open it. */
export async function openCopy(doc: BillDoc, logo: string, billsFolder: string, copy: CopyKind) {
  const path = billPath(billsFolder, doc.invoiceNo, doc.date, copy);
  if (doc.cancelled || !(await fileExists(path))) {
    const bytes = await makePdf(doc, copy, logo);
    if (doc.cancelled) {
      // keep the original file untouched; open a stamped copy alongside it
      const stamped = path.replace(/\.pdf$/, '_CANCELLED.pdf');
      await writeFile(stamped, bytes);
      return openPath(stamped);
    }
    await writeFile(path, bytes);
  }
  return openPath(path);
}

const isMac = navigator.userAgent.includes('Mac');

/**
 * Opens the system print dialog for the PDF. The page is rasterised at 300 dpi with pdf.js so the
 * printout looks exactly like the saved PDF on every platform.
 */
export async function printPdf(pdfBytes: Uint8Array): Promise<void> {
  const task = pdfjs.getDocument({ data: pdfBytes.slice() });
  const pdf = await task.promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 300 / 72 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  await task.destroy();

  const area = document.getElementById('print-area')!;
  area.innerHTML = '';
  const img = new Image();
  img.src = canvas.toDataURL('image/png');
  await img.decode();
  area.appendChild(img);
  if (isMac) {
    // the macOS dialog is asynchronous; the image is replaced on the next print
    await printWindow();
  } else {
    window.print(); // blocks until the dialog closes
    area.innerHTML = '';
  }
}
