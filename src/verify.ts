import type { HarnessDb } from './db/HarnessDb.js';
import { listFiles, pathExists, readFileSafe, scanCode } from './codeScan.js';

/**
 * On-demand comparison of the real code against the harness.
 *
 * This is a SAFETY NET, not a sync mechanism: the harness is never redrawn from
 * code. A divergence is reported so a human can decide which side is wrong —
 * fix the code, or propose a harness change and approve it.
 */

export type DivergenceKind =
  | 'missing_path' // the harness declares a path the repo does not have
  | 'undeclared_area' // a top-level area of the repo the harness never mentions
  | 'design_rule_violation'
  | 'unverifiable_step'; // a step with no executable check

export interface Divergence {
  kind: DivergenceKind;
  severity: 'high' | 'medium' | 'low';
  ref: string;
  detail: string;
  suggestion: string;
}

export interface VerifyReport {
  checked_at: string;
  project_root: string;
  entries_checked: number;
  rules_checked: number;
  divergences: Divergence[];
  in_sync: boolean;
}

export function verifyHarness(db: HarnessDb, projectRoot: string): VerifyReport {
  const divergences: Divergence[] = [];

  const structure = db.listEntries('structure');
  const declaredPaths = new Set<string>();

  for (const node of structure) {
    const p = node.data.path as string | undefined;
    if (!p) continue;
    declaredPaths.add(normalize(p));
    if (!pathExists(projectRoot, p)) {
      divergences.push({
        kind: 'missing_path',
        severity: node.confidence === 'assumption' ? 'low' : 'high',
        ref: `structure/${node.key}`,
        detail: `The harness declares "${node.title}" at \`${p}\`, which does not exist in the repo.`,
        suggestion:
          'Either implement it from the harness, or — if the design moved on — propose a harness change and have it approved.',
      });
    }
  }

  // Top-level areas of the repo nobody in the harness accounts for.
  const inventory = scanCode(projectRoot, { maxEntries: 400 });
  const topDirs = new Set(
    inventory.tree.filter((t) => t.endsWith('/') && !t.slice(0, -1).includes('/')).map((t) => t.slice(0, -1)),
  );
  for (const dir of topDirs) {
    const accounted = [...declaredPaths].some((p) => p === dir || p.startsWith(`${dir}/`));
    if (!accounted) {
      divergences.push({
        kind: 'undeclared_area',
        severity: 'medium',
        ref: dir,
        detail: `\`${dir}/\` exists in the repo but no structure node points at it.`,
        suggestion: 'If it is real project structure, propose a structure node for it so the agent knows it exists.',
      });
    }
  }

  // Design rules that carry a machine check.
  const rules = db.listDesignRules();
  for (const rule of rules) {
    if (!rule.check) continue;
    let re: RegExp;
    try {
      re = new RegExp(rule.check.pattern, 'm');
    } catch {
      continue;
    }
    const files = listFiles(projectRoot, rule.check.glob);
    for (const rel of files) {
      const content = readFileSafe(projectRoot, rel);
      if (content === null) continue;
      const hit = re.test(content);
      const violated = rule.check.forbidden ? hit : !hit;
      if (violated) {
        divergences.push({
          kind: 'design_rule_violation',
          severity: 'medium',
          ref: rel,
          detail: `Design rule #${rule.id} — "${rule.rule}" — is not satisfied in \`${rel}\`.`,
          suggestion: 'Design rules are global. Bring the code in line, or retire the rule through an approved change.',
        });
      }
    }
  }

  // Steps that declare no way to be verified.
  for (const step of db.listEntries('step')) {
    if (!step.data.verify) {
      divergences.push({
        kind: 'unverifiable_step',
        severity: 'low',
        ref: `step/${step.key}`,
        detail: `Step "${step.title}" has no \`verify:\` command.`,
        suggestion: 'Every step should end in an executable check, otherwise "done" is an opinion.',
      });
    }
  }

  return {
    checked_at: new Date().toISOString(),
    project_root: projectRoot,
    entries_checked: structure.length,
    rules_checked: rules.length,
    divergences: divergences.sort((a, b) => weight(b.severity) - weight(a.severity)),
    in_sync: divergences.length === 0,
  };
}

const weight = (s: Divergence['severity']) => (s === 'high' ? 3 : s === 'medium' ? 2 : 1);
const normalize = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
