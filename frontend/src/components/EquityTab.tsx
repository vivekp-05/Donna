import React, { useMemo } from 'react';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { useDonna } from '../state';

const NEAREST = '#8b93a7';
const DONNA = '#ff6a3d';

export function EquityTab() {
  const { equity, runEquity, busy, recipientsById } = useDonna();

  const barData = useMemo(() => {
    if (!equity) return [];
    const ids = new Set([...Object.keys(equity.nearest.perRecipientLbs), ...Object.keys(equity.donna.perRecipientLbs)]);
    return Array.from(ids).map((id) => ({
      name: (recipientsById[id]?.name || id).replace(/ (Pantry|Collective|Center|Kitchen|Agency|Bank)$/, ''),
      nearest: Math.round(equity.nearest.perRecipientLbs[id] || 0),
      donna: Math.round(equity.donna.perRecipientLbs[id] || 0),
    })).sort((a, b) => (b.donna + b.nearest) - (a.donna + a.nearest));
  }, [equity, recipientsById]);

  return (
    <div className="equity">
      <div className="equity-inner">
        <div className="equity-head">
          <h2>Equity</h2>
          <span className="equity-sub"><b style={{ color: NEAREST }}>Nearest-feasible</b> vs <b style={{ color: DONNA }}>Donna</b> · lower Gini = fairer</span>
          <button className="btn hot" style={{ marginLeft: 'auto' }} onClick={() => runEquity(30)} disabled={busy.equity}>
            {busy.equity ? <span className="loading-line"><span className="spinner" /> Simulating…</span> : 'Run 30-drop simulation'}
          </button>
        </div>

        {!equity ? (
          <div className="detail-empty" style={{ padding: 60 }}>Run the simulation to compare fairness under both policies.</div>
        ) : (
          <>
            <div className="stat-row">
              <StatTile label="Gini · Nearest" value={equity.nearest.gini.toFixed(3)} desc="baseline" kind="" />
              <StatTile label="Gini · Donna" value={equity.donna.gini.toFixed(3)} desc={giniDelta(equity.nearest.gini, equity.donna.gini)} kind={equity.donna.gini < equity.nearest.gini ? 'win' : 'hot'} />
              <StatTile label="Min/Max · Nearest" value={equity.nearest.minMaxRatio.toFixed(2)} desc="smallest ÷ largest" kind="" />
              <StatTile label="Min/Max · Donna" value={equity.donna.minMaxRatio.toFixed(2)} desc={equity.donna.minMaxRatio > equity.nearest.minMaxRatio ? 'more balanced' : 'less balanced'} kind={equity.donna.minMaxRatio > equity.nearest.minMaxRatio ? 'win' : 'cool'} />
            </div>

            <div className="chart-card">
              <h3>Inequality over time <span className="csub">Gini after each drop</span></h3>
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={equity.series} margin={{ top: 8, right: 16, left: -6, bottom: 4 }}>
                  <CartesianGrid stroke="#1b2130" vertical={false} />
                  <XAxis dataKey="drop" stroke="#3a4258" tickLine={false} axisLine={{ stroke: '#232a3c' }} />
                  <YAxis stroke="#3a4258" tickLine={false} axisLine={{ stroke: '#232a3c' }} domain={[0, 'auto']} />
                  <Tooltip content={<GiniTip />} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="nearestGini" name="Nearest" stroke={NEAREST} strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="donnaGini" name="Donna" stroke={DONNA} strokeWidth={2.5} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="chart-card">
              <h3>Pounds delivered per recipient <span className="csub">flatter = more equitable</span></h3>
              <ResponsiveContainer width="100%" height={Math.max(280, barData.length * 26)}>
                <BarChart data={barData} layout="vertical" margin={{ top: 8, right: 20, left: 8, bottom: 4 }}>
                  <CartesianGrid stroke="#1b2130" horizontal={false} />
                  <XAxis type="number" stroke="#3a4258" tickLine={false} axisLine={{ stroke: '#232a3c' }} />
                  <YAxis type="category" dataKey="name" width={128} stroke="#3a4258" tickLine={false} axisLine={{ stroke: '#232a3c' }} />
                  <Tooltip content={<LbsTip />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="nearest" name="Nearest" fill={NEAREST} radius={[0, 3, 3, 0]} />
                  <Bar dataKey="donna" name="Donna" fill={DONNA} radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StatTile({ label, value, desc, kind }: { label: string; value: string; desc: string; kind: string }) {
  return (
    <div className={`stat ${kind}`}>
      <div className="sl">{label}</div>
      <div className="sv">{value}</div>
      <div className="sd">{desc}</div>
    </div>
  );
}

function giniDelta(nearest: number, donna: number): string {
  const pct = nearest > 0 ? Math.round(((nearest - donna) / nearest) * 100) : 0;
  if (donna < nearest) return `${pct}% fairer`;
  return 'no improvement';
}

function GiniTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rc-tip">
      <div className="rt-label">Drop {label}</div>
      {payload.map((p: any) => (
        <div className="rt-row" key={p.dataKey}>
          <span className="sw" style={{ background: p.color }} />{p.name}
          <span className="v">{Number(p.value).toFixed(3)}</span>
        </div>
      ))}
    </div>
  );
}

function LbsTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rc-tip">
      <div className="rt-label">{label}</div>
      {payload.map((p: any) => (
        <div className="rt-row" key={p.dataKey}>
          <span className="sw" style={{ background: p.color }} />{p.name}
          <span className="v">{Number(p.value).toLocaleString()} lb</span>
        </div>
      ))}
    </div>
  );
}
