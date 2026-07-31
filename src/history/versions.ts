import type { HarnessDb } from '../db/HarnessDb.js';
import type { LayoutNode } from '../types.js';

/**
 * The history of one harness entry, reconstructed rather than stored.
 *
 * Nothing new is written for this: every approved change already keeps its
 * `before` and `after`, and the approval record keeps who decided and when. A
 * second store of "design versions" would be a second truth, free to disagree
 * with the first — the exact failure this project exists to prevent, and it would
 * be embarrassing to introduce it here.
 *
 * Numbering starts at 0.1 and counts approvals, so a screen's layout reads as
 * 0.1 → 0.2 → 0.3. The numbers are a label for humans, not an identifier: they
 * are derived, and they shift if history is edited. The `change_id` is the thing
 * to quote.
 */

export interface EntryVersion {
  /** 0.1, 0.2 … — derived from position, not stored. */
  version: string;
  change_id: number;
  decided_at: string;
  actor: string;
  note: string | null;
  /** Why the change was proposed, from whoever proposed it. */
  rationale: string;
  /** The rendered diff, exactly as the human saw it when deciding. */
  diff: string;
  title: string;
  /** Present only for entries that carry one — screens and design entries. */
  layout: LayoutNode | null;
}

export interface EntryHistory {
  ref: string;
  /** Oldest first: a history reads forward. */
  versions: EntryVersion[];
  /** True when the entry exists now — a retired one still has a history. */
  current: boolean;
  note: string;
}

/**
 * `ref` is `type/key`, the same form the queue and the approval record use.
 * A rollback can leave the current state older than the newest version here, and
 * that is reported rather than hidden: the versions say what was approved, not
 * what survived.
 */
export function entryHistory(db: HarnessDb, ref: string): EntryHistory {
  const decisions = new Map(db.listApprovals(500).map((a) => [a.change_id, a]));

  const versions = db
    .listPending('all')
    .filter((c) => c.ref === ref && c.status === 'approved')
    .sort((a, b) => a.id - b.id)
    .map((change, i) => {
      const decision = decisions.get(change.id);
      const after = change.after as { title?: string; data?: { layout?: LayoutNode | null } } | null;
      return {
        version: `0.${i + 1}`,
        change_id: change.id,
        decided_at: decision?.created_at ?? change.decided_at ?? '',
        actor: decision?.actor ?? 'unknown',
        note: decision?.note ?? null,
        rationale: change.rationale,
        diff: change.diff,
        title: after?.title ?? '',
        layout: after?.data?.layout ?? null,
      };
    });

  const [type, ...rest] = ref.split('/');
  const current = Boolean(db.getEntry(type as never, rest.join('/')));

  return {
    ref,
    versions,
    current,
    note: versions.length
      ? `${versions.length} approved change(s). Version numbers are derived from order — quote change_id, not "0.2".`
      : // Assembled-and-never-changed is not the same as never existing, and the
        // difference matters to somebody asking why there is no history.
        `No approved changes for ${ref}. It arrived with the initial assembly and has not been altered since, ` +
        `or the reference is wrong.`,
  };
}

/** Which entries have a history worth looking at — for offering, not for filtering. */
export function refsWithHistory(db: HarnessDb): Array<{ ref: string; versions: number }> {
  const counts = new Map<string, number>();
  for (const c of db.listPending('all')) {
    if (c.status !== 'approved' || c.target !== 'entry') continue;
    counts.set(c.ref, (counts.get(c.ref) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([ref, versions]) => ({ ref, versions }))
    .sort((a, b) => b.versions - a.versions || a.ref.localeCompare(b.ref));
}
