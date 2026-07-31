import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callTool } from '../src/tools.js';
import { HarnessService } from '../src/HarnessService.js';
import { SECURITY_CATALOGUE } from '../src/security/catalogue.js';

/**
 * The security layer.
 *
 * Two things are being defended here, and the second matters more. The first is
 * that a rule catches its violation. The second is that it stays silent on correct
 * code — because the second false alarm is when a rule starts being ignored, and
 * the third is when the whole layer is switched off. A noisy rule protects nothing.
 *
 * And throughout: `unverified` never becomes `passed`. Nothing failing and nothing
 * being checked look identical in a summary, and only one of them is safe.
 */

let project: string;

const write = (rel: string, body: string): void => {
  const file = path.join(project, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
};

async function assembleHarness(): Promise<void> {
  const started = (await callTool('harness_reverse', { project_path: project })) as any;
  await callTool('harness_submit_generation', {
    project_path: project, request_id: started.request_id,
    result: {
      constitution: [{ key: 'stack', title: 'Stack', body: 'TypeScript.' }],
      structure: [
        { key: 'pkg', title: 'Package', kind: 'module', parent: null, path: '.' },
        { key: 'src', title: 'Source', kind: 'module', parent: 'pkg', path: 'src' },
      ],
      requirements: [{ key: 'REQ-001', title: 'R', ears: 'When x, the system shall y.' }],
      steps: [{ key: 'S1', title: 'Build', phase: 1, verify: 'npm test' }],
    },
  });
}

/** Import the catalogue and approve everything — the human's part, done for us. */
async function approveCatalogue(keys?: string[]): Promise<void> {
  const imported = (await callTool('harness_import_security_rules', { project_path: project, ...(keys ? { keys } : {}) })) as any;
  const ids = imported.queued.map((q: any) => q.id);
  if (ids.length) await callTool('harness_approve', { project_path: project, change_ids: ids, actor: 'human' });
}

const report = async (): Promise<any> => callTool('harness_security_report', { project_path: project });
const verdictFor = (r: any, key: string) =>
  [...r.passed, ...r.failed, ...r.unverified]
    .find((v: any) => v.rule_key === key);

beforeEach(async () => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-sec-'));
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"demo"}');
  await callTool('harness_hello', { editor: 'test', agent_model: true, webview: false, project_path: project });
  await assembleHarness();
});

afterEach(() => {
  HarnessService.closeAll();
  fs.rmSync(project, { recursive: true, force: true });
});

describe('a rule governs only after a human approves it', () => {
  it('imports the catalogue as proposals and applies nothing', async () => {
    const res = (await callTool('harness_import_security_rules', { project_path: project })) as any;

    expect(res.status).toBe('pending_review');
    expect(res.queued).toHaveLength(SECURITY_CATALOGUE.length);
    // A security layer that installs itself is the kind people disable wholesale.
    expect(((await report()) as any).status).toBe('no_rules');
  });

  it('governs once approved', async () => {
    await approveCatalogue();
    const res = await report();
    expect(res.status).not.toBe('no_rules');
    expect(res.coverage.rules).toBe(SECURITY_CATALOGUE.length);
  });

  it('does not offer a rule the harness already has', async () => {
    await approveCatalogue(['sec-no-secrets']);
    const again = (await callTool('harness_import_security_rules', { project_path: project })) as any;
    expect(again.skipped).toContain('sec-no-secrets');
    expect(again.queued.map((q: any) => q.ref)).not.toContain('sec-no-secrets');
  });
});

describe('each rule catches its violation', () => {
  beforeEach(() => approveCatalogue());

  it('catches SQL built by concatenation', async () => {
    write('src/db.ts', 'export const find = (id: string) =>\n  query(`SELECT * FROM users WHERE id = ${id}`);\n');
    const v = verdictFor(await report(), 'sec-sql-concat');
    expect(v.state).toBe('failed');
    expect(v.violations[0].file).toBe('src/db.ts');
    expect(v.violations[0].line).toBe(2);
  });

  it('catches a secret in source', async () => {
    write('src/config.ts', 'export const client = init("sk-abcdefghijklmnopqrstuvwxyz123456");\n');
    const v = verdictFor(await report(), 'sec-no-secrets');
    expect(v.state).toBe('failed');
    expect(v.violations[0].file).toBe('src/config.ts');
  });

  it('catches an internal error returned to the caller', async () => {
    write('src/handler.ts', 'export const h = (req, res) => {\n  try { work(); } catch (err) { res.status(500).json(err); }\n};\n');
    const v = verdictFor(await report(), 'sec-no-internal-errors');
    expect(v.state).toBe('failed');
  });
});

describe('and stays silent on correct code', () => {
  beforeEach(() => approveCatalogue());

  it('does not fire on a parameterised query', async () => {
    write('src/db.ts', 'export const find = (id: string) =>\n  query("SELECT * FROM users WHERE id = $1", [id]);\n');
    expect(verdictFor(await report(), 'sec-sql-concat').state).toBe('passed');
  });

  it('does not fire on a template literal that is not SQL', async () => {
    // Without the `near` guard this is the line that makes the rule useless: every
    // interpolated string in the project would be reported as SQL injection.
    write('src/greet.ts', 'export const hello = (name: string) => `Hello, ${name}! You have ${count} messages.`;\n');
    expect(verdictFor(await report(), 'sec-sql-concat').state).toBe('passed');
  });

  it('does not fire on a key read from the environment', async () => {
    write('src/config.ts', 'export const client = init(process.env.API_KEY);\n');
    expect(verdictFor(await report(), 'sec-no-secrets').state).toBe('passed');
  });

  it('does not fire on an error that is logged rather than returned', async () => {
    write('src/handler.ts', 'export const h = (req, res) => {\n  try { work(); } catch (err) { logger.error(err); res.status(500).json({ message: "Internal error" }); }\n};\n');
    expect(verdictFor(await report(), 'sec-no-internal-errors').state).toBe('passed');
  });
});

describe('what cannot be proven here is never called passed', () => {
  beforeEach(() => approveCatalogue());

  it('reports rules needing outside evidence as unverified, in their own block', async () => {
    write('src/api/users.ts', 'export const get = (req, res) => res.json(db.user(req.params.id));\n');
    const res = await report();

    const structural = res.unverified.find((v: any) => v.rule_key === 'sec-input-validated-server-side');
    const runtime = res.unverified.find((v: any) => v.rule_key === 'sec-object-level-authorization');
    expect(structural.state).toBe('unverified');
    expect(runtime.state).toBe('unverified');

    // Not in the passed block, and the report says what would settle them.
    expect(res.passed.map((p: any) => p.rule_key)).not.toContain('sec-object-level-authorization');
    expect(runtime.reason).toMatch(/running instance/);
    expect(res.note).toMatch(/not checked/);
  });

  it('says nothing was examined when no file matched, rather than passing', async () => {
    // An empty glob and a clean codebase look the same from a summary line.
    const v = verdictFor(await report(), 'sec-input-validated-server-side');
    expect(v.state).toBe('unverified');
  });

  it('names a capability, never a product', async () => {
    const res = await report();
    const text = JSON.stringify(res.unverified).toLowerCase();
    // inv-capability-not-tool: one person has FlowMind, another has browser
    // automation, a third has a script. The rule is the same for all of them.
    for (const product of ['flowmind', 'projectmind', 'playwright', 'chrome']) {
      expect(text, `the report names ${product}`).not.toContain(product);
    }
  });
});

describe('a verdict from outside', () => {
  beforeEach(async () => {
    await approveCatalogue();
    write('src/api/users.ts', 'export const get = (req, res) => res.json(db.user(req.params.id));\n');
  });

  it('is accepted, with its source recorded', async () => {
    await callTool('harness_submit_security_check', {
      project_path: project, rule_key: 'sec-object-level-authorization',
      state: 'passed', source: 'browser session, two accounts', detail: 'A could not reach B by id.',
    });

    const v = verdictFor(await report(), 'sec-object-level-authorization');
    expect(v.state).toBe('passed');
    expect(v.source).toBe('browser session, two accounts');
    expect(v.stale).toBe(false);
  });

  it('goes stale when the code it judged moves on', async () => {
    await callTool('harness_submit_security_check', {
      project_path: project, rule_key: 'sec-object-level-authorization',
      state: 'passed', source: 'a script',
    });
    write('src/api/users.ts', 'export const get = (req, res) => res.json(db.user(req.params.id, req.user.id));\n');

    const v = verdictFor(await report(), 'sec-object-level-authorization');
    // Still reported, but marked: proven against different code is not evidence
    // about this code.
    expect(v.stale).toBe(true);
    expect(v.reason).toMatch(/changed after this verdict/);
  });

  it('is refused for a rule the harness proves itself', async () => {
    // Otherwise a claim could overrule an observation.
    await expect(
      callTool('harness_submit_security_check', {
        project_path: project, rule_key: 'sec-no-secrets', state: 'passed', source: 'trust me',
      }),
    ).rejects.toThrow(/proves it itself/);
  });
});

describe('the report separates what it knows from what it does not', () => {
  beforeEach(() => approveCatalogue());

  it('counts critical failures and says not to report done', async () => {
    write('src/db.ts', 'query(`SELECT * FROM users WHERE id = ${id}`);\n');
    const res = await report();

    expect(res.critical_failures).toBe(1);
    expect(res.state).toBe('failed');
    expect(res.note).toMatch(/Do not report this work as done/);
  });

  it('never sums the checked and the unchecked into one number', async () => {
    write('src/clean.ts', 'export const ok = 1;\n');
    const res = await report();

    const keys = new Set([
      ...res.passed.map((p: any) => p.rule_key),
      ...res.failed.map((f: any) => f.rule_key),
      ...res.unverified.map((u: any) => u.rule_key),
    ]);
    expect(keys.size).toBe(SECURITY_CATALOGUE.length);
    expect(res.coverage.proven_here + res.coverage.needs_outside_evidence).toBe(SECURITY_CATALOGUE.length);
  });

  it('filters by severity without hiding that it did', async () => {
    const high = (await callTool('harness_security_report', { project_path: project, severity: 'critical' })) as any;
    expect(high.coverage.rules).toBeLessThan(SECURITY_CATALOGUE.length);
  });
});

describe('the catalogue itself', () => {
  it('gives every rule a way to be checked', () => {
    // A rule with no check is a wish wearing a rule's clothes.
    for (const rule of SECURITY_CATALOGUE) {
      expect(['grep', 'structural', 'runtime']).toContain(rule.check_kind);
      if (rule.check_kind === 'grep') expect(rule.check).toHaveProperty('pattern');
      else expect(rule.check).toHaveProperty('needs');
    }
  });

  it('compiles every grep pattern', () => {
    for (const rule of SECURITY_CATALOGUE) {
      if (rule.check_kind !== 'grep') continue;
      const c = rule.check as { pattern: string; near?: string };
      expect(() => new RegExp(c.pattern), `${rule.key} has an invalid pattern`).not.toThrow();
      if (c.near) expect(() => new RegExp(c.near!)).not.toThrow();
    }
  });

  it('says what breaks, not merely what is forbidden', () => {
    for (const rule of SECURITY_CATALOGUE) {
      expect(rule.rationale.length, `${rule.key} has no rationale worth reading`).toBeGreaterThan(60);
    }
  });
});
