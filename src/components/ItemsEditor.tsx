// Item rows shared by New Bill and Estimate. Each item takes two lines so the description box is wide.
import { useEffect, useState } from 'react';
import { calcItem, METAL_LABEL, metalForDescription, RATE_UNIT_LABEL, type ItemCalc, type ItemInput, type MakingType, type Metal } from '../lib/calc';
import { fmtMoney, fmtPct, fmtWeight, paiseToInput, parseMg, parsePaise, parseScaled } from '../lib/money';
import type { DailyRates } from '../lib/types';
import { DescriptionInput } from './DescriptionInput';

const HSN_SUGGESTIONS: [string, string][] = [
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
const newRow = (hsn: string): RowState => ({ key: newKey(), desc: '', metal: 'GOLD22', weight: '', rate: null, makingType: 'PCT', making: '', hsn });

export const todayRateFor = (rates: DailyRates | null, m: Metal): number | null =>
  rates ? (m === 'SILVER' ? rates.silver : m === 'GOLD18' ? rates.gold18 : rates.gold22) : null;

/** Turn the typed rows into items, with friendly errors. Blank rows are ignored. */
export function parseRows(rows: RowState[], rates: DailyRates | null, defaultHsn: string) {
  const parsed: ParsedRow[] = rows.map((r, i) => {
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
export function useItemRows(defaultHsn: string) {
  const [rows, setRows] = useState<RowState[]>(() => [newRow(defaultHsn)]);
  const [focusKey, setFocusKey] = useState<number | null>(null);
  useEffect(() => {
    if (focusKey == null) return;
    document.querySelector<HTMLInputElement>(`[data-desc="${focusKey}"]`)?.focus();
    setFocusKey(null);
  }, [focusKey]);
  return {
    rows,
    setRow: (key: number, patch: Partial<RowState>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r))),
    addRow: () => {
      const r = newRow(defaultHsn);
      setRows((rs) => [...rs, r]);
      setFocusKey(r.key);
    },
    removeRow: (key: number) => setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.key !== key) : [newRow(defaultHsn)])),
    reset: () => setRows([newRow(defaultHsn)]),
  };
}

export function ItemsEditor({
  parsed,
  rates,
  showErrors,
  showHsn,
  defaultHsn,
  suggestions,
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
                    onChange={(v) => setRow(r.key, { desc: v })}
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
                      onChange={(e) => setRow(r.key, { hsn: e.target.value.replace(/[^0-9]/g, '') })}
                      placeholder={defaultHsn}
                    />
                  </label>
                )}
                <label className="field">
                  Metal
                  <select data-nav value={r.metal} onChange={(e) => setRow(r.key, { metal: e.target.value as Metal, rate: null })}>
                    {(Object.keys(METAL_LABEL) as Metal[]).map((m) => (
                      <option key={m} value={m}>
                        {METAL_LABEL[m]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
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
