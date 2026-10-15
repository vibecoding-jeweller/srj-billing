import type { ItemCalc, MakingType, Metal, PaymentMode } from './calc';

export type Relation = '' | 'S/o' | 'D/o' | 'W/o';

/** All shop-specific data. Lives in the settings table, never in code. */
export interface Settings {
  shopName: string;
  addressLines: string[];
  gstin: string;
  pan: string;
  state: string;
  stateCode: string;
  contact: string;
  /** PNG data URL; empty = no logo */
  logo: string;
  bankHolder: string;
  bankName: string;
  bankAccount: string;
  bankBranchIfsc: string;
  invoicePrefix: string;
  /** Estimates have their own series, e.g. EST/26-27/001 */
  estimatePrefix: string;
  /** Starting number for the given FY, only used while that FY has no bills. */
  invoiceStart: { fy: string; seq: number } | null;
  /** hundredths of a percent: 300 = 3% */
  gstRate: number;
  /** default HSN for new items */
  hsn: string;
  billsFolder: string;
  backupFolder: string;
  declaration: string;
}

/** Frozen copy of the shop details stored with each invoice. */
export interface ShopSnapshot {
  name: string;
  addressLines: string[];
  gstin: string;
  pan: string;
  state: string;
  stateCode: string;
  contact: string;
  logoHash: string;
  bankHolder: string;
  bankName: string;
  bankAccount: string;
  bankBranchIfsc: string;
  declaration: string;
  hsn: string;
  gstRate: number;
}

export interface Buyer {
  mobile: string;
  name: string;
  relation: Relation;
  relativeName: string;
  address: string;
  state: string;
  stateCode: string;
  pan: string;
  form60: boolean;
}

export type BillItem = ItemCalc;

export interface BillPayment {
  mode: PaymentMode;
  amount: number;
  referenceNo: string;
}

/** Everything needed to render (and re-render) an invoice PDF. */
export interface BillDoc {
  invoiceNo: string;
  date: string; // YYYY-MM-DD
  shop: ShopSnapshot;
  buyer: Buyer;
  items: BillItem[];
  totalWeightMg: number;
  taxable: number;
  cgstRate: number;
  sgstRate: number;
  cgst: number;
  sgst: number;
  roundOff: number;
  grand: number;
  payments: BillPayment[];
  cancelled?: boolean;
}

export type CopyKind = 'customer' | 'store';

export interface DailyRates {
  date: string;
  gold22: number; // paise per 10 g
  gold18: number; // paise per 10 g
  silver: number; // paise per kg
}

export type { Metal, MakingType };

/** Customer details on an estimate (kept short on purpose). */
export interface EstimateCustomer {
  name: string;
  mobile: string;
  otherMobile: string;
}

/** Everything needed to render (and re-render) an estimate PDF. */
export interface EstimateDoc {
  estimateNo: string;
  date: string; // YYYY-MM-DD
  shop: ShopSnapshot;
  customer: EstimateCustomer;
  items: ItemCalc[];
  totalWeightMg: number;
  subtotal: number;
  roundOff: number;
  grand: number;
  paymentMode: PaymentMode;
  cancelled?: boolean;
}
