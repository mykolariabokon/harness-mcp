import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_DEFS } from '../src/tools.js';

/**
 * Every tool, exercised over the REAL MCP protocol — stdio JSON-RPC against the
 * built server, not the internal `callTool`.
 *
 * The harness invariant `inv-protocol-test` demands this, and the reason is
 * concrete: between callTool and a client sits a layer no internal test can see —
 * the `{ content: [{ type: 'text', text }] }` envelope, inputSchema validation,
 * serialisation over a pipe. A test that calls the function checks an assumption
 * about the response shape; this checks what a client actually receives. That
 * exact gap once shipped a silently broken button in the editor.
 *
 * The last test makes the invariant self-enforcing: add a tool without touching
 * this file and the suite fails, rather than the rule quietly decaying into a
 * comment nobody honours.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const entry = path.join(repo, 'build', 'index.js');

/** Tools this suite actually drove over the wire — checked for completeness below. */
const exercised = new Set<string>();

let server: ChildProcessWithoutNullStreams;
let project: string;
let nextId = 1;
const pendingRpc = new Map<number, (msg: RpcResponse) => void>();

interface RpcResponse {
  id?: number;
  result?: { content?: Array<{ type: string; text?: string }>; tools?: Array<{ name: string }>; isError?: boolean };
  error?: { message?: string };
}

function send(method: string, params: unknown): Promise<RpcResponse> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 20_000);
    pendingRpc.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

/** Call a tool the way a client does, and unwrap the envelope the way a client must. */
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  exercised.add(name);
  const res = await send('tools/call', { name, arguments: args });
  const text = res.result?.content?.find((c) => c.type === 'text')?.text;
  expect(text, `${name} returned no text content`).toBeTruthy();
  return JSON.parse(text!);
}

const newestMtime = (dir: string): number => {
  let latest = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    latest = Math.max(latest, e.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs);
  }
  return latest;
};

/**
 * Checked at module scope, deliberately — NOT in beforeAll.
 *
 * A throw from beforeAll makes vitest report this file's tests as *skipped*, and
 * a skip reads as green in the summary line. A guard against false greens that
 * produces one is worse than no guard: observed here, eight silently skipped
 * protocol tests in a run that ended "73 passed". Failing collection is loud.
 */
if (!fs.existsSync(entry)) {
  throw new Error(`${entry} is missing — run \`npm run build\` before the protocol tests.`);
}
if (newestMtime(path.join(repo, 'src')) > newestMtime(path.join(repo, 'build'))) {
  throw new Error('src/ is newer than build/ — run `npm run build`, or these tests check stale code.');
}

beforeAll(async () => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-proto-'));
  server = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] });

  let buf = '';
  server.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as RpcResponse;
      if (msg.id !== undefined) pendingRpc.get(msg.id)?.(msg);
    }
  });

  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'protocol-test', version: '1' },
  });
  expect(init.result).toBeTruthy();
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
}, 60_000);

afterAll(() => {
  server?.kill();
  if (project) fs.rmSync(project, { recursive: true, force: true });
});

const draft = {
  constitution: [{ key: 'stack', title: 'Stack', body: 'TypeScript.' }],
  structure: [
    { key: 'pkg', title: 'Package', kind: 'module', parent: null, path: '.' },
    { key: 'ui', title: 'UI', kind: 'module', parent: 'pkg', path: 'src' },
    { key: 'home', title: 'Home', kind: 'screen', parent: 'ui', layout: { el: 'main', children: [{ el: 'button', label: 'Go' }] } },
  ],
  requirements: [{ key: 'REQ-001', title: 'R', ears: 'When x, the system shall y.' }],
  steps: [{ key: 'S1', title: 'Build it', phase: 1, verify: 'npm test' }],
};

describe('the server over stdio JSON-RPC', () => {
  it('lists every tool it declares', async () => {
    const res = await send('tools/list', {});
    const names = (res.result?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(TOOL_DEFS.map((t) => t.name).sort());
  });

  it('walks the whole lifecycle the way a client would', async () => {
    const hello = await call('harness_hello', {
      editor: 'protocol-test', agent_model: true, webview: true, project_path: project,
    });
    expect(hello.host.agent_model).toBe(true);

    const cfg = await call('harness_configure', { project_path: project, model: { mode: 'native' } });
    expect(cfg.resolved_model_mode).toBe('native');
    // The key must never come back over the wire, whatever the source.
    expect(JSON.stringify(cfg)).not.toContain('sk-');

    const init = await call('harness_init', { project_path: project, description: 'A tiny app.' });
    expect(init.status).toBe('needs_agent');

    const built = await call('harness_submit_generation', {
      project_path: project, request_id: init.request_id, result: draft,
    });
    expect(built.status).toBe('assembled');

    const status = await call('harness_status', { project_path: project });
    expect(status.assembled).toBe(true);

    const spec = await call('harness_get_spec', { project_path: project, type: 'structure' });
    expect(spec.entries).toHaveLength(3);

    // Assembling twice is refused, and reverse is the other door to the same rule.
    const again = await call('harness_reverse', { project_path: project });
    expect(again.error).toMatch(/already exists/);
  });

  it('proposes, approves and rejects — and nothing applies without a decision', async () => {
    const proposed = await call('harness_propose_change', {
      project_path: project, target: 'entry', op: 'update', entry_type: 'structure',
      key: 'ui', title: 'Interface', rationale: 'Renamed in the brief.',
    });
    expect(proposed.status).toBe('pending_review');

    const queue = await call('harness_list_pending', { project_path: project });
    expect(queue.badge).toBe(1);

    // This client declared no capabilities at initialize, so it cannot be asked
    // mid-call: review must hand the queue back untouched rather than assume.
    const review = await call('harness_review', { project_path: project });
    expect(review.status).toBe('queue_only');
    expect(review.badge).toBe(1);

    // Still untouched while it waits.
    const before = await call('harness_get_spec', { project_path: project, type: 'structure' });
    expect(before.entries.find((e: any) => e.key === 'ui').title).toBe('UI');

    await call('harness_approve', {
      project_path: project, change_ids: [proposed.change.id], actor: 'human', note: 'Agreed.',
    });
    const after = await call('harness_get_spec', { project_path: project, type: 'structure' });
    expect(after.entries.find((e: any) => e.key === 'ui').title).toBe('Interface');

    const doomed = await call('harness_propose_change', {
      project_path: project, target: 'entry', op: 'delete', entry_type: 'structure',
      key: 'home', rationale: 'Not needed.',
    });
    await call('harness_reject', {
      project_path: project, change_ids: [doomed.change.id], actor: 'human', note: 'Still needed.',
    });
    const survived = await call('harness_get_spec', { project_path: project, type: 'structure' });
    expect(survived.entries.some((e: any) => e.key === 'home')).toBe(true);
  });

  it('returns the decision record, joined to what was decided', async () => {
    const hist = await call('harness_history', { project_path: project });

    expect(hist.approvals.length).toBeGreaterThanOrEqual(2);
    const approved = hist.approvals.find((a: any) => a.decision === 'approved');
    const rejected = hist.approvals.find((a: any) => a.decision === 'rejected');

    // The point of REQ-013: an approval that cannot name what it approved is noise.
    expect(approved.ref).toBe('structure/ui');
    expect(approved.actor).toBe('human');
    expect(approved.note).toBe('Agreed.');
    expect(approved.rationale).toMatch(/Renamed in the brief/);
    expect(rejected.ref).toBe('structure/home');
    expect(rejected.note).toBe('Still needed.');
    expect(hist.checkpoints.length).toBeGreaterThan(0);
  });

  it('carries design rules, tokens, render and verify across the wire', async () => {
    const rule = await call('harness_add_design_rule', {
      project_path: project, rule: 'All buttons have an 8px radius.', apply_now: true,
    });
    expect(rule.status).toBe('applied');

    const tokens = await call('harness_set_design_tokens', {
      project_path: project,
      tokens: { tokens: { colors: { brand: { '500': '#b1403c' } }, radii: { md: '24px' } } },
    });
    expect(tokens.tokens.radii.card).toBe('24px');

    // webview, never browser: a test must not open a window on someone's machine.
    const html = await call('harness_render', { project_path: project, output: 'webview', focus: 'structure' });
    expect(html.html).toContain('--t-radius-card: 24px');
    expect(html.html).not.toContain('<script');

    const report = await call('harness_verify', { project_path: project });
    expect(report).toHaveProperty('in_sync');

    const design = await call('harness_sync_design_system', { project_path: project });
    expect(design.status).toBe('not_configured');
  });

  it('takes a structured session summary and rolls back to a checkpoint', async () => {
    const summary = await call('summarize_session_to_harness', {
      project_path: project,
      completed_tasks: ['Wired the button'],
      decisions: ['Routing stays client-side.'],
      open_questions: ['Do we need SSR?'],
      touched_files: ['src/App.tsx'],
    });
    expect(summary.queued).toHaveLength(2);

    const cp = await call('harness_checkpoint', { project_path: project, action: 'create', label: 'before-rollback' });
    await call('harness_add_design_rule', { project_path: project, rule: 'Temporary.', apply_now: true });
    await call('harness_checkpoint', { project_path: project, action: 'restore', checkpoint_id: cp.id });
    const rules = await call('harness_get_spec', { project_path: project, type: 'design' });
    expect(rules.design_rules.some((r: any) => r.rule === 'Temporary.')).toBe(false);

    await call('harness_checkpoint', { project_path: project, action: 'list' });
  });

  it('hands generation back to the agent for chat and structure alike', async () => {
    const chat = await call('harness_chat', { project_path: project, message: 'Make the buttons green.' });
    expect(chat.status).toBe('needs_agent');

    const structure = await call('harness_propose_structure', {
      project_path: project, instruction: 'Add a settings screen.',
    });
    expect(structure.status).toBe('needs_agent');
  });

  it('leaves no tool untested — the invariant, enforced', () => {
    const missed = TOOL_DEFS.map((t) => t.name).filter((n) => !exercised.has(n));
    expect(
      missed,
      `inv-protocol-test: these tools have no protocol-level test: ${missed.join(', ')}`,
    ).toEqual([]);
  });
});
