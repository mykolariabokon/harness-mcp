import type { HarnessDraft } from '../assembly.js';

/**
 * Quality gate for a generated harness draft.
 *
 * Without it a flat list of twenty-five sibling nodes is indistinguishable from a
 * correct tree: it applies cleanly, renders without error, and only a human
 * squinting at the panel notices the specification is useless. Silence is the bug.
 *
 * Two deliberate limits:
 *  - It never *fixes* a draft. Inferring `parent` from path similarity would build
 *    a plausible tree that a human then approves without knowing a machine guessed
 *    it. Asking for the work again is honest; guessing is not.
 *  - It gives up. After MAX_ATTEMPTS the draft is accepted with its problems
 *    recorded, because an endless rework loop is worse than an imperfect harness.
 */

/** Total assembly attempts before the draft is accepted as-is, warts recorded. */
export const MAX_ATTEMPTS = 2;

/** Below this a flat structure is legitimate — a tiny project really is flat. */
const FLAT_TOLERANCE = 6;

export interface QualityReport {
  /** Problems that send the draft back for rework. */
  errors: string[];
  /** Problems worth telling the human about, but not worth another round trip. */
  warnings: string[];
  ok: boolean;
}

export function checkDraft(draft: HarnessDraft): QualityReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  const structure = draft.structure ?? [];
  const keys = new Set(structure.map((n) => n.key));
  const withParent = structure.filter((n) => n.parent);

  if (structure.length > FLAT_TOLERANCE && withParent.length === 0) {
    errors.push(
      `The structure is a flat list: ${structure.length} nodes and not one has a parent. ` +
        `STRUCTURE must be a tree — group entities under the module they live in, screens under ` +
        `their application, components under their screen. Roots are the applications and packages ` +
        `of the repository, and there should only be a few. Rebuild it and resubmit.`,
    );
  }

  const orphans = structure.filter((n) => n.parent && !keys.has(n.parent));
  if (orphans.length) {
    errors.push(
      `${orphans.length} node(s) name a parent that does not exist: ` +
        `${orphans.map((n) => `"${n.key}" → "${n.parent}"`).join(', ')}. ` +
        `A parent must be the key of another node in the same structure array.`,
    );
  }

  const cyclic = findCycle(structure);
  if (cyclic) {
    errors.push(`The structure contains a parent cycle: ${cyclic.join(' → ')}. A tree has no loops.`);
  }

  // Documented since the first version, never actually enforced: an assumption
  // without a question is a guess the human has no way to correct.
  const mute = [...structure, ...(draft.requirements ?? []), ...(draft.constitution ?? [])].filter(
    (n) => n.confidence === 'assumption' && !n.question?.trim(),
  );
  if (mute.length) {
    errors.push(
      `${mute.length} entr(y/ies) marked confidence "assumption" carry no question: ` +
        `${mute.map((n) => `"${n.key}"`).join(', ')}. ` +
        `An assumption exists to be answered — attach the question you would ask the human.`,
    );
  }

  const screensWithoutLayout = structure.filter((n) => n.kind === 'screen' && !n.layout);
  if (screensWithoutLayout.length) {
    warnings.push(
      `${screensWithoutLayout.length} screen(s) have no layout skeleton ` +
        `(${screensWithoutLayout.map((n) => `"${n.key}"`).join(', ')}) — their mockup will render empty.`,
    );
  }

  const pathless = structure.filter((n) => (n.kind === 'module' || n.kind === 'component') && !n.path);
  if (pathless.length) {
    warnings.push(
      `${pathless.length} module/component node(s) declare no repo path — harness_verify cannot check them.`,
    );
  }

  if (!(draft.steps ?? []).length) warnings.push('No steps: the harness says what exists, but not what to do next.');

  return { errors, warnings, ok: errors.length === 0 };
}

/** Depth-first walk over the parent links; returns the first loop found. */
function findCycle(nodes: NonNullable<HarnessDraft['structure']>): string[] | null {
  const parents = new Map(nodes.map((n) => [n.key, n.parent ?? null]));
  for (const start of parents.keys()) {
    const path: string[] = [];
    const seen = new Set<string>();
    let current: string | null = start;
    while (current) {
      if (seen.has(current)) return [...path.slice(path.indexOf(current)), current];
      seen.add(current);
      path.push(current);
      current = parents.get(current) ?? null;
    }
  }
  return null;
}

/** What to tell the agent so the second attempt is better than the first. */
export function reworkInstructions(original: string, report: QualityReport, attempt: number): string {
  return [
    `The previous draft was rejected. This is attempt ${attempt} of ${MAX_ATTEMPTS} — after that it is`,
    'accepted as it stands, with the problems recorded against it, so fix them now.',
    '',
    'What was wrong:',
    ...report.errors.map((e) => `- ${e}`),
    ...(report.warnings.length ? ['', 'Also worth fixing:', ...report.warnings.map((w) => `- ${w}`)] : []),
    '',
    'Return the WHOLE harness again, corrected — not a patch, not only the part that was wrong.',
    '',
    '--- original task ---',
    original,
  ].join('\n');
}
