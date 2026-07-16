// ---------------------------------------------------------------------------
// humanize() — the single source of truth for turning internal enum tokens
// (snake_case categories / infrastructure) into human, speakable copy used in
// any user-visible string (call scripts, manager replies, callbacks).
// UI_REDESIGN §B/§D.3: no raw enum tokens ever reach a person.
//   fresh_produce  -> "fresh produce"
//   walk_in_fridge -> "walk-in fridge"
// ---------------------------------------------------------------------------

const OVERRIDES: Record<string, string> = {
  walk_in_fridge: 'walk-in fridge',
  fresh_produce: 'fresh produce',
  dry_goods: 'dry goods',
  dry_storage: 'dry storage',
  loading_dock: 'loading dock',
  web_form: 'web form',
  walk_in: 'walk-in',
};

/** Convert an enum token (or any snake_case string) to human copy. */
export function humanize(token: unknown): string {
  const key = String(token ?? '').trim().toLowerCase();
  if (!key) return '';
  if (OVERRIDES[key]) return OVERRIDES[key];
  return key.replace(/_/g, ' ');
}

/** First name from a contact string ("Rosa Martinez" -> "Rosa"). Safe on empty. */
export function firstName(contact: unknown): string {
  const s = String(contact ?? '').trim();
  if (!s) return '';
  return s.split(/\s+/)[0];
}

/** Spoken spoilage urgency: "in the next 12 hours" / "within about 2 days". */
export function fmtUrgency(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return 'soon';
  if (hours < 48) return `in the next ${Math.round(hours)} hours`;
  return `within about ${Math.round(hours / 24)} days`;
}
