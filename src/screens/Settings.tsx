import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { backupNow, countBillsInFy, lastSeqInFy } from '../lib/api';
import { financialYear, formatInvoiceNo, todayISO } from '../lib/fy';
import { fmtPct, parseScaled } from '../lib/money';
import { STATES, stateCode } from '../lib/states';
import type { Settings } from '../lib/types';

/** Any PNG/SVG/JPG file → PNG data URL (pdf-lib embeds PNG). */
async function fileToPngDataUrl(file: File): Promise<string> {
  if (file.type === 'image/png') {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(r.error);
      r.readAsDataURL(file);
    });
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const h = 360; // plenty for a 60 pt tall logo at print resolution
    const w = Math.round((img.naturalWidth || 600) * (h / (img.naturalHeight || 300)));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d')!.drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function SettingsScreen({ settings, onSave }: { settings: Settings; onSave: (s: Settings) => Promise<void> }) {
  const [s, setS] = useState<Settings>(settings);
  const [address, setAddress] = useState(settings.addressLines.join('\n'));
  const [gst, setGst] = useState(fmtPct(settings.gstRate));
  const fy = financialYear(todayISO());
  const [billsThisFy, setBillsThisFy] = useState<number | null>(null);
  const [lastSeq, setLastSeq] = useState<number | null>(null);
  const [nextNo, setNextNo] = useState(String(settings.invoiceStart?.fy === fy ? settings.invoiceStart.seq : 1));
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    countBillsInFy(fy).then(setBillsThisFy);
    lastSeqInFy(fy).then(setLastSeq);
  }, [fy]);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((x) => ({ ...x, [k]: v }));

  const pickFolder = async (k: 'billsFolder' | 'backupFolder') => {
    const dir = await open({ directory: true, defaultPath: s[k] || undefined, title: k === 'billsFolder' ? 'Choose the Bills folder' : 'Choose the Backup folder (inside Google Drive)' });
    if (typeof dir === 'string') set(k, dir);
  };

  const save = async () => {
    setMsg(null);
    const gstRate = parseScaled(gst, 2);
    if (gstRate == null || gstRate <= 0 || gstRate > 2800) return setMsg({ kind: 'error', text: 'GST rate must be a number like 3.' });
    if (!s.shopName.trim()) return setMsg({ kind: 'error', text: 'Shop name is required.' });
    if (!s.billsFolder.trim()) return setMsg({ kind: 'error', text: 'Choose a Bills folder.' });
    if (!/^[A-Za-z0-9]{1,10}$/.test(s.invoicePrefix)) return setMsg({ kind: 'error', text: 'Invoice prefix: letters and numbers only (e.g. SR).' });
    let invoiceStart = s.invoiceStart;
    if (billsThisFy === 0) {
      const n = Number(nextNo);
      if (!Number.isInteger(n) || n < 1) return setMsg({ kind: 'error', text: 'Next invoice number must be a whole number, 1 or more.' });
      invoiceStart = { fy, seq: n };
    }
    const next: Settings = {
      ...s,
      shopName: s.shopName.trim(),
      addressLines: address.split('\n').map((l) => l.trim()).filter(Boolean),
      invoicePrefix: s.invoicePrefix.toUpperCase(),
      gstin: s.gstin.trim().toUpperCase(),
      pan: s.pan.trim().toUpperCase(),
      gstRate,
      invoiceStart,
    };
    try {
      await onSave(next);
      setS(next);
      setMsg({ kind: 'ok', text: 'Settings saved.' });
    } catch (e) {
      setMsg({ kind: 'error', text: String(e) });
    }
  };

  const nextPreview = formatInvoiceNo(s.invoicePrefix || 'SR', fy, billsThisFy === 0 ? Number(nextNo) || 1 : (lastSeq ?? 0) + 1);

  return (
    <form
      className="settings"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <section className="card">
        <h3>Shop</h3>
        <div className="grid2">
          <label className="field">
            Shop name
            <input value={s.shopName} onChange={(e) => set('shopName', e.target.value)} />
          </label>
          <label className="field">
            Contact number
            <input value={s.contact} onChange={(e) => set('contact', e.target.value)} />
          </label>
          <label className="field span2">
            Address (one line per row)
            <textarea rows={3} value={address} onChange={(e) => setAddress(e.target.value)} />
          </label>
          <label className="field">
            GSTIN
            <input value={s.gstin} onChange={(e) => set('gstin', e.target.value)} />
          </label>
          <label className="field">
            PAN
            <input value={s.pan} onChange={(e) => set('pan', e.target.value)} />
          </label>
          <label className="field">
            State
            <select value={s.state} onChange={(e) => setS((x) => ({ ...x, state: e.target.value, stateCode: stateCode(e.target.value) }))}>
              {STATES.map((st) => (
                <option key={st.code} value={st.name}>
                  {st.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            State code
            <input value={s.stateCode} onChange={(e) => set('stateCode', e.target.value)} />
          </label>
          <div className="field span2">
            Logo (PNG or SVG)
            <div className="row" style={{ alignItems: 'center' }}>
              {s.logo ? <img className="logo-prev" src={s.logo} alt="Logo" /> : <span className="hint">No logo</span>}
              <label className="btn">
                Upload…
                <input
                  type="file"
                  accept="image/png,image/svg+xml,image/jpeg"
                  style={{ display: 'none' }}
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (f) set('logo', await fileToPngDataUrl(f));
                    e.target.value = '';
                  }}
                />
              </label>
              {s.logo && (
                <button type="button" className="link danger" onClick={() => set('logo', '')}>
                  Remove
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="card">
        <h3>Bank (printed on the bill)</h3>
        <div className="grid2">
          <label className="field">
            Account holder
            <input value={s.bankHolder} onChange={(e) => set('bankHolder', e.target.value)} />
          </label>
          <label className="field">
            Bank name
            <input value={s.bankName} onChange={(e) => set('bankName', e.target.value)} />
          </label>
          <label className="field">
            Account no.
            <input value={s.bankAccount} onChange={(e) => set('bankAccount', e.target.value)} />
          </label>
          <label className="field">
            Branch &amp; IFSC
            <input value={s.bankBranchIfsc} onChange={(e) => set('bankBranchIfsc', e.target.value)} />
          </label>
        </div>
      </section>

      <section className="card">
        <h3>Invoice &amp; tax</h3>
        <div className="grid3">
          <label className="field">
            Invoice prefix
            <input value={s.invoicePrefix} onChange={(e) => set('invoicePrefix', e.target.value.toUpperCase())} />
          </label>
          <label className="field">
            <span>
              Next number <span className="hint">(FY {fy})</span>
            </span>
            <input
              className="num"
              inputMode="numeric"
              disabled={billsThisFy !== 0}
              value={billsThisFy === 0 ? nextNo : String((lastSeq ?? 0) + 1)}
              onChange={(e) => setNextNo(e.target.value.replace(/\D/g, ''))}
              title={billsThisFy !== 0 ? 'Locked: bills already exist this financial year' : ''}
            />
          </label>
          <div className="field">
            Next bill will be
            <div style={{ fontSize: '1.1rem', color: 'var(--ink)', paddingTop: 8 }}>{nextPreview}</div>
          </div>
          <label className="field">
            GST rate (%) <span className="hint">split equally CGST + SGST</span>
            <input className="num" inputMode="decimal" value={gst} onChange={(e) => setGst(e.target.value)} />
          </label>
          <label className="field">
            Default HSN for new items
            <input value={s.hsn} onChange={(e) => set('hsn', e.target.value)} />
          </label>
        </div>
        {billsThisFy !== 0 && <div className="hint" style={{ marginTop: 8 }}>The number is locked because bills already exist this financial year.</div>}
      </section>

      <section className="card">
        <h3>Folders</h3>
        <div className="stack">
          <div className="row">
            <label className="field grow">
              Bills folder (PDFs are saved here)
              <input readOnly value={s.billsFolder} />
            </label>
            <button type="button" className="btn" onClick={() => pickFolder('billsFolder')}>
              Choose…
            </button>
          </div>
          <div className="row">
            <label className="field grow">
              <span>
                Backup folder <span className="hint">— pick a folder inside Google Drive; it syncs when the internet is on</span>
              </span>
              <input readOnly value={s.backupFolder} placeholder="Not set: no backup is made" />
            </label>
            <button type="button" className="btn" onClick={() => pickFolder('backupFolder')}>
              Choose…
            </button>
            {s.backupFolder && (
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  if (s.backupFolder !== settings.backupFolder || s.billsFolder !== settings.billsFolder) {
                    setMsg({ kind: 'error', text: 'Save settings first, then back up.' });
                    return;
                  }
                  try {
                    setMsg({ kind: 'ok', text: await backupNow() });
                  } catch (e) {
                    setMsg({ kind: 'error', text: String(e) });
                  }
                }}
              >
                Back up now
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="card">
        <h3>Declaration (printed on the bill)</h3>
        <textarea rows={3} style={{ width: '100%' }} value={s.declaration} onChange={(e) => set('declaration', e.target.value)} />
      </section>

      <div className="savebar">
        <button type="submit" className="btn primary">
          Save settings
        </button>
        {msg && <div className={'alert ' + msg.kind}>{msg.text}</div>}
      </div>
    </form>
  );
}
