import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  backupNow,
  cancelEstimate,
  cancelInvoice,
  daySummaries,
  estimateEdits,
  getDues,
  getEstimateDoc,
  getInvoiceDoc,
  listReceipts,
  listRecords,
  saveReceipt,
  summaryRecords,
  type Dues,
  type ReceiptRow,
  updateEstimateCustomer,
  type FieldEdit,
  type RecordFilter,
  type RecordKind,
  type RecordRow,
  type RecordsSummary,
} from '../lib/api';
import { financialYear, fmtBillDate, todayISO } from '../lib/fy';
import { fmtMoney, fmtMoneyShort, fmtWeight, parsePaise } from '../lib/money';
import { needsReference, PAYMENT_MODES, type PaymentMode } from '../lib/calc';
import { makeEstimatePdf, makePdf, openCopy, openEstimate, printPdf, saveEstimatePdf, saveReceiptPdf } from '../lib/output';
import { fmtDayHeader, groupByDate, PAGE_SIZE, presetRange, PRESETS, totalSale, type Preset } from '../lib/records';
import { Modal } from '../components/Modal';
import type { BillDoc, EstimateDoc, ReceiptDoc, Settings } from '../lib/types';

const KIND_LABEL: Record<RecordKind, string> = { BILL: 'Bill', EST: 'Estimate' };

// Remembered while the app is open (so switching tabs keeps the choice); a fresh start always opens on Today.
const remembered: { preset: Preset; from: string; to: string } = { preset: 'today', from: '', to: '' };

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el) return false;
  if (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'search' && !el.hasAttribute('data-list-search');
};

/** GST bills and estimates in one list, so every sale can be tracked. */
export function OldBills({ settings }: { settings: Settings }) {
  const [preset, setPreset] = useState<Preset>(remembered.preset);
  const [customFrom, setCustomFrom] = useState(remembered.from);
  const [customTo, setCustomTo] = useState(remembered.to);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'' | RecordKind>('');
  const [showCancelled, setShowCancelled] = useState(false);

  const [rows, setRows] = useState<RecordRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [summary, setSummary] = useState<RecordsSummary | null>(null);
  const [days, setDays] = useState<Map<string, { n: number; total: number }>>(new Map());
  const [selected, setSelected] = useState(0);
  const [panel, setPanel] = useState<RecordRow | null>(null);
  const [panelVersion, setPanelVersion] = useState(0);
  const [editing, setEditing] = useState<RecordRow | null>(null);
  const [cancelling, setCancelling] = useState<RecordRow | null>(null);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    remembered.preset = preset;
    remembered.from = customFrom;
    remembered.to = customTo;
  }, [preset, customFrom, customTo]);

  const range = preset === 'custom' ? { from: customFrom, to: customTo } : presetRange(preset, todayISO());
  const filter: RecordFilter = useMemo(
    () => ({ q, from: range.from, to: range.to, kind, showCancelled }),
    [q, range.from, range.to, kind, showCancelled],
  );

  const load = useCallback(async () => {
    try {
      const [page, sum, perDay] = await Promise.all([listRecords(filter, 0), summaryRecords(filter), daySummaries(filter)]);
      setRows(page);
      setHasMore(page.length === PAGE_SIZE);
      setSummary(sum);
      setDays(perDay);
      setSelected(0);
    } catch (e) {
      setMsg({ kind: 'error', text: String(e) });
    }
  }, [filter]);

  useEffect(() => {
    const t = setTimeout(load, 150);
    return () => clearTimeout(t);
  }, [load]);

  const loadMore = async () => {
    const page = await listRecords(filter, rows.length);
    setRows((r) => [...r, ...page]);
    setHasMore(page.length === PAGE_SIZE);
  };

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ kind: 'error', text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const confirmCancel = () =>
    run(async () => {
      if (!cancelling || !reason.trim()) return;
      if (cancelling.kind === 'BILL') await cancelInvoice(cancelling.id, reason.trim());
      else await cancelEstimate(cancelling.id, reason.trim());
      setMsg({ kind: 'ok', text: `${KIND_LABEL[cancelling.kind]} ${cancelling.no} marked CANCELLED. Its number will not be used again.` });
      setCancelling(null);
      setReason('');
      setPanel(null);
      await load();
      backupNow().catch(() => {});
    });

  /** After a customer correction: refresh the list and re-open the panel with the new details. */
  const afterEdit = async (r: RecordRow, changed: number) => {
    setEditing(null);
    if (!changed) return;
    setMsg({ kind: 'ok', text: `Customer corrected on ${r.no}. The estimate PDF was updated.` });
    await load();
    setPanel((p) => (p && p.kind === r.kind && p.id === r.id ? { ...p } : p));
    setPanelVersion((v) => v + 1);
  };

  // Keyboard: ↑/↓ move through rows, Enter opens the panel, Esc closes it.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (cancelling || editing) return;
      if (e.key === 'Escape' && panel) {
        e.preventDefault();
        setPanel(null);
        return;
      }
      if (isTyping(e.target)) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((i) => Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))));
      } else if (e.key === 'Enter' && rows[selected]) {
        e.preventDefault();
        setPanel(rows[selected]);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [rows, selected, panel, cancelling, editing]);

  // keep the selected row in view; while the panel is open, it follows the selection
  useEffect(() => {
    listRef.current?.querySelector(`[data-row="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
    if (panel && rows[selected] && (rows[selected].kind !== panel.kind || rows[selected].id !== panel.id)) setPanel(rows[selected]);
  }, [selected]);
  useEffect(() => {
    if (!panel) return;
    const fresh = rows.find((r) => r.kind === panel.kind && r.id === panel.id);
    if (fresh && (fresh.name !== panel.name || fresh.mobile !== panel.mobile)) setPanel(fresh);
  }, [rows]);

  const groups = groupByDate(rows);
  let flatIndex = -1;
  const rangeText = range.from && range.to ? (range.from === range.to ? fmtBillDate(range.from) : `${fmtBillDate(range.from)} – ${fmtBillDate(range.to)}`) : range.from ? `from ${fmtBillDate(range.from)}` : range.to ? `up to ${fmtBillDate(range.to)}` : 'all dates';

  return (
    <div className={'records' + (panel ? ' with-panel' : '')}>
      <div className="stack">
        <div className="presets">
          {PRESETS.map((p) => (
            <button key={p.id} className={'chip' + (preset === p.id ? ' on' : '')} onClick={() => setPreset(p.id)}>
              {p.label}
            </button>
          ))}
          {preset === 'custom' && (
            <span className="custom-range">
              <input type="date" value={customFrom} max={customTo || undefined} onChange={(e) => setCustomFrom(e.target.value)} aria-label="From" />
              <span className="hint">to</span>
              <input type="date" value={customTo} min={customFrom || undefined} onChange={(e) => setCustomTo(e.target.value)} aria-label="To" />
            </span>
          )}
        </div>
        <div className="row" style={{ alignItems: 'center' }}>
          <input
            className="grow"
            type="search"
            data-list-search
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, mobile, bill or estimate no.   (↑ ↓ to move, Enter to open)"
          />
          <select value={kind} onChange={(e) => setKind(e.target.value as '' | RecordKind)} style={{ width: 170 }} aria-label="Show">
            <option value="">Bills + Estimates</option>
            <option value="BILL">Bills only</option>
            <option value="EST">Estimates only</option>
          </select>
          <label className="toggle">
            <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />
            Show cancelled
          </label>
        </div>

        <div className="sales-card">
          <div className="sales-head">
            <span className="range">{rangeText}</span>
            {(summary?.cancelled ?? 0) > 0 && (
              <span className="hint">
                {summary!.cancelled} cancelled {showCancelled ? '(shown, not counted)' : '(hidden, not counted)'}
              </span>
            )}
          </div>
          <div className="sales-tiles">
            {!kind && (
              <div className="tile hero">
                <span className="tile-label">Total sale</span>
                <b>₹{fmtMoneyShort(summary ? totalSale(summary) : 0)}</b>
                <span className="tile-sub">bills + estimates + old jewellery</span>
              </div>
            )}
            {kind !== 'EST' && (
              <div className="tile">
                <span className="tile-label">GST bills</span>
                <b>₹{fmtMoneyShort(summary?.bills.total ?? 0)}</b>
                <span className="tile-sub">{summary?.bills.n ?? 0} bills</span>
              </div>
            )}
            {kind !== 'BILL' && (
              <div className="tile">
                <span className="tile-label">Estimates</span>
                <b>₹{fmtMoneyShort(summary?.estimates.total ?? 0)}</b>
                <span className="tile-sub">{summary?.estimates.n ?? 0} estimates</span>
              </div>
            )}
            {kind !== 'BILL' && (
              <div className="tile">
                <span className="tile-label">Old jewellery taken</span>
                <b>₹{fmtMoneyShort(summary?.estimates.exchange ?? 0)}</b>
                <span className="tile-sub">counted in the sale</span>
              </div>
            )}
          </div>
        </div>
        {msg && <div className={'alert ' + msg.kind}>{msg.text}</div>}

        <div className="records-list" ref={listRef}>
          {rows.length === 0 ? (
            <div className="empty">
              {q ? `Nothing found for “${q}” (${rangeText}).` : preset === 'today' ? 'No sales today yet.' : `No sales for ${rangeText}.`}
              {(q || preset !== 'custom' || customFrom || customTo) && range.from !== '' && (
                <button
                  className="link"
                  onClick={() => {
                    setPreset('custom');
                    setCustomFrom('');
                    setCustomTo('');
                  }}
                >
                  Search all dates
                </button>
              )}
            </div>
          ) : (
            <table className="list records-table">
              <thead>
                <tr>
                  <th style={{ width: 90 }}>Type</th>
                  <th style={{ width: 140 }}>Number</th>
                  <th>Customer</th>
                  <th>Payment</th>
                  <th style={{ textAlign: 'right', width: 140 }}>Total</th>
                </tr>
              </thead>
              {groups.map((g) => {
                const d = days.get(g.date);
                return (
                  <tbody key={g.date}>
                    <tr className="day-head">
                      <td colSpan={5}>
                        <b>{fmtDayHeader(g.date)}</b>
                        <span className="hint">
                          {' · '}
                          {d ? `${d.n} sale${d.n === 1 ? '' : 's'} · ` : ''}
                        </span>
                        {d && <b className="num">₹{fmtMoney(d.total)}</b>}
                      </td>
                    </tr>
                    {g.rows.map((r) => {
                      flatIndex++;
                      const i = flatIndex;
                      const open = panel && panel.kind === r.kind && panel.id === r.id;
                      return (
                        <tr
                          key={r.kind + r.id}
                          data-row={i}
                          className={'clickable' + (r.status === 'CANCELLED' ? ' cancelled' : '') + (i === selected ? ' cursor' : '') + (open ? ' selected' : '')}
                          onClick={() => {
                            setSelected(i);
                            setPanel(r);
                          }}
                        >
                          <td>
                            <span className={'badge ' + (r.kind === 'BILL' ? 'kind-bill' : 'kind-est')}>{KIND_LABEL[r.kind]}</span>
                          </td>
                          <td className="nowrap">
                            <b>{r.no}</b>
                          </td>
                          <td>
                            {r.name}
                            {r.mobile && <span className="hint"> · {r.mobile}</span>}
                          </td>
                          <td>
                            {r.status === 'CANCELLED' ? <span className="badge cancel">CANCELLED</span> : r.modes}
                            {r.status === 'ACTIVE' && Number(r.due) > 0 && <span className="badge due">Due ₹{fmtMoneyShort(Number(r.due))}</span>}
                          </td>
                          <td className="num nowrap">
                            <span className={r.status === 'CANCELLED' ? 'struck' : ''}>₹{fmtMoney(r.grand_total)}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                );
              })}
            </table>
          )}
          {hasMore && (
            <button className="btn load-more" onClick={loadMore}>
              Load more
            </button>
          )}
        </div>
      </div>

      {panel && (
        <RecordPanel
          key={panel.kind + panel.id + ':' + panelVersion}
          record={panel}
          settings={settings}
          busy={busy}
          run={run}
          onClose={() => setPanel(null)}
          onCancel={() => setCancelling(panel)}
          onEdit={() => setEditing(panel)}
          onPaid={async (text) => {
            setMsg({ kind: 'ok', text });
            await load();
            setPanelVersion((v) => v + 1);
          }}
        />
      )}

      {editing && <EditCustomerModal record={editing} settings={settings} onClose={(changed) => afterEdit(editing, changed)} />}

      {cancelling && (
        <Modal title={`Cancel ${KIND_LABEL[cancelling.kind].toLowerCase()} ${cancelling.no}?`} onClose={() => setCancelling(null)}>
          <div>
            ₹{fmtMoney(cancelling.grand_total)} · {cancelling.name} · {fmtBillDate(cancelling.date)}
          </div>
          <div className="hint">It stays in the list marked CANCELLED. This cannot be undone, and the number is never reused.</div>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              confirmCancel();
            }}
          >
            <label className="field">
              Reason for cancelling <span className="req">*</span>
              <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. wrong weight entered" />
            </label>
            <div className="actions">
              <button type="button" className="btn" onClick={() => setCancelling(null)}>
                Keep it
              </button>
              <button type="submit" className="btn primary" disabled={!reason.trim() || busy}>
                Cancel {KIND_LABEL[cancelling.kind].toLowerCase()}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

/** Details of one bill or estimate, with its actions. Without onCancel/onEdit (e.g. from Reports) it only views and reprints. */
export function RecordPanel({
  record,
  settings,
  busy,
  run,
  onClose,
  onCancel,
  onEdit,
  onPaid,
}: {
  record: RecordRow;
  settings: Settings;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onClose: () => void;
  onCancel?: () => void;
  onEdit?: () => void;
  onPaid?: (message: string) => void;
}) {
  const [dues, setDues] = useState<Dues | null>(null);
  const [receipts, setReceipts] = useState<ReceiptRow[]>([]);
  const [paying, setPaying] = useState(false);
  useEffect(() => {
    getDues(record.kind, record.id).then(setDues).catch(() => {});
    listReceipts(record.kind, record.id).then(setReceipts).catch(() => {});
  }, [record.kind, record.id]);
  const [data, setData] = useState<{ bill?: BillDoc; est?: EstimateDoc; logo: string } | null>(null);
  const [err, setErr] = useState('');
  const [edits, setEdits] = useState<(FieldEdit & { edited_at: string })[]>([]);
  useEffect(() => {
    if (record.kind === 'EST') estimateEdits(record.id).then(setEdits).catch(() => {});
  }, [record.kind, record.id]);
  useEffect(() => {
    (record.kind === 'BILL'
      ? getInvoiceDoc(record.id).then((r) => ({ bill: r.doc, logo: r.logo }))
      : getEstimateDoc(record.id).then((r) => ({ est: r.doc, logo: r.logo }))
    )
      .then(setData)
      .catch((e) => setErr(String(e)));
  }, [record.kind, record.id]);

  const doc = data?.bill ?? data?.est;
  const items = doc?.items ?? [];
  const isBill = record.kind === 'BILL';

  const reprint = () =>
    run(async () => {
      if (data?.bill) await printPdf(await makePdf(data.bill, 'customer', data.logo));
      if (data?.est) await printPdf(await makeEstimatePdf(data.est, data.logo));
    });
  const openPdf = () =>
    run(async () => {
      if (data?.bill) await openCopy(data.bill, data.logo, settings.billsFolder, 'store');
      if (data?.est) await openEstimate(data.est, data.logo, settings.billsFolder);
    });

  return (
    <aside className="record-panel card stack">
      <div className="panel-head">
        <span className={'badge ' + (isBill ? 'kind-bill' : 'kind-est')}>{KIND_LABEL[record.kind]}</span>
        <b className="panel-no">{record.no}</b>
        {record.status === 'CANCELLED' && <span className="badge cancel">CANCELLED</span>}
        <button className="rm" title="Close (Esc)" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="hint">{fmtDayHeader(record.date)}</div>
      {record.status === 'CANCELLED' && record.cancel_reason && <div className="alert error">Cancelled: {record.cancel_reason}</div>}

      <div>
        <b>{record.name}</b>
        <div className="hint">{[record.mobile, data?.est?.customer.otherMobile].filter(Boolean).join(', ') || 'No mobile'}</div>
        {data?.bill?.buyer.address && <div className="hint">{data.bill.buyer.address}</div>}
      </div>

      {err && <div className="alert error">{err}</div>}
      {!doc && !err && <div className="hint">Loading…</div>}
      {doc && (
        <>
          <table className="list compact">
            <thead>
              <tr>
                <th>Item</th>
                <th style={{ textAlign: 'right' }}>Weight</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i}>
                  <td>{it.description}</td>
                  <td className="num nowrap">{fmtWeight(it.weightMg)} g</td>
                  <td className="num nowrap">₹{fmtMoney(it.metalValue + it.makingAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="panel-lines">
            {(doc?.discount ?? 0) > 0 && (
              <>
                <span>Discount{data?.bill ? ' (before GST)' : ''}</span>
                <span className="num">(-)₹{fmtMoney(doc!.discount!)}</span>
              </>
            )}
            {data?.bill && (
              <>
                <span>Taxable</span>
                <span className="num">₹{fmtMoney(data.bill.taxable)}</span>
                <span>CGST + SGST</span>
                <span className="num">₹{fmtMoney(data.bill.cgst + data.bill.sgst)}</span>
              </>
            )}
            {data?.est?.exchanges.map((x, i) => (
              <span key={i} style={{ display: 'contents' }}>
                <span>Less: old jewellery{x.description ? ` (${x.description})` : ''}</span>
                <span className="num">(-)₹{fmtMoney(x.amount)}</span>
              </span>
            ))}
            <span>
              <b>{data?.est?.exchangeTotal ? 'After old jewellery' : 'Total'}</b>
            </span>
            <span className="num">
              <b className={record.status === 'CANCELLED' ? 'struck' : ''}>₹{fmtMoney(record.grand_total)}</b>
            </span>
          </div>

          <div>
            <div className="hint">Payment</div>
            {data?.bill
              ? data.bill.payments.map((p, i) => (
                  <div key={i}>
                    {p.mode} ₹{fmtMoney(p.amount)}
                    {p.referenceNo && <span className="hint"> · Ref {p.referenceNo}</span>}
                  </div>
                ))
              : data?.est && (
                  <div>
                    {data.est.paymentMode}
                    {data.est.paidNow != null && ` ₹${fmtMoney(data.est.paidNow)} (advance)`}
                  </div>
                )}
            {receipts.map((r) => (
              <div key={r.id}>
                {r.mode} ₹{fmtMoney(r.amount)} <span className="hint">· {r.receipt_no} · {fmtBillDate(r.date)}{r.reference_no ? ` · Ref ${r.reference_no}` : ''}</span>
              </div>
            ))}
            {dues && dues.balance > 0 && record.status === 'ACTIVE' && (
              <div className="due-box">
                <span>
                  Paid ₹{fmtMoney(dues.paid)} · <b>Balance due ₹{fmtMoney(dues.balance)}</b>
                </span>
                {onPaid && (
                  <button className="btn primary" disabled={busy} onClick={() => setPaying(true)}>
                    Record payment…
                  </button>
                )}
              </div>
            )}
            {dues && dues.balance === 0 && receipts.length > 0 && <div className="ok-text">Paid in full</div>}
          </div>
        </>
      )}

      <div className="row">
        <button className="btn primary" disabled={!doc || busy} onClick={reprint}>
          Reprint
        </button>
        <button className="btn" disabled={!doc || busy} onClick={openPdf}>
          {isBill ? 'Store copy' : 'Open PDF'}
        </button>
      </div>
      {onEdit && !isBill && record.status === 'ACTIVE' && (
        <button className="btn" disabled={!doc || busy} onClick={onEdit} style={{ alignSelf: 'flex-start' }}>
          Edit customer…
        </button>
      )}
      {edits.length > 0 && (
        <div className="edit-log">
          <div className="hint">Customer corrected (not printed)</div>
          {edits.map((e, i) => (
            <div key={i} className="hint">
              {e.edited_at.slice(0, 16)} · {FIELD_LABEL[e.field] ?? e.field}: “{e.old_value || '—'}” → “{e.new_value || '—'}”
            </div>
          ))}
        </div>
      )}
      {paying && dues && doc && (
        <PaymentModal
          record={record}
          dues={dues}
          paidBefore={dues.paid}
          settings={settings}
          logo={data?.logo ?? ''}
          shop={doc.shop}
          onClose={(text) => {
            setPaying(false);
            if (text) onPaid?.(text);
          }}
        />
      )}
      {onCancel && isBill && <div className="hint">GST bills can't be edited. Cancel and make a new bill.</div>}
      {onCancel && record.status === 'ACTIVE' && (
        <button className="btn danger panel-cancel" disabled={busy} onClick={onCancel}>
          Cancel this {KIND_LABEL[record.kind].toLowerCase()}…
        </button>
      )}
    </aside>
  );
}

/** Record a later payment (balance) against a bill or estimate, then save and print a receipt. */
function PaymentModal({
  record,
  dues,
  paidBefore,
  settings,
  logo,
  shop,
  onClose,
}: {
  record: RecordRow;
  dues: Dues;
  paidBefore: number;
  settings: Settings;
  logo: string;
  shop: ReceiptDoc['shop'];
  onClose: (message?: string) => void;
}) {
  const [amountIn, setAmountIn] = useState(String(dues.balance / 100));
  const [mode, setMode] = useState<PaymentMode>('Cash');
  const [ref, setRef] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const amount = parsePaise(amountIn);

  const save = async () => {
    setErr('');
    if (amount == null || amount <= 0) return setErr('Enter the amount received.');
    if (amount > dues.balance) return setErr(`Only ₹${fmtMoney(dues.balance)} is due.`);
    if (needsReference(mode) && !ref.trim()) return setErr(`Enter the ${mode === 'Cheque' ? 'cheque number' : 'UTR / reference number'}.`);
    setSaving(true);
    try {
      const date = todayISO();
      const saved = await saveReceipt({ kind: record.kind, doc_id: record.id, date, fy: financialYear(date), prefix: 'RC', amount, mode, reference_no: ref.trim() });
      const doc: ReceiptDoc = {
        receiptNo: saved.receipt_no,
        date,
        shop,
        against: { kind: record.kind, no: record.no, date: record.date },
        customerName: record.name,
        mobile: record.mobile ?? '',
        amount,
        mode,
        referenceNo: ref.trim(),
        total: dues.total,
        paidBefore,
        balance: saved.balance,
      };
      backupNow().catch(() => {});
      let note = '';
      try {
        const out = await saveReceiptPdf(doc, logo, settings.billsFolder);
        await printPdf(out.bytes).catch(() => {});
      } catch (e) {
        note = ` (receipt PDF could not be saved: ${e})`;
      }
      onClose(`Receipt ${saved.receipt_no}: ₹${fmtMoney(amount)} received on ${record.no}. ${saved.balance ? `Balance ₹${fmtMoney(saved.balance)}.` : 'Paid in full.'}${note}`);
    } catch (e) {
      setErr(String(e));
      setSaving(false);
    }
  };

  return (
    <Modal title={`Record payment on ${record.no}`} onClose={() => onClose()}>
      <div>
        {record.name} · Total ₹{fmtMoney(dues.total)} · Paid ₹{fmtMoney(dues.paid)} · <b>Due ₹{fmtMoney(dues.balance)}</b>
      </div>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="row">
          <label className="field grow">
            Amount received (₹)
            <input autoFocus className="num" inputMode="decimal" value={amountIn} onChange={(e) => setAmountIn(e.target.value)} />
          </label>
          <label className="field" style={{ width: 150 }}>
            Mode
            <select value={mode} onChange={(e) => setMode(e.target.value as PaymentMode)}>
              {PAYMENT_MODES.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
        </div>
        {needsReference(mode) && (
          <label className="field">
            {mode === 'Cheque' ? 'Cheque number' : 'UTR / Reference no.'}
            <input value={ref} onChange={(e) => setRef(e.target.value)} />
          </label>
        )}
        <div className="hint">A numbered receipt is saved and printed. The {record.kind === 'BILL' ? 'GST bill' : 'estimate'} itself is not changed.</div>
        {err && <div className="alert error">{err}</div>}
        <div className="actions">
          <button type="button" className="btn" onClick={() => onClose()}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save & print receipt'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const FIELD_LABEL: Record<string, string> = { name: 'Name', mobile: 'Mobile', otherMobile: 'Other mobile' };

/** Correct the customer on an estimate (estimates only; GST bills stay locked). */
function EditCustomerModal({ record, settings, onClose }: { record: RecordRow; settings: Settings; onClose: (changed: number) => void }) {
  const [name, setName] = useState(record.name === 'Cash' ? '' : record.name);
  const [mobile, setMobile] = useState(record.mobile ?? '');
  const [other, setOther] = useState(record.other_mobile ?? '');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 10);

  const save = async () => {
    setErr('');
    if (mobile && mobile.length !== 10) return setErr('Mobile number must be 10 digits.');
    if (other && other.length !== 10) return setErr('Other mobile must be 10 digits.');
    setSaving(true);
    try {
      const changed = await updateEstimateCustomer(record.id, name, mobile, other);
      if (changed.length) {
        // re-create the PDF in the bills folder with the corrected customer, then back up
        const { doc, logo } = await getEstimateDoc(record.id);
        await saveEstimatePdf(doc, logo, settings.billsFolder).catch(() => {});
        backupNow().catch(() => {});
      }
      onClose(changed.length);
    } catch (e) {
      setErr(String(e));
      setSaving(false);
    }
  };

  return (
    <Modal title={`Edit customer on ${record.no}`} onClose={() => onClose(0)}>
      <div className="hint">Only the customer's name and mobile numbers can be corrected. Items, amounts and date stay as saved.</div>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label className="field">
          Name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Leave empty for “Cash”" />
        </label>
        <div className="row">
          <label className="field grow">
            Mobile
            <input inputMode="numeric" value={mobile} onChange={(e) => setMobile(digits(e.target.value))} />
          </label>
          <label className="field grow">
            Other mobile
            <input inputMode="numeric" value={other} onChange={(e) => setOther(digits(e.target.value))} />
          </label>
        </div>
        {err && <div className="alert error">{err}</div>}
        <div className="actions">
          <button type="button" className="btn" onClick={() => onClose(0)}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
