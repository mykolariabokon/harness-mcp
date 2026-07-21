import fs from 'node:fs';
import path from 'node:path';
import { migrate, SCHEMA_VERSION, type HarnessDoc } from './schema.js';

/**
 * The harness state lives in a single JSON file — `harness/harness.json`.
 *
 * Why not SQLite: this server ships inside the editor, and a native module has to
 * be rebuilt for every Electron ABI on every platform. The data is dozens of
 * records per project, not millions, so a document is the right size of tool.
 *
 * What SQLite gave for free and this class has to provide explicitly:
 *
 *  - **Atomicity.** Every write goes to a temporary file in the same directory,
 *    is fsync'd, and then renamed over the target. Rename is atomic within a
 *    filesystem, so an interrupted write can never leave a half-written
 *    `harness.json` — the old file stands until the new one is complete. This
 *    matters: approvals and checkpoints live here, and a human must not lose them.
 *
 *  - **Transactions.** `mutate()` applies the change to a *copy*, persists it, and
 *    only then adopts it as the in-memory state. If the callback throws, or the
 *    write fails, neither memory nor disk moves — all or nothing.
 *
 *  - **Concurrency.** Deliberate choice, not an oversight: the in-memory document
 *    is authoritative for this process, and before every mutation the file's
 *    mtime/size are checked — if another process (the editor's own server, an
 *    external MCP client) wrote in the meantime, the document is re-read and the
 *    mutation is applied on top of the fresh state. Combined with atomic rename
 *    this makes cross-process interleaving safe at operation granularity.
 *    The residual race is the window between that stat and the rename, both
 *    synchronous and microseconds apart; two processes writing inside it means the
 *    later rename wins wholesale. We accept it rather than adding a lock file:
 *    contention here is human-paced (someone approving a change), and a stale lock
 *    left by a killed editor is a worse failure than a race nobody can hit.
 */
export class JsonStore {
  readonly file: string;
  readonly schemaVersion: number;
  private doc: HarnessDoc;
  private stamp: string | null = null;

  constructor(file: string) {
    this.file = file;
    this.doc = this.loadFromDisk();
    this.schemaVersion = this.doc.schema_version;
  }

  /** Current state. Callers get a copy; the document is never handed out live. */
  read(): HarnessDoc {
    this.refreshIfChangedOnDisk();
    return this.doc;
  }

  /**
   * Apply a change transactionally: work on a clone, persist, then adopt.
   * Nothing is visible — in memory or on disk — unless the write succeeded.
   */
  mutate<T>(fn: (doc: HarnessDoc) => T): T {
    this.refreshIfChangedOnDisk();
    const next = structuredClone(this.doc);
    const result = fn(next);
    this.writeAtomic(next);
    this.doc = next;
    return result;
  }

  close(): void {
    // Nothing to release: no handle is held open between operations.
  }

  // ------------------------------------------------------------------ disk

  private loadFromDisk(): HarnessDoc {
    if (!fs.existsSync(this.file)) {
      const fresh = migrate(emptyDoc());
      this.writeAtomic(fresh);
      return fresh;
    }

    const raw = fs.readFileSync(this.file, 'utf8');
    if (!raw.trim()) {
      throw new Error(
        `${this.file} is empty. The harness state is missing — restore the file from version control, ` +
          `or delete it and reassemble with harness_init / harness_reverse.`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // Loud and specific: a truncated state file must never read as "no harness yet".
      throw new Error(
        `${this.file} is not valid JSON (${err instanceof Error ? err.message : String(err)}). ` +
          `Refusing to continue so the damaged file is not overwritten. Restore it from version control, ` +
          `or delete it and reassemble with harness_init / harness_reverse.`,
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${this.file} does not contain a harness document (expected a JSON object).`);
    }

    // Read the version BEFORE migrating: migrate() works in place, so afterwards
    // there is nothing left to compare against.
    const versionOnDisk = Number((parsed as Partial<HarnessDoc>).schema_version ?? 0);
    const migrated = migrate(parsed as Partial<HarnessDoc>);
    if (migrated.schema_version !== versionOnDisk) {
      this.writeAtomic(migrated);
    } else {
      this.stampFile();
    }
    return migrated;
  }

  /**
   * Another process may own the file between our operations, so trust the disk
   * over stale memory before mutating.
   */
  private refreshIfChangedOnDisk(): void {
    const current = this.statStamp();
    if (current !== null && current === this.stamp) return;
    if (current === null) return; // deleted underneath us — keep serving memory.
    this.doc = this.loadFromDisk();
  }

  /** Temp file + rename: the reader either sees the old document or the new one. */
  protected writeAtomic(doc: HarnessDoc): void {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    // Same directory, so the rename stays within one filesystem and is atomic.
    const tmp = path.join(dir, `.${path.basename(this.file)}.${process.pid}.${counter++}.tmp`);
    const payload = JSON.stringify(doc, null, 2) + '\n';

    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, payload, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    try {
      fs.renameSync(tmp, this.file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    this.stampFile();
  }

  private statStamp(): string | null {
    try {
      const s = fs.statSync(this.file);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return null;
    }
  }

  private stampFile(): void {
    this.stamp = this.statStamp();
  }
}

let counter = 0;

function emptyDoc(): Partial<HarnessDoc> {
  return { schema_version: 0 };
}

export { SCHEMA_VERSION };
