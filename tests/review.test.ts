import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callTool, setClientCapabilitiesProbe, setElicitor, type ElicitAnswer, type ElicitForm } from '../src/tools.js';
import { HarnessService } from '../src/HarnessService.js';

/**
 * Reviewing through the client's own interface (REQ-014 / STEP-06).
 *
 * The thing under test is not the plumbing but the discipline: a different way of
 * ASKING must not become a different answerer. Declining a question is not
 * rejecting a change, an unrecognised answer decides nothing, and both branches
 * end in the same apply.
 */

let project: string;
let asked: ElicitForm[];

/** Stands in for the client. Answers each question from a script. */
function clientAnswers(...answers: ElicitAnswer[]): void {
  setClientCapabilitiesProbe(() => ({ elicitation: {} }));
  let i = 0;
  setElicitor(async (form) => {
    asked.push(form);
    return answers[Math.min(i++, answers.length - 1)];
  });
}

/** A client that never declared elicitation — the fallback path. */
function clientCannotBeAsked(): void {
  setClientCapabilitiesProbe(() => ({ roots: {} }));
  setElicitor(null);
}

const accept = (decision: string, note?: string): ElicitAnswer => ({
  action: 'accept',
  content: note ? { decision, note } : { decision },
});

async function propose(key: string, title: string): Promise<number> {
  const res = (await callTool('harness_propose_change', {
    project_path: project, target: 'entry', op: 'update', entry_type: 'structure',
    key, title, rationale: `Renaming ${key}.`,
  })) as any;
  return res.change.id;
}

const titleOf = async (key: string): Promise<string> => {
  const spec = (await callTool('harness_get_spec', { project_path: project, type: 'structure' })) as any;
  return spec.entries.find((e: any) => e.key === key)?.title;
};

beforeEach(async () => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-review-'));
  asked = [];
  await callTool('harness_hello', { editor: 'test', agent_model: true, webview: false, project_path: project });
  const started = (await callTool('harness_reverse', { project_path: project })) as any;
  await callTool('harness_submit_generation', {
    project_path: project, request_id: started.request_id,
    result: {
      constitution: [{ key: 'stack', title: 'Stack', body: 'TypeScript.' }],
      structure: [
        { key: 'pkg', title: 'Package', kind: 'module', parent: null, path: '.' },
        { key: 'ui', title: 'UI', kind: 'module', parent: 'pkg', path: 'src' },
        { key: 'api', title: 'API', kind: 'module', parent: 'pkg', path: 'src' },
      ],
      requirements: [{ key: 'REQ-001', title: 'R', ears: 'When x, the system shall y.' }],
      steps: [{ key: 'S1', title: 'Build', phase: 1, verify: 'npm test' }],
    },
  });
});

afterEach(() => {
  setElicitor(null);
  setClientCapabilitiesProbe(() => undefined);
  HarnessService.closeAll();
  fs.rmSync(project, { recursive: true, force: true });
});

describe('asking through the client', () => {
  it('applies an approval in the same call', async () => {
    await propose('ui', 'Interface');
    clientAnswers(accept('approve', 'Agreed.'));

    const res = (await callTool('harness_review', { project_path: project })) as any;

    expect(res.status).toBe('reviewed');
    expect(res.decided).toEqual([{ id: 1, ref: 'structure/ui', decision: 'approve' }]);
    expect(res.pending_total).toBe(0);
    expect(await titleOf('ui')).toBe('Interface');
  });

  it('applies a rejection without touching the harness', async () => {
    await propose('ui', 'Interface');
    clientAnswers(accept('reject', 'Not yet.'));

    const res = (await callTool('harness_review', { project_path: project })) as any;

    expect(res.decided[0].decision).toBe('reject');
    expect(res.pending_total).toBe(0);
    expect(await titleOf('ui')).toBe('UI');
  });

  it('puts the diff and the reason in front of the human', async () => {
    await propose('ui', 'Interface');
    clientAnswers(accept('approve'));
    await callTool('harness_review', { project_path: project });

    const [form] = asked;
    expect(form.message).toContain('structure/ui');
    expect(form.message).toContain('Renaming ui.');
    expect(form.message).toContain('- title: UI');
    expect(form.message).toContain('+ title: Interface');
    // A decision without options is not a decision.
    expect(form.requestedSchema.properties.decision.enum).toEqual(['approve', 'reject']);
    expect(form.requestedSchema.required).toContain('decision');
  });

  it('walks several changes oldest first', async () => {
    await propose('ui', 'Interface');
    await propose('api', 'Service');
    clientAnswers(accept('approve'), accept('reject'));

    const res = (await callTool('harness_review', { project_path: project })) as any;

    expect(res.decided.map((d: any) => d.ref)).toEqual(['structure/ui', 'structure/api']);
    expect(await titleOf('ui')).toBe('Interface');
    expect(await titleOf('api')).toBe('API');
  });

  it('stops at the limit and says what is left', async () => {
    await propose('ui', 'Interface');
    await propose('api', 'Service');
    clientAnswers(accept('approve'));

    const res = (await callTool('harness_review', { project_path: project, limit: 1 })) as any;

    expect(asked).toHaveLength(1);
    expect(res.pending_total).toBe(1);
    expect(res.note).toMatch(/1 change\(s\) still waiting/);
  });
});

describe('a question not answered decides nothing', () => {
  it('leaves the change pending when the human declines to answer', async () => {
    await propose('ui', 'Interface');
    clientAnswers({ action: 'decline' });

    const res = (await callTool('harness_review', { project_path: project })) as any;

    // Declining the question is not rejecting the change. Treating it as one would
    // apply a decision the human never made.
    expect(res.status).toBe('nothing_decided');
    expect(res.skipped[0].why).toMatch(/declined/);
    expect(res.pending_total).toBe(1);
    expect(await titleOf('ui')).toBe('UI');
  });

  it('stops the walk when the human dismisses it', async () => {
    await propose('ui', 'Interface');
    await propose('api', 'Service');
    clientAnswers({ action: 'cancel' });

    const res = (await callTool('harness_review', { project_path: project })) as any;

    // Dismissed means they walked away: do not keep asking.
    expect(asked).toHaveLength(1);
    expect(res.stopped_early).toBe(true);
    expect(res.pending_total).toBe(2);
  });

  it('decides nothing on an answer it does not recognise', async () => {
    await propose('ui', 'Interface');
    clientAnswers({ action: 'accept', content: { decision: 'maybe' } });

    const res = (await callTool('harness_review', { project_path: project })) as any;

    expect(res.skipped[0].why).toMatch(/unrecognised/);
    expect(res.pending_total).toBe(1);
    expect(await titleOf('ui')).toBe('UI');
  });
});

describe('a client that cannot be asked', () => {
  it('returns the queue and applies nothing', async () => {
    await propose('ui', 'Interface');
    clientCannotBeAsked();

    const res = (await callTool('harness_review', { project_path: project })) as any;

    expect(res.status).toBe('queue_only');
    expect(res.badge).toBe(1);
    expect(res.changes[0].diff).toContain('+ title: Interface');
    expect(res.note).toMatch(/harness_approve/);
    expect(await titleOf('ui')).toBe('UI');
  });

  it('branches on the declared capability, not on the editor name', async () => {
    await propose('ui', 'Interface');
    // Same editor string, opposite capability: the answer must follow the
    // capability. An editor's name is a claim; a declared capability is a contract.
    await callTool('harness_hello', { editor: 'claude-code', agent_model: true, webview: false });
    clientCannotBeAsked();
    expect(((await callTool('harness_review', { project_path: project })) as any).status).toBe('queue_only');

    clientAnswers(accept('approve'));
    expect(((await callTool('harness_review', { project_path: project })) as any).status).toBe('reviewed');
  });
});

describe('nothing to review', () => {
  it('says so instead of asking an empty question', async () => {
    clientAnswers(accept('approve'));
    const res = (await callTool('harness_review', { project_path: project })) as any;

    expect(res.status).toBe('nothing_pending');
    expect(asked).toHaveLength(0);
  });
});

describe('the decision record does not care how it was asked', () => {
  it('records an elicited decision exactly like a called one', async () => {
    await propose('ui', 'Interface');
    clientAnswers(accept('approve', 'Looks right.'));
    await callTool('harness_review', { project_path: project });

    const hist = (await callTool('harness_history', { project_path: project, include: 'approvals' })) as any;
    const entry = hist.approvals[0];
    expect(entry.decision).toBe('approved');
    expect(entry.actor).toBe('human');
    expect(entry.note).toBe('Looks right.');
    expect(entry.ref).toBe('structure/ui');
  });
});
