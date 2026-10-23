// Customers (CRM): search, add and edit customers, see their bills and estimates,
// and upcoming birthdays / anniversaries. Customers are also added automatically from bills and estimates.
import { useEffect, useMemo, useState } from 'react';
import { customerHistory, deleteCustomer, listCustomers, saveCustomer, type Customer, type CustomerRow, type RecordRow } from '../lib/api';
import { MONTHS, upcomingOccasions } from '../lib/crm';
import { fmtBillDate, todayISO } from '../lib/fy';
import { fmtMoney } from '../lib/money';
import { STATES, stateCode } from '../lib/states';
import { PAN_RE } from '../lib/validate';
import { askYesNo } from '../lib/dialogs';
import type { Relation, Settings } from '../lib/types';

/** Day + month picker for birthdays and anniversaries; value is "MM-DD" or ''. */
function DayMonth({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const parse = (v: string) => {
    const m = /^(?:\d{4}-)?(\d{2})-(\d{2})$/.exec(v);
    return m ? { d: Number(m[2]), m: Number(m[1]) } : { d: 0, m: 0 };
  };
  const [dm, setDm] = useState(() => parse(value));
  useEffect(() => setDm(parse(value)), [value]);
  // saved only when both day and month are chosen (or both cleared)
  const update = (d: number, m: number) => {
    setDm({ d, m });
    if (d && m) onChange(`${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    else if (!d && !m) onChange('');
  };
  return (
    <div className="daymonth">
      <select value={dm.d} onChange={(e) => update(Number(e.target.value), dm.m)} aria-label="Day">
        <option value={0}>Day</option>
        {Array.from({ length: 31 }, (_, i) => (
          <option key={i + 1} value={i + 1}>
            {i + 1}
          </option>
        ))}
      </select>
      <select value={dm.m} onChange={(e) => update(dm.d, Number(e.target.value))} aria-label="Month">
        <option value={0}>Month</option>
        {MONTHS.map((name, i) => (
          <option key={name} value={i + 1}>
            {name}
          </option>
        ))}
      </select>
      {(dm.d > 0 || dm.m > 0) && (
        <button type="button" className="rm" title="Clear" onClick={() => update(0, 0)}>
          ×
        </button>
      )}
    </div>
  );
}

const blank = (s: Settings): Customer => ({
  id: 0,
  mobile: '',
  otherMobile: '',
  name: '',
  relation: '',
  relativeName: '',
  address: '',
  state: s.state,
  stateCode: s.stateCode,
  pan: '',
  dob: '',
  anniversary: '',
  notes: '',
});

export function Customers({ settings }: { settings: Settings }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [all, setAll] = useState<CustomerRow[]>([]);
  const [form, setForm] = useState<Customer | null>(null);
  const [history, setHistory] = useState<RecordRow[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = () => listCustomers(q).then(setRows).catch((e) => setMsg({ kind: 'error', text: String(e) }));
  const loadAll = () => listCustomers('').then(setAll).catch(() => {});

  useEffect(() => {
    const t = setTimeout(load, 150);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    loadAll();
  }, []);

  const occasions = useMemo(() => upcomingOccasions(all, todayISO()), [all]);

  const open = (c: Customer) => {
    setMsg(null);
    setForm({ ...c });
    if (c.id) customerHistory(c.id).then(setHistory);
    else setHistory([]);
  };
  const set = <K extends keyof Customer>(k: K, v: Customer[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const save = async () => {
    if (!form) return;
    const f = { ...form, name: form.name.trim(), address: form.address.trim(), notes: form.notes.trim(), pan: form.pan.trim().toUpperCase() };
    const problem = !f.name
      ? 'Enter the customer name.'
      : !/^\d{10}$/.test(f.mobile)
        ? 'Mobile number must be 10 digits.'
        : f.otherMobile && !/^\d{10}$/.test(f.otherMobile)
          ? 'Other mobile must be 10 digits.'
          : f.pan && !PAN_RE.test(f.pan)
            ? 'PAN looks wrong. It should look like ABCDE1234F.'
            : '';
    if (problem) return setMsg({ kind: 'error', text: problem });
    try {
      const id = await saveCustomer(f);
      setForm({ ...f, id });
      setMsg({ kind: 'ok', text: form.id ? 'Customer updated.' : 'Customer added.' });
      load();
      loadAll();
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  };

  const remove = async () => {
    if (!form?.id || !(await askYesNo(`Delete ${form.name}? This cannot be undone.`, 'Delete'))) return;
    try {
      await deleteCustomer(form.id);
      setForm(null);
      setMsg({ kind: 'ok', text: 'Customer deleted.' });
      load();
      loadAll();
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  };

  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 10);
  const totalPaid = history.filter((h) => h.status === 'ACTIVE').reduce((s, h) => s + h.grand_total, 0);

  return (
    <div className="crm">
      <div className="crm-list stack">
        <div className="row">
          <label className="field grow">
            Search customers
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, mobile, address or notes" />
          </label>
          <button className="btn primary" onClick={() => open(blank(settings))}>
            + New customer
          </button>
        </div>

        {occasions.length > 0 && (
          <div className="card occasions">
            <h3>Coming up (next 7 days)</h3>
            {occasions.map((o) => (
              <button key={o.customerId + o.kind} className="occasion" onClick={() => open(all.find((c) => c.id === o.customerId)!)}>
                <span className={'badge ' + (o.kind === 'Birthday' ? 'kind-bill' : 'kind-est')}>{o.kind}</span>
                <b>{o.name}</b> <span className="hint">{o.mobile}</span>
                <span className="when">{o.inDays === 0 ? 'Today' : o.inDays === 1 ? 'Tomorrow' : `in ${o.inDays} days`}</span>
              </button>
            ))}
          </div>
        )}

        <table className="list">
          <thead>
            <tr>
              <th>Name</th>
              <th>Mobile</th>
              <th>Visits</th>
              <th style={{ textAlign: 'right' }}>Paid</th>
              <th>Last visit</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', color: 'var(--muted)', padding: 30 }}>
                  {q ? 'No customer found.' : 'No customers yet. They are added from bills and estimates, or with “+ New customer”.'}
                </td>
              </tr>
            )}
            {rows.map((c) => (
              <tr key={c.id} className={'clickable' + (form?.id === c.id ? ' selected' : '')} onClick={() => open(c)}>
                <td>
                  <b>{c.name || '—'}</b>
                  {c.address && <div className="hint">{c.address.split('\n')[0]}</div>}
                </td>
                <td className="nowrap">
                  {c.mobile}
                  {c.otherMobile && <div className="hint">{c.otherMobile}</div>}
                </td>
                <td className="nowrap">
                  {c.bills ? `${c.bills} bill${c.bills > 1 ? 's' : ''}` : ''}
                  {c.bills && c.estimates ? ', ' : ''}
                  {c.estimates ? `${c.estimates} est.` : ''}
                  {!c.bills && !c.estimates && <span className="hint">—</span>}
                </td>
                <td className="num nowrap">{c.paid ? `₹${fmtMoney(c.paid)}` : '—'}</td>
                <td className="nowrap">{c.lastVisit ? fmtBillDate(c.lastVisit) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 1000 && <div className="hint">Showing 1000 customers. Search to narrow down.</div>}
      </div>

      <div className="crm-detail">
        {!form ? (
          <div className="card hint" style={{ padding: 30, textAlign: 'center' }}>
            Pick a customer to see or edit their details, or add a new one.
          </div>
        ) : (
          <form
            key={form.id || 'new'}
            className="card stack"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <h3>{form.id ? 'Customer details' : 'New customer'}</h3>
            <div className="grid2">
              <label className="field span2">
                <span>
                  Name <span className="req">*</span>
                </span>
                <input value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus={!form.id} />
              </label>
              <label className="field">
                <span>
                  Mobile <span className="req">*</span>
                </span>
                <input inputMode="numeric" value={form.mobile} onChange={(e) => set('mobile', digits(e.target.value))} />
              </label>
              <label className="field">
                Other mobile
                <input inputMode="numeric" value={form.otherMobile} onChange={(e) => set('otherMobile', digits(e.target.value))} />
              </label>
              <label className="field">
                Relation
                <select value={form.relation} onChange={(e) => set('relation', e.target.value as Relation)}>
                  <option value="">none</option>
                  <option>S/o</option>
                  <option>D/o</option>
                  <option>W/o</option>
                </select>
              </label>
              <label className="field">
                Relative's name
                <input disabled={!form.relation} value={form.relativeName} onChange={(e) => set('relativeName', e.target.value)} />
              </label>
              <label className="field span2">
                Address
                <textarea rows={2} value={form.address} onChange={(e) => set('address', e.target.value)} />
              </label>
              <label className="field">
                State
                <select value={form.state} onChange={(e) => setForm((f) => (f ? { ...f, state: e.target.value, stateCode: stateCode(e.target.value) } : f))}>
                  {STATES.map((st) => (
                    <option key={st.code} value={st.name}>
                      {st.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                PAN
                <input maxLength={10} value={form.pan} onChange={(e) => set('pan', e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
              </label>
              <label className="field">
                Birthday
                <DayMonth value={form.dob} onChange={(v) => set('dob', v)} />
              </label>
              <label className="field">
                Anniversary
                <DayMonth value={form.anniversary} onChange={(v) => set('anniversary', v)} />
              </label>
              <label className="field span2">
                Notes
                <textarea rows={3} value={form.notes} onChange={(e) => set('notes', e.target.value)} placeholder="e.g. likes light-weight chains; ring size 14; ordered a kada for Diwali" />
              </label>
            </div>
            {msg && <div className={'alert ' + msg.kind}>{msg.text}</div>}
            <div className="row" style={{ alignItems: 'center' }}>
              <button type="submit" className="btn primary">
                {form.id ? 'Save changes' : 'Add customer'}
              </button>
              <button type="button" className="btn" onClick={() => setForm(null)}>
                Close
              </button>
              {form.id > 0 && (
                <button type="button" className="link danger" style={{ marginLeft: 'auto' }} onClick={remove}>
                  Delete customer
                </button>
              )}
            </div>

            {form.id > 0 && (
              <div className="stack">
                <h3 style={{ marginTop: 8 }}>
                  History <span className="hint">({history.length}, paid ₹{fmtMoney(totalPaid)})</span>
                </h3>
                {history.length === 0 ? (
                  <div className="hint">No bills or estimates yet.</div>
                ) : (
                  <table className="list compact">
                    <tbody>
                      {history.map((h) => (
                        <tr key={h.kind + h.id} className={h.status === 'CANCELLED' ? 'cancelled' : ''}>
                          <td>
                            <span className={'badge ' + (h.kind === 'BILL' ? 'kind-bill' : 'kind-est')}>{h.kind === 'BILL' ? 'Bill' : 'Estimate'}</span>
                          </td>
                          <td className="inv nowrap">{h.no}</td>
                          <td className="nowrap">{fmtBillDate(h.date)}</td>
                          <td className="num nowrap">
                            ₹{fmtMoney(h.grand_total)}
                            <div className="hint">{h.status === 'CANCELLED' ? 'CANCELLED' : h.modes}</div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div className="hint">Reprint any of these from Old Bills.</div>
              </div>
            )}
          </form>
        )}
        {!form && msg && <div className={'alert ' + msg.kind}>{msg.text}</div>}
      </div>
    </div>
  );
}
