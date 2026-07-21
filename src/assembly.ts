import type { HarnessDb } from './db/HarnessDb.js';
import type { Confidence, EntryData, LayoutNode } from './types.js';

/**
 * The shape a model must return when assembling a harness — forward (from a
 * description) or reverse (from code). The same schema serves both branches of
 * the model bridge, which is what keeps native and universal modes identical.
 */
export const HARNESS_DRAFT_SCHEMA = {
  type: 'object',
  required: ['constitution', 'structure', 'requirements', 'steps'],
  properties: {
    constitution: {
      type: 'array',
      description: 'Stack, invariants, verification commands. Few, sharp, inviolable.',
      items: {
        type: 'object',
        required: ['key', 'title', 'body'],
        properties: {
          key: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
          confidence: { enum: ['certain', 'assumption'] },
          question: { type: 'string' },
        },
      },
    },
    structure: {
      type: 'array',
      description: 'Modules, entities, screens and flows. `parent` refers to another node key.',
      items: {
        type: 'object',
        required: ['key', 'title', 'kind'],
        properties: {
          key: { type: 'string' },
          title: { type: 'string' },
          kind: { enum: ['module', 'entity', 'screen', 'flow', 'component'] },
          parent: { type: ['string', 'null'] },
          path: { type: ['string', 'null'], description: 'Repo path this node lives at, if any.' },
          description: { type: 'string' },
          layout: { $ref: '#/$defs/layout' },
          confidence: { enum: ['certain', 'assumption'] },
          question: { type: 'string', description: 'Required when confidence is "assumption".' },
        },
      },
    },
    design: {
      type: 'array',
      description: 'Screen layouts and UI patterns.',
      items: {
        type: 'object',
        required: ['key', 'title'],
        properties: {
          key: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
          layout: { $ref: '#/$defs/layout' },
        },
      },
    },
    design_rules: {
      type: 'array',
      description: 'Rules that apply to the WHOLE project, e.g. "all buttons have an 8px radius".',
      items: {
        type: 'object',
        required: ['rule'],
        properties: { rule: { type: 'string' }, scope: { type: 'string' } },
      },
    },
    requirements: {
      type: 'array',
      description: 'EARS notation ("When <trigger>, the system shall <response>"), each with its why.',
      items: {
        type: 'object',
        required: ['key', 'title', 'ears'],
        properties: {
          key: { type: 'string', description: 'e.g. REQ-001' },
          title: { type: 'string' },
          ears: { type: 'string' },
          why: { type: 'string' },
          confidence: { enum: ['certain', 'assumption'] },
          question: { type: 'string' },
        },
      },
    },
    steps: {
      type: 'array',
      description: 'Phased tasks. Every step ends in an executable verify command.',
      items: {
        type: 'object',
        required: ['key', 'title', 'phase', 'verify'],
        properties: {
          key: { type: 'string' },
          title: { type: 'string' },
          phase: { type: 'integer', minimum: 1 },
          body: { type: 'string' },
          verify: { type: 'string' },
        },
      },
    },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key', 'title', 'body'],
        properties: { key: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } },
      },
    },
  },
  $defs: {
    layout: {
      type: 'object',
      description: 'Coarse layout skeleton — intent, not pixels.',
      required: ['el'],
      properties: {
        el: { type: 'string', description: 'header | sidebar | main | list | form | button | card | ...' },
        label: { type: 'string' },
        children: { type: 'array', items: { $ref: '#/$defs/layout' } },
      },
    },
  },
} as const;

export interface HarnessDraft {
  constitution?: Array<{ key: string; title: string; body: string; confidence?: Confidence; question?: string }>;
  structure?: Array<{
    key: string;
    title: string;
    kind?: EntryData['kind'];
    parent?: string | null;
    path?: string | null;
    description?: string;
    layout?: LayoutNode;
    confidence?: Confidence;
    question?: string;
  }>;
  design?: Array<{ key: string; title: string; body?: string; layout?: LayoutNode }>;
  design_rules?: Array<{ rule: string; scope?: string }>;
  requirements?: Array<{ key: string; title: string; ears: string; why?: string; confidence?: Confidence; question?: string }>;
  steps?: Array<{ key: string; title: string; phase: number; body?: string; verify?: string }>;
  decisions?: Array<{ key: string; title: string; body: string }>;
}

export interface ApplyDraftResult {
  entries: number;
  rules: number;
  assumptions: number;
}

/**
 * Write a draft into the harness. Used only for the ONE-TIME initial assembly —
 * afterwards every change goes through `pending_changes` and human approval.
 */
export function applyDraft(db: HarnessDb, draft: HarnessDraft): ApplyDraftResult {
  let entries = 0;
  let assumptions = 0;
  const count = (confidence?: Confidence) => {
    entries++;
    if (confidence === 'assumption') assumptions++;
  };

  draft.constitution?.forEach((c, i) => {
    db.upsertEntry({
      type: 'constitution',
      key: c.key,
      title: c.title,
      body: c.body,
      confidence: c.confidence ?? 'certain',
      question: c.question ?? null,
      position: i,
    });
    count(c.confidence);
  });

  draft.structure?.forEach((s, i) => {
    db.upsertEntry({
      type: 'structure',
      key: s.key,
      title: s.title,
      body: s.description ?? '',
      data: { kind: s.kind ?? 'module', parent: s.parent ?? null, path: s.path ?? null, layout: s.layout ?? null },
      confidence: s.confidence ?? 'certain',
      question: s.question ?? null,
      position: i,
    });
    count(s.confidence);
  });

  draft.design?.forEach((d, i) => {
    db.upsertEntry({
      type: 'design',
      key: d.key,
      title: d.title,
      body: d.body ?? '',
      data: { layout: d.layout ?? null },
      position: i,
    });
    count();
  });

  draft.requirements?.forEach((r, i) => {
    db.upsertEntry({
      type: 'requirement',
      key: r.key,
      title: r.title,
      body: r.ears,
      data: { why: r.why ?? null },
      confidence: r.confidence ?? 'certain',
      question: r.question ?? null,
      position: i,
    });
    count(r.confidence);
  });

  draft.steps?.forEach((s, i) => {
    db.upsertEntry({
      type: 'step',
      key: s.key,
      title: s.title,
      body: s.body ?? '',
      data: { verify: s.verify ?? null },
      phase: s.phase ?? 1,
      position: i,
    });
    count();
  });

  draft.decisions?.forEach((d, i) => {
    db.upsertEntry({ type: 'decision', key: d.key, title: d.title, body: d.body, position: i });
    count();
  });

  let rules = 0;
  for (const r of draft.design_rules ?? []) {
    db.addDesignRule(r.rule, r.scope ?? 'global');
    rules++;
  }

  return { entries, rules, assumptions };
}

/** Instructions for forward assembly (new project, from the user's description). */
export function initInstructions(description: string, projectName: string): string {
  return [
    `Assemble the initial harness for a NEW project called "${projectName}".`,
    '',
    'The harness is the durable specification a coding agent will implement from, and it is',
    'the source of truth: what is not in it does not exist. Be concrete and decidable —',
    'no "should probably", no placeholder sections.',
    '',
    'Rules:',
    '- CONSTITUTION: stack, hard invariants, and the exact commands that verify the project.',
    '- STRUCTURE: real modules/entities/screens/flows with the repo path each will live at.',
    '- REQUIREMENTS: EARS notation, each with the *why* from the description.',
    '- STEPS: phased, each ending in an executable `verify` command.',
    '- Mark anything the description does not settle as confidence "assumption" and attach',
    '  the question you would ask the human. Never invent certainty.',
    '',
    'Project description from the user:',
    description,
  ].join('\n');
}

/** Instructions for reverse assembly (existing project, from its code). */
export function reverseInstructions(projectName: string, hint: string | null): string {
  return [
    `Reverse-assemble the harness for the EXISTING project "${projectName}" from its code.`,
    '',
    'The code is the evidence. Documentation is only a hint: where docs and code disagree,',
    'THE CODE WINS and you note the disagreement as a decision entry.',
    '',
    'Rules:',
    '- Anything read directly off the code (a module that exists, a script in package.json)',
    '  is confidence "certain".',
    '- Anything inferred (intent, why a boundary is where it is, product requirements) is',
    '  confidence "assumption" and MUST carry a question for the human — code cannot contain intent.',
    '- STRUCTURE nodes must use real repo paths taken from the inventory.',
    '- STEPS should describe what remains, not what already exists.',
    hint ? `\nExtra context from the caller:\n${hint}` : '',
  ].join('\n');
}
