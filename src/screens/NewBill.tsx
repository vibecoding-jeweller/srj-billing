import { useEffect, useMemo, useRef, useState } from 'react';
import { calcBill, needsReference, PAYMENT_MODES, sumPayments, type Payment, type PaymentMode } from '../lib/calc';
import { fmtMoney, fmtPct, fmtRoundOff, fmtWeight, paiseToInput, parsePaise } from '../lib/money';
import { buildBillDoc, shopSnapshot } from '../lib/bill';
import { CASH_BLOCK_MSG, checkBill, isCashBlocked, panRequired } from '../lib/validate';
import { STATES, stateCode } from '../lib/states';
import { financialYear, fmtBillDate, todayISO } from '../lib/fy';
import { backupNow, findCustomer, saveInvoice, sha256Hex, openPath, type NewInvoicePayload } from '../lib/api';
import { printPdf, saveBillPdfs } from '../lib/output';
import { focusNextOnEnter } from '../lib/keys';
import { askYesNo, showError } from '../lib/dialogs';
import { Modal } from '../components/Modal';
import { ItemsEditor, newKey, parseRows, useItemRows } from '../components/ItemsEditor';
import type { BillDoc, Buyer, DailyRates, Relation, Settings } from '../lib/types';

interface SplitRow {
  key: number;
  mode: PaymentMode;
  /** null = automatically the rest of the bill (only the last part) */
  amount: string | null;
  ref: string;
}

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

export function NewBill({
  settings,
  rates,
  active,
  suggestions,
  onSaved,
}: {
  settings: Settings;
  rates: DailyRates | null;
  active: boolean;
  suggestions: string[];
  onSaved: () => void;
}) {
  const [buyer, setBuyer] = useState<Buyer>(() => emptyBuyer(settings));
  const [repeat, setRepeat] = useState(false);
  const items = useItemRows(settings.hsn);
  const [mode, setMode] = useState<PaymentMode>('Cash');
  const [ref, setRef] = useState('');
  const [split, setSplit] = useState<SplitRow[] | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // ---------- derive ----------
  const { parsed, validItems, itemErrors, itemCount } = parseRows(items.rows, rates, settings.hsn);
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
    itemCount,
    itemErrors,
    payments,
    pan: buyer.pan,
    form60: buyer.form60,
    mobile: buyer.mobile,
  });

  // ---------- effects ----------
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
  // Opening this tab puts the cursor in the mobile number box, unless something in the form already has it.
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => {
      if (!formRef.current?.contains(document.activeElement)) formRef.current?.querySelector<HTMLInputElement>('[data-first]')?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [active]);

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
        items.addRow();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [active, done]);

  // ---------- actions ----------
  const setB = <K extends keyof Buyer>(k: K, v: Buyer[K]) => setBuyer((b) => ({ ...b, [k]: v }));
  const startSplit = () => setSplit([
    { key: newKey(), mode, amount: '', ref },
    { key: newKey(), mode: mode === 'Cash' ? 'UPI' : 'Cash', amount: null, ref: '' },
  ]);
  const addSplit = () =>
    setSplit((sp) => [
      ...(sp ?? []).map((s, i) => (s.amount == null ? { ...s, amount: paiseToInput(payments[i].amount) } : s)),
      { key: newKey(), mode: 'Cash', amount: null, ref: '' },
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
    items.reset();
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
      onSaved();

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
      showError(`The bill was NOT saved: ${e}`);
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

        <ItemsEditor
          parsed={parsed}
          rates={rates}
          showErrors={showErrors}
          showHsn
          defaultHsn={settings.hsn}
          suggestions={suggestions}
          setRow={items.setRow}
          addRow={items.addRow}
          removeRow={items.removeRow}
          onLastEnter={() => formRef.current?.querySelector<HTMLElement>('[data-pay]')?.focus()}
        />

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
            <span>Bill date</span>
            <span className="num">{fmtBillDate(todayISO())}</span>
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
        <button type="button" className="link" style={{ alignSelf: 'center' }} onClick={async () => (await askYesNo('Clear this bill and start again?', 'Clear')) && reset()}>
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
