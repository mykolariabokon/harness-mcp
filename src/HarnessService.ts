import fs from 'node:fs';
import { HarnessDb } from './db/HarnessDb.js';
import { ensureHarnessDir, harnessPaths, type HarnessPaths } from './paths.js';
import { loadConfig, resolveModelMode, resolveRenderOutput, type HostCapabilities } from './config.js';
import { LlmBridge } from './model/LlmBridge.js';
import { objectToText, renderDiff } from './diff.js';
import type { CatalogueRule } from './security/catalogue.js';
import type { SecurityRule } from './security/types.js';
import { writeSpecFiles } from './spec/SpecFiles.js';
import type {
  ChangeOp,
  ChangeTarget,
  DesignRule,
  DesignRuleCheck,
  EntryType,
  HarnessConfig,
  HarnessEntry,
  PendingChange,
} from './types.js';
import type { EntryInput } from './db/HarnessDb.js';

/**
 * One open harness per project. Holds the database, the config and the two
 * resolved modes (which model source, which render output).
 */
export class HarnessService {
  readonly paths: HarnessPaths;
  readonly db: HarnessDb;
  config: HarnessConfig;

  private constructor(paths: HarnessPaths, db: HarnessDb, config: HarnessConfig) {
    this.paths = paths;
    this.db = db;
    this.config = config;
  }

  /** One open database per project for the lifetime of the process. */
  private static cache = new Map<string, HarnessService>();

  static open(projectRoot: string, create = false): HarnessService {
    const paths = create ? ensureHarnessDir(projectRoot) : harnessPaths(projectRoot);
    const cached = HarnessService.cache.get(paths.projectRoot);
    if (cached) return cached;

    if (!fs.existsSync(paths.state) && !create) {
      throw new Error(
        `No harness in ${paths.projectRoot}. Run harness_init (new project) or harness_reverse (existing code) first.`,
      );
    }
    const svc = new HarnessService(paths, new HarnessDb(paths.state), loadConfig(paths));
    HarnessService.cache.set(paths.projectRoot, svc);
    return svc;
  }

  static closeAll(): void {
    for (const svc of HarnessService.cache.values()) svc.db.close();
    HarnessService.cache.clear();
  }

  bridge(host: HostCapabilities): LlmBridge {
    return new LlmBridge(this.db, this.config, resolveModelMode(this.config, host));
  }

  modelMode(host: HostCapabilities) {
    return resolveModelMode(this.config, host);
  }

  renderOutput(host: HostCapabilities) {
    return resolveRenderOutput(this.config, host);
  }

  isEmpty(): boolean {
    return this.db.listEntries().length === 0 && this.db.listDesignRules().length === 0;
  }

  /** Rewrite the markdown projection. Called after anything is applied. */
  syncSpecFiles(): string[] {
    if (!this.config.spec_files.autowrite) return [];
    return writeSpecFiles(this.db, this.paths);
  }

  // ------------------------------------------------------------- proposals

  /**
   * The ONLY way an agent touches the harness: it proposes, a human decides.
   * Returns the queued change with a ready-to-show diff.
   */
  proposeEntry(
    type: EntryType,
    key: string,
    op: ChangeOp,
    after: Partial<EntryInput> | null,
    rationale: string,
    source = 'agent',
  ): PendingChange {
    const before = this.db.getEntry(type, key);
    if (op === 'create' && before) op = 'update';
    if (op === 'update' && !before) op = 'create';
    if (op === 'delete' && !before) {
      throw new Error(`Cannot delete ${type}/${key}: it is not in the harness.`);
    }

    const merged: EntryInput | null =
      op === 'delete'
        ? null
        : {
            type,
            key,
            title: after?.title ?? before?.title ?? key,
            body: after?.body ?? before?.body ?? '',
            data: { ...(before?.data ?? {}), ...(after?.data ?? {}) },
            confidence: after?.confidence ?? before?.confidence ?? 'certain',
            question: after?.question ?? null,
            phase: after?.phase ?? before?.phase ?? null,
            position: after?.position ?? before?.position ?? 0,
          };

    const diff = renderDiff(
      objectToText(before ? stripEntry(before) : null),
      objectToText(merged),
    );
    return this.db.addChange({
      target: 'entry',
      op,
      ref: `${type}/${key}`,
      before: before ? stripEntry(before) : null,
      after: merged,
      diff,
      rationale,
      source,
    });
  }

  proposeDesignRule(
    op: ChangeOp,
    ref: string,
    after: { rule?: string; scope?: string; check?: DesignRuleCheck | null } | null,
    rationale: string,
    source = 'agent',
  ): PendingChange {
    const id = Number(ref);
    const before: DesignRule | null = Number.isFinite(id) ? this.db.getDesignRule(id) : null;
    if (op !== 'create' && !before) throw new Error(`Design rule ${ref} not found.`);

    const merged =
      op === 'delete'
        ? null
        : {
            rule: after?.rule ?? before?.rule ?? '',
            scope: after?.scope ?? before?.scope ?? 'global',
            check: after?.check ?? before?.check ?? null,
          };

    const diff = renderDiff(
      objectToText(before ? { rule: before.rule, scope: before.scope, check: before.check } : null),
      objectToText(merged),
    );
    return this.db.addChange({
      target: 'design_rule',
      op,
      ref: before ? String(before.id) : 'new',
      before: before ? { rule: before.rule, scope: before.scope, check: before.check } : null,
      after: merged,
      diff,
      rationale,
      source,
    });
  }

  /**
   * A security rule enters by exactly the same door as everything else. No
   * separate path, no "but this one is important so it applies immediately" —
   * that argument is how a gate acquires its first exception.
   */
  proposeSecurityRule(rule: CatalogueRule, rationale: string, source = 'catalogue'): PendingChange {
    const before = this.db.getSecurityRule(rule.key);
    const diff = renderDiff(objectToText(before ? stripRule(before) : null), objectToText(rule));
    return this.db.addChange({
      target: 'security_rule',
      op: before ? 'update' : 'create',
      ref: rule.key,
      before: before ? stripRule(before) : null,
      after: rule,
      diff,
      rationale,
      source,
    });
  }

  // --------------------------------------------------------------- decision

  approve(changeId: number, actor: string, note: string | null): { change: PendingChange; files: string[] } {
    const change = this.db.getChange(changeId);
    if (!change) throw new Error(`Change #${changeId} not found.`);
    if (change.status !== 'pending') throw new Error(`Change #${changeId} is already ${change.status}.`);

    this.db.createCheckpoint(`before change #${changeId}`);
    this.applyChange(change);
    this.db.decideChange(changeId, 'approved', actor, note);
    return { change: this.db.getChange(changeId)!, files: this.syncSpecFiles() };
  }

  reject(changeId: number, actor: string, note: string | null): PendingChange {
    const change = this.db.getChange(changeId);
    if (!change) throw new Error(`Change #${changeId} not found.`);
    if (change.status !== 'pending') throw new Error(`Change #${changeId} is already ${change.status}.`);
    this.db.decideChange(changeId, 'rejected', actor, note);
    return this.db.getChange(changeId)!;
  }

  private applyChange(change: PendingChange): void {
    if (change.target === 'entry') {
      const [type, ...rest] = change.ref.split('/');
      const key = rest.join('/');
      if (change.op === 'delete') {
        this.db.retireEntry(type as EntryType, key);
      } else {
        this.db.upsertEntry(change.after as EntryInput);
      }
      return;
    }

    if (change.target === 'security_rule') {
      if (change.op === 'delete') this.db.retireSecurityRule(change.ref);
      else this.db.addSecurityRule(change.after as CatalogueRule);
      return;
    }

    const after = change.after as { rule: string; scope: string; check: DesignRuleCheck | null } | null;
    if (change.op === 'create') {
      this.db.addDesignRule(after!.rule, after!.scope, after!.check, change.id);
    } else if (change.op === 'update') {
      this.db.updateDesignRule(Number(change.ref), after!.rule, after!.scope, after!.check);
    } else {
      this.db.retireDesignRule(Number(change.ref));
    }
  }

  // ------------------------------------------------------------- overview

  status() {
    const entries = this.db.listEntries();
    const byType = entries.reduce<Record<string, number>>((acc, e) => {
      acc[e.type] = (acc[e.type] ?? 0) + 1;
      return acc;
    }, {});
    return {
      project_root: this.paths.projectRoot,
      harness_dir: this.paths.dir,
      schema_version: this.db.schemaVersion,
      assembled: !this.isEmpty(),
      entries: byType,
      design_rules: this.db.listDesignRules().length,
      design_tokens: this.db.getDesignTokens()?.source ?? null,
      pending_changes: this.db.pendingCount(),
      checkpoints: this.db.listCheckpoints().length,
      open_questions: entries.filter((e) => e.question).map((e) => ({ ref: `${e.type}/${e.key}`, question: e.question })),
    };
  }
}

/** The parts of an entry a human reviews — ids and timestamps only add noise. */
function stripEntry(e: HarnessEntry) {
  return {
    type: e.type,
    key: e.key,
    title: e.title,
    body: e.body,
    data: e.data,
    confidence: e.confidence,
    question: e.question,
    phase: e.phase,
  };
}

export type { ChangeTarget };

/** What a human reviews for a security rule — ids and timestamps are noise. */
function stripRule(r: SecurityRule) {
  const { id, status, created_at, ...rest } = r;
  return rest;
}
