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
 *
 * Hard constraint: NO JavaScript. The host (Peregrine's webview) serves this under
 * `script-src 'self' blob:` with no `'unsafe-inline'`, so an inline <script> — or
 * anything on onclick — simply does not run, and once left the whole panel blank.
 * Every interaction here is native browser behaviour instead: hidden radio inputs
 * with `:checked ~` selectors for the tab and screen switchers, and <details> for
 * expanding descriptions. Inline <style> IS allowed (the themed mockup already
 * depends on it), so all switching logic lives in CSS.
 */
export interface RenderOptions {
  projectName: string;
  /** 'structure' | 'mockup' | 'spec' | 'review' — which tab opens first. */
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

  const deck = deckItems(structure, design);
  const focus = opts.focus ?? (pending.length ? 'review' : 'structure');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harness — ${esc(opts.projectName)}</title>
<style>${CSS}${screenDeckCss(deck.length)}${tokens ? `\n${tokensToCss(tokens)}\n${THEMED_CSS}` : ''}</style>
</head>
<body>
${tabRadio('structure', focus)}
${tabRadio('mockup', focus)}
${tabRadio('spec', focus)}
${tabRadio('review', focus)}
<header class="top">
  <div>
    <h1>Harness</h1>
    <p class="sub">${esc(opts.projectName)} · source of truth</p>
  </div>
  <nav class="tabs">
    ${tabLabel('structure', 'Structure', structure.length)}
    ${tabLabel('mockup', 'Mockup', deck.length)}
    ${tabLabel('spec', 'Spec', requirements.length + steps.length)}
    ${tabLabel('review', 'Review', pending.length, pending.length > 0)}
  </nav>
</header>

<main>
  <section id="panel-structure" class="panel">
    ${structure.length
      ? `${structureTree(structure)}${flowsSection(structure)}`
      : empty('No structure yet. Run harness_init (new project) or harness_reverse (existing code).')}
  </section>

  <section id="panel-mockup" class="panel${tokens ? ' themed' : ''}">
    ${themeNote(tokens)}
    ${rules.length ? `<div class="rules"><h3>Global design rules</h3><ul>${rules
      .map((r) => `<li>${esc(r.rule)}${r.scope !== 'global' ? ` <span class="scope">${esc(r.scope)}</span>` : ''}</li>`)
      .join('')}</ul></div>` : ''}
    ${screensDeck(deck)}
  </section>

  <section id="panel-spec" class="panel">
    ${requirements.length || steps.length
      ? `${specList('Requirements', requirements)}${specList('Steps', steps)}`
      : empty(
          'No requirements or steps yet — they normally arrive with the initial assembly. Ask for them in the chat, ' +
            'for example: “add a requirement that an order can only be cancelled before it fills”.',
        )}
  </section>

  <section id="panel-review" class="panel">
    ${pending.length
      ? pending.map(reviewCard).join('')
      : empty(
          'Nothing waiting for approval. Everything an agent proposes lands here first — old struck through, ' +
            'new highlighted — and enters the harness only when you accept it.',
        )}
  </section>
</main>

<footer class="foot">${critiqueHint()}</footer>
</body>
</html>`;
}

// ------------------------------------------------------------------ tabs (no JS)

/**
 * A hidden radio per tab, checked on the server for the default. `:checked ~`
 * drives which panel shows and which label is active — no script, so it survives
 * the host CSP that silently killed the old onclick version.
 */
function tabRadio(id: string, focus: string): string {
  return `<input class="tabsel" type="radio" name="htab" id="ht-${id}"${id === focus ? ' checked' : ''}>`;
}

function tabLabel(id: string, label: string, count: number, alert = false): string {
  const badge = count ? `<span class="badge${alert ? ' alert' : ''}">${count}</span>` : '';
  return `<label class="tab" for="ht-${id}">${esc(label)}${badge}</label>`;
}

// ------------------------------------------------------------------- structure

/**
 * The tree, with each node's description tucked inside <details> so the titles
 * read as a map instead of a wall of text. Flow nodes are pulled out into their
 * own section — a flow is a connection across the tree, not a child in it.
 */
function structureTree(nodes: HarnessEntry[]): string {
  const visible = nodes.filter((n) => n.data.kind !== 'flow');
  const byParent = new Map<string | null, HarnessEntry[]>();
  const keys = new Set(visible.map((n) => n.key));
  for (const n of visible) {
    let parent = (n.data.parent as string | null | undefined) ?? null;
    if (parent && !keys.has(parent)) parent = null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), n]);
  }
  const walk = (parent: string | null): string => {
    const kids = byParent.get(parent) ?? [];
    if (!kids.length) return '';
    return `<ul class="tree">${kids.map((n) => `<li>${nodeHead(n)}${walk(n.key)}</li>`).join('')}</ul>`;
  };
  return walk(null) || empty('No structure yet.');
}

function nodeHead(n: HarnessEntry): string {
  const head =
    `<span class="kind k-${esc(String(n.data.kind ?? 'module'))}">${esc(String(n.data.kind ?? 'module'))}</span> ` +
    `<b>${esc(n.title)}</b>` +
    `${n.data.path ? ` <code>${esc(String(n.data.path))}</code>` : ''}` +
    `${n.confidence === 'assumption' ? ` <span class="assume" title="${esc(n.question ?? '')}">assumption</span>` : ''}`;
  // Description behind a native disclosure; the header stays visible either way.
  if (n.body?.trim()) return `<details class="node"><summary>${head}</summary><p>${esc(n.body)}</p></details>`;
  return `<div class="node-head">${head}</div>`;
}

/** Flows are the connections the user asked to see — the tree only shows nesting. */
function flowsSection(nodes: HarnessEntry[]): string {
  const flows = nodes.filter((n) => n.data.kind === 'flow');
  if (!flows.length) return '';
  const nameByKey = new Map(nodes.map((n) => [n.key, n.title]));
  return `<div class="flows"><h3>Flows &amp; connections</h3><ul class="flowlist">${flows
    .map((f) => {
      const within = f.data.parent ? nameByKey.get(String(f.data.parent)) : null;
      const context = within ? ` <span class="scope">in ${esc(within)}</span>` : '';
      const head = `<b>${esc(f.title)}</b>${context}`;
      return `<li class="flow">${
        f.body?.trim()
          ? `<details><summary>${head}</summary><p>${esc(f.body)}</p></details>`
          : `<div class="node-head">${head}</div>`
      }</li>`;
    })
    .join('')}</ul></div>`;
}

// ----------------------------------------------------------------- mockup deck

interface DeckScreen {
  title: string;
  layout: LayoutNode | null;
  /** Real description text carried from the entries — never fabricated. */
  notes: string[];
}

/**
 * One screen may be modelled twice — as a structure node of kind "screen" and as a
 * design entry describing its layout. Merge them by a normalized key so the deck
 * shows each screen once: the structured skeleton where it exists, the written
 * description otherwise. Nothing is invented; unmatched entries simply stand alone.
 */
function deckItems(structure: HarnessEntry[], design: HarnessEntry[]): DeckScreen[] {
  const order: string[] = [];
  const map = new Map<string, DeckScreen & { fromStruct: boolean }>();

  const add = (e: HarnessEntry, fromStruct: boolean): void => {
    const k = mergeKey(e);
    let it = map.get(k);
    if (!it) {
      it = { title: e.title, layout: null, notes: [], fromStruct };
      map.set(k, it);
      order.push(k);
    }
    // A structure screen's own title wins over a "Макет X" design title.
    if (fromStruct) {
      it.title = e.title;
      it.fromStruct = true;
    } else if (!it.fromStruct) {
      it.title = e.title;
    }
    if (e.data.layout && !it.layout) it.layout = e.data.layout as LayoutNode;
    if (e.body?.trim()) it.notes.push(e.body.trim());
  };

  structure.filter((e) => e.data.kind === 'screen').forEach((e) => add(e, true));
  design.forEach((e) => add(e, false));
  return order.map((k) => {
    const { title, layout, notes } = map.get(k)!;
    return { title, layout, notes };
  });
}

const mergeKey = (e: HarnessEntry): string => norm(e.key) || norm(e.title) || e.key;

/** Strip an artefact prefix (screen-/layout-/Макет …) so screen-X and layout-X meet. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/^(screen|layout|design|mockup|макет)[\s_-]+/i, '')
    .replace(/\(.*?\)/g, '')
    .replace(/[^a-z0-9а-яёіїєґ]+/gi, '');
}

/**
 * The screens, one shown at a time. A hidden radio per screen + `:checked ~`
 * (rules generated in screenDeckCss) does the switching with no JavaScript.
 */
function screensDeck(deck: DeckScreen[]): string {
  if (!deck.length)
    return empty('No screens described yet. Ask for one in the chat, e.g. “add a settings screen with a form”.');

  const radios = deck
    .map((_, i) => `<input class="scrsel" type="radio" name="hscreen" id="hs-${i}"${i === 0 ? ' checked' : ''}>`)
    .join('');
  const tabs = deck.map((s, i) => `<label class="deck-tab" for="hs-${i}">${esc(s.title)}</label>`).join('');
  const bodies = deck.map((s) => `<figure class="screen">${screenBody(s)}</figure>`).join('');
  return `<div class="deck">${radios}<div class="deck-tabs">${tabs}</div><div class="deck-body">${bodies}</div></div>`;
}

function screenBody(s: DeckScreen): string {
  const parts: string[] = [];
  if (s.layout) parts.push(`<div class="frame">${layout(s.layout)}</div>`);
  if (s.notes.length) {
    parts.push(`<div class="screen-note">${s.notes.map((n) => `<p>${esc(n)}</p>`).join('')}</div>`);
  }
  // Honest about a missing skeleton rather than drawing a fake one.
  if (!s.layout) {
    parts.push(
      s.notes.length
        ? `<p class="screen-hint">No visual skeleton yet — only the description above. Ask in the chat to “draw the ${esc(
            s.title,
          )} layout”.</p>`
        : empty('Layout not described for this screen yet — ask for one in the chat.'),
    );
  }
  return parts.join('');
}

/**
 * Every layout element is drawn AS ITS TYPE, so the mockup reads like an interface,
 * not a list of framed labels. Direction matters: header/controls/tabs lay their
 * children in a row, main/section/form/list stack them; a container holding a
 * sidebar becomes a horizontal split (that is what makes the dashboard read right).
 * Still a skeleton, not pixels — but the skeleton of a building, not a list of rooms.
 */
function layout(node: LayoutNode | null | undefined): string {
  if (!node) return '';
  const el = String(node.el || 'box');
  const label = node.label ? esc(node.label) : '';
  const kids = (node.children ?? []).filter(Boolean);
  const inner = kids.map(layout).join('');

  switch (el) {
    case 'stat':
      return `<div class="el el-stat"><span class="el-cap">${label || 'stat'}</span><span class="el-num"></span></div>`;
    case 'chart':
      return `<div class="el el-chart"><span class="el-cap">${label || 'chart'}</span><span class="el-plot"></span></div>`;
    case 'button':
      return `<span class="el el-button"><span>${label || 'button'}</span></span>`;
    case 'dropdown':
      return `<div class="el el-dropdown"><span>${label || 'select'}</span><b class="caret">▾</b></div>`;
    case 'badge':
      return `<span class="el el-badge">${label || 'badge'}</span>`;
    case 'table':
      return `<div class="el el-table"><span class="el-cap">${label || 'table'}</span><span class="el-rows">${bars(4)}</span></div>`;
    case 'tabs':
      return `<div class="el el-tabs"><span class="el-cap">${label || 'tabs'}</span><span class="el-chips">${
        kids.length ? inner : chips(4)
      }</span></div>`;
  }

  // Containers. A sidebar among the children means this row splits horizontally.
  const hasSidebar = kids.some((k) => k.el === 'sidebar');
  const dir = hasSidebar || ROW_ELS.has(el) ? 'row' : 'col';
  const cap = node.label ? label : TAGGED.has(el) ? el : '';
  // Empty list/form get faint placeholder bars (clearly skeleton); other empty
  // containers stay an empty frame — no invented content.
  const body = inner || (FILLED.has(el) ? bars(3) : '');
  return `<div class="el el-${esc(el)} dir-${dir}">${
    cap ? `<span class="el-cap">${cap}</span>` : ''
  }<div class="el-in">${body}</div></div>`;
}

const ROW_ELS = new Set(['header', 'controls', 'tabs', 'footer', 'toolbar', 'nav', 'row']);
const TAGGED = new Set(['header', 'sidebar', 'footer', 'controls', 'form', 'list']);
const FILLED = new Set(['list', 'form']);
const bars = (n: number) => Array.from({ length: n }, () => '<i class="bar"></i>').join('');
const chips = (n: number) => Array.from({ length: n }, () => '<i class="chip"></i>').join('');

// -------------------------------------------------------------------- the rest

/**
 * "Criticise in words" told the human the rule but not the move. This is for the
 * person reading the panel, so it belongs on the page — with real sentences they
 * can copy, not an abstract instruction.
 */
function critiqueHint(): string {
  const examples = [
    'sidebar on the left',
    'drop the settings screen',
    'Order belongs to engine, not shared',
    'all buttons get an 8px radius',
  ];
  return `<span class="foot-main">This view is read-only by design. To change anything, say it in the chat in plain words —
    the agent turns it into a harness change and you approve the diff.</span>
    <span class="foot-eg">${examples.map((e) => `<code>${esc(e)}</code>`).join(' ')}</span>`;
}

function themeNote(tokens: DesignTokens | null): string {
  if (!tokens)
    return `<p class="theme-note">Grey skeleton — no design tokens yet. Feed them in with <code>harness_set_design_tokens</code> or <code>harness_sync_design_system</code> to see the mockup in your own design system.</p>`;
  return `<p class="theme-note">Rendered in tokens from <b>${esc(tokens.source)}</b> · fetched ${esc(tokens.fetched_at.slice(0, 10))}</p>`;
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

/**
 * Per-render rules for the screen switcher: how many screens there are is only
 * known at render time, so the `:checked ~ nth-of-type` pairs are generated here.
 */
function screenDeckCss(n: number): string {
  if (!n) return '';
  let out = '\n.deck-body > .screen { display: none; }';
  for (let i = 0; i < n; i++) {
    out += `\n#hs-${i}:checked ~ .deck-body > .screen:nth-of-type(${i + 1}) { display: block; }`;
    out += `\n#hs-${i}:checked ~ .deck-tabs label[for="hs-${i}"] { background: var(--accent); color: var(--bg); border-color: transparent; }`;
  }
  return out;
}

const CSS = `
:root {
  --bg: #ffffff; --fg: #1c1c1e; --muted: #6b7280; --line: #e5e7eb;
  --card: #f8f9fb; --accent: #2f6f4f; --add: #1a7f37; --addbg: #e7f7ec;
  --del: #b3261e; --delbg: #fdecea; --skel: #e3e5ea;
}
@media (prefers-color-scheme: dark) {
  /* Тепла темна палітра — та сама, що в редакторі Peregrine: панель має
     виглядати його частиною, а не чужою сторінкою. Акцент clay #d97757. */
  :root {
    --bg: #1b1a17; --fg: #e8e6e1; --muted: #8f8c85; --line: #34322d;
    --card: #232120; --accent: #d97757; --add: #7fb08a; --addbg: #1e2a22;
    --del: #e08b83; --delbg: #2e1f1e; --skel: #2b2926;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.55 -apple-system, "Segoe UI", Roboto, sans-serif; }

/* --- tabs: hidden radios drive everything, no JS --- */
.tabsel { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; }
.top { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px;
       padding: 18px 22px 0; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
h1 { margin: 0; font-size: 18px; letter-spacing: .2px; }
.sub { margin: 2px 0 12px; color: var(--muted); font-size: 12px; }
.tabs { display: flex; gap: 4px; }
.tab { background: none; border: 0; border-bottom: 2px solid transparent; color: var(--muted);
       padding: 8px 12px; font: inherit; cursor: pointer; border-radius: 8px 8px 0 0; }
.tab:hover { color: var(--fg); }
.badge { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 8px;
         background: var(--skel); font-size: 11px; }
.badge.alert { background: var(--accent); color: var(--bg); }

.panel { display: none; }
#ht-structure:checked ~ main #panel-structure,
#ht-mockup:checked    ~ main #panel-mockup,
#ht-spec:checked      ~ main #panel-spec,
#ht-review:checked    ~ main #panel-review { display: block; }
#ht-structure:checked ~ header label[for="ht-structure"],
#ht-mockup:checked    ~ header label[for="ht-mockup"],
#ht-spec:checked      ~ header label[for="ht-spec"],
#ht-review:checked    ~ header label[for="ht-review"] { color: var(--fg); border-bottom-color: var(--accent); }

main { padding: 20px 22px 96px; max-width: 980px; } /* clears the fixed footer, which wraps to two lines when narrow */
.empty { color: var(--muted); }
h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .6px; color: var(--muted); margin: 22px 0 8px; }

/* --- structure tree --- */
ul.tree, ul.tree ul { list-style: none; margin: 0; padding-left: 16px; }
ul.tree > li { border-left: 1px solid var(--line); padding: 4px 0 4px 12px; margin-left: -1px; }
.kind { font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: var(--muted);
        border: 1px solid var(--line); border-radius: 8px; padding: 1px 6px; margin-right: 2px; }
code { background: var(--card); border-radius: 6px; padding: 1px 5px; font-size: 12px; }
.assume { color: var(--del); font-size: 11px; margin-left: 6px; border-bottom: 1px dotted var(--del); cursor: help; }
details.node > summary, .flows details > summary { cursor: pointer; list-style-position: outside; }
details.node > summary::marker, .flows details > summary::marker { color: var(--muted); }
.node-head { padding: 1px 0; }
details.node > p, .flows details > p { margin: 4px 0 2px 4px; color: var(--muted);
        border-left: 2px solid var(--line); padding-left: 8px; }
.flows { margin-top: 22px; }
.flowlist { list-style: none; margin: 0; padding: 0; }
.flow { padding: 4px 0; border-top: 1px solid var(--line); }
.flow b { font-weight: 600; }

.rules ul { margin: 0; padding-left: 18px; }
.scope { color: var(--muted); font-size: 11px; margin-left: 6px; }

/* --- mockup deck (screen switcher, no JS) --- */
.scrsel { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; }
.deck-tabs { display: flex; gap: 6px; flex-wrap: wrap; margin: 12px 0 12px; }
.deck-tab { padding: 4px 12px; border: 1px solid var(--line); border-radius: 9999px;
            font-size: 12px; color: var(--muted); cursor: pointer; }
.deck-tab:hover { color: var(--fg); }
.screen { margin: 0; }
.screen-note { margin-top: 10px; color: var(--muted); font-size: 13px; }
.screen-note p { margin: 4px 0; }
.screen-hint { margin-top: 8px; color: var(--muted); font-size: 12px; }
figcaption { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.frame { max-width: 640px; border: 1px solid var(--line); border-radius: 10px;
         background: var(--card); padding: 10px; }

/* --- layout elements, drawn by type --- */
.el { border: 1px solid var(--line); border-radius: 8px; background: var(--card); padding: 6px; }
.el-cap { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: .4px;
          color: var(--muted); margin-bottom: 4px; }
.el-in { display: flex; gap: 6px; }
.dir-col > .el-in { flex-direction: column; }
.dir-row > .el-in { flex-direction: row; align-items: stretch; }
.dir-row > .el-in > .el { flex: 1 1 0; }
.dir-row > .el-in > .el-chart { flex: 2 1 0; }
.dir-row > .el-in > .el-sidebar { flex: 0 0 34%; }
.dir-row > .el-in > .el-button, .dir-row > .el-in > .el-badge,
.dir-row > .el-in > .el-dropdown { flex: 0 0 auto; }
.el-main, .el-section, .el-box { background: transparent; }
.el-sidebar { background: var(--card); }
.el-stat { background: var(--skel); }
.el-num { display: block; height: 24px; border-radius: 6px; background: var(--line); }
.el-chart { min-width: 0; }
.el-plot { display: block; height: 76px; border-radius: 6px; background-color: var(--skel);
  background-image:
    linear-gradient(115deg, transparent 58%, var(--accent) 58%, var(--accent) 60%, transparent 60%),
    repeating-linear-gradient(0deg,  var(--line) 0 1px, transparent 1px 19px),
    repeating-linear-gradient(90deg, var(--line) 0 1px, transparent 1px 24px); }
.el-rows { display: flex; flex-direction: column; gap: 5px; }
.bar { display: block; height: 8px; border-radius: 4px; background: var(--line); }
.el-chips { display: flex; gap: 5px; flex-wrap: wrap; }
.chip { display: inline-block; height: 16px; min-width: 28px; border-radius: 6px;
        background: var(--skel); border: 1px solid var(--line); }
.el-button { display: inline-flex; align-items: center; background: var(--accent);
             border-color: transparent; border-radius: 9999px; padding: 4px 12px; }
.el-button > span { color: #fff; font-size: 11px; }
.el-dropdown { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.el-dropdown .caret { color: var(--muted); }
.el-badge { display: inline-block; padding: 1px 9px; border-radius: 9999px; background: var(--skel);
            border: 1px solid var(--line); font-size: 10px; color: var(--muted); }

/* --- spec / review --- */
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
        border-top: 1px solid var(--line); background: var(--bg); color: var(--muted); font-size: 12px;
        display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
.foot-main { flex: 1 1 320px; min-width: 0; }
.foot-eg { display: flex; gap: 6px; flex-wrap: wrap; }
.foot-eg code { white-space: nowrap; }
`;

/**
 * Applied only when a token set is present. The layout tree is unchanged — the same
 * skeleton, painted in the project's tokens, so what you approve is what gets built.
 */
const THEMED_CSS = `
.themed .frame { background: var(--t-bg); border-color: var(--t-border);
                 border-radius: var(--t-radius-card); box-shadow: var(--t-shadow-card);
                 font-family: var(--t-font-body); padding: var(--t-space-md); }
.themed .el { background: var(--t-surface); color: var(--t-text); border-color: var(--t-border);
              border-radius: var(--t-radius-card); }
.themed .el-main, .themed .el-section, .themed .el-box { background: transparent; }
.themed .el-cap { color: var(--t-muted); font-family: var(--t-font-heading); }
.themed .el-stat { background: var(--t-bg); }
.themed .el-num, .themed .bar { background: var(--t-border); }
.themed .el-plot { background-color: var(--t-bg); }
.themed .chip, .themed .el-badge { background: var(--t-bg); border-color: var(--t-border); }
.themed .el-button { background: var(--t-accent); border-radius: var(--t-radius-pill); }
.themed .el-button > span { color: var(--t-accent-text); }
.themed .deck-tab { border-radius: var(--t-radius-pill); }
.themed figcaption { font-family: var(--t-font-heading); font-size: var(--t-size-label); }
`;
