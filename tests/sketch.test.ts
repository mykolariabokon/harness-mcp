import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callTool } from '../src/tools.js';
import { HarnessService } from '../src/HarnessService.js';
import { renderServer } from '../src/render/server.js';
import { renderSketchHtml } from '../src/render/sketch.js';

/**
 * The block editor.
 *
 * What it is for: saying where the blocks go and which blocks they are. Not what
 * they look like — there is no way to express a colour, a font or a pixel, and
 * that is the point. `dir` is row or column, `span` is in twelfths, and a skeleton
 * that could say "340px" would stop describing intent and start competing with
 * the implementation.
 *
 * What is being defended: the mouse gets no privileges. A saved sketch takes the
 * same road as a sentence in the chat — proposal, diff, human decision.
 */

let project: string;

async function assemble(): Promise<void> {
  const started = (await callTool('harness_reverse', { project_path: project })) as any;
  await callTool('harness_submit_generation', {
    project_path: project, request_id: started.request_id,
    result: {
      constitution: [{ key: 'stack', title: 'Stack', body: 'TypeScript.' }],
      structure: [
        { key: 'pkg', title: 'Package', kind: 'module', parent: null, path: '.' },
        { key: 'dash', title: 'Dashboard', kind: 'screen', parent: 'pkg', layout: { el: 'main', children: [{ el: 'chart', label: 'Traffic' }] } },
      ],
      requirements: [{ key: 'REQ-001', title: 'R', ears: 'When x, the system shall y.' }],
      steps: [{ key: 'S1', title: 'Build', phase: 1, verify: 'npm test' }],
    },
  });
}

/** Post a layout the way the page does. */
const save = async (url: string, body: unknown): Promise<any> => {
  const res = await fetch(`${url}sketch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

beforeEach(async () => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-sketch-'));
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"demo"}');
  await callTool('harness_hello', { editor: 'test', agent_model: true, webview: false, project_path: project });
  await assemble();
});

afterEach(() => {
  renderServer.setSketchHandler(null);
  renderServer.stop();
  HarnessService.closeAll();
  fs.rmSync(project, { recursive: true, force: true });
});

describe('a saved sketch is a proposal, not a change', () => {
  it('queues a diff and leaves the harness alone', async () => {
    const open = (await callTool('harness_sketch', { project_path: project, ref: 'structure/dash', open_browser: false })) as any;
    expect(open.status).toBe('open');

    const sent = await save(open.url, {
      ref: 'structure/dash',
      layout: { el: 'main', dir: 'row', children: [{ el: 'sidebar', span: 4 }, { el: 'chart', span: 8, label: 'Traffic' }] },
    });
    expect(sent.body.ok).toBe(true);
    expect(sent.body.message).toMatch(/Nothing has changed yet/);

    // The layout on disk is still the old one until somebody approves.
    const spec = (await callTool('harness_get_spec', { project_path: project, type: 'structure' })) as any;
    expect(spec.entries.find((e: any) => e.key === 'dash').data.layout.dir).toBeUndefined();

    const queue = (await callTool('harness_list_pending', { project_path: project })) as any;
    expect(queue.badge).toBe(1);
    expect(queue.changes[0].source).toBe('sketch');
    expect(queue.changes[0].diff).toContain('sidebar');
  });

  it('becomes the layout once approved, like any other change', async () => {
    const open = (await callTool('harness_sketch', { project_path: project, ref: 'structure/dash', open_browser: false })) as any;
    await save(open.url, {
      ref: 'structure/dash',
      layout: { el: 'main', dir: 'row', children: [{ el: 'sidebar', span: 4 }] },
    });
    const queue = (await callTool('harness_list_pending', { project_path: project })) as any;
    await callTool('harness_approve', { project_path: project, change_id: queue.changes[0].id, actor: 'human' });

    const spec = (await callTool('harness_get_spec', { project_path: project, type: 'structure' })) as any;
    const layout = spec.entries.find((e: any) => e.key === 'dash').data.layout;
    expect(layout.dir).toBe('row');
    expect(layout.children[0].span).toBe(4);
  });

  it('shows up in the version history like any other iteration', async () => {
    const open = (await callTool('harness_sketch', { project_path: project, ref: 'structure/dash', open_browser: false })) as any;
    await save(open.url, { ref: 'structure/dash', layout: { el: 'main', dir: 'row', children: [] } });
    const queue = (await callTool('harness_list_pending', { project_path: project })) as any;
    await callTool('harness_approve', { project_path: project, change_id: queue.changes[0].id, actor: 'human', note: 'Yes.' });

    const hist = (await callTool('harness_versions', { project_path: project, ref: 'structure/dash' })) as any;
    expect(hist.versions).toHaveLength(1);
    expect(hist.versions[0].rationale).toMatch(/Sketched in the block editor/);
    expect(hist.versions[0].layout.dir).toBe('row');
  });
});

describe('the save endpoint refuses what it should', () => {
  it('rejects a sketch aimed at a different entry', async () => {
    const open = (await callTool('harness_sketch', { project_path: project, ref: 'structure/dash', open_browser: false })) as any;
    const sent = await save(open.url, { ref: 'structure/pkg', layout: { el: 'main' } });

    expect(sent.body.ok).toBe(false);
    expect(sent.body.message).toMatch(/is for structure\/dash/);
    expect(((await callTool('harness_list_pending', { project_path: project })) as any).badge).toBe(0);
  });

  it('rejects something that is not a layout tree', async () => {
    const open = (await callTool('harness_sketch', { project_path: project, ref: 'structure/dash', open_browser: false })) as any;
    for (const junk of [null, 'a string', { nope: true }]) {
      const sent = await save(open.url, { ref: 'structure/dash', layout: junk });
      expect(sent.body.ok, `accepted ${JSON.stringify(junk)}`).toBe(false);
    }
  });

  it('refuses a save when no sketch is open', async () => {
    const open = (await callTool('harness_sketch', { project_path: project, ref: 'structure/dash', open_browser: false })) as any;
    renderServer.setSketchHandler(null);

    const sent = await save(open.url, { ref: 'structure/dash', layout: { el: 'main' } });
    expect(sent.status).toBe(409);
    expect(sent.body.message).toMatch(/No sketch is open/);
  });

  it('will not open for an entry that does not exist', async () => {
    await expect(
      callTool('harness_sketch', { project_path: project, ref: 'structure/nowhere' }),
    ).rejects.toThrow(/No entry/);
  });
});

describe('the vocabulary is structure, not design', () => {
  const page = () =>
    renderSketchHtml({ projectName: 'Demo', ref: 'structure/dash', title: 'Dashboard', layout: null, tokens: null });

  it('offers no way to express a colour, a font or a pixel', () => {
    const html = page().toLowerCase();
    for (const forbidden of ['color picker', 'font-family"', 'background-color:', 'px"', 'font size', 'opacity']) {
      expect(html, `the editor exposes ${forbidden}`).not.toContain(forbidden);
    }
    // What it does offer: arrangement and share of the row.
    expect(html).toContain('side by side');
    expect(html).toContain('stacked');
    expect(html).toContain('/12');
  });

  it('is honest that it needs a script, unlike the read-only panel', () => {
    // The design rule draws that line: looking works everywhere, editing works
    // where scripts run. The panel must stay scriptless; this page need not.
    expect(page()).toContain('<script>');
  });
});

describe('span and direction render as proportion, never as measurement', () => {
  it('turns twelfths into a share of the row', async () => {
    const open = (await callTool('harness_sketch', { project_path: project, ref: 'structure/dash', open_browser: false })) as any;
    await save(open.url, {
      ref: 'structure/dash',
      layout: { el: 'main', dir: 'row', children: [{ el: 'sidebar', span: 4 }, { el: 'chart', span: 8 }] },
    });
    const queue = (await callTool('harness_list_pending', { project_path: project })) as any;
    await callTool('harness_approve', { project_path: project, change_id: queue.changes[0].id, actor: 'human' });

    const html = ((await callTool('harness_render', { project_path: project, output: 'webview' })) as any).html;
    // A third and two thirds — as percentages of whatever the row happens to be.
    expect(html).toContain('flex:0 0 33.3333%');
    expect(html).toContain('flex:0 0 66.6667%');
    expect(html).not.toMatch(/flex:0 0 \d+px/);
  });

  it('lets an explicit direction override what the renderer would have guessed', async () => {
    // `main` is inferred as a column. Saying otherwise has to win, or the model
    // cannot express a layout the inference did not anticipate.
    const open = (await callTool('harness_sketch', { project_path: project, ref: 'structure/dash', open_browser: false })) as any;
    await save(open.url, { ref: 'structure/dash', layout: { el: 'main', dir: 'row', children: [{ el: 'list' }] } });
    const queue = (await callTool('harness_list_pending', { project_path: project })) as any;
    await callTool('harness_approve', { project_path: project, change_id: queue.changes[0].id, actor: 'human' });

    const html = ((await callTool('harness_render', { project_path: project, output: 'webview' })) as any).html;
    expect(html).toMatch(/el el-main dir-row/);
  });
});
