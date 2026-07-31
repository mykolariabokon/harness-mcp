/**
 * Security rules — a layer beside `design_rules`, kept separate on purpose.
 *
 * A design rule and a security rule look alike and are not alike: the cost of
 * getting one wrong differs by orders of magnitude, and a security rule must not
 * be quietly switched off the way a button-radius rule can be. What they DO share
 * is the checking machinery, so there is one glob+regex implementation and not two.
 *
 * The organising idea is that a rule is classified by HOW IT IS PROVEN, not by
 * what it is about. A rule with no way to check it is a wish wearing a rule's
 * clothes, and this layer does not accept one.
 */

export type Severity = 'critical' | 'high' | 'medium';

/**
 * What kind of evidence the rule needs — deliberately a capability, never a tool
 * (`inv-capability-not-tool`). One person has a semantic indexer, another has
 * browser automation, a third has a shell script; the rule is the same for all
 * three, only the producer of the verdict differs.
 */
export type CheckKind =
  /** A pattern in the source. The harness proves this itself, always. */
  | 'grep'
  /** Needs a call/import graph: who reaches what. Proven by whoever has one. */
  | 'structural'
  /** Needs a running application to act against. Proven by whoever can drive it. */
  | 'runtime';

/** A pattern check the harness runs on its own — same shape as a design rule's. */
export interface GrepCheck {
  /** Regex source. */
  pattern: string;
  /** true → a match is a violation; false → the absence of a match is. */
  forbidden: boolean;
  /**
   * Optional second pattern that must ALSO be present on the line for a match to
   * count. Cuts the false positives that kill a rule: a template literal is only
   * a SQL injection if it is SQL.
   */
  near?: string;
}

/** What an outside checker is being asked to establish. Prose, not a tool call. */
export interface DelegatedCheck {
  /** What has to be true, in words a human or an agent can act on. */
  question: string;
  /** What evidence settles it — again a capability, not a product name. */
  needs: string;
}

export interface SecurityRule {
  id: number;
  key: string;
  title: string;
  /** What breaks if this is violated. Short, concrete, no lecturing. */
  rationale: string;
  severity: Severity;
  check_kind: CheckKind;
  check: GrepCheck | DelegatedCheck;
  /** Glob of paths the rule governs. Outside it, the rule is silent. */
  applies_to: string;
  /**
   * Paths excused from the rule, each with a reason. An exception is a change to
   * the harness like any other and passes the same approval — otherwise it is a
   * hole that inconvenient files get quietly dropped into.
   */
  exceptions: Array<{ path: string; why: string }>;
  status: 'active' | 'retired';
  created_at: string;
}

export type CheckState = 'passed' | 'failed' | 'unverified';

export interface Violation {
  file: string;
  line: number;
  /** The offending line, trimmed — enough to see the problem without opening it. */
  excerpt: string;
}

/**
 * A verdict on one rule.
 *
 * `unverified` is never folded into `passed`. A report where the unproven looks
 * proven is worse than no report: it manufactures confidence that nothing earned.
 */
export interface RuleVerdict {
  rule_key: string;
  title: string;
  severity: Severity;
  check_kind: CheckKind;
  state: CheckState;
  /** Why it is unverified, in the state's own words. Never left to be guessed. */
  reason?: string;
  violations: Violation[];
  files_checked: number;
  /** Who produced this and when — a verdict without provenance is a rumour. */
  source?: string;
  checked_at?: string;
  /** Set when the files the rule governs changed after the verdict was recorded. */
  stale?: boolean;
}

/**
 * A verdict handed in from outside, for the checks the harness cannot run itself.
 * Stored with its origin and a fingerprint of the code it judged, so it can be
 * told later that it has gone stale rather than trusted forever.
 */
export interface StoredVerdict {
  id: number;
  rule_key: string;
  state: CheckState;
  source: string;
  detail: string;
  violations: Violation[];
  /** Cheap fingerprint of the governed files at the time of the verdict. */
  fingerprint: string;
  created_at: string;
}
