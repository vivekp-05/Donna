import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useDonna } from '../state';
import type { CallAttempt, DonationItem, RankedRecipient, Weights } from '../types';
import { TERM_KEYS } from '../types';
import { TERM_COLORS, TERM_LABELS, HARDFAIL_LABELS, scoreColor, fmtMiles, fmtHours, CATEGORY_LABELS } from '../theme';
import { ScoreBar, TermLegend } from './ScoreBar';

export function DecisionPanel() {
  const {
    current, activeRankings, activeExplanation, selectedItemId,
    config, rerank, dispatch, busy, recipientsById,
  } = useDonna();

  const donation = current?.donation ?? null;
  const item = useMemo<DonationItem | null>(
    () => donation?.items.find((i) => i.id === selectedItemId) ?? null,
    [donation, selectedItemId],
  );

  // ---- weight sliders (debounced live re-rank) ----
  const [weights, setWeights] = useState<Weights | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (config && !weights) setWeights(config.weights);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  const onSlide = (k: keyof Weights, v: number) => {
    if (!weights || !selectedItemId) return;
    const next = { ...weights, [k]: v };
    setWeights(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => rerank(selectedItemId, next), 220);
  };

  const resetWeights = () => {
    if (!config || !selectedItemId) return;
    setWeights(config.weights);
    rerank(selectedItemId, config.weights);
  };

  const [showConfirm, setShowConfirm] = useState(false);
  const resolved = donation?.status === 'resolved';
  const canDispatch = !!donation && donation.items.some((i) => i.status === 'pending') && !resolved;

  const onDispatchClick = () => {
    if (config && !config.autopilot) setShowConfirm(true);
    else dispatch();
  };

  if (!donation) {
    return (
      <div className="col-scroll">
        <div className="section-title"><span className="accent-c">◇</span> Decision</div>
        <div className="empty">Load a donation to see the allocation board.</div>
      </div>
    );
  }

  const attempts = item?.attempts ?? [];

  return (
    <div className="col-scroll">
      <div className="section-title">
        <span className="accent-c">◇</span> Decision
        {item && <span className="count">{item.item} · {Math.round(item.qtyLbs)}lb</span>}
      </div>

      {item && (
        <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>{item.item}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 3, fontFamily: 'var(--mono)' }}>
              {CATEGORY_LABELS[item.category]} · {Math.round(item.qtyLbs)}lb · spoils {fmtHours(item.hoursToSpoil)}
              {item.needsRefrigeration ? ' · ❄ cold' : ''}
            </div>
          </div>
          <span className={`chip ${item.status}`}>{item.status}</span>
        </div>
      )}

      {/* ranked recipients */}
      {activeRankings.length === 0 ? (
        <div className="empty">No rankings for this item yet.</div>
      ) : (
        <>
          <div className="rank-list">
            {activeRankings.map((r, i) => (
              <RankRow key={r.recipient.id} r={r} idx={i} matched={item?.matchedRecipientId === r.recipient.id} />
            ))}
          </div>
          <TermLegend />
        </>
      )}

      {activeExplanation && (
        <div className="explain" dangerouslySetInnerHTML={{ __html: boldFirst(activeExplanation) }} />
      )}

      {/* weight sliders */}
      {weights && item && (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="section-title" style={{ margin: 0 }}>
            Weights
            <button className="btn ghost small" style={{ marginLeft: 'auto' }} onClick={resetWeights}>Reset</button>
          </div>
          <div className="sliders">
            {TERM_KEYS.map((k) => (
              <div className="slider-row" key={k}>
                <span className="sl-name"><span className="sw" style={{ background: TERM_COLORS[k] }} />{TERM_LABELS[k]}</span>
                <input
                  type="range" min={0} max={1} step={0.05}
                  value={weights[k]}
                  onChange={(e) => onSlide(k, parseFloat(e.target.value))}
                />
                <span className="sl-val">{weights[k].toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* dispatch */}
      <div className="dispatch-cta">
        {resolved ? (
          <button className="btn block" disabled>✓ Dispatched & resolved</button>
        ) : (
          <button className="btn hot block" onClick={onDispatchClick} disabled={!canDispatch || busy.dispatch}>
            {busy.dispatch
              ? <span className="loading-line"><span className="spinner" /> Placing calls…</span>
              : (config && !config.autopilot ? '▶ Dispatch (confirm)' : '▶ Dispatch all items')}
          </button>
        )}
      </div>

      {/* transcript feed for selected item */}
      {attempts.length > 0 && (
        <div>
          <div className="section-title"><span className="accent-c">◇</span> Call log <span className="count">{item?.item}</span></div>
          <div className="transcript">
            {attempts.map((a, i) => <AttemptCard key={i} a={a} />)}
          </div>
        </div>
      )}

      {item && item.status === 'matched' && item.matchedRecipientId && (
        <div className="explain" style={{ borderLeftColor: 'var(--good)', background: 'rgba(87,204,153,0.08)' }}>
          ✓ Matched to <b>{recipientsById[item.matchedRecipientId]?.name || item.matchedRecipientId}</b>
          {item.resolutionReason ? ` — ${item.resolutionReason}` : ''}
        </div>
      )}
      {item && item.status === 'unplaceable' && (
        <div className="explain" style={{ borderLeftColor: 'var(--bad)', background: 'var(--bad-dim)' }}>
          ✕ Unplaceable — {item.resolutionReason || 'no feasible recipient'}
        </div>
      )}

      {/* donor callback */}
      {donation.donorMessage && (
        <div className="callback fade-in">
          <div className="cb-head">📨 Donor callback — {donation.donorName}</div>
          <div className="cb-bubble">{donation.donorMessage}</div>
        </div>
      )}

      {showConfirm && (
        <ConfirmModal
          count={donation.items.filter((i) => i.status === 'pending').length}
          onCancel={() => setShowConfirm(false)}
          onConfirm={() => { setShowConfirm(false); dispatch(); }}
        />
      )}
    </div>
  );
}

function RankRow({ r, idx, matched }: { r: RankedRecipient; idx: number; matched: boolean }) {
  const { selectRecipient } = useDonna();
  const s = r.score;
  const failed = !!s.hardFail;
  return (
    <div
      className={`rank${idx === 0 && !failed ? ' top' : ''}${failed ? ' failed' : ''}`}
      onClick={() => selectRecipient(r.recipient.id)}
    >
      <div className="rank-head">
        <span className="rank-num">{failed ? '—' : `#${idx + 1}`}</span>
        <span className="rank-name">{r.recipient.name}{matched ? ' ✓' : ''}</span>
        {failed
          ? <span className="rank-fail">{HARDFAIL_LABELS[s.hardFail!]}</span>
          : <span className="rank-total" style={{ color: scoreColor(s) }}>{s.total.toFixed(2)}</span>}
      </div>
      <ScoreBar score={s} />
      <div className="rank-sub">
        <span>{fmtMiles(s.distanceMiles)}</span>
        <span>{fmtHours(s.driveTimeHours)}</span>
        <span style={{ marginLeft: 'auto' }}>{r.recipient.type === 'pantry' ? 'pantry' : 'agency'}</span>
      </div>
    </div>
  );
}

function AttemptCard({ a }: { a: CallAttempt }) {
  const time = a.at ? new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <div className={`attempt ${a.outcome}`}>
      <div className="attempt-head">
        <span className="an">{a.recipientName}</span>
        {a.simulated && <span className="chip mini pending" style={{ background: 'var(--bg-3)', color: 'var(--text-faint)' }}>sim</span>}
        <span className="at">{time}</span>
      </div>
      <div className="bubbles">
        {a.transcript.map((t, i) => (
          <div key={i} className={`bubble ${t.speaker}`}>{t.text}</div>
        ))}
      </div>
      <div className={`attempt-verdict ${a.outcome}`}>
        {a.outcome === 'accepted' ? '✓ Accepted' : a.outcome === 'declined' ? '✕ Declined' : '… No answer'}
        {a.reason && <span className="reason">— {a.reason}</span>}
      </div>
    </div>
  );
}

function ConfirmModal({ count, onCancel, onConfirm }: { count: number; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Dispatch {count} item{count === 1 ? '' : 's'}?</h3>
        <p>Autopilot is off. Donna will place outbound calls to ranked recipients and won't stop until each item is matched or exhausted. This is the human-confirm gate.</p>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn hot" onClick={onConfirm}>▶ Confirm dispatch</button>
        </div>
      </div>
    </div>
  );
}

function boldFirst(text: string): string {
  // escape then bold the first recipient-ish token span up to first period lightly
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc;
}
