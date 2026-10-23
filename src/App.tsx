import { useCallback, useEffect, useState } from 'react';
import { getLatestRates, getRates, loadSettings, pastDescriptions, saveSettings, setRates } from './lib/api';
import { BASE_DESCRIPTIONS, uniqueDescriptions } from './lib/search';
import { todayISO } from './lib/fy';
import { fmtMoneyShort } from './lib/money';
import type { DailyRates, Settings } from './lib/types';
import { RatesModal } from './components/RatesModal';
import { LiveClock } from './components/LiveClock';
import { NewBill } from './screens/NewBill';
import { Estimate } from './screens/Estimate';
import { OldBills } from './screens/OldBills';
import { Customers } from './screens/Customers';
import { SettingsScreen } from './screens/Settings';

type Screen = 'new' | 'estimate' | 'old' | 'customers' | 'settings';

export default function App() {
  const [screen, setScreen] = useState<Screen>('new');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [today, setToday] = useState(todayISO());
  const [rates, setRatesState] = useState<DailyRates | null>(null);
  const [lastRates, setLastRates] = useState<DailyRates | null>(null);
  const [ratesOpen, setRatesOpen] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>(BASE_DESCRIPTIONS);

  // Description search offers common goods plus everything typed on earlier bills and estimates.
  const refreshSuggestions = useCallback(() => {
    pastDescriptions()
      .then((past) => setSuggestions(uniqueDescriptions(BASE_DESCRIPTIONS, past)))
      .catch(() => {});
  }, []);
  useEffect(refreshSuggestions, [refreshSuggestions]);

  const refreshRates = useCallback(async (date: string, askIfMissing: boolean) => {
    const r = await getRates(date);
    setRatesState(r);
    if (!r) {
      setLastRates(await getLatestRates());
      if (askIfMissing) setRatesOpen(true);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        setSettings(await loadSettings());
        await refreshRates(todayISO(), true);
      } catch (e) {
        setLoadError(String(e));
      }
    })();
  }, [refreshRates]);

  // If the app stays open past midnight, roll over to the new day and ask for rates again.
  useEffect(() => {
    const t = setInterval(() => {
      const d = todayISO();
      if (d !== today) {
        setToday(d);
        refreshRates(d, true);
      }
    }, 60_000);
    return () => clearInterval(t);
  }, [today, refreshRates]);

  // After the rates popup, put the cursor back on the bill so typing can start straight away.
  const closeRates = () => {
    setRatesOpen(false);
    setTimeout(() => {
      const visible = Array.from(document.querySelectorAll<HTMLInputElement>('[data-first]')).find((el) => el.offsetParent !== null);
      visible?.focus();
    }, 0);
  };

  const updateSettings = async (s: Settings) => {
    await saveSettings(s);
    setSettings(s);
  };

  if (loadError) return <div className="content"><div className="alert error">Could not open the database: {loadError}</div></div>;
  if (!settings) return <div className="content">Loading…</div>;

  const chip = (label: string, v: number | undefined, unit: string) => (
    <button className={'chip' + (rates ? '' : ' missing')} onClick={() => setRatesOpen(true)} title="Click to change today's rates">
      {label}
      <b>{rates && v != null ? `₹${fmtMoneyShort(v)}` : 'set rate'}</b>
      <span className="hint"> {unit}</span>
    </button>
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">{settings.shopName}</div>
        <LiveClock />
        <nav className="tabs">
          <button className={'tab' + (screen === 'new' ? ' active' : '')} onClick={() => setScreen('new')}>
            New Bill
          </button>
          <button className={'tab' + (screen === 'estimate' ? ' active' : '')} onClick={() => setScreen('estimate')}>
            Estimate
          </button>
          <button className={'tab' + (screen === 'old' ? ' active' : '')} onClick={() => setScreen('old')}>
            Old Bills
          </button>
          <button className={'tab' + (screen === 'customers' ? ' active' : '')} onClick={() => setScreen('customers')}>
            Customers
          </button>
          <button className={'tab' + (screen === 'settings' ? ' active' : '')} onClick={() => setScreen('settings')}>
            Settings
          </button>
        </nav>
        <div className="rates">
          {chip('Gold 22K', rates?.gold22, '/10g')}
          {chip('Gold 18K', rates?.gold18, '/10g')}
          {chip('Silver', rates?.silver, '/kg')}
        </div>
      </header>
      <main className="content">
        {/* New Bill and Estimate stay mounted so a half-filled form survives a look at another tab */}
        <div style={{ display: screen === 'new' ? 'block' : 'none' }}>
          <NewBill settings={settings} rates={rates} active={screen === 'new'} suggestions={suggestions} onSaved={refreshSuggestions} />
        </div>
        <div style={{ display: screen === 'estimate' ? 'block' : 'none' }}>
          <Estimate settings={settings} rates={rates} active={screen === 'estimate'} suggestions={suggestions} onSaved={refreshSuggestions} />
        </div>
        {screen === 'old' && <OldBills settings={settings} />}
        {screen === 'customers' && <Customers settings={settings} />}
        {screen === 'settings' && <SettingsScreen settings={settings} onSave={updateSettings} />}
      </main>
      {ratesOpen && (
        <RatesModal
          date={today}
          initial={rates ?? lastRates}
          onClose={closeRates}
          onSave={async (r) => {
            await setRates(r);
            setRatesState(r);
            closeRates();
          }}
        />
      )}
    </div>
  );
}
