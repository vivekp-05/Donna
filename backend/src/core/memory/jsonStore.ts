import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type {
  Donation, Recipient, HistoryEvent, AgentConfig,
} from '../types.js';
import type { MemoryStore } from './store.js';
import { makeSeedRecipients, makeSeedHistory } from '../../seed/recipients.js';
import { DEFAULT_AGENT_CONFIG } from '../../config.js';

interface DbDocument {
  recipients: Recipient[];
  donations: Donation[];
  history: HistoryEvent[];
  config: AgentConfig;
}

const HERE = dirname(fileURLToPath(import.meta.url));
// src/core/memory → backend/data/db.json  (dist/core/memory → backend/data/db.json)
const DEFAULT_DB_PATH = resolve(HERE, '../../../data/db.json');

const WRITE_DEBOUNCE_MS = 200;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function freshConfig(): AgentConfig {
  return clone(DEFAULT_AGENT_CONFIG);
}

/**
 * §5 default MemoryStore — an in-memory document mirrored to backend/data/db.json.
 * Reads are served from memory; every mutation schedules a debounced (~200ms)
 * write-through. Seeds from seed/recipients.ts when the file is empty/absent, and
 * reset() restores those seeds.
 *
 * `dbPath` is injectable so tests can point at a throwaway file.
 */
export class JsonStore implements MemoryStore {
  private readonly dbPath: string;

  private recipients = new Map<string, Recipient>();
  private donations = new Map<string, Donation>();
  private history: HistoryEvent[] = [];
  private config: AgentConfig = freshConfig();

  private initialized = false;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingWrite: Promise<void> | null = null;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    this.dbPath = dbPath;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    let doc: DbDocument | null = null;
    try {
      const raw = await fs.readFile(this.dbPath, 'utf8');
      const trimmed = raw.trim();
      if (trimmed.length > 0) doc = JSON.parse(trimmed) as DbDocument;
    } catch {
      doc = null; // missing/unreadable ⇒ seed fresh
    }

    if (!doc || !Array.isArray(doc.recipients) || doc.recipients.length === 0) {
      await this.seed();
    } else {
      this.loadDoc(doc);
    }
    this.initialized = true;
  }

  private loadDoc(doc: DbDocument): void {
    this.recipients = new Map((doc.recipients ?? []).map((r) => [r.id, r]));
    this.donations = new Map((doc.donations ?? []).map((d) => [d.id, d]));
    this.history = Array.isArray(doc.history) ? doc.history : [];
    this.config = doc.config ?? freshConfig();
  }

  /** Load seeds into memory and persist immediately (used by init + reset). */
  private async seed(): Promise<void> {
    this.recipients = new Map(makeSeedRecipients().map((r) => [r.id, r]));
    this.donations = new Map();
    this.history = makeSeedHistory();
    this.config = freshConfig();
    await this.flushNow();
  }

  // ---- donations -----------------------------------------------------------

  async saveDonation(d: Donation): Promise<void> {
    this.donations.set(d.id, clone(d));
    this.scheduleWrite();
  }

  async getDonation(id: string): Promise<Donation | null> {
    const d = this.donations.get(id);
    return d ? clone(d) : null;
  }

  async listDonations(): Promise<Donation[]> {
    return Array.from(this.donations.values()).map(clone);
  }

  // ---- recipients ----------------------------------------------------------

  async listRecipients(): Promise<Recipient[]> {
    return Array.from(this.recipients.values()).map(clone);
  }

  async getRecipient(id: string): Promise<Recipient | null> {
    const r = this.recipients.get(id);
    return r ? clone(r) : null;
  }

  async updateRecipient(id: string, patch: Partial<Recipient>): Promise<Recipient> {
    const existing = this.recipients.get(id);
    if (!existing) throw new Error(`Recipient not found: ${id}`);
    // Never let a patch change the primary key.
    const updated: Recipient = { ...existing, ...patch, id: existing.id };
    this.recipients.set(id, updated);
    this.scheduleWrite();
    return clone(updated);
  }

  // ---- history & ledger ----------------------------------------------------

  async addHistory(e: HistoryEvent): Promise<void> {
    this.history.push(clone(e));
    this.scheduleWrite();
  }

  async listHistory(recipientId?: string): Promise<HistoryEvent[]> {
    const all = recipientId
      ? this.history.filter((e) => e.recipientId === recipientId)
      : this.history;
    return all.map(clone);
  }

  async creditReceived(recipientId: string, lbs: number): Promise<void> {
    const existing = this.recipients.get(recipientId);
    if (!existing) throw new Error(`Recipient not found: ${recipientId}`);
    existing.receivedRecentLbs = (existing.receivedRecentLbs ?? 0) + lbs;
    this.scheduleWrite();
  }

  // ---- config --------------------------------------------------------------

  async getConfig(): Promise<AgentConfig> {
    return clone(this.config);
  }

  async setConfig(patch: Partial<AgentConfig>): Promise<AgentConfig> {
    this.config = {
      ...this.config,
      ...patch,
      // weights merge shallowly so callers can patch a single term.
      weights: { ...this.config.weights, ...(patch.weights ?? {}) },
    };
    this.scheduleWrite();
    return clone(this.config);
  }

  // ---- reset ---------------------------------------------------------------

  async reset(): Promise<void> {
    await this.seed();
  }

  // ---- persistence ---------------------------------------------------------

  private snapshot(): DbDocument {
    return {
      recipients: Array.from(this.recipients.values()),
      donations: Array.from(this.donations.values()),
      history: this.history,
      config: this.config,
    };
  }

  /** Debounced trailing write-through (~200ms). */
  private scheduleWrite(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flushNow();
    }, WRITE_DEBOUNCE_MS);
    // Do not keep the event loop alive purely for a pending flush.
    if (typeof this.writeTimer === 'object' && this.writeTimer && 'unref' in this.writeTimer) {
      (this.writeTimer as { unref: () => void }).unref();
    }
  }

  /**
   * Flush the current snapshot to disk now, cancelling any pending debounce.
   * Not part of the MemoryStore interface — exposed for deterministic tests and
   * graceful shutdown.
   */
  async flushNow(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    const data = JSON.stringify(this.snapshot(), null, 2);
    const dir = dirname(this.dbPath);
    // Serialize concurrent flushes so writes never interleave.
    this.pendingWrite = (this.pendingWrite ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(this.dbPath, data, 'utf8');
      });
    await this.pendingWrite;
  }
}
