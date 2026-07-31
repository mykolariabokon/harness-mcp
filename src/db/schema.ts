import type {
  Approval,
  Checkpoint,
  DesignRule,
  HarnessEntry,
  PendingChange,
  SessionSummary,
} from '../types.js';
import type { DesignTokens } from '../design/tokens.js';
import type { SecurityRule, StoredVerdict } from '../security/types.js';

/**
 * Schema versioning is in place from day one: a future release must be able to
 * open a `/harness` folder written by an older one. Never edit a shipped
 * migration — append a new one and bump SCHEMA_VERSION.
 */
export const SCHEMA_VERSION = 3;

export interface StoredGeneration {
  id: number;
  purpose: string;
  instructions: string;
  schema: unknown;
  context: unknown;
  status: 'open' | 'closed';
  result: unknown | null;
  created_at: string;
  closed_at: string | null;
}

export interface StoredSession {
  id: number;
  summary: SessionSummary;
  created_at: string;
}

export interface StoredTokens {
  id: number;
  source: string;
  tokens: DesignTokens;
  raw: unknown | null;
  created_at: string;
}

/** The whole harness state, as persisted in `harness/harness.json`. */
export interface HarnessDoc {
  schema_version: number;
  /** Next free id per collection — the document's stand-in for AUTOINCREMENT. */
  next_id: Record<string, number>;
  entries: HarnessEntry[];
  design_rules: DesignRule[];
  pending_changes: PendingChange[];
  approvals: Approval[];
  checkpoints: Checkpoint[];
  sessions: StoredSession[];
  generation_requests: StoredGeneration[];
  design_tokens: StoredTokens[];
  security_rules: SecurityRule[];
  /** Verdicts handed in for the checks the harness cannot run itself. */
  security_verdicts: StoredVerdict[];
}

interface Migration {
  to: number;
  up: (doc: Partial<HarnessDoc>) => void;
}

const MIGRATIONS: Migration[] = [
  {
    to: 1,
    up: (doc) => {
      doc.next_id = {};
      doc.entries = [];
      doc.design_rules = [];
      doc.pending_changes = [];
      doc.approvals = [];
      doc.checkpoints = [];
      doc.sessions = [];
      doc.generation_requests = [];
    },
  },
  {
    // v2 — design tokens from a design system (Design MCP or any other source), so
    // the mockup renders in the project's own visual language, not a grey skeleton.
    to: 2,
    up: (doc) => {
      doc.design_tokens = [];
    },
  },
  {
    // v3 — security rules and the verdicts handed in for the checks the harness
    // cannot run itself. Separate from design_rules: same machinery, different
    // stakes, and a security rule must not be switchable off as casually.
    to: 3,
    up: (doc) => {
      doc.security_rules = [];
      doc.security_verdicts = [];
    },
  },
];

export function migrate(input: Partial<HarnessDoc>): HarnessDoc {
  const from = Number(input.schema_version ?? 0);
  if (from > SCHEMA_VERSION) {
    throw new Error(
      `This /harness was written by a newer Harness MCP (schema v${from}, this build understands v${SCHEMA_VERSION}). ` +
        `Update the server — refusing to touch the file so a newer state is not damaged by an older build.`,
    );
  }

  const doc = input;
  for (const m of MIGRATIONS) {
    if (m.to <= from) continue;
    m.up(doc);
    doc.schema_version = m.to;
  }
  doc.schema_version = SCHEMA_VERSION;
  return normalize(doc);
}

/** A hand-edited or partially-written document must still open predictably. */
function normalize(doc: Partial<HarnessDoc>): HarnessDoc {
  return {
    schema_version: doc.schema_version ?? SCHEMA_VERSION,
    next_id: doc.next_id ?? {},
    entries: doc.entries ?? [],
    design_rules: doc.design_rules ?? [],
    pending_changes: doc.pending_changes ?? [],
    approvals: doc.approvals ?? [],
    checkpoints: doc.checkpoints ?? [],
    sessions: doc.sessions ?? [],
    generation_requests: doc.generation_requests ?? [],
    design_tokens: doc.design_tokens ?? [],
    security_rules: doc.security_rules ?? [],
    security_verdicts: doc.security_verdicts ?? [],
  };
}
