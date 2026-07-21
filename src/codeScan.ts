import fs from 'node:fs';
import path from 'node:path';

/**
 * A cheap local inventory of the repository. Reverse assembly feeds it to a model
 * as evidence, and `harness_verify` compares the harness against it.
 *
 * Deliberately dependency-free and shallow: the deep semantic picture is
 * ProjectMind MCP's job, and its output can be passed in as `analysis` instead.
 */

const IGNORED = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', 'venv',
  '__pycache__', '.idea', '.vscode', 'coverage', '.turbo', '.cache', 'target',
  '.ai', 'harness', 'vector_store',
]);

const DOC_FILES = ['README.md', 'ARCHITECTURE.md', 'AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'docs/README.md'];

export interface CodeInventory {
  root: string;
  /** Directories and files, relative, capped. */
  tree: string[];
  file_count: number;
  manifests: Record<string, unknown>;
  /** Doc excerpts used only as a HINT — code wins when they disagree. */
  docs: Record<string, string>;
  languages: Record<string, number>;
}

export function scanCode(root: string, opts: { maxEntries?: number; maxDocChars?: number } = {}): CodeInventory {
  const maxEntries = opts.maxEntries ?? 1200;
  const maxDocChars = opts.maxDocChars ?? 6000;

  const tree: string[] = [];
  const languages: Record<string, number> = {};
  let fileCount = 0;

  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 6 || tree.length >= maxEntries) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      if (IGNORED.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        tree.push(`${childRel}/`);
        walk(path.join(dir, e.name), childRel, depth + 1);
      } else {
        fileCount++;
        const ext = path.extname(e.name).toLowerCase();
        if (ext) languages[ext] = (languages[ext] ?? 0) + 1;
        if (tree.length < maxEntries) tree.push(childRel);
      }
    }
  };
  walk(root, '', 0);

  const manifests: Record<string, unknown> = {};
  for (const name of ['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'tsconfig.json']) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    manifests[name] = name.endsWith('.json') ? tryJson(raw) : raw.slice(0, 4000);
  }

  const docs: Record<string, string> = {};
  for (const name of DOC_FILES) {
    const file = path.join(root, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      docs[name] = fs.readFileSync(file, 'utf8').slice(0, maxDocChars);
    }
  }

  return { root, tree, file_count: fileCount, manifests, docs, languages };
}

/** Does a path declared in the harness exist in the repo? */
export function pathExists(root: string, rel: string): boolean {
  return fs.existsSync(path.join(root, rel));
}

/**
 * Minimal glob matcher: `**` crosses directories, `*` does not, `?` is one char.
 * `a/**` + `/b.ts` also matches `a/b.ts`, as glob users expect.
 */
export function globToRegExp(glob: string): RegExp {
  let src = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          src += '(?:[^/]*\\/)*';
        } else {
          src += '.*';
        }
      } else {
        src += '[^/]*';
      }
    } else if (c === '?') {
      src += '[^/]';
    } else {
      src += /[.+^${}()|[\]\\/]/.test(c) ? `\\${c}` : c;
    }
  }
  return new RegExp(`^${src}$`);
}

export function listFiles(root: string, glob: string, limit = 400): string[] {
  const re = globToRegExp(glob);
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 8 || out.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (IGNORED.has(e.name) || (e.name.startsWith('.') && e.name !== '.github')) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), childRel, depth + 1);
      else if (re.test(childRel)) out.push(childRel);
    }
  };
  walk(root, '', 0);
  return out;
}

export function readFileSafe(root: string, rel: string, limit = 200_000): string | null {
  try {
    const file = path.join(root, rel);
    if (fs.statSync(file).size > limit) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function tryJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw.slice(0, 2000);
  }
}
