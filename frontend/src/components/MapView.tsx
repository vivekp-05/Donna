import React, { useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, CircleMarker, Marker, Popup, ZoomControl, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useDonna } from '../state';
import type { Recipient, ScoreBreakdown } from '../types';
import { scoreColor, HARDFAIL_LABELS, fmtMiles, fmtHours } from '../theme';

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
    map.fitBounds(bounds, { padding: [90, 90], maxZoom: 14, animate: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, JSON.stringify(pts)]);
  return null;
}

export function MapView() {
  const { current, recipients, activeRankings, selectedRecipientId, selectRecipient } = useDonna();

  const donation = current?.donation ?? null;
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
    <div className="map-hero">
      <MapContainer center={pickup || SF_CENTER} zoom={12} zoomControl={false} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
        <ZoomControl position="bottomright" />
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
        <div className="ramp-bar" />
        <div className="ramp-scale"><span>low</span><span>match</span><span>high</span></div>
        <div className="lg-row"><span className="swx grey" /> not feasible</div>
        <div className="lg-row"><span className="swx pickup" /> pickup</div>
      </div>
    </div>
  );
}

function RecipientPopup({ r, score, rank }: { r: Recipient; score?: ScoreBreakdown; rank?: number }) {
  return (
    <div className="pop">
      <h4>{rank ? `#${rank} · ` : ''}{r.name}</h4>
      <div className="sub">{r.type === 'pantry' ? 'Pantry' : 'Community agency'} · {r.leadContact}</div>
      {!score ? (
        <div className="sub">No ranking for this item.</div>
      ) : score.hardFail ? (
        <div className="pop-fail">✕ {HARDFAIL_LABELS[score.hardFail]}</div>
      ) : (
        <>
          <div className="pop-total">{score.total.toFixed(2)}</div>
          <div className="pop-meta">
            <span>{fmtMiles(score.distanceMiles)}</span>
            <span>{fmtHours(score.driveTimeHours)} drive</span>
          </div>
        </>
      )}
    </div>
  );
}
