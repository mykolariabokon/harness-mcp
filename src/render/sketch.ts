import { esc } from './html.js';
import { tokensToCss, type DesignTokens } from '../design/tokens.js';
import type { LayoutNode } from '../types.js';

/**
 * The sketch editor: place blocks, nest them, say which sit side by side and how
 * wide. It emits the same `LayoutNode` tree that a sentence in the chat produces,
 * so the diff, the review and the approval are identical — a mouse is a different
 * way to say the thing, not a way around the gate.
 *
 * What it deliberately cannot do is draw. No canvas, no free coordinates, no
 * colours, no fonts. `span` is in twelfths and `dir` is row or column; there is no
 * way to express "340 pixels" because a skeleton that could would stop describing
 * intent and start competing with the implementation.
 *
 * This page requires JavaScript, which the read-only panel still refuses to. The
 * design rule now draws that line explicitly: looking works everywhere, editing
 * works where scripts run.
 */

/** The blocks that can be placed, grouped so the palette reads as a vocabulary. */
const PALETTE: Array<{ group: string; items: Array<{ el: string; label: string }> }> = [
  {
    group: 'Regions',
    items: [
      { el: 'header', label: 'Header' },
      { el: 'sidebar', label: 'Sidebar' },
      { el: 'main', label: 'Main' },
      { el: 'footer', label: 'Footer' },
      { el: 'controls', label: 'Controls' },
    ],
  },
  {
    group: 'Content',
    items: [
      { el: 'list', label: 'List' },
      { el: 'table', label: 'Table' },
      { el: 'chart', label: 'Chart' },
      { el: 'stat', label: 'Stat' },
      { el: 'form', label: 'Form' },
    ],
  },
  {
    group: 'Controls',
    items: [
      { el: 'button', label: 'Button' },
      { el: 'dropdown', label: 'Select' },
      { el: 'tabs', label: 'Tabs' },
      { el: 'badge', label: 'Badge' },
    ],
  },
];

export interface SketchOptions {
  projectName: string;
  /** `type/key` of the entry being sketched. */
  ref: string;
  title: string;
  layout: LayoutNode | null;
  tokens: DesignTokens | null;
}

export function renderSketchHtml(o: SketchOptions): string {
  const seed = o.layout ?? { el: 'main', dir: 'col', children: [] };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sketch — ${esc(o.title)}</title>
<style>${SKETCH_CSS}${o.tokens ? `\n${tokensToCss(o.tokens)}\n${THEMED}` : ''}</style>
</head>
<body${o.tokens ? ' class="themed"' : ''}>
<header class="top">
  <div>
    <h1>${esc(o.title)}</h1>
    <p class="sub">${esc(o.projectName)} · <code>${esc(o.ref)}</code> · structure only, no pixels</p>
  </div>
  <div class="acts">
    <button id="undo" type="button">Undo</button>
    <button id="save" type="button" class="primary">Propose this layout</button>
  </div>
</header>

<main>
  <aside class="palette">
    ${PALETTE.map(
      (g) => `<div class="pgroup"><h3>${esc(g.group)}</h3>${g.items
        .map((i) => `<button class="pitem" type="button" data-el="${esc(i.el)}">${esc(i.label)}</button>`)
        .join('')}</div>`,
    ).join('')}
    <p class="hint">Click a block to add it inside the selected one. Drag to move it
    somewhere else. Select a block to rename it, set its width, or switch a container
    between a row and a column.</p>
  </aside>

  <section class="canvas">
    <div id="tree"></div>
  </section>

  <aside class="inspect" id="inspect">
    <p class="hint">Nothing selected.</p>
  </aside>
</main>

<footer class="foot">
  <span id="status">Saving proposes a change — the harness only takes it once you approve the diff.</span>
</footer>

<script>
const REF = ${JSON.stringify(o.ref)};
const CONTAINERS = new Set(['main','header','footer','sidebar','controls','section','form','list','tabs','box']);
let model = ${JSON.stringify(seed)};
let selected = null;
const past = [];

const clone = (v) => JSON.parse(JSON.stringify(v));
const snapshot = () => { past.push(clone(model)); if (past.length > 50) past.shift(); };

/** Address a node by its path of child indices — stable across re-renders. */
function at(path) {
  let n = model;
  for (const i of path) n = n.children[i];
  return n;
}
function parentOf(path) {
  return path.length ? at(path.slice(0, -1)) : null;
}

function render() {
  const tree = document.getElementById('tree');
  tree.innerHTML = '';
  tree.appendChild(node(model, []));
  inspector();
}

function node(n, path) {
  const wrap = document.createElement('div');
  const key = path.join('.');
  wrap.className = 'blk' + (CONTAINERS.has(n.el) ? ' cont' : '') + (key === (selected || []).join('.') && selected ? ' sel' : '');
  wrap.dataset.path = key;
  wrap.draggable = path.length > 0;
  if (typeof n.span === 'number' && n.span > 0 && n.span < 12) wrap.style.flex = '0 0 ' + ((n.span / 12) * 100).toFixed(3) + '%';

  const head = document.createElement('div');
  head.className = 'blk-head';
  head.textContent = (n.label || n.el) + (n.el !== (n.label || n.el) ? '  ·  ' + n.el : '');
  wrap.appendChild(head);

  if (CONTAINERS.has(n.el)) {
    const kids = document.createElement('div');
    kids.className = 'kids ' + ((n.dir || (n.el === 'header' || n.el === 'footer' || n.el === 'controls' ? 'row' : 'col')) === 'row' ? 'row' : 'col');
    (n.children || []).forEach((c, i) => kids.appendChild(node(c, path.concat(i))));
    if (!(n.children || []).length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'empty — add a block from the left';
      kids.appendChild(empty);
    }
    wrap.appendChild(kids);
  }

  wrap.addEventListener('click', (e) => { e.stopPropagation(); selected = path; render(); });
  wrap.addEventListener('dragstart', (e) => { e.stopPropagation(); e.dataTransfer.setData('text/plain', key); });
  wrap.addEventListener('dragover', (e) => { if (CONTAINERS.has(n.el)) { e.preventDefault(); e.stopPropagation(); } });
  wrap.addEventListener('drop', (e) => {
    if (!CONTAINERS.has(n.el)) return;
    e.preventDefault(); e.stopPropagation();
    const from = e.dataTransfer.getData('text/plain');
    if (!from) return;
    move(from.split('.').filter(s => s !== '').map(Number), path);
  });
  return wrap;
}

function move(fromPath, toPath) {
  if (!fromPath.length) return;
  // Refuse to drop a block inside itself: it would vanish from the tree.
  if (toPath.length >= fromPath.length && fromPath.every((v, i) => toPath[i] === v)) {
    say('A block cannot be moved inside itself.');
    return;
  }
  snapshot();
  const src = parentOf(fromPath);
  const [cut] = src.children.splice(fromPath[fromPath.length - 1], 1);
  const dst = at(toPath);
  (dst.children ||= []).push(cut);
  selected = null;
  render();
  say('Moved.');
}

function add(el) {
  const target = selected ? at(selected) : model;
  const host = CONTAINERS.has(target.el) ? target : (parentOf(selected) || model);
  snapshot();
  (host.children ||= []).push(CONTAINERS.has(el) ? { el, dir: 'col', children: [] } : { el });
  render();
  say('Added ' + el + '.');
}

function inspector() {
  const box = document.getElementById('inspect');
  if (!selected) { box.innerHTML = '<p class="hint">Nothing selected.</p>'; return; }
  const n = at(selected);
  const isCont = CONTAINERS.has(n.el);
  box.innerHTML =
    '<h3>' + n.el + '</h3>' +
    '<label>Label<input id="f-label" value="' + (n.label || '').replace(/"/g, '&quot;') + '" placeholder="what this block is"></label>' +
    (isCont ? '<label>Arrangement<select id="f-dir"><option value="col">stacked</option><option value="row">side by side</option></select></label>' : '') +
    '<label>Width <span class="muted" id="f-span-out">' + (n.span ? n.span + '/12' : 'auto') + '</span>' +
    '<input id="f-span" type="range" min="0" max="12" step="1" value="' + (n.span || 0) + '"></label>' +
    (selected.length ? '<button id="f-del" type="button" class="danger">Remove</button>' : '');

  const label = document.getElementById('f-label');
  label.addEventListener('change', () => { snapshot(); n.label = label.value.trim() || undefined; render(); });
  const dir = document.getElementById('f-dir');
  if (dir) {
    dir.value = n.dir || (n.el === 'header' || n.el === 'footer' || n.el === 'controls' ? 'row' : 'col');
    dir.addEventListener('change', () => { snapshot(); n.dir = dir.value; render(); });
  }
  const span = document.getElementById('f-span');
  span.addEventListener('input', () => { document.getElementById('f-span-out').textContent = span.value === '0' ? 'auto' : span.value + '/12'; });
  span.addEventListener('change', () => { snapshot(); n.span = Number(span.value) || undefined; render(); });
  const del = document.getElementById('f-del');
  if (del) del.addEventListener('click', () => {
    snapshot();
    parentOf(selected).children.splice(selected[selected.length - 1], 1);
    selected = null; render(); say('Removed.');
  });
}

const say = (m) => { document.getElementById('status').textContent = m; };

document.querySelectorAll('.pitem').forEach((b) => b.addEventListener('click', () => add(b.dataset.el)));
document.getElementById('undo').addEventListener('click', () => {
  if (!past.length) return say('Nothing to undo.');
  model = past.pop(); selected = null; render(); say('Undone.');
});
document.getElementById('save').addEventListener('click', async () => {
  say('Proposing…');
  try {
    const res = await fetch('/sketch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: REF, layout: prune(model) }),
    });
    const out = await res.json();
    say(out.message);
  } catch (err) {
    say('Could not reach the harness: ' + err.message);
  }
});

/** Drop empty children arrays and undefined fields — the diff should be readable. */
function prune(n) {
  const out = { el: n.el };
  if (n.label) out.label = n.label;
  if (n.dir) out.dir = n.dir;
  if (typeof n.span === 'number' && n.span > 0 && n.span < 12) out.span = n.span;
  const kids = (n.children || []).map(prune);
  if (kids.length) out.children = kids;
  return out;
}

render();
</script>
</body>
</html>`;
}

const SKETCH_CSS = `
:root { --bg:#fff; --fg:#1c1c1e; --muted:#6b7280; --line:#e5e7eb; --card:#f8f9fb;
        --accent:#2f6f4f; --skel:#e3e5ea; --danger:#b3261e; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#1b1a17; --fg:#e8e6e1; --muted:#8f8c85; --line:#34322d; --card:#232120;
          --accent:#d97757; --skel:#2b2926; --danger:#e08b83; }
}
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif; }
.top { display:flex; justify-content:space-between; align-items:flex-end; gap:16px;
       padding:14px 18px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
h1 { margin:0; font-size:16px; }
.sub { margin:2px 0 0; color:var(--muted); font-size:12px; }
code { background:var(--card); border-radius:5px; padding:1px 5px; font-size:12px; }
button { font:inherit; background:none; border:1px solid var(--line); color:var(--fg);
         border-radius:7px; padding:5px 11px; cursor:pointer; }
button:hover { border-color:var(--muted); }
button.primary { background:var(--accent); color:#fff; border-color:transparent; }
button.danger { color:var(--danger); border-color:var(--danger); width:100%; margin-top:10px; }
.acts { display:flex; gap:8px; }
main { display:flex; gap:0; align-items:stretch; min-height:calc(100vh - 108px); }
.palette, .inspect { width:190px; flex:0 0 190px; padding:14px; border-right:1px solid var(--line); }
.inspect { border-right:0; border-left:1px solid var(--line); }
.canvas { flex:1; padding:18px; overflow:auto; }
h3 { font-size:11px; text-transform:uppercase; letter-spacing:.6px; color:var(--muted); margin:14px 0 6px; }
.pgroup:first-child h3 { margin-top:0; }
.pitem { display:block; width:100%; text-align:left; margin-bottom:4px; font-size:13px; }
.hint { color:var(--muted); font-size:12px; line-height:1.5; margin-top:16px; }
label { display:block; font-size:12px; color:var(--muted); margin-bottom:10px; }
input, select { width:100%; font:inherit; margin-top:3px; padding:4px 6px; background:var(--bg);
                color:var(--fg); border:1px solid var(--line); border-radius:6px; }
input[type=range] { padding:0; }
.muted { color:var(--muted); }

#tree { max-width:760px; }
.blk { border:1px solid var(--line); border-radius:8px; background:var(--card); padding:6px; cursor:pointer; }
.blk.cont { background:transparent; }
.blk.sel { border-color:var(--accent); box-shadow:0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent); }
.blk-head { font-size:10px; text-transform:uppercase; letter-spacing:.4px; color:var(--muted); margin-bottom:4px; }
.kids { display:flex; gap:6px; }
.kids.col { flex-direction:column; }
.kids.row { flex-direction:row; align-items:stretch; }
.kids.row > .blk { flex:1 1 0; }
.empty { color:var(--muted); font-size:11px; padding:8px; border:1px dashed var(--line);
         border-radius:6px; text-align:center; flex:1; }
.foot { position:sticky; bottom:0; padding:8px 18px; border-top:1px solid var(--line);
        background:var(--bg); color:var(--muted); font-size:12px; }
`;

const THEMED = `
.themed .blk { border-color:var(--t-border); border-radius:var(--t-radius-card); background:var(--t-surface); }
.themed .blk.cont { background:transparent; }
.themed button.primary { background:var(--t-accent); border-radius:var(--t-radius-pill); }
`;
