import React from 'react';
import { useDonna } from '../state';
import type { Channel, Donation, DonationItem } from '../types';

export const CHANNEL_ICON: Record<Channel, string> = {
  voice: '☎',
  sms: '💬',
  email: '✉',
  walk_in: '🚶',
  web_form: '🌐',
};

function statusClass(it: DonationItem): string {
  if (it.status === 'matched') return 'ok';
  if (it.status === 'unplaceable') return 'bad';
  return 'pending';
}

export function Feed({ onNew }: { onNew: () => void }) {
  const { donations, selectedItemId, current, openItem, busy } = useDonna();

  return (
    <aside className="feed">
      <div className="feed-head">
        <span className="feed-title">Inbound</span>
        <span className="feed-legend" title="Channels donations arrive on">☎ 💬 ✉ 🚶</span>
      </div>

      <div className="feed-scroll">
        {donations.length === 0 ? (
          <div className="feed-empty">Waiting for donations…</div>
        ) : (
          donations.slice().reverse().map((d) => (
            <FeedCard
              key={d.id}
              d={d}
              activeDonation={current?.donation.id === d.id}
              selectedItemId={selectedItemId}
              onItem={(itemId) => openItem(d.id, itemId)}
            />
          ))
        )}
      </div>

      <button className="feed-new" onClick={onNew} disabled={busy.ingest}>+ Donation</button>
    </aside>
  );
}

function FeedCard({ d, activeDonation, selectedItemId, onItem }: {
  d: Donation; activeDonation: boolean; selectedItemId: string | null;
  onItem: (itemId: string) => void;
}) {
  const time = new Date(d.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div className={`fcard${activeDonation ? ' active' : ''}`}>
      <div className="fcard-line1">
        <span className="fdonor">{d.donorName || 'Unknown donor'}</span>
        <span className="fmeta">{CHANNEL_ICON[d.sourceChannel]} {time}</span>
      </div>
      <div className="fpills">
        {d.items.map((it) => (
          <button
            key={it.id}
            className={`pill-item${activeDonation && selectedItemId === it.id ? ' sel' : ''}`}
            onClick={() => onItem(it.id)}
            title={it.item}
          >
            <span className={`sdot ${statusClass(it)}`} />
            <span className="pname">{it.item}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
