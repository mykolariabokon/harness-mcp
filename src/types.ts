/**
 * Domain types for the harness.
 *
 * The harness is the SOURCE OF TRUTH for a project: it is assembled once
 * (from a description for a new project, or reverse-engineered from code for an
 * existing one) and from then on it is *edited* — every edit passing through a
 * human approval. Code is implemented FROM the harness, never the other way round.
 */

/** Kinds of harness entries. Text spec files are projections of these. */
export type EntryType =
  | 'constitution' // stack, invariants, verification commands   → CONSTITUTION.md
  | 'structure' // modules / entities / screens / flows           → STRUCTURE.md
  | 'design' // UI patterns and screen layouts                    → DESIGN.md
  | 'requirement' // EARS-style requirements                      → SPEC.md
  | 'step' // phased implementation tasks                         → tasks/phase-N.md
  | 'decision'; // architectural decisions (why)                  → CONSTITUTION.md

export const ENTRY_TYPES: EntryType[] = [
  'constitution',
  'structure',
  'design',
  'requirement',
  'step',
  'decision',
];

/** Confidence marker used by reverse assembly: code wins, guesses are flagged. */
export type Confidence = 'certain' | 'assumption';

export type EntryStatus = 'active' | 'retired';

export interface HarnessEntry {
  id: number;
  type: EntryType;
  /** Stable slug, unique per type. Used as the anchor for updates. */
  key: string;
  title: string;
  /** Markdown body. */
  body: string;
  /** Type-specific payload (structure node shape, step verify line, ...). */
  data: EntryData;
  status: EntryStatus;
  confidence: Confidence;
  /** Question to the human when confidence = 'assumption'. */
  question: string | null;
  phase: number | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface EntryData {
  /** structure nodes: what this node is. */
  kind?: 'module' | 'entity' | 'screen' | 'flow' | 'component';
  /** structure nodes: key of the parent entry (null = root). */
  parent?: string | null;
  /** structure nodes: path in the repo this node is expected to live at. */
  path?: string | null;
  /** screens: coarse layout tree used by the mockup renderer. */
  layout?: LayoutNode | null;
  /** steps: executable verification command. */
  verify?: string | null;
  /** anything else a generator wants to carry along. */
  [k: string]: unknown;
}

/** A skeleton mockup node — deliberately coarse: the mockup shows intent, not pixels. */
export interface LayoutNode {
  el: string; // 'header' | 'sidebar' | 'button' | 'list' | ...
  label?: string;
  children?: LayoutNode[];
}

/** A design rule applies GLOBALLY to the whole project once approved. */
export interface DesignRule {
  id: number;
  rule: string;
  /** 'global' or a component/screen key it is scoped to. */
  scope: string;
  /** Optional machine check: files matching `glob` must match/not match `pattern`. */
  check: DesignRuleCheck | null;
  status: EntryStatus;
  origin_change_id: number | null;
  created_at: string;
}

export interface DesignRuleCheck {
  glob: string;
  /** Regex source. */
  pattern: string;
  /** true → every match is a violation; false → absence of a match is a violation. */
  forbidden: boolean;
}

export type ChangeTarget = 'entry' | 'design_rule';
export type ChangeOp = 'create' | 'update' | 'delete';
export type ChangeStatus = 'pending' | 'approved' | 'rejected';

/**
 * A change proposed by an agent. It is NOT applied — it waits for a human to
 * review the diff and accept or reject it. This is the only way the harness changes.
 */
export interface PendingChange {
  id: number;
  target: ChangeTarget;
  op: ChangeOp;
  /** entry key (target='entry') or design rule id (target='design_rule'). */
  ref: string;
  before: unknown | null;
  after: unknown | null;
  /** Rendered line diff, ready to show as struck-through / highlighted. */
  diff: string;
  rationale: string;
  source: string;
  status: ChangeStatus;
  created_at: string;
  decided_at: string | null;
}

export interface Approval {
  id: number;
  change_id: number;
  decision: 'approved' | 'rejected';
  actor: string;
  note: string | null;
  created_at: string;
}

export interface Checkpoint {
  id: number;
  label: string;
  /** Full harness state, restorable. */
  snapshot: string;
  created_at: string;
}

/** Structured session summary — the bridge between ephemeral chat and the durable spec. */
export interface SessionSummary {
  completed_tasks: string[];
  decisions: string[];
  open_questions: string[];
  touched_files: string[];
}

/** How the harness gets a model for its own chat/generation work. */
export type ModelMode = 'native' | 'universal';

export interface HarnessConfig {
  version: number;
  model: {
    /** 'auto' resolves to 'native' when the editor agent announced itself. */
    mode: ModelMode | 'auto';
    provider: 'openrouter' | 'anthropic' | null;
    model: string | null;
    api_key: string | null;
    base_url: string | null;
  };
  render: {
    /** 'auto' resolves to 'webview' when the host announced webview support. */
    output: 'auto' | 'webview' | 'browser';
    port: number;
  };
  /**
   * Optional direct connection to a design system MCP server, so the harness can
   * pull tokens itself where no host wires the two together.
   */
  design_mcp: {
    enabled: boolean;
    command: string | null;
    args: string[];
    env: Record<string, string>;
  };
  spec_files: {
    /** Regenerate the markdown projection after every approved change. */
    autowrite: boolean;
  };
}

export const CONFIG_VERSION = 1;

export function defaultConfig(): HarnessConfig {
  return {
    version: CONFIG_VERSION,
    model: { mode: 'auto', provider: null, model: null, api_key: null, base_url: null },
    render: { output: 'auto', port: 0 },
    design_mcp: { enabled: false, command: null, args: [], env: {} },
    spec_files: { autowrite: true },
  };
}
