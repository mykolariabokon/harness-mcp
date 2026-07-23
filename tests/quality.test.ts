import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callTool } from '../src/tools.js';
import { HarnessService } from '../src/HarnessService.js';
import { checkDraft, MAX_ATTEMPTS } from '../src/assembly/quality.js';

/**
 * The failure this guards against: a flat list of sibling nodes applies cleanly,
 * renders without error, and is indistinguishable from a correct tree unless
 * something checks. It used to pass in silence.
 */

let project: string;

beforeEach(async () => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-quality-'));
  await callTool('harness_hello', { editor: 'test', agent_model: true, webview: true });
});

afterEach(() => {
  HarnessService.closeAll();
  fs.rmSync(project, { recursive: true, force: true });
});

const flatDraft = {
  constitution: [{ key: 'stack', title: 'Stack', body: 'TypeScript.' }],
  structure: Array.from({ length: 25 }, (_, i) => ({
    key: `node-${i}`,
    title: `Node ${i}`,
    kind: i < 5 ? 'module' : 'entity',
    parent: null,
    path: `src/node-${i}`,
  })),
  requirements: [{ key: 'REQ-001', title: 'R', ears: 'When x, the system shall y.' }],
  steps: [{ key: 'S1', title: 'Do it', phase: 1, verify: 'npm test' }],
};

const treeDraft = {
  constitution: [{ key: 'stack', title: 'Stack', body: 'TypeScript.' }],
  structure: [
    { key: 'engine', title: 'Engine', kind: 'module', parent: null, path: 'apps/engine' },
    { key: 'api', title: 'API', kind: 'module', parent: 'engine', path: 'apps/engine/api' },
    { key: 'bybit', title: 'Bybit', kind: 'module', parent: 'engine', path: 'apps/engine/bybit' },
    { key: 'strategy', title: 'Strategy', kind: 'module', parent: 'engine', path: 'apps/engine/strategy' },
    { key: 'order', title: 'Order', kind: 'entity', parent: 'strategy' },
    { key: 'ui', title: 'UI', kind: 'module', parent: null, path: 'apps/ui' },
    { key: 'dash', title: 'Dashboard', kind: 'screen', parent: 'ui', layout: { el: 'main', children: [{ el: 'button', label: 'Go' }] } },
  ],
  requirements: [{ key: 'REQ-001', title: 'R', ears: 'When x, the system shall y.' }],
  steps: [{ key: 'S1', title: 'Do it', phase: 1, verify: 'npm test' }],
};

async function startReverse() {
  const res = (await callTool('harness_reverse', { project_path: project })) as any;
  expect(res.status).toBe('needs_agent');
  return res.request_id as number;
}

const submit = (request_id: number, result: unknown) =>
  callTool('harness_submit_generation', { project_path: project, request_id, result }) as Promise<any>;

describe('draft quality gate', () => {
  it('rejects a flat structure and explains why', async () => {
    const res = await submit(await startReverse(), flatDraft);

    expect(res.status).toBe('rework_needed');
    expect(res.rejected_because.join(' ')).toMatch(/flat list: 25 nodes/);
    expect(res.request_id).toBeGreaterThan(0);

    // Nothing was written: a rejected draft must not leave a half-harness behind.
    const status = (await callTool('harness_status', { project_path: project })) as any;
    expect(status.assembled).toBe(false);
  });

  it('accepts a tree and renders it nested', async () => {
    const res = await submit(await startReverse(), treeDraft);
    expect(res.status).toBe('assembled');
    expect(res.problems).toHaveLength(0);

    const html = (await callTool('harness_render', { project_path: project, output: 'webview' })) as any;
    // The children of `engine` sit inside a nested list, not beside it.
    expect(html.html).toMatch(/Engine[\s\S]*?<ul class="tree">[\s\S]*?API/);
    expect(html.html).toContain('Dashboard');
  });

  it('warns about a screen without a layout but still assembles', async () => {
    const draft = {
      ...treeDraft,
      structure: treeDraft.structure.map((n) => (n.key === 'dash' ? { ...n, layout: undefined } : n)),
    };
    const res = await submit(await startReverse(), draft);

    expect(res.status).toBe('assembled');
    expect(res.warnings.join(' ')).toMatch(/no layout skeleton/);
  });

  it('rejects an assumption that carries no question', async () => {
    const draft = {
      ...treeDraft,
      structure: [...treeDraft.structure, { key: 'guess', title: 'Reports', kind: 'module', parent: 'ui', confidence: 'assumption' }],
    };
    const res = await submit(await startReverse(), draft);

    expect(res.status).toBe('rework_needed');
    expect(res.rejected_because.join(' ')).toMatch(/no question/);
  });

  it('rejects a parent that does not exist', () => {
    const report = checkDraft({
      structure: [
        { key: 'a', title: 'A', kind: 'module', parent: null },
        { key: 'b', title: 'B', kind: 'entity', parent: 'nowhere' },
      ],
    } as never);
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toMatch(/parent that does not exist/);
  });

  it('rejects a parent cycle', () => {
    const report = checkDraft({
      structure: [
        { key: 'a', title: 'A', kind: 'module', parent: 'b' },
        { key: 'b', title: 'B', kind: 'module', parent: 'a' },
      ],
    } as never);
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toMatch(/cycle/);
  });

  it('leaves a small flat project alone', () => {
    const report = checkDraft({
      structure: [
        { key: 'a', title: 'A', kind: 'module', parent: null },
        { key: 'b', title: 'B', kind: 'module', parent: null },
      ],
      steps: [{ key: 'S1', title: 'x', phase: 1, verify: 'npm test' }],
    } as never);
    expect(report.ok).toBe(true);
  });

  it('gives up after the attempt limit instead of looping forever', async () => {
    const first = await submit(await startReverse(), flatDraft);
    expect(first.status).toBe('rework_needed');
    expect(first.attempt).toBe(MAX_ATTEMPTS);

    // Same rubbish again: accepted, but on the record — not a third round trip.
    const second = await submit(first.request_id, flatDraft);
    expect(second.status).toBe('assembled_with_problems');
    expect(second.attempts).toBe(MAX_ATTEMPTS);
    expect(second.problems.join(' ')).toMatch(/flat list/);

    // The complaint is written into the harness itself, so nobody approves the
    // structure later believing it passed.
    const constitution = fs.readFileSync(path.join(project, 'harness', 'CONSTITUTION.md'), 'utf8');
    expect(constitution).toContain('accepted with unresolved assembly problems');
    const status = (await callTool('harness_status', { project_path: project })) as any;
    expect(status.assembled).toBe(true);
    expect(status.open_questions.some((q: any) => q.ref === 'decision/assembly-quality')).toBe(true);
  });
});

describe('panel guidance', () => {
  it('tells the human how to criticise it, with examples', async () => {
    await submit(await startReverse(), treeDraft);
    const html = (await callTool('harness_render', { project_path: project, output: 'webview' })) as any;

    expect(html.html).toContain('say it in the chat in plain words');
    expect(html.html).toContain('sidebar on the left');
    expect(html.html).toContain('group these entities under one module');
  });

  it('explains what an empty panel is missing', async () => {
    await submit(await startReverse(), { ...treeDraft, requirements: [], steps: [] });
    const html = (await callTool('harness_render', { project_path: project, output: 'webview' })) as any;

    expect(html.html).toMatch(/No requirements or steps yet/);
    expect(html.html).toMatch(/Nothing waiting for approval\. Everything an agent proposes/);
  });
});
