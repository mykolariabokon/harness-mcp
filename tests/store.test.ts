import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HarnessDb } from '../src/db/HarnessDb.js';
import { SCHEMA_VERSION } from '../src/db/schema.js';

/**
 * What SQLite used to guarantee and a JSON document must now prove: an interrupted
 * write leaves the previous state intact, a damaged file is refused loudly instead
 * of read as "empty harness", and a restore is all-or-nothing.
 */

const dirs: string[] = [];

function stateFile(seed?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-store-'));
  dirs.push(dir);
  const file = path.join(dir, 'harness.json');
  if (seed !== undefined) fs.writeFileSync(file, seed, 'utf8');
  return file;
}

/** Simulate the process dying mid-save: the write throws after nothing was renamed. */
function breakWrites(db: HarnessDb, message = 'disk full'): void {
  (db.store as unknown as { writeAtomic: () => void }).writeAtomic = () => {
    throw new Error(message);
  };
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('json store durability', () => {
  it('creates a fresh document at the current schema version', () => {
    const file = stateFile();
    const db = new HarnessDb(file);
    expect(db.schemaVersion).toBe(SCHEMA_VERSION);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).schema_version).toBe(SCHEMA_VERSION);
  });

  it('leaves the previous state intact when a write fails', () => {
    const file = stateFile();
    const db = new HarnessDb(file);
    db.upsertEntry({ type: 'structure', key: 'ui', title: 'UI' });
    const onDisk = fs.readFileSync(file, 'utf8');

    breakWrites(db);
    expect(() => db.upsertEntry({ type: 'structure', key: 'ui', title: 'Renamed' })).toThrow('disk full');

    // Neither the file nor the in-memory state moved.
    expect(fs.readFileSync(file, 'utf8')).toBe(onDisk);
    expect(db.getEntry('structure', 'ui')!.title).toBe('UI');
  });

  it('never leaves a partially written file behind', () => {
    const file = stateFile();
    const db = new HarnessDb(file);
    for (let i = 0; i < 25; i++) db.upsertEntry({ type: 'step', key: `S${i}`, title: `Step ${i}`, phase: 1 });

    // Whatever moment we read at, the document parses and is complete.
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(parsed.entries).toHaveLength(25);
    // No temp files survive a clean run.
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('restores a checkpoint atomically', () => {
    const file = stateFile();
    const db = new HarnessDb(file);
    db.upsertEntry({ type: 'structure', key: 'ui', title: 'UI' });
    const cp = db.createCheckpoint('before');
    db.upsertEntry({ type: 'structure', key: 'later', title: 'Added later' });
    db.addDesignRule('Temporary rule.');

    breakWrites(db);
    expect(() => db.restoreCheckpoint(cp.id)).toThrow('disk full');

    // The failed restore changed nothing — not half of it.
    expect(db.getEntry('structure', 'later')).not.toBeNull();
    expect(db.listDesignRules()).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).entries).toHaveLength(2);
  });

  it('refuses an empty state file instead of reading it as an empty harness', () => {
    expect(() => new HarnessDb(stateFile(''))).toThrow(/is empty/);
  });

  it('refuses a truncated state file with a clear message', () => {
    const truncated = '{"schema_version":2,"entries":[{"id":1,"type":"struct';
    expect(() => new HarnessDb(stateFile(truncated))).toThrow(/not valid JSON/);
  });

  it('refuses a document that is not a harness object', () => {
    expect(() => new HarnessDb(stateFile('[1,2,3]'))).toThrow(/harness document/);
  });

  it('refuses a state file written by a newer build', () => {
    const future = JSON.stringify({ schema_version: SCHEMA_VERSION + 1, entries: [] });
    expect(() => new HarnessDb(stateFile(future))).toThrow(/newer Harness MCP/);
  });

  it('migrates a document from an older schema version', () => {
    // v1 predates design tokens: the collection is absent entirely.
    const old = JSON.stringify({
      schema_version: 1,
      next_id: { entries: 1 },
      entries: [
        {
          id: 1, type: 'structure', key: 'ui', title: 'UI', body: '', data: {},
          status: 'active', confidence: 'certain', question: null, phase: null, position: 0,
          created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      design_rules: [], pending_changes: [], approvals: [], checkpoints: [],
      sessions: [], generation_requests: [],
    });
    const file = stateFile(old);
    const db = new HarnessDb(file);

    expect(db.schemaVersion).toBe(SCHEMA_VERSION);
    expect(db.getEntry('structure', 'ui')!.title).toBe('UI');
    expect(db.getDesignTokens()).toBeNull();
    // The migration was persisted, not just applied in memory.
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).schema_version).toBe(SCHEMA_VERSION);
  });

  it('picks up a write made by another process', () => {
    const file = stateFile();
    const a = new HarnessDb(file);
    const b = new HarnessDb(file);

    a.upsertEntry({ type: 'structure', key: 'ui', title: 'UI' });
    // b loaded before that write, and must not serve its stale copy.
    expect(b.getEntry('structure', 'ui')!.title).toBe('UI');

    b.upsertEntry({ type: 'structure', key: 'api', title: 'API' });
    expect(a.listEntries('structure')).toHaveLength(2);
  });

  it('hands out copies, so stored state cannot be mutated by reference', () => {
    const db = new HarnessDb(stateFile());
    db.upsertEntry({ type: 'structure', key: 'ui', title: 'UI' });
    const entry = db.getEntry('structure', 'ui')!;
    entry.title = 'Tampered';
    expect(db.getEntry('structure', 'ui')!.title).toBe('UI');
  });
});
