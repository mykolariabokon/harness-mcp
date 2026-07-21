import type { HarnessDb } from '../db/HarnessDb.js';
import { diffLines } from '../diff.js';
import { tokensToCss, type DesignTokens } from '../design/tokens.js';
import type { HarnessEntry, LayoutNode } from '../types.js';

/**
 * ONE generator for the visualization. The output goes either into a webview
 * panel (native hosts) or into a browser tab served from localhost (everywhere
 * else) — same HTML in both cases.
 *
 * The picture is an OUTPUT: it shows what the harness currently says, so a human
 * can see the intent and criticise it in words. There is no direct manipulation
 * here on purpose — every edit re-enters through the chat and the approval queue.
 */
export interface RenderOptions {
  projectName: string;
  /** 'structure' | 'mockup' | 'review' — which tab opens first. */
  focus?: string;
}

export function renderHarnessHtml(db: HarnessDb, opts: RenderOptions): string {
  const structure = db.listEntries('structure');
  const design = db.listEntries('design');
  const rules = db.listDesignRules();
  const pending = db.listPending('pending');
  const requirements = db.listEntries('requirement');
  const steps = db.listEntries('step');
  // With tokens the mockup speaks the project's own visual language; without them
  // it stays a deliberately grey skeleton.
  const tokens = db.getDesignTokens();

  const focus = opts.focus ?? (pending.length ? 'review' : 'structure');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harness — ${esc(opts.projectName)}</title>
<style>${CSS}${tokens ? `\n${tokensToCss(tokens)}\n${THEMED_CSS}` : ''}</style>
</head>
<body data-focus="${esc(focus)}">
<header class="top">
  <div>
    <h1>Harness</h1>
    <p class="sub">${esc(opts.projectName)} · source of truth</p>
  </div>
  <nav class="tabs">
    ${tab('structure', 'Structure', structure.length)}
    ${tab('mockup', 'Mockup', design.length)}
    ${tab('spec', 'Spec', requirements.length + steps.length)}
    ${tab('review', 'Review', pending.length, pending.length > 0)}
  </nav>
</header>

<main>
  <section id="panel-structure" class="panel">
    ${structure.length ? structureTree(structure) : empty('No structure yet. Run harness_init (new project) or harness_reverse (existing code).')}
  </section>

  <section id="panel-mockup" class="panel${tokens ? ' themed' : ''}">
    ${themeNote(tokens)}
    ${rules.length ? `<div class="rules"><h3>Global design rules</h3><ul>${rules
      .map((r) => `<li>${esc(r.rule)}${r.scope !== 'global' ? ` <span class="scope">${esc(r.scope)}</span>` : ''}</li>`)
      .join('')}</ul></div>` : ''}
    ${screens(structure, design)}
  </section>

  <section id="panel-spec" class="panel">
    ${specList('Requirements', requirements)}
    ${specList('Steps', steps)}
  </section>

  <section id="panel-review" class="panel">
    ${pending.length ? pending.map(reviewCard).join('') : empty('Nothing waiting for approval.')}
  </section>
</main>

<footer class="foot">
  <span>Criticise in words — the chat is the only way in. This view is read-only by design.</span>
</footer>

<script>${JS}</script>
</body>
</html>`;
}

function tab(id: string, label: string, count: number, alert = false): string {
  const badge = count ? `<span class="badge${alert ? ' alert' : ''}">${count}</span>` : '';
  return `<button class="tab" data-tab="${id}">${esc(label)}${badge}</button>`;
}

function structureTree(nodes: HarnessEntry[]): string {
  const byParent = new Map<string | null, HarnessEntry[]>();
  const keys = new Set(nodes.map((n) => n.key));
  for (const n of nodes) {
    let parent = (n.data.parent as string | null | undefined) ?? null;
    if (parent && !keys.has(parent)) parent = null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), n]);
  }
  const walk = (parent: string | null): string => {
    const kids = byParent.get(parent) ?? [];
    if (!kids.length) return '';
    return `<ul class="tree">${kids
      .map(
        (n) => `<li>
          <span class="kind k-${esc(String(n.data.kind ?? 'module'))}">${esc(String(n.data.kind ?? 'module'))}</span>
          <b>${esc(n.title)}</b>
          ${n.data.path ? `<code>${esc(String(n.data.path))}</code>` : ''}
          ${n.confidence === 'assumption' ? `<span class="assume" title="${esc(n.question ?? '')}">assumption</span>` : ''}
          ${n.body ? `<p>${esc(n.body)}</p>` : ''}
          ${walk(n.key)}
        </li>`,
      )
      .join('')}</ul>`;
  };
  return walk(null) || empty('No structure yet.');
}

function themeNote(tokens: DesignTokens | null): string {
  if (!tokens)
    return `<p class="theme-note">Grey skeleton — no design tokens yet. Feed them in with <code>harness_set_design_tokens</code> or <code>harness_sync_design_system</code> to see the mockup in your own design system.</p>`;
  return `<p class="theme-note">Rendered in tokens from <b>${esc(tokens.source)}</b> · fetched ${esc(tokens.fetched_at.slice(0, 10))}</p>`;
}

function screens(structure: HarnessEntry[], design: HarnessEntry[]): string {
  const withLayout = [...structure, ...design].filter((e) => e.data.layout);
  if (!withLayout.length && !design.length) return empty('No screens described yet.');
  return `<div class="screens">${withLayout
    .map(
      (s) => `<figure class="screen">
        <figcaption>${esc(s.title)}</figcaption>
        <div class="frame">${layout(s.data.layout as LayoutNode)}</div>
      </figure>`,
    )
    .join('')}${design
    .filter((d) => !d.data.layout)
    .map((d) => `<div class="note"><b>${esc(d.title)}</b><p>${esc(d.body)}</p></div>`)
    .join('')}</div>`;
}

/** The mockup is a grey skeleton: it communicates layout intent, never pixels. */
function layout(node: LayoutNode | null | undefined): string {
  if (!node) return '';
  const kids = (node.children ?? []).map(layout).join('');
  return `<div class="el el-${esc(node.el)}"><span>${esc(node.label ?? node.el)}</span>${kids}</div>`;
}

function specList(title: string, entries: HarnessEntry[]): string {
  if (!entries.length) return '';
  return `<h3>${esc(title)}</h3><ol class="spec">${entries
    .map(
      (e) => `<li>
        <b>${esc(e.key)}</b> — ${esc(e.title)}
        ${e.phase ? `<span class="scope">phase ${e.phase}</span>` : ''}
        ${e.body ? `<p>${esc(e.body)}</p>` : ''}
        ${e.data.verify ? `<code>verify: ${esc(String(e.data.verify))}</code>` : ''}
      </li>`,
    )
    .join('')}</ol>`;
}

function reviewCard(c: { id: number; op: string; target: string; ref: string; rationale: string; diff: string; before: unknown; after: unknown }): string {
  const lines = c.diff
    ? c.diff.split('\n').map((l) => ({ kind: l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'ctx', text: l.slice(2) }))
    : diffLines('', '');
  return `<article class="change">
    <header>
      <span class="op op-${esc(c.op)}">${esc(c.op)}</span>
      <b>${esc(c.target)} · ${esc(c.ref)}</b>
      <span class="id">#${c.id}</span>
    </header>
    ${c.rationale ? `<p class="why">${esc(c.rationale)}</p>` : ''}
    <pre class="diff">${lines
      .map((l) => `<span class="d-${l.kind}">${esc(l.text)}</span>`)
      .join('\n')}</pre>
    <p class="hint">Approve with <code>harness_approve(change_id: ${c.id})</code> · reject with <code>harness_reject(change_id: ${c.id})</code></p>
  </article>`;
}

const empty = (msg: string) => `<p class="empty">${esc(msg)}</p>`;

export function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CSS = `
:root {
  --bg: #ffffff; --fg: #1c1c1e; --muted: #6b7280; --line: #e5e7eb;
  --card: #f8f9fb; --accent: #2f6f4f; --add: #1a7f37; --addbg: #e7f7ec;
  --del: #b3261e; --delbg: #fdecea; --skel: #e3e5ea;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16181d; --fg: #e6e8ec; --muted: #9aa1ac; --line: #2b2f36;
    --card: #1d2026; --accent: #6bbf8f; --add: #6bbf8f; --addbg: #17301f;
    --del: #ef8a83; --delbg: #33191a; --skel: #2b2f36;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.55 -apple-system, "Segoe UI", Roboto, sans-serif; }
.top { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px;
       padding: 18px 22px 0; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
h1 { margin: 0; font-size: 18px; letter-spacing: .2px; }
.sub { margin: 2px 0 12px; color: var(--muted); font-size: 12px; }
.tabs { display: flex; gap: 4px; }
.tab { background: none; border: 0; border-bottom: 2px solid transparent; color: var(--muted);
       padding: 8px 12px; font: inherit; cursor: pointer; border-radius: 8px 8px 0 0; }
.tab:hover { color: var(--fg); }
.tab.on { color: var(--fg); border-bottom-color: var(--accent); }
.badge { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 8px;
         background: var(--skel); font-size: 11px; }
.badge.alert { background: var(--accent); color: var(--bg); }
main { padding: 20px 22px 60px; max-width: 980px; }
.panel { display: none; }
.panel.on { display: block; }
.empty { color: var(--muted); }
h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .6px; color: var(--muted); margin: 22px 0 8px; }
ul.tree, ul.tree ul { list-style: none; margin: 0; padding-left: 16px; }
ul.tree > li { border-left: 1px solid var(--line); padding: 4px 0 4px 12px; margin-left: -1px; }
.kind { font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: var(--muted);
        border: 1px solid var(--line); border-radius: 8px; padding: 1px 6px; margin-right: 6px; }
code { background: var(--card); border-radius: 6px; padding: 1px 5px; font-size: 12px; }
.assume { color: var(--del); font-size: 11px; margin-left: 6px; border-bottom: 1px dotted var(--del); cursor: help; }
li p { margin: 2px 0 0; color: var(--muted); }
.rules ul { margin: 0; padding-left: 18px; }
.scope { color: var(--muted); font-size: 11px; margin-left: 6px; }
.screens { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 14px; }
.screen { margin: 0; }
figcaption { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.frame { width: 300px; min-height: 190px; border: 1px solid var(--line); border-radius: 8px;
         background: var(--card); padding: 8px; }
.el { background: var(--skel); border-radius: 8px; padding: 6px; margin: 4px 0; }
.el > span { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .4px; }
.el-sidebar { width: 34%; display: inline-block; vertical-align: top; }
.el-button { display: inline-block; width: auto; padding: 4px 10px; }
.note { max-width: 300px; }
ol.spec { padding-left: 20px; }
ol.spec li { margin-bottom: 10px; }
.change { border: 1px solid var(--line); border-radius: 10px; margin-bottom: 14px; overflow: hidden; }
.change header { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
                 background: var(--card); border-bottom: 1px solid var(--line); }
.op { font-size: 10px; text-transform: uppercase; letter-spacing: .5px; border-radius: 8px;
      padding: 1px 6px; background: var(--skel); }
.id { margin-left: auto; color: var(--muted); font-size: 12px; }
.why { margin: 10px 12px 0; color: var(--muted); }
pre.diff { margin: 10px 12px; padding: 10px; background: var(--card); border-radius: 8px;
           overflow-x: auto; font-size: 12.5px; }
.d-add { display: block; background: var(--addbg); color: var(--add); }
.d-del { display: block; background: var(--delbg); color: var(--del); text-decoration: line-through; }
.d-ctx { display: block; color: var(--muted); }
.hint { margin: 0 12px 12px; font-size: 12px; color: var(--muted); }
.theme-note { color: var(--muted); font-size: 12px; margin: 0 0 10px; }
.foot { position: fixed; bottom: 0; left: 0; right: 0; padding: 8px 22px;
        border-top: 1px solid var(--line); background: var(--bg); color: var(--muted); font-size: 12px; }
`;

/**
 * Applied only when a token set is present. The layout tree is unchanged — the same
 * skeleton, painted in the project's tokens, so what you approve is what gets built.
 */
const THEMED_CSS = `
.themed .frame { background: var(--t-bg); border-color: var(--t-border);
                 border-radius: var(--t-radius-card); box-shadow: var(--t-shadow-card);
                 font-family: var(--t-font-body); padding: var(--t-space-md); }
.themed .el { background: var(--t-surface); color: var(--t-text); border: 1px solid var(--t-border);
              border-radius: var(--t-radius-card); padding: var(--t-space-sm); margin: var(--t-space-xs) 0; }
.themed .el > span { color: var(--t-muted); font-size: var(--t-size-label);
                     font-family: var(--t-font-heading); text-transform: none; letter-spacing: 0; }
.themed .el-button { background: var(--t-accent); border-color: transparent;
                     border-radius: var(--t-radius-pill); padding: var(--t-space-sm) var(--t-space-md); }
.themed .el-button > span { color: var(--t-accent-text); }
.themed figcaption { font-family: var(--t-font-heading); font-size: var(--t-size-label); }
`;

const JS = `
const show = (id) => {
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('on', p.id === 'panel-' + id));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === id));
};
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => show(t.dataset.tab)));
show(document.body.dataset.focus || 'structure');
`;
