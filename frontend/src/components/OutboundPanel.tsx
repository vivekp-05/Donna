import React, { useMemo, useState } from 'react';
import { useDonna } from '../state';
import type { CallLogEntry, Donation } from '../types';
import { humanize } from '../theme';

// §F — the right dock's default view. A DB-first feed of everything Donna sends
// OUT, newest first: call attempts (from GET /api/calls) interleaved with donor
// callbacks (derived client-side from resolved donations with a donorMessage).
// Renders exclusively from fetched state; ≤2-line rows; one accent, dots only.

type OutboundRow =
  | { kind: 'call'; ts: string; key: string; call: CallLogEntry }
  | { kind: 'callback'; ts: string; key: string; donorName?: string; message: string };

// Latest attempt `at` across the donation's items, else its receivedAt (§F).
function callbackTs(d: Donation): string {
  let latest = '';
  for (const it of d.items) {
    for (const a of it.attempts ?? []) {
      if (a.at > latest) latest = a.at;
    }
  }
  return latest || d.receivedAt;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function OutboundPanel() {
  const { calls, donations } = useDonna();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  // Merge attempts + callbacks into one newest-first stream.
  const rows = useMemo<OutboundRow[]>(() => {
    const out: OutboundRow[] = [];
    for (const c of calls) {
      out.push({ kind: 'call', ts: c.at, key: `call:${c.itemId}:${c.recipientId}:${c.at}`, call: c });
    }
    for (const d of donations) {
      if (d.status === 'resolved' && d.donorMessage) {
        out.push({
          kind: 'callback',
          ts: callbackTs(d),
          key: `cb:${d.id}`,
          donorName: d.donorName,
          message: d.donorMessage,
        });
      }
    }
    // Newest first (ISO timestamps sort lexicographically).
    out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return out;
  }, [calls, donations]);

  const toggle = (key: string) => setExpandedKey((cur) => (cur === key ? null : key));

  return (
    <aside className="outbound">
      <div className="ob-head">
        <span className="ob-title">Outbound</span>
        <span className="ob-legend" title="Calls placed &amp; donor messages">☎ ✉</span>
      </div>

      <div className="ob-scroll">
        {rows.length === 0 ? (
          <div className="ob-empty">No outbound activity yet.</div>
        ) : (
          rows.map((row) =>
            row.kind === 'call' ? (
              <CallRow
                key={row.key}
                c={row.call}
                expanded={expandedKey === row.key}
                onToggle={() => toggle(row.key)}
              />
            ) : (
              <CallbackRow
                key={row.key}
                donorName={row.donorName}
                message={row.message}
                ts={row.ts}
                expanded={expandedKey === row.key}
                onToggle={() => toggle(row.key)}
              />
            ),
          )
        )}
      </div>
    </aside>
  );
}

function outcomeDot(outcome: CallLogEntry['outcome']): string {
  if (outcome === 'accepted') return 'ok';
  if (outcome === 'declined') return 'bad';
  return 'pending'; // no_answer → grey
}

function CallRow({ c, expanded, onToggle }: {
  c: CallLogEntry; expanded: boolean; onToggle: () => void;
}) {
  return (
    <div className={`ob-row call ${c.outcome}${expanded ? ' open' : ''}`}>
      <button className="ob-line" onClick={onToggle}>
        <span className="ob-l1">
          <span className={`sdot ${outcomeDot(c.outcome)}`} />
          <span className="ob-name">{c.recipientName}</span>
          <span className="ob-time">{fmtTime(c.at)}</span>
        </span>
        <span className="ob-l2">{humanize(c.itemName)}</span>
      </button>
      {expanded && (
        <div className="att-transcript">
          {c.transcript.map((t, i) => (
            <div key={i} className={`bubble ${t.speaker}`}>{t.text}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function CallbackRow({ donorName, message, ts, expanded, onToggle }: {
  donorName?: string; message: string; ts: string; expanded: boolean; onToggle: () => void;
}) {
  const firstLine = message.split('\n')[0];
  return (
    <div className={`ob-row callback${expanded ? ' open' : ''}`}>
      <button className="ob-line" onClick={onToggle}>
        <span className="ob-l1">
          <span className="ob-env">✉</span>
          <span className="ob-name">To {donorName || 'the donor'}</span>
          <span className="ob-time">{fmtTime(ts)}</span>
        </span>
        {!expanded && <span className="ob-l2">{firstLine}</span>}
      </button>
      {expanded && <div className="ob-msg">{message}</div>}
    </div>
  );
}
