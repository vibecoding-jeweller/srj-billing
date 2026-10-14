import { calcBill, type ItemInput, type Metal } from './calc';
import type { BillDoc, BillPayment, Buyer, Settings, ShopSnapshot } from './types';

export const DEFAULT_SETTINGS: Settings = {
  shopName: 'S.R. Jewellers',
  addressLines: ['Lal Kuan, Sarrafa Bazar', 'Bulandshahr'],
  gstin: '09AIPPV2929L1ZB',
  pan: 'AIPPV2929L',
  state: 'Uttar Pradesh',
  stateCode: '09',
  contact: '9760012800',
  logo: '',
  bankHolder: 'S.R. Jewellers',
  bankName: 'IndusInd Bank C/a A/c No:- 259760012801',
  bankAccount: '259760012801',
  bankBranchIfsc: 'D.M. Road, Bsr & INDB0002099',
  invoicePrefix: 'SR',
  invoiceStart: null,
  gstRate: 300,
  hsn: '7113',
  billsFolder: '',
  backupFolder: '',
  declaration:
    'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.',
};

export function shopSnapshot(s: Settings, logoHash: string): ShopSnapshot {
  return {
    name: s.shopName,
    addressLines: s.addressLines.filter((l) => l.trim()),
    gstin: s.gstin,
    pan: s.pan,
    state: s.state,
    stateCode: s.stateCode,
    contact: s.contact,
    logoHash,
    bankHolder: s.bankHolder,
    bankName: s.bankName,
    bankAccount: s.bankAccount,
    bankBranchIfsc: s.bankBranchIfsc,
    declaration: s.declaration,
    hsn: s.hsn,
    gstRate: s.gstRate,
  };
}

const PURITY_SUFFIX: Record<Metal, string> = { GOLD22: '22kt', GOLD18: '18kt', SILVER: '' };

/** Description as printed: adds the purity ("Gold Ring" → "Gold Ring 22kt") unless already mentioned. */
export function printedDescription(desc: string, metal: Metal): string {
  const d = desc.trim() || (metal === 'SILVER' ? 'Silver Item' : 'Gold Item');
  const suffix = PURITY_SUFFIX[metal];
  if (!suffix || /\b(22|18)\s*(k|kt|ct|carat|karat)\b/i.test(d)) return d;
  return `${d} ${suffix}`;
}

/** Buyer as printed/stored: name defaults to "Cash", text trimmed, PAN upper-cased. */
export function normalizeBuyer(b: Buyer): Buyer {
  return {
    ...b,
    mobile: b.mobile.trim(),
    name: b.name.trim() || 'Cash',
    relativeName: b.relation ? b.relativeName.trim() : '',
    address: b.address.trim(),
    pan: b.pan.trim().toUpperCase(),
    form60: b.pan.trim() ? false : b.form60,
  };
}

export function buildBillDoc(args: {
  invoiceNo: string;
  date: string;
  shop: ShopSnapshot;
  buyer: Buyer;
  items: ItemInput[];
  payments: BillPayment[];
}): BillDoc {
  const items = args.items.map((it) => ({
    ...it,
    description: printedDescription(it.description, it.metal),
    hsn: it.hsn.trim() || args.shop.hsn,
  }));
  const c = calcBill(items, args.shop.gstRate);
  return {
    invoiceNo: args.invoiceNo,
    date: args.date,
    shop: args.shop,
    buyer: normalizeBuyer(args.buyer),
    items: c.items,
    totalWeightMg: c.totalWeightMg,
    taxable: c.taxable,
    cgstRate: c.cgstRate,
    sgstRate: c.sgstRate,
    cgst: c.cgst,
    sgst: c.sgst,
    roundOff: c.roundOff,
    grand: c.grand,
    payments: args.payments,
  };
}
