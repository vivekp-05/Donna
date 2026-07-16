import type { Recipient, DonationItem } from '../types.js';
import { humanize } from '../text/humanize.js';

// ---------------------------------------------------------------------------
// memoryHint() — UI_REDESIGN §D.3: at most ONE short, human contextual clause
// drawn from what we remember about a recipient. NEVER enumerates their
// infrastructure / accepts / rejects lists and never emits raw enum tokens.
// Returns '' when there is nothing worth saying (the offer then simply asks).
// ---------------------------------------------------------------------------

const COLD_STORAGE: ReadonlyArray<Recipient['infrastructure'][number]> = [
  'walk_in_fridge',
  'freezer',
  'fridge',
];

export function memoryHint(recipient: Recipient, item: DonationItem): string {
  // Cold-chain items → nod to their cold storage if they have any.
  if (item.needsRefrigeration) {
    const cold = COLD_STORAGE.find((k) => recipient.infrastructure.includes(k));
    if (cold) return `I know you've got ${humanize(cold)} space`;
  }
  // Otherwise, if this is squarely in what they usually take, say so once.
  if (recipient.accepts.includes(item.category)) {
    return `I know ${humanize(item.category)} is right in your wheelhouse`;
  }
  return '';
}
