// Item rows shared by New Bill and Estimate. Each item takes two lines so the description box is wide.
import { useEffect, useState } from 'react';
import { calcItem, isSilver, METAL_LABEL, metalForDescription, RATE_UNIT_LABEL, type ItemCalc, type ItemInput, type MakingType, type Metal, type Pricing } from '../lib/calc';
import { catalogueDescription, looksLikeSku, type CatalogueItem } from '../lib/catalogue';
import { fmtMoney, fmtPct, fmtWeight, paiseToInput, parseMg, parsePaise, parseScaled } from '../lib/money';
import type { DailyRates } from '../lib/types';
import { DescriptionInput } from './DescriptionInput';

const HSN_SUGGESTIONS: [string, string][] = [
  ['711319', 'Gold jewellery'],
  ['711311', 'Silver jewellery (925 too)'],
  ['711411', 'Silver articles (utensils, idols)'],
  ['711419', 'Gold articles'],
  ['7113', 'Jewellery of gold / silver'],
  ['7114', "Goldsmiths' / silversmiths' wares (utensils, articles)"],
  ['7117', 'Imitation jewellery'],
  ['7118', 'Coins'],
  ['7108', 'Gold, unwrought / bars'],
  ['7106', 'Silver, unwrought / bars'],
];

export interface RowState {
  key: number;
  desc: string;
  metal: Metal;
  weight: string;
  /** null = use today's rate */
  rate: string | null;
  makingType: MakingType;
  making: string;
  hsn: string;
  /** true once the HSN was typed by hand: auto-fill then leaves it alone */
  hsnManual?: boolean;
  pricing: Pricing;
  /** catalogue code, e.g. RNG0005 */
  sku: string;
  /** FIXED_PRICE only */
  qty: string;
  /** FIXED_PRICE: rupees per piece as typed (GST-inclusive on bills) */
  price: string;
}

export interface ParsedRow {
  row: RowState;
  blank: boolean;
  errs: string[];
  input: ItemInput | null;
  calc: ItemCalc | null;
}

let nextKey = 1;
export const newKey = () => nextKey++;
const newRow = (hsn: string): RowState => ({
  key: newKey(),
  desc: '',
  metal: 'GOLD22',
  weight: '',
  rate: null,
  makingType: 'PCT',
  making: '',
  hsn,
  pricing: 'WEIGHT',
  sku: '',
  qty: '1',
  price: '',
});

/** Row changes for a catalogue piece: name, Silver 925, fixed price at ShopSP, weight if the sheet has it. */
export function fillFromCatalogue(c: CatalogueItem): Partial<RowState> {
  return {
    desc: catalogueDescription(c),
    sku: c.sku,
    metal: 'SILVER925',
    pricing: 'FIXED_PRICE',
    price: paiseToInput(c.shop_price),
    qty: '1',
    weight: c.weight_mg ? fmtWeight(c.weight_mg) : '',
    rate: null,
  };
}

export const todayRateFor = (rates: DailyRates | null, m: Metal): number | null =>
  rates ? (isSilver(m) ? rates.silver : m === 'GOLD18' ? rates.gold18 : rates.gold22) : null;

/** A fixed-price (tag price) row: qty × price; weight is optional and only printed. */
function parseFixedRow(r: RowState, i: number, defaultHsn: string): ParsedRow {
  const blank = !r.desc.trim() && !r.price.trim() && !r.sku.trim();
  const unitPrice = parsePaise(r.price);
  const qty = /^\d+$/.test(r.qty.trim()) ? Number(r.qty.trim()) : null;
  const weightMg = r.weight.trim() ? parseMg(r.weight) : 0;
  const errs: string[] = [];
  if (!blank) {
    if (!unitPrice) errs.push(`Item ${i + 1}: enter the price.`);
    if (!qty || qty < 1) errs.push(`Item ${i + 1}: quantity must be a whole number, 1 or more.`);
    if (weightMg == null) errs.push(`Item ${i + 1}: weight is not a valid number (or leave it blank).`);
  }
  const input: ItemInput | null =
    !blank && errs.length === 0
      ? {
          description: r.desc,
          metal: r.metal,
          weightMg: weightMg!,
          rateInput: 0,
          makingType: 'FIXED',
          makingValue: 0,
          hsn: r.hsn.trim() || defaultHsn,
          pricing: 'FIXED_PRICE',
          sku: r.sku.trim().toUpperCase() || undefined,
          qty: qty!,
          unitPrice: unitPrice!,
        }
      : null;
  return { row: r, blank, errs, input, calc: input ? calcItem(input) : null };
}

/** Turn the typed rows into items, with friendly errors. Blank rows are ignored. */
export function parseRows(rows: RowState[], rates: DailyRates | null, defaultHsn: string) {
  const parsed: ParsedRow[] = rows.map((r, i) => {
    if (r.pricing === 'FIXED_PRICE') return parseFixedRow(r, i, defaultHsn);
    const blank = !r.desc.trim() && !r.weight.trim();
    const weightMg = parseMg(r.weight);
    const rate = r.rate != null ? parsePaise(r.rate) : todayRateFor(rates, r.metal);
    const makingValue = r.making.trim() === '' ? 0 : r.makingType === 'PCT' ? parseScaled(r.making, 2) : parsePaise(r.making);
    const errs: string[] = [];
    if (!blank) {
      if (!weightMg) errs.push(`Item ${i + 1}: enter the weight in grams (up to 3 decimals).`);
      if (!rate) errs.push(`Item ${i + 1}: enter the rate.`);
      if (makingValue == null) errs.push(`Item ${i + 1}: making charge is not a valid number.`);
      // e.g. 300 typed while the type is still "%" instead of "₹ fixed"
      else if (r.makingType === 'PCT' && makingValue > 100_00)
        errs.push(`Item ${i + 1}: making charge of ${r.making.trim()}% looks wrong. For rupees, choose "₹ fixed" or "₹/g".`);
    }
    const input: ItemInput | null =
      !blank && errs.length === 0
        ? { description: r.desc, metal: r.metal, weightMg: weightMg!, rateInput: rate!, makingType: r.makingType, makingValue: makingValue!, hsn: r.hsn.trim() || defaultHsn }
        : null;
    return { row: r, blank, errs, input, calc: input ? calcItem(input) : null };
  });
  return {
    parsed,
    validItems: parsed.flatMap((p) => (p.input ? [p.input] : [])),
    itemErrors: parsed.flatMap((p) => p.errs),
    itemCount: parsed.filter((p) => !p.blank).length,
  };
}

/** Row state + add/remove, with focus moving to a newly added row. */
export function useItemRows(defaultHsn: string, autoHsn?: (description: string, metal: Metal) => string) {
  const fresh = () => newRow(autoHsn ? autoHsn('', 'GOLD22') : defaultHsn);
  const [rows, setRows] = useState<RowState[]>(() => [fresh()]);
  const [focusKey, setFocusKey] = useState<number | null>(null);
  useEffect(() => {
    if (focusKey == null) return;
    document.querySelector<HTMLInputElement>(`[data-desc="${focusKey}"]`)?.focus();
    setFocusKey(null);
  }, [focusKey]);
  return {
    rows,
    setRow: (key: number, patch: Partial<RowState>) =>
      setRows((rs) =>
        rs.map((r) => {
          if (r.key !== key) return r;
          const n = { ...r, ...patch };
          // the HSN follows the description and metal until it is typed by hand
          if (autoHsn && !n.hsnManual && ('desc' in patch || 'metal' in patch || 'hsnManual' in patch)) n.hsn = autoHsn(n.desc, n.metal);
          return n;
        }),
      ),
    addRow: () => {
      const r = fresh();
      setRows((rs) => [...rs, r]);
      setFocusKey(r.key);
    },
    removeRow: (key: number) => setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.key !== key) : [fresh()])),
    reset: () => setRows([fresh()]),
  };
}

export function ItemsEditor({
  parsed,
  rates,
  showErrors,
  showHsn,
  defaultHsn,
  suggestions,
  catalogue,
  taxInclusive,
  setRow,
  addRow,
  removeRow,
  onLastEnter,
}: {
  parsed: ParsedRow[];
  rates: DailyRates | null;
  showErrors: boolean;
  showHsn: boolean;
  defaultHsn: string;
  suggestions: string[];
  /** cached 925 catalogue by SKU */
  catalogue: Map<string, CatalogueItem>;
  /** bills: tag prices include GST */
  taxInclusive: boolean;
  setRow: (key: number, patch: Partial<RowState>) => void;
  addRow: () => void;
  removeRow: (key: number) => void;
  /** Enter on the last item's making charge */
  onLastEnter: () => void;
}) {
  return (
    <section className="card">
      <h3>Items</h3>
      <div className="items-list">
        {parsed.map(({ row: r, calc, blank }, idx) => {
          const isLast = idx === parsed.length - 1;
          const rateOk = !!(r.rate != null ? parsePaise(r.rate) : todayRateFor(rates, r.metal));
          const fixed = r.pricing === 'FIXED_PRICE';
          const enterNext = (e: React.KeyboardEvent) => {
            if (e.key === 'Enter' && isLast) {
              e.preventDefault();
              e.stopPropagation();
              onLastEnter();
            }
          };
          return (
            <div className="item" key={r.key}>
              <div className="item-no">{idx + 1}</div>
              <div className={'item-line1' + (showHsn ? ' with-hsn' : '')}>
                <label className="field">
                  Description of goods
                  <DescriptionInput
                    rowKey={r.key}
                    value={r.desc}
                    suggestions={suggestions}
                    onChange={(v) => {
                      // typing a catalogue code (RNG0005) fills in the piece; anything else is a normal description
                      const hit = looksLikeSku(v) ? catalogue.get(v.trim().toUpperCase().replace('-', '')) ?? catalogue.get(v.trim().toUpperCase()) : undefined;
                      setRow(r.key, hit ? fillFromCatalogue(hit) : { desc: v });
                    }}
                    onPick={(v) => {
                      const metal = metalForDescription(v, r.metal);
                      setRow(r.key, { desc: v, ...(metal !== r.metal ? { metal, rate: null } : {}) });
                    }}
                  />
                </label>
                {showHsn && (
                  <label className="field" title="Not on the Enter path: press Tab or click to change">
                    HSN
                    <input
                      list="hsn-suggestions"
                      inputMode="numeric"
                      maxLength={8}
                      value={r.hsn}
                      onChange={(e) => {
                        const hsn = e.target.value.replace(/[^0-9]/g, '');
                        setRow(r.key, { hsn, hsnManual: hsn !== '' });
                      }}
                      placeholder={defaultHsn}
                    />
                  </label>
                )}
                <label className="field">
                  Metal
                  <select
                    data-nav
                    value={r.metal}
                    onChange={(e) => {
                      const metal = e.target.value as Metal;
                      // 925 pieces are sold at their tag price; switching to it starts in fixed-price mode
                      setRow(r.key, { metal, rate: null, ...(metal === 'SILVER925' && r.metal !== 'SILVER925' ? { pricing: 'FIXED_PRICE' as const } : {}) });
                    }}
                  >
                    {(Object.keys(METAL_LABEL) as Metal[]).map((m) => (
                      <option key={m} value={m}>
                        {METAL_LABEL[m]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field" title="Fixed price: a tag price per piece, e.g. LUXMÉ 925">
                  Price by
                  <select value={r.pricing} onChange={(e) => setRow(r.key, { pricing: e.target.value as Pricing })}>
                    <option value="WEIGHT">Weight × rate</option>
                    <option value="FIXED_PRICE">Fixed price</option>
                  </select>
                </label>
              </div>
              {fixed ? (
                <div className="item-line2 fixed">
                  <label className="field">
                    Qty (pcs)
                    <input data-nav className="num" inputMode="numeric" value={r.qty} onChange={(e) => setRow(r.key, { qty: e.target.value.replace(/\D/g, '') })} />
                  </label>
                  <label className="field">
                    <span>Price per piece (₹{taxInclusive ? ', incl. GST' : ''})</span>
                    <input
                      data-nav
                      className={'num' + (showErrors && !blank && !parsePaise(r.price) ? ' invalid' : '')}
                      inputMode="decimal"
                      value={r.price}
                      onChange={(e) => setRow(r.key, { price: e.target.value })}
                      onKeyDown={enterNext}
                      placeholder="tag price"
                    />
                    {r.sku && catalogue.get(r.sku) && parsePaise(r.price) !== catalogue.get(r.sku)!.shop_price && (
                      <button type="button" className="link sub-link" onClick={() => setRow(r.key, { price: paiseToInput(catalogue.get(r.sku)!.shop_price) })}>
                        sheet price ₹{fmtMoney(catalogue.get(r.sku)!.shop_price)}
                      </button>
                    )}
                  </label>
                  <label className="field">
                    <span>
                      Weight (g) <span className="hint">optional</span>
                    </span>
                    <input
                      className="num"
                      inputMode="decimal"
                      value={r.weight}
                      onChange={(e) => setRow(r.key, { weight: e.target.value })}
                      onBlur={() => {
                        const mg = parseMg(r.weight);
                        if (mg) setRow(r.key, { weight: fmtWeight(mg) });
                      }}
                      placeholder="—"
                    />
                  </label>
                  <label className="field">
                    SKU
                    <input
                      value={r.sku}
                      spellCheck={false}
                      onChange={(e) => setRow(r.key, { sku: e.target.value.toUpperCase().replace(/\s/g, '') })}
                      placeholder="e.g. RNG0005"
                      title={r.sku && !catalogue.get(r.sku) ? 'Not in the synced catalogue: enter the price by hand' : ''}
                    />
                    {r.sku && catalogue.size > 0 && !catalogue.get(r.sku) && <span className="sub hint">not in catalogue</span>}
                  </label>
                  <div className="item-amount">
                    <span className="hint">{taxInclusive ? 'Amount (incl. GST)' : 'Amount'}</span>
                    <b>{calc ? `₹${fmtMoney(calc.metalValue)}` : '—'}</b>
                  </div>
                  <button type="button" className="rm" title="Remove item" tabIndex={-1} onClick={() => removeRow(r.key)}>
                    ×
                  </button>
                </div>
              ) : (
              <div className="item-line2">
                <label className="field">
                  Weight (g)
                  <input
                    data-nav
                    className={'num' + (showErrors && !blank && !parseMg(r.weight) ? ' invalid' : '')}
                    inputMode="decimal"
                    value={r.weight}
                    onChange={(e) => setRow(r.key, { weight: e.target.value })}
                    onBlur={() => {
                      const mg = parseMg(r.weight);
                      if (mg) setRow(r.key, { weight: fmtWeight(mg) });
                    }}
                    placeholder="0.000"
                  />
                </label>
                <label className="field">
                  <span>
                    Rate (₹ {RATE_UNIT_LABEL[r.metal]})
                  </span>
                  <input
                    data-nav
                    className={'num' + (showErrors && !blank && !rateOk ? ' invalid' : '')}
                    inputMode="decimal"
                    value={r.rate ?? paiseToInput(todayRateFor(rates, r.metal))}
                    onChange={(e) => setRow(r.key, { rate: e.target.value })}
                  />
                  {r.rate != null && (
                    <button type="button" className="link sub-link" onClick={() => setRow(r.key, { rate: null })}>
                      use today's rate
                    </button>
                  )}
                </label>
                <label className="field">
                  Making charge
                  <div className="making">
                    <select data-nav value={r.makingType} onChange={(e) => setRow(r.key, { makingType: e.target.value as MakingType })}>
                      <option value="PCT">%</option>
                      <option value="PER_G">₹/g</option>
                      <option value="FIXED">₹ fixed</option>
                    </select>
                    <input
                      data-nav
                      className="num"
                      inputMode="decimal"
                      value={r.making}
                      onChange={(e) => setRow(r.key, { making: e.target.value })}
                      placeholder={r.makingType === 'PCT' ? '%' : '₹'}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && isLast) {
                          e.preventDefault();
                          e.stopPropagation();
                          onLastEnter();
                        }
                      }}
                    />
                  </div>
                  {calc && calc.makingAmount > 0 && (
                    <span className="sub">
                      = ₹{fmtMoney(calc.makingAmount)}
                      {r.makingType === 'PCT' ? ` (${fmtPct(calc.makingValue)}%)` : ''}
                    </span>
                  )}
                </label>
                <div className="item-amount">
                  <span className="hint">Amount</span>
                  <b>{calc ? `₹${fmtMoney(calc.metalValue + calc.makingAmount)}` : '—'}</b>
                </div>
                <button type="button" className="rm" title="Remove item" tabIndex={-1} onClick={() => removeRow(r.key)}>
                  ×
                </button>
              </div>
              )}
            </div>
          );
        })}
      </div>
      {showHsn && (
        <datalist id="hsn-suggestions">
          {HSN_SUGGESTIONS.map(([code, label]) => (
            <option key={code} value={code} label={label} />
          ))}
        </datalist>
      )}
      <button type="button" className="link" onClick={addRow}>
        + Add item <span className="hint">(Ctrl+I)</span>
      </button>
    </section>
  );
}
