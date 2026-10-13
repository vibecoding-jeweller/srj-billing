import { useEffect, useState } from 'react';
import { backupNow, cancelInvoice, getInvoiceDoc, listInvoices, type InvoiceListRow } from '../lib/api';
import { fmtBillDate } from '../lib/fy';
import { fmtMoney } from '../lib/money';
import { makePdf, openCopy, printPdf } from '../lib/output';
import { Modal } from '../components/Modal';
import type { Settings } from '../lib/types';

export function OldBills({ settings }: { settings: Settings }) {
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rows, setRows] = useState<InvoiceListRow[]>([]);
  const [cancelling, setCancelling] = useState<InvoiceListRow | null>(null);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => listInvoices({ q, from, to }).then(setRows).catch((e) => setMsg({ kind: 'error', text: String(e) }));

  useEffect(() => {
    const t = setTimeout(load, 150);
    return () => clearTimeout(t);
  }, [q, from, to]);

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

  const reprint = (r: InvoiceListRow) =>
    run(async () => {
      const { doc, logo } = await getInvoiceDoc(r.id);
      await printPdf(await makePdf(doc, 'customer', logo));
    });

  const openStore = (r: InvoiceListRow) =>
    run(async () => {
      const { doc, logo } = await getInvoiceDoc(r.id);
      await openCopy(doc, logo, settings.billsFolder, 'store');
    });

  const confirmCancel = () =>
    run(async () => {
      if (!cancelling || !reason.trim()) return;
      await cancelInvoice(cancelling.id, reason.trim());
      setMsg({ kind: 'ok', text: `Bill ${cancelling.invoice_no} marked CANCELLED. Its number will not be used again.` });
      setCancelling(null);
      setReason('');
      await load();
      backupNow().catch(() => {});
    });

  return (
    <div className="stack" style={{ maxWidth: 1400, margin: '0 auto' }}>
      <div className="row">
        <label className="field grow">
          Search
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, mobile or invoice no." />
        </label>
        <label className="field">
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        {(q || from || to) && (
          <button
            className="btn"
            onClick={() => {
              setQ('');
              setFrom('');
              setTo('');
            }}
          >
            Clear
          </button>
        )}
      </div>
      {msg && <div className={'alert ' + msg.kind}>{msg.text}</div>}
      <table className="list">
        <thead>
          <tr>
            <th>Invoice no</th>
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
              <td colSpan={8} style={{ textAlign: 'center', color: 'var(--muted)', padding: 30 }}>
                No bills found.
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.id} className={r.status === 'CANCELLED' ? 'cancelled' : ''}>
              <td className="inv">
                <b>{r.invoice_no}</b>
              </td>
              <td>{fmtBillDate(r.date)}</td>
              <td>{r.name}</td>
              <td>{r.mobile}</td>
              <td className="num">₹{fmtMoney(r.grand_total)}</td>
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
                <button className="link" disabled={busy} onClick={() => openStore(r)}>
                  Store copy
                </button>
                {r.status === 'ACTIVE' && (
                  <button className="link danger" disabled={busy} onClick={() => setCancelling(r)}>
                    Cancel bill
                  </button>
                )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 500 && <div className="hint">Showing the latest 500 bills. Use search or dates to narrow down.</div>}

      {cancelling && (
        <Modal title={`Cancel bill ${cancelling.invoice_no}?`} onClose={() => setCancelling(null)}>
          <div>
            ₹{fmtMoney(cancelling.grand_total)} · {cancelling.name} · {fmtBillDate(cancelling.date)}
          </div>
          <div className="hint">The bill stays in the list marked CANCELLED. This cannot be undone, and the number is never reused.</div>
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
                Keep bill
              </button>
              <button type="submit" className="btn primary" disabled={!reason.trim() || busy}>
                Cancel bill
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
