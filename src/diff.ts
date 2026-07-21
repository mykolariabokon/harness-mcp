/**
 * Line diff for the review screen: the human sees the old struck through and the
 * new highlighted before accepting a change. Small enough to keep dependency-free.
 */

export interface DiffLine {
  kind: 'ctx' | 'del' | 'add';
  text: string;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.length ? before.split('\n') : [];
  const b = after.length ? after.split('\n') : [];
  const lcs = lcsTable(a, b);

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: 'del', text: a[i++] });
    } else {
      out.push({ kind: 'add', text: b[j++] });
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++] });
  while (j < b.length) out.push({ kind: 'add', text: b[j++] });
  return out;
}

function lcsTable(a: string[], b: string[]): number[][] {
  const t: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    }
  }
  return t;
}

export function renderDiff(before: string, after: string): string {
  return diffLines(before, after)
    .map((l) => (l.kind === 'ctx' ? `  ${l.text}` : l.kind === 'del' ? `- ${l.text}` : `+ ${l.text}`))
    .join('\n');
}

/** Human-readable projection of a harness object, used as the diff input. */
export function objectToText(obj: unknown): string {
  if (obj === null || obj === undefined) return '';
  if (typeof obj === 'string') return obj;
  const o = obj as Record<string, unknown>;
  const skip = new Set(['id', 'created_at', 'updated_at', 'position']);
  return Object.keys(o)
    .filter((k) => !skip.has(k) && o[k] !== null && o[k] !== undefined && o[k] !== '')
    .sort()
    .map((k) => {
      const v = o[k];
      const text = typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
      return text.includes('\n') ? `${k}:\n${indent(text)}` : `${k}: ${text}`;
    })
    .join('\n');
}

const indent = (s: string) => s.split('\n').map((l) => `  ${l}`).join('\n');
