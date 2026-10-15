import { useEffect, useState } from 'react';
import {
  backupNow,
  cancelEstimate,
  cancelInvoice,
  getEstimateDoc,
  getInvoiceDoc,
  listRecords,
  type RecordKind,
  type RecordRow,
} from '../lib/api';
import { fmtBillDate } from '../lib/fy';
import { fmtMoney } from '../lib/money';
import { makeEstimatePdf, makePdf, openCopy, openEstimate, printPdf } from '../lib/output';
import { Modal } from '../components/Modal';
import type { Settings } from '../lib/types';

const KIND_LABEL: Record<RecordKind, string> = { BILL: 'Bill', EST: 'Estimate' };

/** GST bills and estimates in one list, so every sale can be tracked. */
export function OldBills({ settings }: { settings: Settings }) {
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [kind, setKind] = useState<'' | RecordKind>('');
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [cancelling, setCancelling] = useState<RecordRow | null>(null);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => listRecords({ q, from, to, kind }).then(setRows).catch((e) => setMsg({ kind: 'error', text: String(e) }));

  useEffect(() => {
    const t = setTimeout(load, 150);
    return () => clearTimeout(t);
  }, [q, from, to, kind]);

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

  const reprint = (r: RecordRow) =>
    run(async () => {
      if (r.kind === 'BILL') {
        const { doc, logo } = await getInvoiceDoc(r.id);
        await printPdf(await makePdf(doc, 'customer', logo));
      } else {
        const { doc, logo } = await getEstimateDoc(r.id);
        await printPdf(await makeEstimatePdf(doc, logo));
      }
    });

  const openPdf = (r: RecordRow) =>
    run(async () => {
      if (r.kind === 'BILL') {
        const { doc, logo } = await getInvoiceDoc(r.id);
        await openCopy(doc, logo, settings.billsFolder, 'store');
      } else {
        const { doc, logo } = await getEstimateDoc(r.id);
        await openEstimate(doc, logo, settings.billsFolder);
      }
    });

  const confirmCancel = () =>
    run(async () => {
      if (!cancelling || !reason.trim()) return;
      if (cancelling.kind === 'BILL') await cancelInvoice(cancelling.id, reason.trim());
      else await cancelEstimate(cancelling.id, reason.trim());
      setMsg({ kind: 'ok', text: `${KIND_LABEL[cancelling.kind]} ${cancelling.no} marked CANCELLED. Its number will not be used again.` });
      setCancelling(null);
      setReason('');
      await load();
      backupNow().catch(() => {});
    });

  // Sales totals for what is listed (cancelled ones not counted)
  const active = rows.filter((r) => r.status === 'ACTIVE');
  const sum = (k: RecordKind) => active.filter((r) => r.kind === k).reduce((s, r) => s + r.grand_total, 0);
  const count = (k: RecordKind) => active.filter((r) => r.kind === k).length;

  return (
    <div className="stack" style={{ maxWidth: 1400, margin: '0 auto' }}>
      <div className="row">
        <label className="field grow">
          Search
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, mobile, bill or estimate no." />
        </label>
        <label className="field" style={{ width: 150 }}>
          Show
          <select value={kind} onChange={(e) => setKind(e.target.value as '' | RecordKind)}>
            <option value="">Bills + Estimates</option>
            <option value="BILL">Bills only</option>
            <option value="EST">Estimates only</option>
          </select>
        </label>
        <label className="field">
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        {(q || from || to || kind) && (
          <button
            className="btn"
            onClick={() => {
              setQ('');
              setFrom('');
              setTo('');
              setKind('');
            }}
          >
            Clear
          </button>
        )}
      </div>
      <div className="totals-bar">
        {kind !== 'EST' && (
          <span>
            Bills ({count('BILL')}): <b>₹{fmtMoney(sum('BILL'))}</b>
          </span>
        )}
        {kind !== 'BILL' && (
          <span>
            Estimates ({count('EST')}): <b>₹{fmtMoney(sum('EST'))}</b>
          </span>
        )}
        {!kind && (
          <span className="grand-sum">
            Total sale: <b>₹{fmtMoney(sum('BILL') + sum('EST'))}</b>
          </span>
        )}
        <span className="hint">Cancelled ones are not counted.</span>
      </div>
      {msg && <div className={'alert ' + msg.kind}>{msg.text}</div>}
      <table className="list">
        <thead>
          <tr>
            <th>Type</th>
            <th>Number</th>
            <th>Date</th>
            <th>Customer</th>
            <th>Mobile</th>
            <th style={{ textAlign: 'right' }}>Total</th>
            <th>Payment</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={9} style={{ textAlign: 'center', color: 'var(--muted)', padding: 30 }}>
                Nothing found.
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.kind + r.id} className={r.status === 'CANCELLED' ? 'cancelled' : ''}>
              <td>
                <span className={'badge ' + (r.kind === 'BILL' ? 'kind-bill' : 'kind-est')}>{KIND_LABEL[r.kind]}</span>
              </td>
              <td className="inv nowrap">
                <b>{r.no}</b>
              </td>
              <td className="nowrap">{fmtBillDate(r.date)}</td>
              <td>{r.name}</td>
              <td>{r.mobile}</td>
              <td className="num nowrap">₹{fmtMoney(r.grand_total)}</td>
              <td>{r.modes}</td>
              <td>
                {r.status === 'ACTIVE' ? (
                  <span className="badge ok">Active</span>
                ) : (
                  <span className="badge cancel" title={r.cancel_reason ?? ''}>
                    CANCELLED
                  </span>
                )}
                {r.status === 'CANCELLED' && r.cancel_reason && <div className="hint">{r.cancel_reason}</div>}
              </td>
              <td className="actions">
                <div className="acts">
                  <button className="link" disabled={busy} onClick={() => reprint(r)}>
                    Reprint
                  </button>
                  <button className="link" disabled={busy} onClick={() => openPdf(r)}>
                    {r.kind === 'BILL' ? 'Store copy' : 'Open PDF'}
                  </button>
                  {r.status === 'ACTIVE' && (
                    <button className="link danger" disabled={busy} onClick={() => setCancelling(r)}>
                      Cancel
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 500 && <div className="hint">Showing the latest 500. Use search or dates to narrow down.</div>}

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
