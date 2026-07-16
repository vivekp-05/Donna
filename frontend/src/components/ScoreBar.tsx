import React from 'react';
import type { ScoreBreakdown } from '../types';
import { TERM_COLORS, TERM_LABELS } from '../theme';
import { TERM_KEYS } from '../types';

/** Horizontal stacked 5-term score bar. Each segment width ∝ its 0..1 term value. */
export function ScoreBar({ score }: { score: ScoreBreakdown }) {
  if (score.hardFail) {
    return (
      <div className="sbar" title="Hard fail — total 0">
        <div className="seg" style={{ width: '100%', background: 'repeating-linear-gradient(45deg,#2a3145,#2a3145 6px,#222738 6px,#222738 12px)' }} />
      </div>
    );
  }
  const total = TERM_KEYS.reduce((s, k) => s + score[k], 0) || 1;
  return (
    <div className="sbar">
      {TERM_KEYS.map((k) => (
        <div
          key={k}
          className="seg"
          title={`${TERM_LABELS[k]} ${Math.round(score[k] * 100)}%`}
          style={{ width: `${(score[k] / total) * 100}%`, background: TERM_COLORS[k] }}
        />
      ))}
    </div>
  );
}

export function TermLegend() {
  return (
    <div className="legend">
      {TERM_KEYS.map((k) => (
        <div className="li" key={k}>
          <span className="sw" style={{ background: TERM_COLORS[k] }} />
          {TERM_LABELS[k]}
        </div>
      ))}
    </div>
  );
}
