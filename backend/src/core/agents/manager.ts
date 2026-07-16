import type {
  ManagerReply,
  ConfigPatch,
  Recipient,
  ItemCategory,
  Infrastructure,
  Weights,
} from '../types.js';
import type { MemoryStore } from '../memory/store.js';
import type { LlmClient } from './llm.js';
import { createLlm, extractJson } from './llm.js';
import { buildTaskPrompt } from './protocol.js';
import { heuristicManager } from './llmMock.js';

const VALID_CATEGORIES: ItemCategory[] = [
  'fresh_produce', 'fruit', 'canned', 'dry_goods', 'baked',
  'dairy', 'meat', 'prepared', 'beverages', 'other',
];
const VALID_INFRA: Infrastructure[] = [
  'walk_in_fridge', 'fridge', 'freezer', 'dry_storage', 'loading_dock',
];
const VALID_OPS = new Set<ConfigPatch['op']>([
  'set_accepts', 'add_infrastructure', 'remove_infrastructure', 'set_rejects',
  'set_weights', 'set_autopilot', 'set_note', 'set_volume',
]);
const WEIGHT_KEYS: Array<keyof Weights> = ['feasibility', 'coldchain', 'capacity', 'equity', 'prefs'];

const INSTRUCTIONS =
  'You are Donna, a dispatch manager assistant. Convert the operator message into a list of ' +
  'declarative config patches. Never invent recipients. Return JSON: {"reply": string, ' +
  '"patches": [{"op": one of ' + [...VALID_OPS].join('|') + ', "recipientId"?: string, ' +
  '"value": any}]}. Recipient-targeted ops (set_accepts, set_rejects, add_infrastructure, ' +
  'remove_infrastructure, set_note, set_volume) require a recipientId from the provided list.';

/**
 * Agent 4 — manager chat (§6). The LLM/mock PROPOSES ConfigPatch[]; this code
 * VALIDATES each patch against the type system and known recipient ids, then
 * APPLIES the valid ones via the store. Unknown ops / bad ids are rejected
 * politely. Declarative only — the LLM never mutates state directly.
 */
export async function managerChat(
  message: string,
  store: MemoryStore,
  llm: LlmClient = createLlm(),
): Promise<ManagerReply> {
  const recipients = await store.listRecipients();
  const config = await store.getConfig();

  const proposal = await propose(message, recipients, config.weights, llm);

  const applied: ConfigPatch[] = [];
  const rejected: string[] = [];

  for (const patch of proposal.patches) {
    const result = await validateAndApply(patch, store, recipients);
    if (result.ok) applied.push(patch);
    else rejected.push(result.reason);
  }

  let reply = proposal.reply;
  if (rejected.length) {
    const note = `I couldn't apply ${rejected.length} change${rejected.length > 1 ? 's' : ''}: ${rejected.join('; ')}.`;
    reply = applied.length ? `${reply} (${note})` : note;
  }

  return { reply, patches: applied, applied: applied.length > 0 };
}

async function propose(
  message: string,
  recipients: Recipient[],
  weights: Weights,
  llm: LlmClient,
): Promise<{ reply: string; patches: ConfigPatch[] }> {
  const payload = {
    message,
    recipients: recipients.map((r) => ({
      id: r.id,
      name: r.name,
      accepts: r.accepts,
      rejects: r.rejects,
      infrastructure: r.infrastructure,
    })),
    currentWeights: weights,
  };
  try {
    const prompt = buildTaskPrompt('manager', INSTRUCTIONS, payload);
    const out = await llm.complete({ prompt, json: true });
    const parsed = extractJson<{ reply?: unknown; patches?: unknown }>(out);
    const patches = Array.isArray(parsed.patches) ? (parsed.patches as ConfigPatch[]) : [];
    const reply = typeof parsed.reply === 'string' ? parsed.reply : 'Okay.';
    return { reply, patches };
  } catch {
    // Degrade to the deterministic pattern matcher directly.
    return heuristicManager(
      message,
      recipients.map((r) => ({ id: r.id, name: r.name, accepts: r.accepts, rejects: r.rejects, infrastructure: r.infrastructure })),
    );
  }
}

type ApplyResult = { ok: true } | { ok: false; reason: string };

async function validateAndApply(
  patch: ConfigPatch,
  store: MemoryStore,
  recipients: Recipient[],
): Promise<ApplyResult> {
  if (!patch || !VALID_OPS.has(patch.op)) {
    return { ok: false, reason: `unknown operation "${patch?.op ?? ''}"` };
  }

  // Global (non-recipient) ops.
  if (patch.op === 'set_weights') {
    const w = coerceWeights(patch.value);
    if (!w) return { ok: false, reason: 'invalid weights value' };
    const current = await store.getConfig();
    await store.setConfig({ weights: { ...current.weights, ...w } });
    return { ok: true };
  }
  if (patch.op === 'set_autopilot') {
    if (typeof patch.value !== 'boolean') return { ok: false, reason: 'autopilot must be true/false' };
    await store.setConfig({ autopilot: patch.value });
    return { ok: true };
  }

  // Recipient-targeted ops from here on.
  const id = patch.recipientId;
  if (!id) return { ok: false, reason: `"${patch.op}" needs a recipientId` };
  // Fetch fresh so multiple patches to the same recipient compound correctly.
  const recipient = (await store.getRecipient(id)) ?? recipients.find((r) => r.id === id) ?? null;
  if (!recipient) return { ok: false, reason: `unknown recipient "${id}"` };

  switch (patch.op) {
    case 'set_accepts': {
      const cats = coerceCategories(patch.value);
      if (!cats) return { ok: false, reason: 'invalid accepts categories' };
      await store.updateRecipient(id, { accepts: cats });
      return { ok: true };
    }
    case 'set_rejects': {
      const cats = coerceCategories(patch.value);
      if (!cats) return { ok: false, reason: 'invalid rejects categories' };
      await store.updateRecipient(id, { rejects: cats });
      return { ok: true };
    }
    case 'add_infrastructure': {
      const infra = coerceInfra(patch.value);
      if (!infra) return { ok: false, reason: 'invalid infrastructure value' };
      const next = Array.from(new Set([...recipient.infrastructure, infra]));
      await store.updateRecipient(id, { infrastructure: next });
      return { ok: true };
    }
    case 'remove_infrastructure': {
      const infra = coerceInfra(patch.value);
      if (!infra) return { ok: false, reason: 'invalid infrastructure value' };
      const next = recipient.infrastructure.filter((x) => x !== infra);
      await store.updateRecipient(id, { infrastructure: next });
      return { ok: true };
    }
    case 'set_note': {
      if (typeof patch.value !== 'string') return { ok: false, reason: 'note must be a string' };
      await store.updateRecipient(id, { notes: patch.value });
      return { ok: true };
    }
    case 'set_volume': {
      const n = typeof patch.value === 'number' ? patch.value : Number.parseFloat(String(patch.value));
      if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: 'volume must be a positive number' };
      await store.updateRecipient(id, { typicalWeeklyVolumeLbs: n });
      return { ok: true };
    }
    default:
      return { ok: false, reason: `unsupported operation "${patch.op}"` };
  }
}

function coerceCategories(value: unknown): ItemCategory[] | null {
  if (!Array.isArray(value)) return null;
  const out: ItemCategory[] = [];
  for (const v of value) {
    const s = String(v).toLowerCase().replace(/\s+/g, '_');
    if ((VALID_CATEGORIES as string[]).includes(s)) out.push(s as ItemCategory);
  }
  return out.length || value.length === 0 ? Array.from(new Set(out)) : null;
}

function coerceInfra(value: unknown): Infrastructure | null {
  const s = String(value).toLowerCase().replace(/[\s-]+/g, '_');
  return (VALID_INFRA as string[]).includes(s) ? (s as Infrastructure) : null;
}

function coerceWeights(value: unknown): Partial<Weights> | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const out: Partial<Weights> = {};
  let any = false;
  for (const k of WEIGHT_KEYS) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      out[k] = v;
      any = true;
    }
  }
  return any ? out : null;
}
