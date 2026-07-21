import { JsonStore } from './store.js';
import { SCHEMA_VERSION, type HarnessDoc, type StoredGeneration } from './schema.js';
import type {
  Approval,
  ChangeOp,
  ChangeTarget,
  Checkpoint,
  Confidence,
  DesignRule,
  DesignRuleCheck,
  EntryData,
  EntryType,
  HarnessEntry,
  PendingChange,
  SessionSummary,
} from '../types.js';
import type { DesignTokens } from '../design/tokens.js';

const now = () => new Date().toISOString();

export interface EntryInput {
  type: EntryType;
  key: string;
  title: string;
  body?: string;
  data?: EntryData;
  confidence?: Confidence;
  question?: string | null;
  phase?: number | null;
  position?: number;
}

export interface GenerationRequest {
  id: number;
  purpose: string;
  instructions: string;
  schema: unknown;
  context: unknown;
  status: 'open' | 'closed';
  result: unknown | null;
}

/**
 * Thin, synchronous data layer over `/harness/harness.json`.
 *
 * Every read returns a copy, so no caller can reach into the stored state by
 * accident; every write goes through `store.mutate`, which is all-or-nothing.
 */
export class HarnessDb {
  readonly store: JsonStore;
  readonly schemaVersion: number;

  constructor(file: string) {
    this.store = new JsonStore(file);
    this.schemaVersion = this.store.schemaVersion;
  }

  close(): void {
    this.store.close();
  }

  // ---------------------------------------------------------------- entries

  listEntries(type?: EntryType, includeRetired = false): HarnessEntry[] {
    return this.store
      .read()
      .entries.filter((e) => (!type || e.type === type) && (includeRetired || e.status === 'active'))
      .sort(byTypePhasePosition)
      .map(copy);
  }

  getEntry(type: EntryType, key: string): HarnessEntry | null {
    const found = this.store.read().entries.find((e) => e.type === type && e.key === key);
    return found ? copy(found) : null;
  }

  upsertEntry(input: EntryInput): HarnessEntry {
    return this.store.mutate((doc) => {
      const ts = now();
      const existing = doc.entries.find((e) => e.type === input.type && e.key === input.key);

      if (existing) {
        existing.title = input.title;
        existing.body = input.body ?? existing.body;
        existing.data = input.data ?? existing.data;
        existing.confidence = input.confidence ?? existing.confidence;
        existing.question = input.question ?? null;
        existing.phase = input.phase ?? existing.phase;
        existing.position = input.position ?? existing.position;
        existing.status = 'active';
        existing.updated_at = ts;
        return copy(existing);
      }

      const created: HarnessEntry = {
        id: nextId(doc, 'entries'),
        type: input.type,
        key: input.key,
        title: input.title,
        body: input.body ?? '',
        data: input.data ?? {},
        status: 'active',
        confidence: input.confidence ?? 'certain',
        question: input.question ?? null,
        phase: input.phase ?? null,
        position: input.position ?? 0,
        created_at: ts,
        updated_at: ts,
      };
      doc.entries.push(created);
      return copy(created);
    });
  }

  retireEntry(type: EntryType, key: string): void {
    this.store.mutate((doc) => {
      const found = doc.entries.find((e) => e.type === type && e.key === key);
      if (!found) return;
      found.status = 'retired';
      found.updated_at = now();
    });
  }

  // ----------------------------------------------------------- design rules

  listDesignRules(includeRetired = false): DesignRule[] {
    return this.store
      .read()
      .design_rules.filter((r) => includeRetired || r.status === 'active')
      .sort((a, b) => a.id - b.id)
      .map(copy);
  }

  getDesignRule(id: number): DesignRule | null {
    const found = this.store.read().design_rules.find((r) => r.id === id);
    return found ? copy(found) : null;
  }

  addDesignRule(rule: string, scope = 'global', check: DesignRuleCheck | null = null, originChangeId: number | null = null): DesignRule {
    return this.store.mutate((doc) => {
      const created: DesignRule = {
        id: nextId(doc, 'design_rules'),
        rule,
        scope,
        check,
        status: 'active',
        origin_change_id: originChangeId,
        created_at: now(),
      };
      doc.design_rules.push(created);
      return copy(created);
    });
  }

  updateDesignRule(id: number, rule: string, scope: string, check: DesignRuleCheck | null): void {
    this.store.mutate((doc) => {
      const found = doc.design_rules.find((r) => r.id === id);
      if (!found) return;
      found.rule = rule;
      found.scope = scope;
      found.check = check;
    });
  }

  retireDesignRule(id: number): void {
    this.store.mutate((doc) => {
      const found = doc.design_rules.find((r) => r.id === id);
      if (found) found.status = 'retired';
    });
  }

  // -------------------------------------------------------- pending changes

  listPending(status: 'pending' | 'approved' | 'rejected' | 'all' = 'pending'): PendingChange[] {
    return this.store
      .read()
      .pending_changes.filter((c) => status === 'all' || c.status === status)
      .sort((a, b) => b.id - a.id)
      .map(copy);
  }

  pendingCount(): number {
    return this.store.read().pending_changes.filter((c) => c.status === 'pending').length;
  }

  getChange(id: number): PendingChange | null {
    const found = this.store.read().pending_changes.find((c) => c.id === id);
    return found ? copy(found) : null;
  }

  addChange(c: {
    target: ChangeTarget;
    op: ChangeOp;
    ref: string;
    before: unknown | null;
    after: unknown | null;
    diff: string;
    rationale: string;
    source: string;
  }): PendingChange {
    return this.store.mutate((doc) => {
      const created: PendingChange = {
        id: nextId(doc, 'pending_changes'),
        target: c.target,
        op: c.op,
        ref: c.ref,
        before: c.before ?? null,
        after: c.after ?? null,
        diff: c.diff,
        rationale: c.rationale,
        source: c.source,
        status: 'pending',
        created_at: now(),
        decided_at: null,
      };
      doc.pending_changes.push(created);
      return copy(created);
    });
  }

  decideChange(id: number, decision: 'approved' | 'rejected', actor: string, note: string | null): void {
    this.store.mutate((doc) => {
      const ts = now();
      const found = doc.pending_changes.find((c) => c.id === id);
      if (found) {
        found.status = decision;
        found.decided_at = ts;
      }
      doc.approvals.push({
        id: nextId(doc, 'approvals'),
        change_id: id,
        decision,
        actor,
        note,
        created_at: ts,
      });
    });
  }

  listApprovals(limit = 50): Approval[] {
    return this.store
      .read()
      .approvals.slice()
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map(copy);
  }

  // ------------------------------------------------------------ checkpoints

  createCheckpoint(label: string): Checkpoint {
    return this.store.mutate((doc) => {
      const created: Checkpoint = {
        id: nextId(doc, 'checkpoints'),
        label,
        snapshot: JSON.stringify(snapshotOf(doc)),
        created_at: now(),
      };
      doc.checkpoints.push(created);
      return copy(created);
    });
  }

  listCheckpoints(): Array<Omit<Checkpoint, 'snapshot'>> {
    return this.store
      .read()
      .checkpoints.slice()
      .sort((a, b) => b.id - a.id)
      .map(({ id, label, created_at }) => ({ id, label, created_at }));
  }

  /**
   * All of it or none of it: the whole restore happens inside one `mutate`, so a
   * failed write leaves the previous state standing in memory and on disk.
   */
  restoreCheckpoint(id: number): void {
    this.store.mutate((doc) => {
      const found = doc.checkpoints.find((c) => c.id === id);
      if (!found) throw new Error(`Checkpoint ${id} not found`);
      const snap = JSON.parse(found.snapshot) as Snapshot;
      doc.entries = snap.entries;
      doc.design_rules = snap.rules;
      doc.pending_changes = [];
    });
  }

  snapshot(): Snapshot {
    return snapshotOf(this.store.read());
  }

  // ---------------------------------------------------------- design tokens

  /** The latest token set wins; earlier ones stay as history. */
  setDesignTokens(tokens: DesignTokens): void {
    this.store.mutate((doc) => {
      doc.design_tokens.push({
        id: nextId(doc, 'design_tokens'),
        source: tokens.source,
        tokens: { ...tokens, raw: undefined },
        raw: tokens.raw ?? null,
        created_at: now(),
      });
    });
  }

  getDesignTokens(): DesignTokens | null {
    const all = this.store.read().design_tokens;
    if (!all.length) return null;
    const latest = all.reduce((a, b) => (b.id > a.id ? b : a));
    return copy({ ...latest.tokens, raw: latest.raw ?? undefined });
  }

  // --------------------------------------------------------------- sessions

  addSessionSummary(summary: SessionSummary): number {
    return this.store.mutate((doc) => {
      const id = nextId(doc, 'sessions');
      doc.sessions.push({ id, summary, created_at: now() });
      return id;
    });
  }

  listSessionSummaries(limit = 20): Array<{ id: number; summary: SessionSummary; created_at: string }> {
    return this.store
      .read()
      .sessions.slice()
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map(copy);
  }

  // --------------------------------------------------- generation requests

  openGeneration(purpose: string, instructions: string, schema: unknown, context: unknown): GenerationRequest {
    return this.store.mutate((doc) => {
      const created: StoredGeneration = {
        id: nextId(doc, 'generation_requests'),
        purpose,
        instructions,
        schema,
        context,
        status: 'open',
        result: null,
        created_at: now(),
        closed_at: null,
      };
      doc.generation_requests.push(created);
      return toRequest(created);
    });
  }

  getGeneration(id: number): GenerationRequest | null {
    const found = this.store.read().generation_requests.find((g) => g.id === id);
    return found ? toRequest(found) : null;
  }

  closeGeneration(id: number, result: unknown): void {
    this.store.mutate((doc) => {
      const found = doc.generation_requests.find((g) => g.id === id);
      if (!found) return;
      found.status = 'closed';
      found.result = result;
      found.closed_at = now();
    });
  }
}

export interface Snapshot {
  schema_version: number;
  entries: HarnessEntry[];
  rules: DesignRule[];
}

// ------------------------------------------------------------------ helpers

function snapshotOf(doc: HarnessDoc): Snapshot {
  return {
    schema_version: SCHEMA_VERSION,
    entries: doc.entries.slice().sort(byTypePhasePosition).map(copy),
    rules: doc.design_rules.slice().sort((a, b) => a.id - b.id).map(copy),
  };
}

/** Mirrors the old `ORDER BY type, phase IS NULL, phase, position, id`. */
function byTypePhasePosition(a: HarnessEntry, b: HarnessEntry): number {
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  const aNull = a.phase === null || a.phase === undefined;
  const bNull = b.phase === null || b.phase === undefined;
  if (aNull !== bNull) return aNull ? 1 : -1;
  if (!aNull && !bNull && a.phase !== b.phase) return (a.phase as number) - (b.phase as number);
  if (a.position !== b.position) return a.position - b.position;
  return a.id - b.id;
}

function nextId(doc: HarnessDoc, collection: string): number {
  const next = (doc.next_id[collection] ?? 0) + 1;
  doc.next_id[collection] = next;
  return next;
}

function toRequest(g: StoredGeneration): GenerationRequest {
  return copy({
    id: g.id,
    purpose: g.purpose,
    instructions: g.instructions,
    schema: g.schema,
    context: g.context,
    status: g.status,
    result: g.result,
  });
}

/** Hand out copies so callers cannot mutate stored state by holding a reference. */
const copy = <T>(value: T): T => structuredClone(value);
