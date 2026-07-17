import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { InventoryEntry } from '../types';
import { humanize } from '../theme';

/**
 * §M.2 — the right-hand column that belongs to the gate (rail stage 05, "Your
 * call"), and to the gate only.
 *
 * Two surfaces stacked bottom-right: what is already on the food bank's shelf,
 * and a line to Donna. Both exist to inform ONE decision — approve, hold, or
 * reject — so both mount when the gate opens and unmount when it closes. The
 * caller renders <GateAside> under `phase === 'gate'` and nothing else; there is
 * no internal visibility flag to get out of step with the rail.
 *
 * The right side is free at the gate: `.stage-panel.outbound` (same edge) only
 * appears from stage 06 onward, so the column never has to fight it for space.
 * That is also why it may sit at the bottom edge — see styles.css `.gaside`.
 */
export function GateAside({ holdSeq = 0, onSend }: {
  /** Bumped by the parent each time an item is held, to refetch the shelf. */
  holdSeq?: number;
  onSend?: (text: string) => Promise<string>;
}) {
  return (
    <aside className="gaside">
      <InventoryCard holdSeq={holdSeq} />
      <GateChat onSend={onSend} />
    </aside>
  );
}

/* --------------------------------------------------------------- inventory */

/**
 * What the food bank is currently holding, from GET /api/inventory.
 *
 * Fetched on mount rather than polled: the gate is a human reading a screen for
 * a few seconds, and the only thing that can change the shelf while they look at
 * it is their own "Add to inventory" click — which is why `holdSeq` exists. The
 * parent bumps it on each hold, and this refetches. A 1s poll would spend a
 * request a second to catch an event we are already told about.
 */
function InventoryCard({ holdSeq }: { holdSeq: number }) {
  const [items, setItems] = useState<InventoryEntry[] | null>(null);
  const [totalLbs, setTotalLbs] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void api.inventory().then((inv) => {
      if (!alive) return;
      setItems(inv.items);
      setTotalLbs(inv.totalLbs);
      setErr(null);
    }).catch((e: unknown) => {
      if (alive) setErr(e instanceof Error ? e.message : String(e));
    });
    return () => { alive = false; };
  }, [holdSeq]);

  return (
    <section className="gcard inv">
      <header className="gc-head">
        <span className="gc-title display-face">Inventory — at the food bank</span>
        {items != null && items.length > 0 && (
          <span className="gc-count">{totalLbs.toLocaleString()} lbs</span>
        )}
      </header>

      {err && <p className="gc-empty err">inventory unavailable — {err}</p>}
      {!err && items == null && <p className="gc-empty">Loading…</p>}
      {!err && items != null && items.length === 0 && (
        <p className="gc-empty">Nothing on the shelf. Held items appear here.</p>
      )}

      {items != null && items.length > 0 && (
        <ul className="inv-list">
          {items.map((e) => (
            <li key={e.itemId} className="inv-row">
              <div className="inv-top">
                <span className="inv-name">{e.item}</span>
                <span className="inv-qty">{e.qtyLbs.toLocaleString()} lbs</span>
              </div>
              <div className="inv-sub">
                {humanize(e.category)}
                {e.needsRefrigeration && <span className="inv-cold"> · refrigerated</span>}
                {e.donorName && <span className="inv-from"> · from {e.donorName}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------- chat */

type Msg = { who: 'you' | 'donna'; text: string };

/**
 * A line to Donna at the gate, for the question the three buttons can't answer.
 *
 * DELIBERATELY NOT WIRED to a model yet. `onSend` is the seam: give it a
 * function and this becomes a real conversation. Left unwired it answers with a
 * fixed placeholder, which is honest about being a placeholder rather than
 * pretending to think.
 *
 * When it is wired, note that /api/manager/chat is NOT the endpoint to reach for
 * even though it is right there and Gemini-backed: it is the manager agent, and
 * it MUTATES CONFIG — it answers "stop calling Bayview for dairy" by editing
 * that recipient's rejects. A coordinator typing a question into a gate they are
 * mid-decision on does not expect the scoring weights to move underneath them.
 * This wants its own read-only endpoint over the staged donation.
 */
function GateChat({ onSend }: { onSend?: (text: string) => Promise<string> }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length, busy]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const q = text.trim();
    if (!q || busy) return;
    setText('');
    setMsgs((m) => [...m, { who: 'you', text: q }]);
    setBusy(true);
    try {
      const reply = onSend
        ? await onSend(q)
        : "I'm not connected to a model yet — this is the chat surface only.";
      setMsgs((m) => [...m, { who: 'donna', text: reply }]);
    } catch (err) {
      setMsgs((m) => [...m, {
        who: 'donna',
        text: `Something went wrong — ${err instanceof Error ? err.message : String(err)}`,
      }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="gcard chat">
      <header className="gc-head">
        <span className="gc-title display-face">Ask Donna</span>
      </header>

      {msgs.length > 0 && (
        <div className="gchat-scroll" ref={scrollRef}>
          {msgs.map((m, i) => (
            <p key={i} className={`gmsg ${m.who}`}>{m.text}</p>
          ))}
          {busy && <p className="gmsg donna thinking">Thinking…</p>}
        </div>
      )}

      <form className="gchat-row" onSubmit={(e) => void send(e)}>
        <input
          className="gchat-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask about this donation…"
          aria-label="Ask Donna about this donation"
          disabled={busy}
        />
        <button className="btn-quiet gchat-send" type="submit" disabled={busy || !text.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}
