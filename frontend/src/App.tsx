import React, { useState } from 'react';
import './styles.css';
import { DonnaProvider, useDonna } from './state';
import { Feed } from './components/Feed';
import { IntakeModal } from './components/IntakeModal';
import { MapView } from './components/MapView';
import { DetailPanel } from './components/DetailPanel';
import { NetworkPanel } from './components/NetworkPanel';
import { DemoStage } from './components/DemoStage';
import { PitchStage } from './components/PitchStage';
import { ManagerDrawer } from './components/ManagerDrawer';
import { MessageSquare, RotateCcw } from './icons';

type View = 'dispatch' | 'demo' | 'pitch';

export default function App(): React.JSX.Element {
  return (
    <DonnaProvider>
      <Shell />
    </DonnaProvider>
  );
}

function Shell() {
  const { mode, reset, busy, toast, detailOpen, appliedPatchCount } = useDonna();
  // Boots into the Pitch deck: the deck opens the room, then we cross to the
  // Dispatch console / Demo tab from the ribbon.
  const [view, setView] = useState<View>('pitch');
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [mgrOpen, setMgrOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const live = !!mode && (mode.llm !== 'mock' || mode.db !== 'json' || mode.voice !== 'sim');
  const modeTip = mode ? `LLM ${mode.llm} · DB ${mode.db} · Voice ${mode.voice}` : 'connecting…';

  return (
    <div className="app">
      {/* full-bleed map hero under everything */}
      <MapView />

      <header className="hbar">
        <span className="wordmark">Donna<span className="wm-dot">.</span></span>
        <div className="seg">
          <button className={`seg-btn${view === 'dispatch' ? ' on' : ''}`} onClick={() => setView('dispatch')}>Dispatch</button>
          <button className={`seg-btn${view === 'demo' ? ' on' : ''}`} onClick={() => setView('demo')}>Demo</button>
        </div>
        <span className="win-banner" title="AI Supply Chain Hackathon — July 15–17 2026, San Francisco">
          <span className="wb-tag">First prize</span>
          <span className="wb-text">AI Supply Chain Hackathon 2026 · Pebblebed × Capgemini</span>
        </span>
        <div className="hspacer" />
        {/* Pitch sits at the right of the ribbon, immediately left of the mode
            tag: the deck opens the room, then we cross to Dispatch/Demo. */}
        <button
          className={`pitch-btn${view === 'pitch' ? ' on' : ''}`}
          onClick={() => setView(view === 'pitch' ? 'dispatch' : 'pitch')}
          title="Pitch deck"
        >
          Pitch
        </button>
        <span className={`mode-tag${live ? ' live' : ''}`} title={modeTip}>{live ? 'Live' : 'Sim'}</span>
        <button className="icon-btn mgr" onClick={() => setMgrOpen((o) => !o)} title="Manager console" aria-label="Manager console">
          <MessageSquare />{appliedPatchCount > 0 && <span className="badge">{appliedPatchCount}</span>}
        </button>
        {/* Reset arms a confirm popover rather than firing: /api/demo/reset wipes
            every donation and call and reseeds the store, which is a lot to lose
            to a stray click. Clicking the icon again cancels. */}
        <button
          className={`icon-btn${confirmReset ? ' armed' : ''}`}
          onClick={() => setConfirmReset((o) => !o)}
          disabled={busy.init}
          title="Reset demo"
          aria-label="Reset demo"
        >
          <RotateCcw />
        </button>
        {confirmReset && (
          <div className="confirm-pop" role="alertdialog" aria-label="Confirm demo reset">
            <span className="cp-text">
              Reset the demo? Every donation and call is wiped and the seed data restored.
            </span>
            <div className="cp-actions">
              <button className="btn-quiet" onClick={() => setConfirmReset(false)}>Cancel</button>
              <button className="btn-primary" onClick={() => { setConfirmReset(false); void reset(); }}>
                Reset demo
              </button>
            </div>
          </div>
        )}
      </header>

      {view === 'dispatch' && (
        <>
          <Feed onNew={() => setIntakeOpen(true)} />
          {/* right dock is always mounted: Outbound · Network directory by default,
              swaps to the item Detail view while an item is selected (§G) */}
          {detailOpen ? <DetailPanel /> : <NetworkPanel />}
        </>
      )}
      {view === 'demo' && <DemoStage />}
      {view === 'pitch' && <PitchStage />}

      {intakeOpen && <IntakeModal onClose={() => setIntakeOpen(false)} />}

      <ManagerDrawer open={mgrOpen} onClose={() => setMgrOpen(false)} />

      {toast && (
        <div className={`toast${toast.error ? ' err' : ''}`}>
          <span className="dot" />{toast.text}
        </div>
      )}
    </div>
  );
}
