// Estimate receipt for customers who don't want a GST bill. No GST, own number series (EST/26-27/001),
// saved and listed in Old Bills so every sale is tracked.
import { useEffect, useMemo, useRef, useState } from 'react';
import { calcEstimate, PAYMENT_MODES, type PaymentMode } from '../lib/calc';
import { fmtMoney, fmtMoneyShort, fmtRoundOff, fmtWeight, parsePaise } from '../lib/money';
import { buildEstimateDoc, shopSnapshot } from '../lib/bill';
import { CASH_BLOCK_MSG, isCashBlocked } from '../lib/validate';
import { financialYear, fmtBillDate, todayISO } from '../lib/fy';
import { backupNow, findCustomer, getRates, openPath, saveEstimate, sha256Hex, type NewEstimatePayload } from '../lib/api';
import { printPdf, saveEstimatePdf } from '../lib/output';
import { focusNextOnEnter } from '../lib/keys';
import { askYesNo, showError } from '../lib/dialogs';
import { Modal } from '../components/Modal';
import { ItemsEditor, newKey, parseRows, useItemRows } from '../components/ItemsEditor';
import type { DailyRates, EstimateCustomer, EstimateDoc, Settings } from '../lib/types';

const emptyCustomer = (): EstimateCustomer => ({ name: '', mobile: '', otherMobile: '' });

/** Old jewellery the customer gives in exchange: money only, no weight or rate. */
interface ExchangeRow {
  key: number;
  description: string;
  amount: string;
}

interface Done {
  doc: EstimateDoc;
  pdf: Uint8Array | null;
  path: string;
  problem: string;
}

export function Estimate({
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
  const [customer, setCustomer] = useState<EstimateCustomer>(emptyCustomer);
  const [repeat, setRepeat] = useState(false);
  const items = useItemRows(settings.hsn);
  const [mode, setMode] = useState<PaymentMode>('Cash');
  const [date, setDate] = useState(todayISO());
  const [dateRates, setDateRates] = useState<DailyRates | null>(null);
  const [exchanges, setExchanges] = useState<ExchangeRow[]>([]);
  const [focusExchange, setFocusExchange] = useState<number | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const today = todayISO();
  const backDated = date !== today;
  // A back-dated estimate uses that day's saved rates (if any); rates can still be typed on each item.
  const effectiveRates = backDated ? dateRates : rates;
  useEffect(() => {
    if (!backDated || !date) return setDateRates(null);
    let stale = false;
    getRates(date).then((r) => !stale && setDateRates(r));
    return () => {
      stale = true;
    };
  }, [date, backDated]);

  const { parsed, validItems, itemErrors, itemCount } = parseRows(items.rows, effectiveRates, settings.hsn);
  const exchangeAmounts = exchanges.map((x) => (x.amount.trim() ? parsePaise(x.amount) : 0));
  const est = useMemo(
    () => calcEstimate(validItems, exchangeAmounts.map((a) => a ?? 0)),
    [JSON.stringify(validItems), JSON.stringify(exchangeAmounts)],
  );
  // 269ST applies to the cash actually received: the balance after the exchange
  const cashBlocked = mode === 'Cash' && isCashBlocked([{ mode, amount: est.grand }]);
  const errors = [
    ...(!date ? ['Choose the estimate date.'] : date > today ? ['The estimate date cannot be in the future.'] : []),
    ...itemErrors,
    ...exchangeAmounts.flatMap((a, i) => (a == null ? [`Old jewellery ${i + 1}: amount is not a valid number.`] : [])),
    ...(est.exchangeTotal > 0 && est.grand < 0 ? ['Old jewellery value is more than the purchase. Check the amounts.'] : []),
    ...(itemCount === 0 ? ['Add at least one item.'] : []),
    ...(customer.mobile && !/^\d{10}$/.test(customer.mobile) ? ['Mobile number must be 10 digits.'] : []),
    ...(customer.otherMobile && !/^\d{10}$/.test(customer.otherMobile) ? ['Other mobile number must be 10 digits.'] : []),
    ...(cashBlocked ? [CASH_BLOCK_MSG] : []),
  ];

  // Repeat customer: fill the name from the mobile number
  useEffect(() => {
    if (!/^\d{10}$/.test(customer.mobile)) {
      setRepeat(false);
      return;
    }
    let stale = false;
    findCustomer(customer.mobile).then((c) => {
      if (stale || !c) return;
      setCustomer((x) => ({
        ...x,
        name: x.name.trim() ? x.name : c.name === 'Cash' ? '' : c.name,
        otherMobile: x.otherMobile || c.otherMobile,
      }));
      setRepeat(true);
    });
    return () => {
      stale = true;
    };
  }, [customer.mobile]);

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

  const reset = () => {
    setCustomer(emptyCustomer());
    setRepeat(false);
    items.reset();
    setMode('Cash');
    setDate(todayISO());
    setExchanges([]);
    setShowErrors(false);
  };

  async function save() {
    if (saving) return;
    setShowErrors(true);
    if (errors.length) return;
    setSaving(true);
    try {
      const fy = financialYear(date);
      const exch = exchanges.map((x, i) => ({ description: x.description, amount: exchangeAmounts[i] ?? 0 }));
      const logoHash = settings.logo ? (await sha256Hex(settings.logo)).slice(0, 16) : '';
      const doc = buildEstimateDoc({ estimateNo: '', date, shop: shopSnapshot(settings, logoHash), customer, items: validItems, exchanges: exch, paymentMode: mode });
      const payload: NewEstimatePayload = {
        date,
        fy,
        prefix: (settings.estimatePrefix || 'EST').trim() || 'EST',
        customer: doc.customer.mobile ? { mobile: doc.customer.mobile, name: customer.name.trim(), other_mobile: doc.customer.otherMobile } : null,
        customer_snapshot: doc.customer,
        shop_snapshot: doc.shop,
        logo: settings.logo ? { hash: logoHash, data_url: settings.logo } : null,
        subtotal: doc.subtotal,
        round_off: doc.roundOff,
        grand_total: doc.grand,
        payment_mode: doc.paymentMode,
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
        })),
        exchanges: doc.exchanges,
      };
      const saved = await saveEstimate(payload);
      doc.estimateNo = saved.estimate_no;
      reset();
      onSaved();

      const result: Done = { doc, pdf: null, path: '', problem: '' };
      try {
        const out = await saveEstimatePdf(doc, settings.logo, settings.billsFolder);
        result.pdf = out.bytes;
        result.path = out.path;
      } catch (e) {
        result.problem = `The PDF could not be saved (${e}). Check the Bills folder in Settings, then reprint from Old Bills.`;
      }
      setDone(result);
      backupNow().catch(() => {});
      if (result.pdf) await printPdf(result.pdf).catch((e) => setDone({ ...result, problem: `Printing failed: ${e}` }));
    } catch (e) {
      showError(`The estimate was NOT saved: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  const finishDone = () => {
    setDone(null);
    setTimeout(() => formRef.current?.querySelector<HTMLInputElement>('[data-first]')?.focus(), 0);
  };

  useEffect(() => {
    if (focusExchange == null) return;
    document.querySelector<HTMLInputElement>(`[data-exch="${focusExchange}"]`)?.focus();
    setFocusExchange(null);
  }, [focusExchange]);
  const addExchange = () => {
    const k = newKey();
    setExchanges((xs) => [...xs, { key: k, description: '', amount: '' }]);
    setFocusExchange(k);
  };
  const setExchange = (key: number, patch: Partial<ExchangeRow>) => setExchanges((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  const setC = (k: keyof EstimateCustomer, v: string) => setCustomer((c) => ({ ...c, [k]: v }));
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 10);

  return (
    <form ref={formRef} className="bill" onKeyDown={(e) => focusNextOnEnter(e)} onSubmit={(e) => e.preventDefault()} autoComplete="off">
      <div className="bill-main">
        <div className="alert estimate-note">Estimate · no GST · not a tax invoice. Numbered separately ({(settings.estimatePrefix || 'EST') + '/' + financialYear(todayISO()) + '/…'}).</div>
        <section className="card stack">
          <h3>Customer</h3>
          <div className="row">
            <label className="field" style={{ width: 170 }} title="Change only for an estimate of an earlier day">
              Date
              <input type="date" value={date} max={today} className={date > today || !date ? 'invalid' : ''} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label className="field" style={{ width: 220 }}>
              Mobile number
              <input data-nav data-first inputMode="numeric" maxLength={10} value={customer.mobile} onChange={(e) => setC('mobile', digits(e.target.value))} placeholder="10 digits" />
            </label>
            <label className="field grow">
              Name
              <input data-nav value={customer.name} onChange={(e) => setC('name', e.target.value)} placeholder="Leave empty for “Cash”" />
            </label>
            <label className="field" style={{ width: 220 }}>
              <span>
                Other mobile <span className="hint">(optional)</span>
              </span>
              <input data-nav inputMode="numeric" maxLength={10} value={customer.otherMobile} onChange={(e) => setC('otherMobile', digits(e.target.value))} />
            </label>
          </div>
          {repeat && <div className="repeat">Repeat customer ✓</div>}
          {backDated && date && date < today && (
            <div className="alert backdated">
              Back-dated estimate for <b>{fmtBillDate(date)}</b>.{' '}
              {dateRates
                ? `Using that day's rates: Gold 22K ₹${fmtMoneyShort(dateRates.gold22)}/10g, Gold 18K ₹${fmtMoneyShort(dateRates.gold18)}/10g, Silver ₹${fmtMoneyShort(dateRates.silver)}/kg.`
                : 'No rates were saved for that day: type the rate in each item.'}{' '}
              <button type="button" className="link" onClick={() => setDate(today)}>
                Back to today
              </button>
            </div>
          )}
        </section>

        <ItemsEditor
          parsed={parsed}
          rates={effectiveRates}
          showErrors={showErrors}
          showHsn={false}
          defaultHsn={settings.hsn}
          suggestions={suggestions}
          setRow={items.setRow}
          addRow={items.addRow}
          removeRow={items.removeRow}
          onLastEnter={() => formRef.current?.querySelector<HTMLElement>(exchanges.length ? '[data-exch]' : '[data-pay]')?.focus()}
        />

        <section className="card stack">
          <h3>Old jewellery exchange</h3>
          {exchanges.length === 0 && <div className="hint">If the customer gives old jewellery, add its value here. Only the amount is printed (no weight or rate).</div>}
          {exchanges.map((x, i) => (
            <div className="exch-row" key={x.key}>
              <label className="field">
                <span>
                  Old item <span className="hint">(optional, e.g. old payal)</span>
                </span>
                <input data-nav data-exch={x.key} value={x.description} onChange={(e) => setExchange(x.key, { description: e.target.value })} />
              </label>
              <label className="field">
                Value (₹)
                <input
                  data-nav
                  className={'num' + (showErrors && exchangeAmounts[i] == null ? ' invalid' : '')}
                  inputMode="decimal"
                  value={x.amount}
                  onChange={(e) => setExchange(x.key, { amount: e.target.value })}
                  placeholder="0"
                />
              </label>
              <button type="button" className="rm" title="Remove" tabIndex={-1} onClick={() => setExchanges((xs) => xs.filter((y) => y.key !== x.key))}>
                ×
              </button>
            </div>
          ))}
          <button type="button" className="link" style={{ alignSelf: 'flex-start' }} onClick={addExchange}>
            + Add old jewellery
          </button>
        </section>

        <section className="card stack">
          <h3>Payment</h3>
          <div className="row">
            <label className="field" style={{ width: 180 }}>
              Payment mode
              <select data-nav data-pay value={mode} onChange={(e) => setMode(e.target.value as PaymentMode)}>
                {PAYMENT_MODES.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
          </div>
          {cashBlocked && <div className="alert error">{CASH_BLOCK_MSG}</div>}
        </section>
      </div>

      <aside className="summary">
        <section className="card stack">
          <h3>Estimate summary</h3>
          <div className="lines">
            <span>Date</span>
            <span className="num" style={backDated ? { color: '#7a5200', fontWeight: 700 } : undefined}>
              {date ? fmtBillDate(date) : '—'}
            </span>
            <span>Total weight</span>
            <span className="num">{fmtWeight(est.totalWeightMg)} g</span>
            <span>Items total</span>
            <span className="num">₹{fmtMoney(est.subtotal)}</span>
            {est.exchangeTotal > 0 && (
              <>
                <span>Less: old jewellery</span>
                <span className="num">(-)₹{fmtMoney(est.exchangeTotal)}</span>
              </>
            )}
            <span>Round off</span>
            <span className="num">{fmtRoundOff(est.roundOff)}</span>
          </div>
          <div className="grand">
            <strong>{est.exchangeTotal > 0 ? 'Balance to pay' : 'Total'}</strong>
            <span className="num">₹{fmtMoney(est.grand)}</span>
          </div>
          <div className="hint">No GST on estimates.</div>
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
          {saving ? 'Saving…' : 'Save & Print Estimate'}
          <div className="hint" style={{ color: 'inherit', opacity: 0.85 }}>
            Ctrl+P
          </div>
        </button>
        <button type="button" className="link" style={{ alignSelf: 'center' }} onClick={async () => (await askYesNo('Clear this estimate and start again?', 'Clear')) && reset()}>
          Clear form
        </button>
      </aside>

      {done && (
        <Modal title={`Estimate ${done.doc.estimateNo} saved`} onClose={finishDone}>
          <div>
            Total <b>₹{fmtMoney(done.doc.grand)}</b> · {done.doc.customer.name}
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
              New estimate
            </button>
          </div>
        </Modal>
      )}
    </form>
  );
}
