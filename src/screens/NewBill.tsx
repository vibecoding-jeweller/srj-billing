import { useEffect, useMemo, useRef, useState } from 'react';
import {
  calcBill,
  calcItem,
  METAL_LABEL,
  needsReference,
  PAYMENT_MODES,
  RATE_UNIT_LABEL,
  sumPayments,
  type ItemInput,
  type MakingType,
  type Metal,
  type Payment,
  type PaymentMode,
} from '../lib/calc';
import { fmtMoney, fmtPct, fmtRoundOff, fmtWeight, paiseToInput, parseMg, parsePaise, parseScaled } from '../lib/money';
import { buildBillDoc, shopSnapshot } from '../lib/bill';
import { CASH_BLOCK_MSG, checkBill, isCashBlocked, panRequired } from '../lib/validate';
import { STATES, stateCode } from '../lib/states';
import { financialYear, todayISO } from '../lib/fy';
import { backupNow, findCustomer, saveInvoice, sha256Hex, openPath, type NewInvoicePayload } from '../lib/api';
import { printPdf, saveBillPdfs } from '../lib/output';
import { focusNextOnEnter } from '../lib/keys';
import { Modal } from '../components/Modal';
import type { BillDoc, Buyer, DailyRates, Relation, Settings } from '../lib/types';

const SUGGESTIONS = [
  'Gold Ring', 'Gold Chain', 'Gold Earrings', 'Gold Tops', 'Gold Bangles', 'Gold Kada', 'Gold Pendant', 'Gold Mangalsutra',
  'Gold Necklace', 'Gold Nose Pin', 'Gold Locket', 'Silver Payal', 'Silver Bichhiya', 'Silver Chain', 'Silver Ring',
  'Silver Coin', 'Silver Glass', 'Silver Kada',
];

const HSN_SUGGESTIONS: [string, string][] = [
  ['7113', 'Jewellery of gold / silver'],
  ['7114', "Goldsmiths' / silversmiths' wares (utensils, articles)"],
  ['7117', 'Imitation jewellery'],
  ['7118', 'Coins'],
  ['7108', 'Gold, unwrought / bars'],
  ['7106', 'Silver, unwrought / bars'],
];

interface RowState {
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

interface SplitRow {
  key: number;
  mode: PaymentMode;
  /** null = automatically the rest of the bill (only the last part) */
  amount: string | null;
  ref: string;
}

let nextKey = 1;
const newRow = (hsn: string): RowState => ({ key: nextKey++, desc: '', metal: 'GOLD22', weight: '', rate: null, makingType: 'PCT', making: '', hsn });

const emptyBuyer = (s: Settings): Buyer => ({
  mobile: '',
  name: '',
  relation: '',
  relativeName: '',
  address: '',
  state: s.state,
  stateCode: s.stateCode,
  pan: '',
  form60: false,
});

interface Done {
  doc: BillDoc;
  pdf: Uint8Array | null;
  path: string;
  problem: string;
}

export function NewBill({ settings, rates, active }: { settings: Settings; rates: DailyRates | null; active: boolean }) {
  const [buyer, setBuyer] = useState<Buyer>(() => emptyBuyer(settings));
  const [repeat, setRepeat] = useState(false);
  const [rows, setRows] = useState<RowState[]>(() => [newRow(settings.hsn)]);
  const [mode, setMode] = useState<PaymentMode>('Cash');
  const [ref, setRef] = useState('');
  const [split, setSplit] = useState<SplitRow[] | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [focusKey, setFocusKey] = useState<number | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const todayRate = (m: Metal): number | null => (rates ? (m === 'SILVER' ? rates.silver : m === 'GOLD18' ? rates.gold18 : rates.gold22) : null);

  // ---------- derive ----------
  const parsed = rows.map((r, i) => {
    const blank = !r.desc.trim() && !r.weight.trim();
    const weightMg = parseMg(r.weight);
    const rate = r.rate != null ? parsePaise(r.rate) : todayRate(r.metal);
    const makingValue = r.making.trim() === '' ? 0 : r.makingType === 'PCT' ? parseScaled(r.making, 2) : parsePaise(r.making);
    const errs: string[] = [];
    if (!blank) {
      if (!weightMg) errs.push(`Item ${i + 1}: enter the weight in grams (up to 3 decimals).`);
      if (!rate) errs.push(`Item ${i + 1}: enter the rate.`);
      if (makingValue == null) errs.push(`Item ${i + 1}: making charge is not a valid number.`);
    }
    const input: ItemInput | null =
      !blank && errs.length === 0
        ? { description: r.desc, metal: r.metal, weightMg: weightMg!, rateInput: rate!, makingType: r.makingType, makingValue: makingValue!, hsn: r.hsn.trim() || settings.hsn }
        : null;
    return { row: r, blank, errs, input, calc: input ? calcItem(input) : null };
  });
  const validItems = parsed.flatMap((p) => (p.input ? [p.input] : []));
  const itemErrors = parsed.flatMap((p) => p.errs);
  const bill = useMemo(() => calcBill(validItems, settings.gstRate), [JSON.stringify(validItems), settings.gstRate]);

  const payments: Payment[] = split
    ? (() => {
        const fixed = split.map((s) => (s.amount == null ? 0 : parsePaise(s.amount) ?? 0));
        const rest = bill.grand - fixed.reduce((a, b) => a + b, 0);
        return split.map((s, i) => ({ mode: s.mode, amount: s.amount == null ? Math.max(0, rest) : fixed[i], referenceNo: s.ref }));
      })()
    : [{ mode, amount: bill.grand, referenceNo: ref }];
  const remaining = bill.grand - sumPayments(payments);
  const cashBlocked = bill.grand > 0 && isCashBlocked(payments);
  const panNeeded = panRequired(bill.grand);
  const errors = checkBill({
    grand: bill.grand,
    itemCount: validItems.length + parsed.filter((p) => !p.blank && !p.input).length,
    itemErrors,
    payments,
    pan: buyer.pan,
    form60: buyer.form60,
    mobile: buyer.mobile,
  });

  // ---------- effects ----------
  useEffect(() => {
    if (focusKey == null) return;
    formRef.current?.querySelector<HTMLInputElement>(`[data-desc="${focusKey}"]`)?.focus();
    setFocusKey(null);
  }, [focusKey]);

  // Customer lookup on 10 digits
  useEffect(() => {
    if (!/^\d{10}$/.test(buyer.mobile)) {
      setRepeat(false);
      return;
    }
    let stale = false;
    findCustomer(buyer.mobile).then((c) => {
      if (stale || !c) return;
      setBuyer((b) => ({ ...b, ...c, state: c.state || settings.state, stateCode: c.state ? c.stateCode : settings.stateCode, form60: false }));
      setRepeat(true);
    });
    return () => {
      stale = true;
    };
  }, [buyer.mobile, settings.state, settings.stateCode]);

  // Keyboard shortcuts
  const saveRef = useRef<() => void>(() => {});
  saveRef.current = () => void save();
  useEffect(() => {
    if (!active || done) return;
    const h = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        saveRef.current();
      } else if (mod && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        addRow();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [active, done]);

  // ---------- actions ----------
  const setB = <K extends keyof Buyer>(k: K, v: Buyer[K]) => setBuyer((b) => ({ ...b, [k]: v }));
  const setRow = (key: number, patch: Partial<RowState>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  function addRow() {
    const r = newRow(settings.hsn);
    setRows((rs) => [...rs, r]);
    setFocusKey(r.key);
  }
  const removeRow = (key: number) => setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.key !== key) : [newRow(settings.hsn)]));

  const startSplit = () => setSplit([
    { key: nextKey++, mode, amount: '', ref },
    { key: nextKey++, mode: mode === 'Cash' ? 'UPI' : 'Cash', amount: null, ref: '' },
  ]);
  const addSplit = () =>
    setSplit((sp) => [
      ...(sp ?? []).map((s, i) => (s.amount == null ? { ...s, amount: paiseToInput(payments[i].amount) } : s)),
      { key: nextKey++, mode: 'Cash', amount: null, ref: '' },
    ]);
  const setSplitRow = (key: number, patch: Partial<SplitRow>) => setSplit((sp) => sp!.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const removeSplit = (key: number) =>
    setSplit((sp) => {
      const left = sp!.filter((s) => s.key !== key);
      if (left.length <= 1) {
        if (left[0]) {
          setMode(left[0].mode);
          setRef(left[0].ref);
        }
        return null;
      }
      return left.map((s, i) => (i === left.length - 1 && !left.some((x) => x.amount == null) ? { ...s, amount: null } : s));
    });

  const reset = () => {
    setBuyer(emptyBuyer(settings));
    setRepeat(false);
    setRows([newRow(settings.hsn)]);
    setMode('Cash');
    setRef('');
    setSplit(null);
    setShowErrors(false);
  };

  async function save() {
    if (saving) return;
    setShowErrors(true);
    if (errors.length) return;
    setSaving(true);
    try {
      const date = todayISO();
      const fy = financialYear(date);
      const logoHash = settings.logo ? (await sha256Hex(settings.logo)).slice(0, 16) : '';
      const pays = payments.map((p) => ({ ...p, referenceNo: needsReference(p.mode) ? (p.referenceNo ?? '').trim() : '' }));
      const doc = buildBillDoc({ invoiceNo: '', date, shop: shopSnapshot(settings, logoHash), buyer, items: validItems, payments: pays });
      const b = doc.buyer;
      const payload: NewInvoicePayload = {
        date,
        fy,
        prefix: settings.invoicePrefix.trim() || 'SR',
        start_seq: settings.invoiceStart?.fy === fy ? settings.invoiceStart.seq : null,
        customer: b.mobile
          ? { mobile: b.mobile, name: b.name, relation: b.relation, relative_name: b.relativeName, address: b.address, state: b.state, state_code: b.stateCode, pan: b.pan }
          : null,
        buyer_snapshot: b,
        shop_snapshot: doc.shop,
        logo: settings.logo ? { hash: logoHash, data_url: settings.logo } : null,
        taxable: doc.taxable,
        cgst: doc.cgst,
        sgst: doc.sgst,
        round_off: doc.roundOff,
        grand_total: doc.grand,
        items: doc.items.map((it) => ({
          description: it.description,
          metal: it.metal,
          weight_mg: it.weightMg,
          rate_input: it.rateInput,
          rate_per_g: it.ratePerG,
          metal_value: it.metalValue,
          making_type: it.makingType,
          making_value: it.makingValue,
          making_amount: it.makingAmount,
          hsn: it.hsn,
        })),
        payments: pays.map((p) => ({ mode: p.mode, amount: p.amount, reference_no: p.referenceNo })),
      };
      const saved = await saveInvoice(payload);
      doc.invoiceNo = saved.invoice_no;
      reset();

      // The bill is saved. Everything below is output; failures are reported but never lose the bill.
      const result: Done = { doc, pdf: null, path: '', problem: '' };
      try {
        const out = await saveBillPdfs(doc, settings.logo, settings.billsFolder);
        result.pdf = out.customer;
        result.path = out.paths.customer;
      } catch (e) {
        result.problem = `The PDF could not be saved (${e}). Check the Bills folder in Settings, then reprint from Old Bills.`;
      }
      setDone(result);
      backupNow().catch(() => {});
      if (result.pdf) await printPdf(result.pdf).catch((e) => setDone({ ...result, problem: `Printing failed: ${e}` }));
    } catch (e) {
      alert(`The bill was NOT saved: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  const finishDone = () => {
    setDone(null);
    setTimeout(() => formRef.current?.querySelector<HTMLInputElement>('[data-first]')?.focus(), 0);
  };

  // ---------- render ----------
  return (
    <form ref={formRef} className="bill" onKeyDown={(e) => focusNextOnEnter(e)} onSubmit={(e) => e.preventDefault()} autoComplete="off">
      <div className="bill-main">
        <section className="card stack">
          <h3>Customer</h3>
          <div className="row">
            <label className="field" style={{ width: 220 }}>
              Mobile number
              <input
                data-nav
                data-first
                autoFocus
                inputMode="numeric"
                maxLength={10}
                value={buyer.mobile}
                className={showErrors && buyer.mobile && buyer.mobile.length !== 10 ? 'invalid' : ''}
                onChange={(e) => setB('mobile', e.target.value.replace(/\D/g, '').slice(0, 10))}
                placeholder="10 digits"
              />
            </label>
            {repeat && <div className="repeat">Repeat customer ✓</div>}
          </div>
          <div className="row">
            <label className="field grow">
              Name
              <input data-nav value={buyer.name} onChange={(e) => setB('name', e.target.value)} placeholder="Leave empty for “Cash”" />
            </label>
            <label className="field" style={{ width: 110 }}>
              Relation
              <select data-nav value={buyer.relation} onChange={(e) => setB('relation', e.target.value as Relation)}>
                <option value="">none</option>
                <option>S/o</option>
                <option>D/o</option>
                <option>W/o</option>
              </select>
            </label>
            <label className="field grow">
              Relative's name
              <input data-nav disabled={!buyer.relation} value={buyer.relativeName} onChange={(e) => setB('relativeName', e.target.value)} placeholder={buyer.relation ? 'optional' : ''} />
            </label>
          </div>
          <div className="row">
            <label className="field grow">
              <span>
                Address <span className="hint">(Shift+Enter for a new line)</span>
              </span>
              <textarea data-nav rows={2} value={buyer.address} onChange={(e) => setB('address', e.target.value)} />
            </label>
            <label className="field" style={{ width: 230 }}>
              State
              <select
                data-nav
                value={buyer.state}
                onChange={(e) => setBuyer((b) => ({ ...b, state: e.target.value, stateCode: stateCode(e.target.value) }))}
              >
                {STATES.map((s) => (
                  <option key={s.code} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="row">
            <label className="field" style={{ width: 220 }}>
              <span>
                PAN {panNeeded ? <span style={{ color: 'var(--danger)' }}>* required above ₹2 lakh</span> : <span className="hint">(optional)</span>}
              </span>
              <input
                data-nav
                maxLength={10}
                value={buyer.pan}
                className={panNeeded && !buyer.pan && !buyer.form60 ? 'invalid' : ''}
                onChange={(e) => setB('pan', e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                placeholder="ABCDE1234F"
              />
            </label>
            {panNeeded && !buyer.pan && (
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', paddingBottom: 10, fontWeight: 600 }}>
                <input type="checkbox" checked={buyer.form60} onChange={(e) => setB('form60', e.target.checked)} />
                Form 60 taken (customer has no PAN)
              </label>
            )}
          </div>
        </section>

        <section className="card">
          <h3>Items</h3>
          <table className="items">
            <thead>
              <tr>
                <th>Description</th>
                <th style={{ width: 80 }} title="Press Tab to reach this box">
                  HSN
                </th>
                <th style={{ width: 130 }}>Metal</th>
                <th style={{ width: 110 }}>Weight (g)</th>
                <th style={{ width: 130 }}>Rate (₹)</th>
                <th style={{ width: 190 }}>Making</th>
                <th style={{ width: 120, textAlign: 'right' }}>Amount</th>
                <th style={{ width: 28 }} />
              </tr>
            </thead>
            <tbody>
              {parsed.map(({ row: r, calc, blank }, idx) => {
                const isLast = idx === parsed.length - 1;
                return (
                  <tr key={r.key}>
                    <td>
                      <input data-nav data-desc={r.key} list="desc-suggestions" value={r.desc} onChange={(e) => setRow(r.key, { desc: e.target.value })} placeholder="e.g. Gold Ring" />
                    </td>
                    <td>
                      {/* Not on the Enter path: the default is right for most items; Tab or click to change it */}
                      <input list="hsn-suggestions" inputMode="numeric" maxLength={8} value={r.hsn} onChange={(e) => setRow(r.key, { hsn: e.target.value.replace(/[^0-9]/g, '') })} placeholder={settings.hsn} />
                    </td>
                    <td>
                      <select data-nav value={r.metal} onChange={(e) => setRow(r.key, { metal: e.target.value as Metal, rate: null })}>
                        {(Object.keys(METAL_LABEL) as Metal[]).map((m) => (
                          <option key={m} value={m}>
                            {METAL_LABEL[m]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
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
                    </td>
                    <td>
                      <input
                        data-nav
                        className={'num' + (showErrors && !blank && !(r.rate != null ? parsePaise(r.rate) : todayRate(r.metal)) ? ' invalid' : '')}
                        inputMode="decimal"
                        value={r.rate ?? paiseToInput(todayRate(r.metal))}
                        onChange={(e) => setRow(r.key, { rate: e.target.value })}
                        title={`${METAL_LABEL[r.metal]} rate ${RATE_UNIT_LABEL[r.metal]}`}
                      />
                      <div className="sub">
                        {RATE_UNIT_LABEL[r.metal]}
                        {r.rate != null && (
                          <>
                            {' · '}
                            <button type="button" className="link" style={{ fontSize: 'inherit', padding: 0 }} onClick={() => setRow(r.key, { rate: null })}>
                              use today's
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                    <td>
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
                            // Enter on the last item's making goes on to payment
                            if (e.key === 'Enter' && isLast) {
                              e.preventDefault();
                              e.stopPropagation();
                              formRef.current?.querySelector<HTMLElement>('[data-pay]')?.focus();
                            }
                          }}
                        />
                      </div>
                      {calc && calc.makingAmount > 0 && (
                        <div className="sub">
                          making ₹{fmtMoney(calc.makingAmount)}
                          {r.makingType === 'PCT' ? ` (${fmtPct(calc.makingValue)}%)` : ''}
                        </div>
                      )}
                    </td>
                    <td className="amount">{calc ? fmtMoney(calc.metalValue + calc.makingAmount) : '—'}</td>
                    <td>
                      <button type="button" className="rm" title="Remove item" tabIndex={-1} onClick={() => removeRow(r.key)}>
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <datalist id="hsn-suggestions">
            {HSN_SUGGESTIONS.map(([code, label]) => (
              <option key={code} value={code} label={label} />
            ))}
          </datalist>
          <datalist id="desc-suggestions">
            {SUGGESTIONS.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <button type="button" className="link" onClick={addRow}>
            + Add item <span className="hint">(Ctrl+I)</span>
          </button>
        </section>

        <section className="card stack">
          <h3>Payment</h3>
          {!split ? (
            <div className="row">
              <label className="field" style={{ width: 180 }}>
                Payment mode
                <select data-nav data-pay value={mode} onChange={(e) => setMode(e.target.value as PaymentMode)}>
                  {PAYMENT_MODES.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </label>
              {needsReference(mode) && (
                <label className="field grow">
                  {mode === 'Cheque' ? 'Cheque number' : 'UTR / Reference no.'}
                  <input data-nav value={ref} className={showErrors && !ref.trim() ? 'invalid' : ''} onChange={(e) => setRef(e.target.value)} />
                </label>
              )}
              <button type="button" className="link" style={{ paddingBottom: 12 }} onClick={startSplit}>
                + Split payment
              </button>
            </div>
          ) : (
            <div className="stack">
              {split.map((s, i) => (
                <div className="pay-row" key={s.key}>
                  <label className="field">
                    Mode
                    <select data-nav data-pay={i === 0 ? '' : undefined} value={s.mode} onChange={(e) => setSplitRow(s.key, { mode: e.target.value as PaymentMode })}>
                      {PAYMENT_MODES.map((m) => (
                        <option key={m}>{m}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>
                      Amount (₹) {s.amount == null && <span className="hint">— rest of the bill</span>}
                    </span>
                    <input
                      data-nav
                      className="num"
                      inputMode="decimal"
                      value={s.amount ?? paiseToInput(payments[i].amount)}
                      onChange={(e) => setSplitRow(s.key, { amount: e.target.value })}
                    />
                  </label>
                  {needsReference(s.mode) ? (
                    <label className="field">
                      {s.mode === 'Cheque' ? 'Cheque number' : 'UTR / Reference no.'}
                      <input data-nav value={s.ref} className={showErrors && !s.ref.trim() ? 'invalid' : ''} onChange={(e) => setSplitRow(s.key, { ref: e.target.value })} />
                    </label>
                  ) : (
                    <div />
                  )}
                  <button type="button" className="rm" title="Remove part" tabIndex={-1} onClick={() => removeSplit(s.key)}>
                    ×
                  </button>
                </div>
              ))}
              <div className="row" style={{ alignItems: 'center' }}>
                <button type="button" className="link" onClick={addSplit}>
                  + Add part
                </button>
                <span style={{ marginLeft: 'auto', fontWeight: 700, color: remaining === 0 ? 'var(--ok)' : 'var(--danger)' }}>
                  {remaining === 0 ? 'Parts add up ✓' : remaining > 0 ? `₹${fmtMoney(remaining)} still to allot` : `₹${fmtMoney(-remaining)} too much`}
                </span>
              </div>
            </div>
          )}
          {cashBlocked && <div className="alert error">{CASH_BLOCK_MSG}</div>}
        </section>
      </div>

      <aside className="summary">
        <section className="card stack">
          <h3>Bill summary</h3>
          <div className="lines">
            <span>Total weight</span>
            <span className="num">{fmtWeight(bill.totalWeightMg)} g</span>
            <span>Taxable value</span>
            <span className="num">₹{fmtMoney(bill.taxable)}</span>
            <span>CGST {fmtPct(bill.cgstRate)}%</span>
            <span className="num">₹{fmtMoney(bill.cgst)}</span>
            <span>SGST {fmtPct(bill.sgstRate)}%</span>
            <span className="num">₹{fmtMoney(bill.sgst)}</span>
            <span>Round off</span>
            <span className="num">{fmtRoundOff(bill.roundOff)}</span>
          </div>
          <div className="grand">
            <strong>Grand Total</strong>
            <span className="num">₹{fmtMoney(bill.grand)}</span>
          </div>
        </section>
        {showErrors && errors.length > 0 && (
          <div className="alert error">
            <ul>
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        )}
        <button type="button" className="btn primary big" disabled={saving || cashBlocked} onClick={() => save()}>
          {saving ? 'Saving…' : 'Save & Print'}
          <div className="hint" style={{ color: 'inherit', opacity: 0.85 }}>
            Ctrl+P
          </div>
        </button>
        <button type="button" className="link" style={{ alignSelf: 'center' }} onClick={() => confirm('Clear this bill and start again?') && reset()}>
          Clear form
        </button>
      </aside>

      {done && (
        <Modal title={`Bill ${done.doc.invoiceNo} saved`} onClose={finishDone}>
          <div>
            Total <b>₹{fmtMoney(done.doc.grand)}</b> · {done.doc.buyer.name}
          </div>
          {done.problem ? <div className="alert error">{done.problem}</div> : <div className="hint">Saved to {done.path}</div>}
          <div className="actions">
            {done.pdf && (
              <>
                <button type="button" className="btn" onClick={() => openPath(done.path)}>
                  Open PDF
                </button>
                <button type="button" className="btn" onClick={() => printPdf(done.pdf!)}>
                  Print again
                </button>
              </>
            )}
            <button type="button" className="btn primary" autoFocus onClick={finishDone}>
              New bill
            </button>
          </div>
        </Modal>
      )}
    </form>
  );
}
