import React, { useState } from 'react';
import { useDonna } from '../state';
import type { Channel } from '../types';

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
  walk_in: 'Type what the donor said at the dock…',
  web_form: 'Paste the form submission…',
};

export function IntakeModal({ onClose }: { onClose: () => void }) {
  const { ingest, loadCanned, busy } = useDonna();
  const [channel, setChannel] = useState<Channel>('voice');
  const [text, setText] = useState('');

  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    await ingest(channel, `${channel}-donor`, t);
    onClose();
  };

  const canned = async () => {
    await loadCanned();
    onClose();
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal intake-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>New donation</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

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
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(); }}
        />

        <div className="modal-actions">
          <button className="link-btn" onClick={canned} disabled={busy.ingest}>Play canned demo</button>
          <button className="btn hot" onClick={submit} disabled={busy.ingest || !text.trim()}>
            {busy.ingest ? <span className="spinner" /> : 'Parse & score'}
          </button>
        </div>
      </div>
    </div>
  );
}
