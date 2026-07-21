import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolution of the /harness folder for a project.
 *
 * Mirrors how ProjectMind MCP owns `/ai`: one folder at the project root, created
 * on first use, holding the database plus the committable markdown spec.
 */
export const HARNESS_DIR = 'harness';

/** Plain JSON — no native module, so the server ships inside the editor unchanged. */
export const STATE_FILE = 'harness.json';

export interface HarnessPaths {
  projectRoot: string;
  dir: string;
  /** Working state: entries, pending changes, approvals, checkpoints. */
  state: string;
  config: string;
  cache: string;
  tasks: string;
  constitution: string;
  structure: string;
  design: string;
  spec: string;
}

export function harnessPaths(projectRoot: string): HarnessPaths {
  const root = path.resolve(projectRoot);
  const dir = path.join(root, HARNESS_DIR);
  return {
    projectRoot: root,
    dir,
    state: path.join(dir, STATE_FILE),
    config: path.join(dir, 'config.json'),
    cache: path.join(dir, '.cache'),
    tasks: path.join(dir, 'tasks'),
    constitution: path.join(dir, 'CONSTITUTION.md'),
    structure: path.join(dir, 'STRUCTURE.md'),
    design: path.join(dir, 'DESIGN.md'),
    spec: path.join(dir, 'SPEC.md'),
  };
}

export function ensureHarnessDir(projectRoot: string): HarnessPaths {
  const p = harnessPaths(projectRoot);
  fs.mkdirSync(p.dir, { recursive: true });
  fs.mkdirSync(p.tasks, { recursive: true });
  fs.mkdirSync(p.cache, { recursive: true });
  ensureGitignore(p);
  return p;
}

export function harnessExists(projectRoot: string): boolean {
  return fs.existsSync(harnessPaths(projectRoot).state);
}

/**
 * The markdown spec is meant to be committed; the database, cache and pending
 * state are local working state.
 */
const GITIGNORE_BODY = `# Harness working state — the markdown spec next to it IS meant to be committed.
harness.json
.harness.json.*.tmp
.cache/
config.json
`;

function ensureGitignore(p: HarnessPaths): void {
  const file = path.join(p.dir, '.gitignore');
  if (!fs.existsSync(file)) fs.writeFileSync(file, GITIGNORE_BODY, 'utf8');
}

/**
 * Walk up from `start` looking for a project root marker. Used only as a fallback —
 * tools take an explicit `project_path`, the same discipline ProjectMind MCP asks for.
 */
export function findProjectRoot(start: string): string {
  let cur = path.resolve(start);
  for (;;) {
    for (const marker of [HARNESS_DIR, '.git', 'package.json', 'pyproject.toml']) {
      if (fs.existsSync(path.join(cur, marker))) return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(start);
    cur = parent;
  }
}
