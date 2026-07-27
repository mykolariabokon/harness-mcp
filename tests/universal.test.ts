import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callTool } from '../src/tools.js';
import { HarnessService } from '../src/HarnessService.js';
import { parseJson } from '../src/model/LlmBridge.js';

/**
 * Universal mode — the branch that runs where no editor lends its agent.
 *
 * It was the last untested path in the server: everything else had been driven
 * end to end, while this one had only ever been checked for how it refuses when
 * unconfigured. A live key would prove more, but almost all of the risk is
 * local — which URL, which auth header, which field the answer hides in, and
 * what happens when the provider says no. That is what a stubbed transport
 * pins down, and it pins it down on every run rather than when someone
 * remembers to export a key.
 */

const KEYS = ['HARNESS_MODEL_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY'] as const;

let project: string;
let calls: Array<{ url: string; init: RequestInit }>;

/** Stand-in for the provider. Records the request, replies with what we choose. */
function stubFetch(reply: unknown, ok = true, status = 200): void {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok, status, json: async () => reply } as unknown as Response;
  });
}

const draft = {
  constitution: [{ key: 'stack', title: 'Stack', body: 'TypeScript.' }],
  structure: [
    { key: 'pkg', title: 'Package', kind: 'module', parent: null, path: '.' },
    { key: 'ui', title: 'UI', kind: 'module', parent: 'pkg', path: 'src' },
  ],
  requirements: [{ key: 'REQ-001', title: 'R', ears: 'When x, the system shall y.' }],
  steps: [{ key: 'S1', title: 'Build', phase: 1, verify: 'npm test' }],
};

const openRouterReply = (payload: unknown) => ({
  choices: [{ message: { content: JSON.stringify(payload) } }],
});
const anthropicReply = (payload: unknown) => ({
  content: [{ text: JSON.stringify(payload) }],
});

async function configureUniversal(provider: 'openrouter' | 'anthropic', extra: Record<string, unknown> = {}) {
  return callTool('harness_configure', {
    project_path: project,
    model: { mode: 'universal', provider, model: 'some/model', ...extra },
  });
}

beforeEach(async () => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-univ-'));
  calls = [];
  // No agent to borrow: this is exactly the client universal mode exists for.
  await callTool('harness_hello', { editor: 'bare-client', agent_model: false, webview: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of KEYS) delete process.env[k];
  HarnessService.closeAll();
  fs.rmSync(project, { recursive: true, force: true });
});

describe('universal mode assembles without any agent', () => {
  it('calls OpenRouter and writes the harness from its answer', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    await configureUniversal('openrouter');
    stubFetch(openRouterReply(draft));

    const res = (await callTool('harness_init', { project_path: project, description: 'A tiny app.' })) as any;

    // No handoff: the harness used its own model and finished the job itself.
    expect(res.status).toBe('assembled');
    expect(res.entries).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);

    const [{ url, init }] = calls;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-or-test');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('some/model');
    expect(body.response_format).toEqual({ type: 'json_object' });
    // The schema has to travel, or the model is guessing at the shape.
    expect(String(body.messages[1].content)).toContain('"required"');
  });

  it('calls Anthropic with its own auth header and shape', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    await configureUniversal('anthropic');
    stubFetch(anthropicReply(draft));

    const res = (await callTool('harness_init', { project_path: project, description: 'A tiny app.' })) as any;
    expect(res.status).toBe('assembled');

    const [{ url, init }] = calls;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    // Anthropic takes the system prompt beside the messages, not inside them.
    expect(JSON.parse(String(init.body)).system).toContain('JSON only');
  });

  it('honours base_url, so an OpenAI-compatible endpoint works', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-local';
    await configureUniversal('openrouter', { base_url: 'http://127.0.0.1:1234' });
    stubFetch(openRouterReply(draft));

    await callTool('harness_init', { project_path: project, description: 'x' });
    expect(calls[0].url).toBe('http://127.0.0.1:1234/v1/chat/completions');
  });

  it('turns words into queued proposals without an agent', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    await configureUniversal('openrouter');
    stubFetch(openRouterReply(draft));
    await callTool('harness_init', { project_path: project, description: 'x' });

    stubFetch(openRouterReply({
      reply: 'Renaming the module.',
      changes: [{
        target: 'entry', op: 'update', entry_type: 'structure', key: 'ui',
        title: 'Interface', rationale: 'The brief calls it Interface.',
      }],
    }));
    const chat = (await callTool('harness_chat', { project_path: project, message: 'Call the UI module Interface.' })) as any;

    // The discipline does not weaken because the model changed: still a proposal.
    expect(chat.status).toBe('pending_review');
    expect(chat.queued[0].diff).toContain('+ title: Interface');
    const spec = (await callTool('harness_get_spec', { project_path: project, type: 'structure' })) as any;
    expect(spec.entries.find((e: any) => e.key === 'ui').title).toBe('UI');
  });

  it('surfaces a provider error instead of writing half a harness', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-bad';
    await configureUniversal('openrouter');
    stubFetch({ error: { message: 'Invalid API key' } }, false, 401);

    // The failure travels as a thrown error, which the server turns into an
    // isError result for the client — carrying the provider's own words, not a
    // generic "request failed" the user cannot act on.
    await expect(
      callTool('harness_init', { project_path: project, description: 'x' }),
    ).rejects.toThrow(/401.*Invalid API key/);

    // And the important half: a failed call leaves no partial harness behind.
    const status = (await callTool('harness_status', { project_path: project })) as any;
    expect(status.assembled).toBe(false);
  });

  it('refuses before spending a request when nothing is configured', async () => {
    stubFetch(openRouterReply(draft));
    const res = (await callTool('harness_init', { project_path: project, description: 'x' })) as any;

    expect(res.status).toBe('not_configured');
    expect(res.reason).toMatch(/OPENROUTER_API_KEY/);
    expect(calls).toHaveLength(0);
  });

  it('still checks quality — a flat answer comes back for rework, then is accepted with problems', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    await configureUniversal('openrouter');
    const flat = {
      ...draft,
      structure: Array.from({ length: 25 }, (_, i) => ({
        key: `n${i}`, title: `N${i}`, kind: 'module', parent: null, path: `src/n${i}`,
      })),
    };
    stubFetch(openRouterReply(flat));

    const res = (await callTool('harness_init', { project_path: project, description: 'x' })) as any;

    // Universal mode owns the model, so it retries in place rather than handing
    // back — two requests, then the honest give-up.
    expect(calls).toHaveLength(2);
    expect(res.status).toBe('assembled_with_problems');
    expect(res.problems.join(' ')).toMatch(/flat list/);
    expect(String(calls[1].init.body)).toContain('rejected');
  });
});

describe('parsing what a model actually returns', () => {
  it('survives the fences models add however firmly you ask them not to', () => {
    expect(parseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('digs the object out of surrounding chatter', () => {
    expect(parseJson('Sure! Here you go:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it('fails loudly on prose with no JSON at all', () => {
    expect(() => parseJson('I cannot do that.')).toThrow(/did not return JSON/);
  });
});

describe('the harness reports which decision path it is on', () => {
  it('names the client capabilities and the resulting path', async () => {
    // Read lazily, never at connect: initialize arrives after the pipe opens, and
    // reading too early once reported "undeclared" for a client not yet asked.
    const hello = (await callTool('harness_hello', {
      editor: 'bare-client', agent_model: false, webview: false, project_path: project,
    })) as any;

    expect(hello.client_capabilities).toBeDefined();
    expect(hello.decision_path).toMatch(/queue|elicitation/);
  });
});
