import type { CallRecord, CallPhase, LiveCallRow } from '../../src/core/types.js';
import type { MemoryStore } from '../../src/core/memory/store.js';

type Speaker = 'agent' | 'recipient';
interface LiveLine { speaker: Speaker; text: string }

/**
 * The call-tracking + live-transcript half of MemoryStore, factored out so every
 * test fake implements it identically.
 *
 * These moved into the store when vapi.ts's in-memory `pending` map was deleted:
 * a placed call is now a persisted row, and `handledAt` (set by claimCall) is the
 * idempotency guard against VAPI's duplicate end-of-call-reports. The semantics
 * here mirror JsonStore exactly — in particular claimCall returns false for an
 * already-handled call, which is what stops a duplicate webhook double-dialling.
 */
export type CallStoreParts = Pick<
  MemoryStore,
  | 'saveCall' | 'getCall' | 'claimCall' | 'listUnhandledCallsBefore'
  | 'appendLiveLine' | 'getLiveLines' | 'listLiveCalls' | 'clearLiveLines'
  | 'setCallPhase'
> & {
  /** The raw rows, exposed so tests can inspect or backdate `placedAt`. */
  calls: Map<string, CallRecord>;
};

export function makeCallStoreParts(): CallStoreParts {
  const calls = new Map<string, CallRecord>();
  const live = new Map<string, LiveLine[]>();
  const phases = new Map<string, CallPhase>();
  return {
    calls,
    async saveCall(call) { calls.set(call.callId, { ...call }); },
    async getCall(callId) {
      const c = calls.get(callId);
      return c ? { ...c } : null;
    },
    async claimCall(callId, at) {
      const existing = calls.get(callId);
      if (!existing || existing.handledAt) return false;
      existing.handledAt = at;
      return true;
    },
    async listUnhandledCallsBefore(before) {
      return [...calls.values()]
        .filter((c) => !c.handledAt && c.placedAt < before)
        .sort((a, b) => (a.placedAt < b.placedAt ? -1 : a.placedAt > b.placedAt ? 1 : 0))
        .map((c) => ({ ...c }));
    },
    async appendLiveLine(callId, speaker, text) {
      const lines = live.get(callId) ?? [];
      lines.push({ speaker, text });
      live.set(callId, lines);
    },
    async getLiveLines(callId) { return (live.get(callId) ?? []).map((l) => ({ ...l })); },
    // Mirrors JsonStore/D1Store: a call is live if it has captions OR a phase.
    async listLiveCalls() {
      const ids = new Set([...live.keys(), ...phases.keys()]);
      return [...ids].map((callId) => {
        const row: LiveCallRow = { callId, lines: (live.get(callId) ?? []).map((l) => ({ ...l })) };
        const phase = phases.get(callId);
        if (phase) row.phase = phase;
        return row;
      });
    },
    async setCallPhase(callId, phase) { phases.set(callId, phase); },
    async clearLiveLines(callId) { live.delete(callId); phases.delete(callId); },
  };
}
