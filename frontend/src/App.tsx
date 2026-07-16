import React, { useState } from 'react';
import './styles.css';
import { DonnaProvider, useDonna } from './state';
import { IntakePanel } from './components/IntakePanel';
import { MapView } from './components/MapView';
import { DecisionPanel } from './components/DecisionPanel';
import { EquityTab } from './components/EquityTab';
import { ManagerDrawer } from './components/ManagerDrawer';

type View = 'dispatch' | 'equity';

export default function App(): React.JSX.Element {
  return (
    <DonnaProvider>
      <Shell />
    </DonnaProvider>
  );
}

function Shell() {
  const { mode, reset, busy, toast } = useDonna();
  const [view, setView] = useState<View>('dispatch');

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="mark"><b>Donna</b></span>
          <span className="tag">Food-rescue dispatch</span>
        </div>
        <nav className="tabs">
          <button className={`tab dispatch${view === 'dispatch' ? ' active' : ''}`} onClick={() => setView('dispatch')}>Dispatch</button>
          <button className={`tab equity${view === 'equity' ? ' active' : ''}`} onClick={() => setView('equity')}>Equity</button>
        </nav>
        <div className="top-spacer" />
        <div className="modepills">
          <span className={`pill${mode && mode.llm !== 'mock' ? ' live' : ''}`}><span className="dot" />LLM {mode?.llm ?? '—'}</span>
          <span className={`pill${mode && mode.db !== 'json' ? ' live' : ''}`}><span className="dot" />DB {mode?.db ?? '—'}</span>
          <span className={`pill${mode && mode.voice !== 'sim' ? ' live' : ''}`}><span className="dot" />Voice {mode?.voice ?? '—'}</span>
        </div>
        <button className="btn ghost small" onClick={reset} disabled={busy.init} title="Reseed the demo store">↺ Reset</button>
      </header>

      {view === 'dispatch' ? (
        <div className="console">
          <div className="col left"><IntakePanel /></div>
          <MapView />
          <div className="col right"><DecisionPanel /></div>
        </div>
      ) : (
        <EquityTab />
      )}

      <ManagerDrawer />

      {toast && (
        <div className={`toast${toast.error ? ' err' : ''}`}>
          <span className="dot" />{toast.text}
        </div>
      )}
    </div>
  );
}
