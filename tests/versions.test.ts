import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callTool } from '../src/tools.js';
import { HarnessService } from '../src/HarnessService.js';

/**
 * The history of a single entry — for a screen, its design across versions.
 *
 * Nothing is stored for this. Every approved change already keeps its before and
 * after, and the approval keeps who and when; a second store of "design versions"
 * would be a second truth free to disagree with the first.
 *
 * Which makes one thing load-bearing: those records must survive. A rollback used
 * to delete them, leaving approvals that pointed at nothing — a history claiming a
 * decision was made about a change that no longer existed.
 */

let project: string;

const layout = (label: string) => ({ el: 'main', children: [{ el: 'sidebar', label }] });

async function assemble(): Promise<void> {
  const started = (await callTool('harness_reverse', { project_path: project })) as any;
  await callTool('harness_submit_generation', {
    project_path: project, request_id: started.request_id,
    result: {
      constitution: [{ key: 'stack', title: 'Stack', body: 'TypeScript.' }],
      structure: [
        { key: 'pkg', title: 'Package', kind: 'module', parent: null, path: '.' },
        { key: 'dash', title: 'Dashboard', kind: 'screen', parent: 'pkg', layout: layout('Filters') },
      ],
      requirements: [{ key: 'REQ-001', title: 'R', ears: 'When x, the system shall y.' }],
      steps: [{ key: 'S1', title: 'Build', phase: 1, verify: 'npm test' }],
    },
  });
}

/** Propose a new layout for the screen and approve it — one design iteration. */
async function iterate(label: string, rationale: string, note: string): Promise<number> {
  const proposed = (await callTool('harness_propose_change', {
    project_path: project, target: 'entry', op: 'update', entry_type: 'structure',
    key: 'dash', data: { layout: layout(label) }, rationale,
  })) as any;
  await callTool('harness_approve', {
    project_path: project, change_id: proposed.change.id, actor: 'human', note,
  });
  return proposed.change.id;
}

beforeEach(async () => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ver-'));
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"demo"}');
  await callTool('harness_hello', { editor: 'test', agent_model: true, webview: false, project_path: project });
  await assemble();
});

afterEach(() => {
  HarnessService.closeAll();
  fs.rmSync(project, { recursive: true, force: true });
});

describe('the design of a screen, across versions', () => {
  it('reads forward, numbered, with the layout at each step', async () => {
    await iterate('Filters on the left', 'Filters are used on every visit.', 'Agreed.');
    await iterate('Filters collapsed', 'They crowd the chart on a laptop.', 'Better.');

    const hist = (await callTool('harness_versions', { project_path: project, ref: 'structure/dash' })) as any;

    expect(hist.versions.map((v: any) => v.version)).toEqual(['0.1', '0.2']);
    expect(hist.versions[0].layout.children[0].label).toBe('Filters on the left');
    expect(hist.versions[1].layout.children[0].label).toBe('Filters collapsed');
    expect(hist.current).toBe(true);
  });

  it('carries why each step was proposed and why it was accepted', async () => {
    await iterate('Filters on the left', 'Filters are used on every visit.', 'Agreed.');
    const hist = (await callTool('harness_versions', { project_path: project, ref: 'structure/dash' })) as any;

    // A version without its reasoning is a snapshot; with it, it is a decision.
    const [v] = hist.versions;
    expect(v.rationale).toBe('Filters are used on every visit.');
    expect(v.note).toBe('Agreed.');
    expect(v.actor).toBe('human');
    expect(v.diff).toContain('Filters on the left');
    expect(v.change_id).toBeGreaterThan(0);
  });

  it('says plainly when an entry simply never changed', async () => {
    const hist = (await callTool('harness_versions', { project_path: project, ref: 'structure/pkg' })) as any;

    // Assembled-and-never-touched is not the same as never existing, and the
    // person asking deserves to be told which.
    expect(hist.versions).toEqual([]);
    expect(hist.note).toMatch(/arrived with the initial assembly/);
  });

  it('lists what has a history when asked for no ref in particular', async () => {
    await iterate('A', 'r', 'n');
    await iterate('B', 'r', 'n');
    const index = (await callTool('harness_versions', { project_path: project })) as any;

    expect(index.status).toBe('index');
    expect(index.entries).toContainEqual({ ref: 'structure/dash', versions: 2 });
  });

  it('does not invent a history for a rejected proposal', async () => {
    const proposed = (await callTool('harness_propose_change', {
      project_path: project, target: 'entry', op: 'update', entry_type: 'structure',
      key: 'dash', data: { layout: layout('Never approved') }, rationale: 'Try this.',
    })) as any;
    await callTool('harness_reject', { project_path: project, change_id: proposed.change.id, actor: 'human' });

    const hist = (await callTool('harness_versions', { project_path: project, ref: 'structure/dash' })) as any;
    expect(hist.versions).toEqual([]);
  });
});

describe('a rollback does not erase what was decided', () => {
  it('keeps the record of approved changes after restoring a checkpoint', async () => {
    await iterate('Filters on the left', 'First idea.', 'Agreed.');
    const cp = (await callTool('harness_checkpoint', { project_path: project, action: 'create', label: 'before second' })) as any;
    await iterate('Filters collapsed', 'Second idea.', 'Also fine.');

    await callTool('harness_checkpoint', { project_path: project, action: 'restore', checkpoint_id: cp.id });

    const hist = (await callTool('harness_versions', { project_path: project, ref: 'structure/dash' })) as any;
    // Rolling the state back does not un-happen the decision. Deleting the record
    // used to leave the approval pointing at a change that no longer existed.
    expect(hist.versions).toHaveLength(2);
    expect(hist.versions[1].rationale).toBe('Second idea.');

    // And the decision record can still name what each decision was about.
    const record = (await callTool('harness_history', { project_path: project, include: 'approvals' })) as any;
    expect(record.approvals.every((a: any) => a.ref !== null)).toBe(true);
  });

  it('still drops proposals that were never decided', async () => {
    const cp = (await callTool('harness_checkpoint', { project_path: project, action: 'create', label: 'clean' })) as any;
    await callTool('harness_propose_change', {
      project_path: project, target: 'entry', op: 'update', entry_type: 'structure',
      key: 'dash', title: 'Renamed', rationale: 'Pending when the rollback happens.',
    });

    await callTool('harness_checkpoint', { project_path: project, action: 'restore', checkpoint_id: cp.id });

    // A proposal written against a state that no longer exists must not be left
    // sitting in the queue: approving it later would apply something nobody
    // reviewed against the state it would land in.
    const queue = (await callTool('harness_list_pending', { project_path: project })) as any;
    expect(queue.badge).toBe(0);
  });
});
