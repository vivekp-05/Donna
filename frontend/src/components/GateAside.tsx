import React, { useEffect, useState } from 'react';
import { api } from '../api';
import type { InventoryEntry } from '../types';
import { humanize } from '../theme';

/**
 * §M.2 — the right-hand column that belongs to the gate (rail stage 05, "Your
 * call"), and to the gate only.
 *
 * Two surfaces stacked bottom-right: what is already on the food bank's shelf,
 * and a one-click way to put this donation there. Both exist to inform ONE
 * decision — approve, hold, or reject — so both mount when the gate opens and
 * unmount when it closes. The caller renders <GateAside> under `phase === 'gate'`
 * and nothing else; there is no internal visibility flag to get out of step with
 * the rail.
 *
 * The right side is free at the gate: `.stage-panel.outbound` (same edge) only
 * appears from stage 06 onward, so the column never has to fight it for space.
 * That is also why it may sit at the bottom edge — see styles.css `.gaside`.
 */
export function GateAside({ holdSeq = 0, pendingCount = 0, onAdd }: {
  /** Bumped by the parent each time an item is held, to refetch the shelf. */
  holdSeq?: number;
  /** Pending items on this donation that "Add to inventory" would shelve. */
  pendingCount?: number;
  /** Shelve every pending item on the staged donation, then advance the flow. */
  onAdd?: () => void | Promise<void>;
}) {
  return (
    <aside className="gaside">
      <InventoryCard holdSeq={holdSeq} />
      <AddToInventoryCard pendingCount={pendingCount} onAdd={onAdd} />
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

/* --------------------------------------------------------------- add action */

/**
 * §M.2 — take this whole donation onto the shelf in one click.
 *
 * The per-item "Add to inventory" buttons on the verdict cards shelve one item
 * at a time; this is the same action for the common case where the coordinator
 * has decided the food bank keeps all of it. `onAdd` does the work (the parent
 * owns the staged donation and the hold machinery) — this card only reflects how
 * many items are still pending and whether a request is in flight.
 */
function AddToInventoryCard({ pendingCount, onAdd }: {
  pendingCount: number;
  onAdd?: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function add() {
    if (busy || pendingCount === 0 || !onAdd) return;
    setBusy(true);
    setErr(null);
    try {
      await onAdd();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="gcard add">
      <header className="gc-head">
        <span className="gc-title display-face">Add to inventory</span>
      </header>
      <p className="gc-empty">
        {pendingCount === 0
          ? 'Every item on this donation is already held.'
          : `Store ${pendingCount} item${pendingCount === 1 ? '' : 's'} from this donation on the food bank's shelf.`}
      </p>
      {err && <p className="gc-empty err">could not add — {err}</p>}
      <button
        className="btn-primary gadd-btn"
        type="button"
        onClick={() => void add()}
        disabled={busy || pendingCount === 0}
      >
        {busy ? 'Adding…' : 'Add to inventory'}
      </button>
    </section>
  );
}
