import React, { useState } from 'react';
import { useDonna } from '../state';
import type { Channel, Donation } from '../types';
import { CATEGORY_LABELS } from '../theme';

const CHANNELS: Array<{ id: Channel; ico: string; lbl: string }> = [
  { id: 'voice', ico: '☎', lbl: 'Voice' },
  { id: 'sms', ico: '💬', lbl: 'SMS' },
  { id: 'email', ico: '✉', lbl: 'Email' },
  { id: 'walk_in', ico: '🚶', lbl: 'Walk-in' },
];

const PLACEHOLDERS: Record<Channel, string> = {
  voice: 'Paste the voicemail transcript…',
  sms: 'Paste the text message…',
  email: 'Paste the email body…',
  walk_in: "Type what the donor said at the dock…",
  web_form: 'Paste the form submission…',
};

export function IntakePanel() {
  const { donations, current, selectDonation, ingest, loadCanned, selectItem, selectedItemId, busy } = useDonna();
  const [channel, setChannel] = useState<Channel>('voice');
  const [text, setText] = useState('');

  const submit = () => {
    if (!text.trim()) return;
    ingest(channel, `${channel}-donor`, text.trim());
    setText('');
  };

  return (
    <div className="col-scroll">
      <div>
        <div className="section-title"><span className="accent-h">◆</span> Intake</div>
      </div>

      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="chan-tabs">
          {CHANNELS.map((c) => (
            <button
              key={c.id}
              className={`chan${channel === c.id ? ' active' : ''}`}
              onClick={() => setChannel(c.id)}
            >
              <span className="ico">{c.ico}</span>
              <span className="lbl">{c.lbl}</span>
            </button>
          ))}
        </div>
        <textarea
          className="intake-input"
          placeholder={PLACEHOLDERS[channel]}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}
        />
        <div className="intake-actions">
          <button className="btn hot" onClick={submit} disabled={busy.ingest || !text.trim()}>
            {busy.ingest ? <span className="spinner" /> : 'Parse & score'}
          </button>
          <button className="btn" onClick={loadCanned} disabled={busy.ingest} title="Load the Golden State Produce scenario">
            ▶ Canned demo
          </button>
        </div>
      </div>

      <div>
        <div className="section-title">
          <span className="accent-h">◆</span> Donations
          <span className="count">{donations.length}</span>
        </div>
      </div>

      {donations.length === 0 ? (
        <div className="empty">
          No donations yet.<br />
          Hit <b>▶ Canned demo</b> to load the strawberry-shipment scenario.
        </div>
      ) : (
        <div className="don-list">
          {donations.slice().reverse().map((d) => (
            <DonationCard
              key={d.id}
              d={d}
              active={current?.donation.id === d.id}
              selectedItemId={selectedItemId}
              onOpen={() => selectDonation(d.id)}
              onItem={(id) => { if (current?.donation.id === d.id) selectItem(id); else selectDonation(d.id); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DonationCard({ d, active, selectedItemId, onOpen, onItem }: {
  d: Donation; active: boolean; selectedItemId: string | null;
  onOpen: () => void; onItem: (id: string) => void;
}) {
  const time = new Date(d.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div className={`don${active ? ' active' : ''}`} onClick={onOpen}>
      <div className="don-head">
        <span className="don-donor">{d.donorName || 'Unknown donor'}</span>
        <span className="don-meta">{d.sourceChannel} · {time}</span>
      </div>
      {d.pickupLocation && <div className="don-loc">📍 {d.pickupLocation}</div>}
      <div className="don-items">
        {d.items.map((it) => (
          <div
            key={it.id}
            className={`item-row${active && selectedItemId === it.id ? ' sel' : ''}`}
            onClick={(e) => { e.stopPropagation(); onItem(it.id); }}
          >
            <span className="iname">{it.item}</span>
            <span className="iqty">{Math.round(it.qtyLbs)}lb · {CATEGORY_LABELS[it.category]}</span>
            <span className={`chip mini ${it.status}`}>{it.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
