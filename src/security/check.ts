import { globToRegExp, listFiles, readFileSafe } from '../codeScan.js';
import type {
  CheckState,
  DelegatedCheck,
  GrepCheck,
  RuleVerdict,
  SecurityRule,
  StoredVerdict,
  Violation,
} from './types.js';

/**
 * Running the security rules the harness can run, and being honest about the rest.
 *
 * Only `grep` is proven here. `structural` and `runtime` need evidence the harness
 * cannot produce — a call graph, a live application — and it does not pretend
 * otherwise: those come back `unverified` with the reason, until somebody who has
 * that capability hands in a verdict.
 *
 * The temptation this file exists to resist is reporting an unproven rule as
 * passed because nothing failed. Nothing failing and nothing being checked look
 * identical from here, and only one of them is safe.
 */

const MAX_VIOLATIONS_PER_RULE = 20;

export function runGrepRule(rule: SecurityRule, projectRoot: string): RuleVerdict {
  const base: RuleVerdict = {
    rule_key: rule.key,
    title: rule.title,
    severity: rule.severity,
    check_kind: rule.check_kind,
    state: 'passed',
    violations: [],
    files_checked: 0,
  };

  const check = rule.check as GrepCheck;
  let pattern: RegExp;
  let near: RegExp | null = null;
  try {
    pattern = new RegExp(check.pattern);
    if (check.near) near = new RegExp(check.near);
  } catch (err) {
    // A rule that cannot compile has not passed — it has not run.
    return { ...base, state: 'unverified', reason: `The pattern does not compile: ${(err as Error).message}` };
  }

  const excused = (rule.exceptions ?? []).map((e) => globToRegExp(e.path));
  const files = listFiles(projectRoot, rule.applies_to).filter(
    (rel) => !excused.some((re) => re.test(rel)),
  );

  const violations: Violation[] = [];
  let checked = 0;

  for (const rel of files) {
    const content = readFileSafe(projectRoot, rel);
    if (content === null) continue;
    checked++;

    if (check.forbidden) {
      content.split('\n').forEach((text, i) => {
        if (!pattern.test(text)) return;
        // `near` is what keeps a rule alive: a template literal is only a SQL
        // injection if it is SQL. Without it the rule cries wolf and gets removed.
        if (near && !near.test(text)) return;
        if (violations.length < MAX_VIOLATIONS_PER_RULE) {
          violations.push({ file: rel, line: i + 1, excerpt: text.trim().slice(0, 160) });
        }
      });
    } else if (!pattern.test(content)) {
      // Absence is the violation: the file was supposed to contain this and does not.
      violations.push({ file: rel, line: 1, excerpt: '(required pattern not found in this file)' });
    }
  }

  // No files matched is not a pass either — the rule governs nothing here, and
  // saying "passed" would imply it looked at something.
  if (!checked) {
    return {
      ...base,
      state: 'unverified',
      reason: `No files matched ${rule.applies_to}, so nothing was examined.`,
      files_checked: 0,
    };
  }

  return {
    ...base,
    state: violations.length ? 'failed' : 'passed',
    violations,
    files_checked: checked,
  };
}

/**
 * A rule the harness cannot prove. If somebody handed in a verdict, use it — with
 * its provenance, and marked stale when the governed files moved on since.
 */
export function delegatedVerdict(
  rule: SecurityRule,
  projectRoot: string,
  stored: StoredVerdict | undefined,
): RuleVerdict {
  const check = rule.check as DelegatedCheck;
  const base: RuleVerdict = {
    rule_key: rule.key,
    title: rule.title,
    severity: rule.severity,
    check_kind: rule.check_kind,
    state: 'unverified',
    violations: [],
    files_checked: 0,
  };

  if (!stored) {
    return {
      ...base,
      reason:
        `Not checked here — this needs ${check.needs}. ` +
        `Question to settle: ${check.question} ` +
        `Whoever can answer it should submit the verdict with harness_submit_security_check.`,
    };
  }

  const now = fingerprint(projectRoot, rule);
  const stale = now !== stored.fingerprint;

  return {
    ...base,
    state: stored.state,
    violations: stored.violations,
    source: stored.source,
    checked_at: stored.created_at,
    stale,
    // A stale verdict is reported as what it is. Silently trusting it would let a
    // change slip past a rule that was proven against different code.
    reason: stale
      ? `The files under ${rule.applies_to} changed after this verdict — it no longer covers the current code.`
      : stored.detail || undefined,
  };
}

/**
 * Cheap fingerprint of the files a rule governs: enough to notice they moved,
 * not enough to say how. Costs a stat per file and no reads.
 */
export function fingerprint(projectRoot: string, rule: SecurityRule): string {
  const files = listFiles(projectRoot, rule.applies_to).sort();
  const parts = files.map((rel) => {
    const content = readFileSafe(projectRoot, rel);
    return `${rel}:${content ? content.length : 0}`;
  });
  return `${files.length}|${hash(parts.join('\n'))}`;
}

/** FNV-1a — no dependency, and collision risk here costs a false "fresh", not data. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export function worstState(verdicts: RuleVerdict[]): CheckState {
  if (verdicts.some((v) => v.state === 'failed')) return 'failed';
  if (verdicts.some((v) => v.state === 'unverified')) return 'unverified';
  return 'passed';
}
