import { useState } from 'react';
import { Modal } from './Modal';
import { paiseToInput, parsePaise } from '../lib/money';
import type { DailyRates } from '../lib/types';
import { focusNextOnEnter } from '../lib/keys';

export function RatesModal({
  date,
  initial,
  onSave,
  onClose,
}: {
  date: string;
  initial: DailyRates | null;
  onSave: (r: DailyRates) => Promise<void>;
  onClose: () => void;
}) {
  const [g22, setG22] = useState(paiseToInput(initial?.gold22));
  const [g18, setG18] = useState(paiseToInput(initial?.gold18));
  const [sil, setSil] = useState(paiseToInput(initial?.silver));
  const [err, setErr] = useState('');

  const save = async () => {
    const r = { date, gold22: parsePaise(g22), gold18: parsePaise(g18), silver: parsePaise(sil) };
    if (r.gold22 == null || r.gold18 == null || r.silver == null) {
      setErr('Please enter all three rates (numbers only).');
      return;
    }
    await onSave(r as DailyRates);
  };

  return (
    <Modal title="Today's rates" onClose={onClose}>
      <form
        className="stack"
        onKeyDown={(e) => focusNextOnEnter(e, save)}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label className="field">
          Gold 22K (₹ per 10 g)
          <input data-nav autoFocus className="num" inputMode="decimal" value={g22} onChange={(e) => setG22(e.target.value)} placeholder="e.g. 139000" />
        </label>
        <label className="field">
          Gold 18K (₹ per 10 g)
          <input data-nav className="num" inputMode="decimal" value={g18} onChange={(e) => setG18(e.target.value)} placeholder="e.g. 114000" />
        </label>
        <label className="field">
          Silver (₹ per kg)
          <input data-nav className="num" inputMode="decimal" value={sil} onChange={(e) => setSil(e.target.value)} placeholder="e.g. 95000" />
        </label>
        {err && <div className="alert error">{err}</div>}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>
            Later
          </button>
          <button type="submit" className="btn primary">
            Save rates
          </button>
        </div>
      </form>
    </Modal>
  );
}
