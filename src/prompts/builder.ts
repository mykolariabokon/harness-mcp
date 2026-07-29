import { FRAGMENTS } from './generated.js';

/**
 * Assembles an instruction out of markdown fragments.
 *
 * What it builds is an INSTRUCTION, not a request to a particular API. The same
 * assembled text goes two ways: handed back to the editor's agent in native mode
 * (`status: "needs_agent"`), or sent to the harness's own model in universal mode.
 * So nothing here may assume a provider, a message format, or that the model is
 * "ours" — a test pins the two modes to identical output.
 *
 * The result format is not described in prose either: the JSON Schema travels with
 * the instruction and is the single source of truth about shape. Prose that
 * restated it would be a second source, free to drift.
 */

export type PromptKind = 'init' | 'reverse' | 'chat' | 'structure' | 'rework' | 'server';

/**
 * What the caller can offer. A section keyed on a capability is omitted entirely
 * when the capability is absent — see the `inv-no-advice-without-capability`
 * invariant: advising an agent to use something that is not there costs a turn and
 * teaches it to distrust the rest of the instruction.
 */
export interface PromptContext {
  project_name?: string;
  description?: string;
  message?: string;
  /** Caller-supplied context the code cannot contain. Absent → no such section. */
  hint?: string | null;
  /** 'analysis' when a semantic index was supplied instead of a shallow file walk. */
  inventory?: 'scan' | 'analysis';
  attempt?: number;
  max_attempts?: number;
  errors?: string[];
  warnings?: string[];
  original?: string;
}

interface Section {
  id: string;
  /** Rendered only when this returns true. Absent means always. */
  when?: (c: PromptContext) => boolean;
}

const always = (id: string): Section => ({ id });
const onlyIf = (id: string, when: (c: PromptContext) => boolean): Section => ({ id, when });

const has = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;

/**
 * The order of sections is the order of the instruction. Shared fragments appear
 * in several recipes on purpose — that is the deduplication: one file, one wording,
 * every tool that needs it.
 */
const RECIPES: Record<PromptKind, Section[]> = {
  init: [
    always('init/task'),
    always('shared/harness-principle'),
    always('shared/output-style'),
    always('init/rules'),
    always('shared/tree-rule'),
    always('shared/screen-layout'),
    always('init/spec-rules'),
    always('shared/assumption-marking'),
    onlyIf('init/description', (c) => has(c.description)),
  ],
  reverse: [
    always('reverse/task'),
    always('reverse/evidence'),
    always('shared/output-style'),
    always('reverse/rules'),
    onlyIf('reverse/analysis-source', (c) => c.inventory === 'analysis'),
    always('shared/tree-rule'),
    always('reverse/tree-hint-layout'),
    always('shared/screen-layout'),
    always('shared/assumption-marking'),
    always('reverse/steps-remaining'),
    onlyIf('reverse/hint', (c) => has(c.hint)),
  ],
  chat: [
    always('chat/task'),
    always('shared/harness-principle'),
    always('shared/authorities'),
    always('chat/rules'),
    always('chat/message'),
  ],
  structure: [
    always('structure/task'),
    always('shared/harness-principle'),
    always('shared/authorities'),
    always('shared/tree-rule'),
    always('chat/rules'),
    always('chat/message'),
  ],
  rework: [
    always('rework/task'),
    always('rework/errors'),
    onlyIf('rework/warnings', (c) => (c.warnings?.length ?? 0) > 0),
    always('rework/whole-again'),
  ],
  // Sent at connect, before anything is known about the project — so no
  // conditionals and no placeholders. It is here rather than inline in index.ts
  // because it reaches EVERY session this server is registered for: the highest
  // reach of any text in the project, and the one most worth reading as a diff.
  server: [always('server/instructions')],
};

/** Which fragments a recipe can ever use — for the coverage test, and for docs. */
export function sectionsFor(kind: PromptKind): string[] {
  return RECIPES[kind].map((s) => s.id);
}

export const PROMPT_KINDS = Object.keys(RECIPES) as PromptKind[];

/** Every fragment reachable from some recipe. A file nobody composes is dead text. */
export function composedFragments(): Set<string> {
  return new Set(PROMPT_KINDS.flatMap(sectionsFor));
}

export function build(kind: PromptKind, context: PromptContext): string {
  const values = flatten(context);
  const rendered = RECIPES[kind]
    .filter((s) => !s.when || s.when(context))
    .map((s) => {
      const text = FRAGMENTS[s.id];
      if (text === undefined) throw new Error(`Prompt fragment missing: ${s.id}`);
      return substitute(text, values, s.id);
    });

  return rendered.join('\n\n');
}

/** Bullet lists arrive as arrays; the fragment only ever sees finished text. */
function flatten(c: PromptContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c)) {
    if (v === null || v === undefined) continue;
    out[k] = Array.isArray(v) ? v.map((line) => `- ${line}`).join('\n') : String(v);
  }
  return out;
}

/**
 * Placeholders are explicit and total: an unresolved `{{name}}` throws rather than
 * reaching a model. A literal `{{project_name}}` in an instruction is not a cosmetic
 * flaw — it is a prompt that silently asks the model to invent what should have
 * been supplied.
 */
function substitute(text: string, values: Record<string, string>, id: string): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw new Error(`Prompt fragment ${id} needs {{${name}}}, which the caller did not supply.`);
    }
    return value;
  });
}
