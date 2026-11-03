import { useEffect, useMemo, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { catalogueCategories, getRecord, itemSales, writeFile, type RecordKind, type RecordRow } from '../lib/api';
import { METAL_LABEL, type Metal } from '../lib/calc';
import { fmtBillDate, todayISO } from '../lib/fy';
import { fmtMoney, fmtWeight } from '../lib/money';
import { ITEM_METALS, toCsv, type ItemFilter, type ItemMetal, type ItemSalesResult } from '../lib/itemSales';
import { presetRange, PRESETS, type Preset } from '../lib/records';
import { RecordPanel } from './OldBills';
import type { Settings } from '../lib/types';

const metalLabel = (m: string) => METAL_LABEL[m as Metal] ?? ITEM_METALS.find((x) => x.id === m)?.label ?? m;

// Remembered while the app is open, like Old Bills.
const remembered: { preset: Preset; from: string; to: string; q: string } = { preset: 'month', from: '', to: '', q: '' };

/** Reports → Item sales: how many of an item sold, under every spelling it was typed. */
export function Reports({ settings }: { settings: Settings }) {
  const [preset, setPreset] = useState<Preset>(remembered.preset);
  const [customFrom, setCustomFrom] = useState(remembered.from);
  const [customTo, setCustomTo] = useState(remembered.to);
  const [q, setQ] = useState(remembered.q);
  const [metal, setMetal] = useState<ItemMetal>('');
  const [kind, setKind] = useState<'' | RecordKind>('');
  const [category, setCategory] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  useEffect(() => {
    catalogueCategories().then(setCategories).catch(() => {});
  }, []);
  const [result, setResult] = useState<ItemSalesResult | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [panel, setPanel] = useState<RecordRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    Object.assign(remembered, { preset, from: customFrom, to: customTo, q });
  }, [preset, customFrom, customTo, q]);

  const range = preset === 'custom' ? { from: customFrom, to: customTo } : presetRange(preset, todayISO());
  const filter: ItemFilter = useMemo(() => ({ q, from: range.from, to: range.to, metal, kind, category }), [q, range.from, range.to, metal, kind, category]);

  useEffect(() => {
    const t = setTimeout(() => {
      itemSales(filter)
        .then((r) => {
          setResult(r);
          // a narrow search opens its groups straight away
          setOpen(new Set(q.trim() && r.groups.length <= 3 ? r.groups.map((g) => g.description) : []));
        })
        .catch((e) => setMsg({ kind: 'error', text: String(e) }));
    }, 200);
    return () => clearTimeout(t);
  }, [filter]);

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

  const toggle = (d: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(d)) n.delete(d);
      else n.add(d);
      return n;
    });

  const openRecord = (k: RecordKind, id: number) =>
    run(async () => {
      const r = await getRecord(k, id);
      if (r) setPanel(r);
    });

  const exportCsv = () =>
    run(async () => {
      if (!result) return;
      const name = `Item sales${q.trim() ? ' - ' + q.trim().replace(/[\\/:*?"<>|]/g, '') : ''} ${range.from || 'start'} to ${range.to || todayISO()}.csv`;
      const path = await save({ title: 'Save item sales for Excel', defaultPath: name, filters: [{ name: 'CSV (Excel)', extensions: ['csv'] }] });
      if (!path) return;
      await writeFile(path, new TextEncoder().encode(toCsv(result, metalLabel)));
      setMsg({ kind: 'ok', text: `Saved ${path}` });
    });

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && panel) setPanel(null);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [panel]);

  const rangeText = range.from && range.to ? (range.from === range.to ? fmtBillDate(range.from) : `${fmtBillDate(range.from)} – ${fmtBillDate(range.to)}`) : 'all dates';
  const r = result;

  return (
    <div className={'records' + (panel ? ' with-panel' : '')}>
      <div className="stack">
        <h2 className="report-title">Item sales</h2>
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
            autoFocus
            spellCheck={false}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Item to count, e.g. bichiya, payal, gold ring (any spelling), or a SKU like RNG0005"
          />
          {categories.length > 0 && (
            <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: 150 }} aria-label="925 category">
              <option value="">All 925 tabs</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  925: {c}
                </option>
              ))}
            </select>
          )}
          <select value={metal} onChange={(e) => setMetal(e.target.value as ItemMetal)} style={{ width: 150 }} aria-label="Metal">
            {ITEM_METALS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <select value={kind} onChange={(e) => setKind(e.target.value as '' | RecordKind)} style={{ width: 170 }} aria-label="Count">
            <option value="">Bills + Estimates</option>
            <option value="BILL">Bills only</option>
            <option value="EST">Estimates only</option>
          </select>
          <button className="btn" disabled={!r || !r.pieces || busy} onClick={exportCsv} title="Save as a CSV file that opens in Excel">
            Export to Excel
          </button>
        </div>
        {msg && <div className={'alert ' + msg.kind}>{msg.text}</div>}

        {r && (
          <div className="report-cards">
            <div className="card stat">
              <span className="hint">Pieces sold</span>
              <b>{r.pieces}</b>
            </div>
            <div className="card stat">
              <span className="hint">Total weight</span>
              <b>{fmtWeight(r.weightMg)} g</b>
            </div>
            <div className="card stat">
              <span className="hint">Sale value (before GST)</span>
              <b>₹{fmtMoney(r.amount)}</b>
            </div>
            <div className="card stat">
              <span className="hint">Bills + estimates</span>
              <b>{r.records}</b>
            </div>
          </div>
        )}
        <div className="hint">
          <b className="range">{rangeText}</b> · cancelled bills and estimates are never counted · each item line counts as one piece
        </div>

        {r && r.groups.length === 0 && (
          <div className="card empty">
            Nothing sold{q.trim() ? ` matching “${q.trim()}”` : ''} in {rangeText}.
            {preset !== 'fy' && (
              <button className="btn" onClick={() => setPreset('fy')}>
                Look in This FY
              </button>
            )}
          </div>
        )}
        {r && r.groups.length > 0 && (
          <div className="card" style={{ padding: 0 }}>
            <table className="list records-table report-table">
              <thead>
                <tr>
                  <th>Description (as typed on the bill)</th>
                  <th>Metal</th>
                  <th className="num">Pieces</th>
                  <th className="num">Weight</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {r.groups.map((g) => {
                  const isOpen = open.has(g.description);
                  return [
                    <tr key={g.description} className="group-row" onClick={() => toggle(g.description)}>
                      <td>
                        <span className="caret">{isOpen ? '▾' : '▸'}</span> {g.description}
                      </td>
                      <td className="hint">{g.metals.map(metalLabel).join(', ')}</td>
                      <td className="num">{g.pieces}</td>
                      <td className="num nowrap">{fmtWeight(g.weightMg)} g</td>
                      <td className="num nowrap">₹{fmtMoney(g.amount)}</td>
                    </tr>,
                    ...(isOpen
                      ? g.lines.map((l) => {
                          const sel = panel?.kind === l.kind && panel.id === l.doc_id;
                          return (
                            <tr key={`${g.description}-${l.kind}${l.doc_id}-${l.sl}`} className={'line-row' + (sel ? ' cursor' : '')} onClick={() => openRecord(l.kind, l.doc_id)}>
                              <td>
                                <span className={'badge ' + (l.kind === 'BILL' ? 'kind-bill' : 'kind-est')}>{l.kind === 'BILL' ? 'Bill' : 'Est'}</span> {l.no}{' '}
                                <span className="hint">· {l.name}</span>
                              </td>
                              <td className="hint nowrap">{fmtBillDate(l.date)}</td>
                              <td className="num">1</td>
                              <td className="num nowrap">{fmtWeight(l.weight_mg)} g</td>
                              <td className="num nowrap">₹{fmtMoney(l.amount)}</td>
                            </tr>
                          );
                        })
                      : []),
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {panel && <RecordPanel key={panel.kind + panel.id} record={panel} settings={settings} busy={busy} run={run} onClose={() => setPanel(null)} />}
    </div>
  );
}
