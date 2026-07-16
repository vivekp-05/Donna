import React, { useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, CircleMarker, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useDonna } from '../state';
import type { DonationItem, Recipient, ScoreBreakdown } from '../types';
import { scoreColor, CATEGORY_LABELS, HARDFAIL_LABELS, TERM_COLORS, TERM_LABELS, fmtMiles, fmtHours } from '../theme';
import { TERM_KEYS } from '../types';

const SF_CENTER: [number, number] = [37.7749, -122.4194];

const pickupIcon = L.divIcon({
  className: '',
  html: '<div class="pickup-pin"><div class="ring"></div><div class="core"></div></div>',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

function FitBounds({ pts }: { pts: Array<[number, number]> }) {
  const map = useMap();
  useEffect(() => {
    if (pts.length === 0) return;
    if (pts.length === 1) { map.setView(pts[0], 13, { animate: true }); return; }
    const bounds = L.latLngBounds(pts);
    map.fitBounds(bounds, { padding: [70, 70], maxZoom: 14, animate: true });
  }, [map, JSON.stringify(pts)]);
  return null;
}

export function MapView() {
  const { current, recipients, activeRankings, selectedItemId, selectItem, selectedRecipientId, selectRecipient } = useDonna();

  const donation = current?.donation ?? null;
  const items = donation?.items ?? [];
  const pickup: [number, number] | null =
    donation && donation.pickupLat != null && donation.pickupLng != null
      ? [donation.pickupLat, donation.pickupLng] : null;

  const scoreById = useMemo(() => {
    const m: Record<string, ScoreBreakdown> = {};
    for (const r of activeRankings) m[r.recipient.id] = r.score;
    return m;
  }, [activeRankings]);

  const pts = useMemo<Array<[number, number]>>(() => {
    const arr: Array<[number, number]> = recipients.map((r) => [r.lat, r.lng]);
    if (pickup) arr.push(pickup);
    return arr;
  }, [recipients, pickup]);

  return (
    <div className="col center">
      {items.length > 0 && (
        <div className="map-item-tabs">
          {items.map((it) => (
            <button
              key={it.id}
              className={`mtab${selectedItemId === it.id ? ' active' : ''}`}
              onClick={() => selectItem(it.id)}
            >
              <span className="sw" style={{ background: statusSwatch(it) }} />
              {it.item}
            </button>
          ))}
        </div>
      )}

      <div className="mapwrap">
        <MapContainer center={pickup || SF_CENTER} zoom={12} zoomControl scrollWheelZoom style={{ height: '100%', width: '100%' }}>
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
            subdomains="abcd"
            maxZoom={20}
          />
          <FitBounds pts={pts} />

          {recipients.map((r) => {
            const score = scoreById[r.id];
            const color = scoreColor(score);
            const selected = selectedRecipientId === r.id;
            const rank = activeRankings.findIndex((x) => x.recipient.id === r.id);
            return (
              <CircleMarker
                key={r.id}
                center={[r.lat, r.lng]}
                radius={selected ? 12 : 8}
                pathOptions={{
                  color: selected ? '#ffffff' : color,
                  weight: selected ? 2.5 : 1.5,
                  fillColor: color,
                  fillOpacity: score?.hardFail ? 0.35 : 0.82,
                }}
                eventHandlers={{ click: () => selectRecipient(r.id) }}
              >
                <Popup>
                  <RecipientPopup r={r} score={score} rank={rank >= 0 ? rank + 1 : undefined} />
                </Popup>
              </CircleMarker>
            );
          })}

          {pickup && (
            <Marker position={pickup} icon={pickupIcon} zIndexOffset={1000}>
              <Popup>
                <div className="pop">
                  <h4>{donation?.donorName || 'Pickup'}</h4>
                  <div className="sub">{donation?.pickupLocation}</div>
                </div>
              </Popup>
            </Marker>
          )}
        </MapContainer>

        <div className="map-legend">
          <div className="lg-title">Match score</div>
          <div className="ramp-bar" />
          <div className="ramp-scale"><span>0</span><span>0.5</span><span>1.0</span></div>
          <div className="lg-row"><span className="swx" style={{ background: '#54607a' }} /> Hard fail</div>
          <div className="lg-row"><span className="swx pickup-swatch" style={{ background: 'var(--hot)' }} /> Pickup</div>
        </div>
      </div>
    </div>
  );
}

function statusSwatch(it: DonationItem): string {
  if (it.status === 'matched') return 'var(--good)';
  if (it.status === 'unplaceable') return 'var(--bad)';
  return 'var(--warn)';
}

function RecipientPopup({ r, score, rank }: { r: Recipient; score?: ScoreBreakdown; rank?: number }) {
  return (
    <div className="pop">
      <h4>{rank ? `#${rank} · ` : ''}{r.name}</h4>
      <div className="sub">{r.type === 'pantry' ? 'Pantry' : 'Community agency'} · {r.leadContact}</div>
      {!score ? (
        <div className="sub">No ranking for this item.</div>
      ) : score.hardFail ? (
        <>
          <div className="pop-fail">✕ {HARDFAIL_LABELS[score.hardFail]}</div>
          <div className="pop-meta">
            <span>{fmtMiles(score.distanceMiles)}</span>
            <span>{fmtHours(score.driveTimeHours)} drive</span>
          </div>
        </>
      ) : (
        <>
          <div className="pop-total" style={{ color: scoreColor(score) }}>{score.total.toFixed(2)}</div>
          <div className="pop-terms">
            {TERM_KEYS.map((k) => (
              <div className="pop-term" key={k}>
                <span className="pt-name">{TERM_LABELS[k]}</span>
                <span className="pt-track"><span className="pt-fill" style={{ width: `${score[k] * 100}%`, background: TERM_COLORS[k] }} /></span>
                <span className="pt-val">{score[k].toFixed(2)}</span>
              </div>
            ))}
          </div>
          <div className="pop-meta">
            <span>{fmtMiles(score.distanceMiles)}</span>
            <span>{fmtHours(score.driveTimeHours)} drive</span>
          </div>
        </>
      )}
    </div>
  );
}
