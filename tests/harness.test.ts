import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callTool } from '../src/tools.js';
import { HarnessService } from '../src/HarnessService.js';
import { globToRegExp } from '../src/codeScan.js';
import { renderDiff } from '../src/diff.js';
import { renderServer } from '../src/render/server.js';

let project: string;

beforeAll(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"demo"}');
  fs.writeFileSync(path.join(project, 'src', 'App.tsx'), 'export const App = () => <button>go</button>;');
});

afterAll(() => {
  HarnessService.closeAll();
  fs.rmSync(project, { recursive: true, force: true });
});

const draft = {
  constitution: [{ key: 'stack', title: 'Stack', body: 'React + Vite. Verify with `npm test`.' }],
  structure: [
    { key: 'ui', title: 'UI', kind: 'module', path: 'src', description: 'React app' },
    { key: 'app-screen', title: 'App screen', kind: 'screen', parent: 'ui', path: 'src/App.tsx',
      layout: { el: 'main', children: [{ el: 'button', label: 'go' }] } },
    { key: 'ghost', title: 'Reports module', kind: 'module', path: 'src/reports',
      confidence: 'assumption', question: 'Is a reports module actually planned?' },
  ],
  requirements: [{ key: 'REQ-001', title: 'Go button', ears: 'When the user clicks go, the system shall start.', why: 'Core flow.' }],
  steps: [{ key: 'S1', title: 'Wire the button', phase: 1, verify: 'npm test' }],
  design_rules: [{ rule: 'All buttons have an 8px radius.' }],
};

describe('harness lifecycle', () => {
  it('runs in native mode and hands generation back to the editor agent', async () => {
    const hello = (await callTool('harness_hello', {
      editor: 'peregrine', agent_model: true, webview: true, project_path: project,
    })) as any;
    expect(hello.host.agent_model).toBe(true);

    const init = (await callTool('harness_init', { project_path: project, description: 'A tiny demo app.' })) as any;
    expect(init.status).toBe('needs_agent');
    expect(init.request_id).toBeGreaterThan(0);

    const applied = (await callTool('harness_submit_generation', {
      project_path: project, request_id: init.request_id, result: draft,
    })) as any;
    expect(applied.status).toBe('assembled');
    expect(applied.assumptions).toBe(1);
  });

  it('writes a committable markdown spec', () => {
    const dir = path.join(project, 'harness');
    expect(fs.existsSync(path.join(dir, 'harness.json'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'STRUCTURE.md'), 'utf8')).toContain('App screen');
    expect(fs.readFileSync(path.join(dir, 'DESIGN.md'), 'utf8')).toContain('8px radius');
    expect(fs.readFileSync(path.join(dir, 'tasks', 'phase-1.md'), 'utf8')).toContain('verify: `npm test`');
    // Assumptions stay visible instead of masquerading as fact.
    expect(fs.readFileSync(path.join(dir, 'STRUCTURE.md'), 'utf8')).toContain('[assumption]');
  });

  it('refuses to assemble twice', async () => {
    const again = (await callTool('harness_init', { project_path: project, description: 'again' })) as any;
    expect(again.error).toMatch(/already exists/);
  });

  it('queues changes instead of applying them, and applies only on approval', async () => {
    const proposed = (await callTool('harness_propose_change', {
      project_path: project, target: 'entry', op: 'update', entry_type: 'structure',
      key: 'app-screen', title: 'Home screen', rationale: 'Renamed in the product brief.',
    })) as any;
    expect(proposed.status).toBe('pending_review');
    expect(proposed.change.diff).toContain('- title: App screen');
    expect(proposed.change.diff).toContain('+ title: Home screen');

    // Still untouched before approval.
    const before = (await callTool('harness_get_spec', { project_path: project, type: 'structure' })) as any;
    expect(before.entries.find((e: any) => e.key === 'app-screen').title).toBe('App screen');

    const decided = (await callTool('harness_approve', { project_path: project, change_id: proposed.change.id })) as any;
    expect(decided.results[0].status).toBe('approved');

    const after = (await callTool('harness_get_spec', { project_path: project, type: 'structure' })) as any;
    expect(after.entries.find((e: any) => e.key === 'app-screen').title).toBe('Home screen');
  });

  it('keeps a rejected change out of the harness', async () => {
    const proposed = (await callTool('harness_propose_change', {
      project_path: project, target: 'entry', op: 'delete', entry_type: 'requirement',
      key: 'REQ-001', rationale: 'Not needed.',
    })) as any;
    await callTool('harness_reject', { project_path: project, change_id: proposed.change.id, note: 'Still needed.' });
    const spec = (await callTool('harness_get_spec', { project_path: project, type: 'requirement' })) as any;
    expect(spec.entries).toHaveLength(1);
  });

  it('applies a dictated design rule globally', async () => {
    const res = (await callTool('harness_add_design_rule', {
      project_path: project, rule: 'All buttons are green.', apply_now: true,
    })) as any;
    expect(res.status).toBe('applied');
    expect(fs.readFileSync(path.join(project, 'harness', 'DESIGN.md'), 'utf8')).toContain('All buttons are green.');
  });

  it('reports divergences between code and harness on demand', async () => {
    const report = (await callTool('harness_verify', { project_path: project })) as any;
    expect(report.in_sync).toBe(false);
    // src/reports was an assumption and does not exist on disk.
    expect(report.divergences.some((d: any) => d.kind === 'missing_path' && d.ref.includes('ghost'))).toBe(true);
  });

  it('turns a session summary into per-item proposals', async () => {
    const res = (await callTool('summarize_session_to_harness', {
      project_path: project,
      completed_tasks: ['Wired the go button'],
      decisions: ['Routing stays client-side for now.'],
      open_questions: ['Do we need SSR?'],
      touched_files: ['src/App.tsx'],
    })) as any;
    expect(res.queued).toHaveLength(2);
    expect(res.status).toBe('pending_review');
  });

  it('renders one visualization, delivered to a webview when the host has one', async () => {
    const res = (await callTool('harness_render', { project_path: project, output: 'webview' })) as any;
    expect(res.output).toBe('webview');
    expect(res.html).toContain('Home screen');
    expect(res.html).toContain('Harness');
  });

  it('checkpoints and restores', async () => {
    const cp = (await callTool('harness_checkpoint', { project_path: project, action: 'create', label: 'test' })) as any;
    await callTool('harness_add_design_rule', { project_path: project, rule: 'Temporary rule.', apply_now: true });
    await callTool('harness_checkpoint', { project_path: project, action: 'restore', checkpoint_id: cp.id });
    const spec = (await callTool('harness_get_spec', { project_path: project })) as any;
    expect(spec.design_rules.some((r: any) => r.rule === 'Temporary rule.')).toBe(false);
  });
});

// A trimmed but real-shaped Design MCP get_tokens payload.
const designMcpTokens = {
  chakraVersion: 'v2.8.2',
  tokens: {
    colors: { brand: { '500': '#b1403c' }, neutral: { '0': '#ffffff', '50': '#f8fafc', '200': '#e2e8f0', '500': '#64748b', '800': '#1f2937' } },
    radii: { sm: '22px', md: '24px', pill: '9999px' },
    spacing: { '1': '4px', '2': '8px', '4': '16px' },
    fonts: { heading: "'Sora', sans-serif", body: "'Manrope', sans-serif", mono: "'JetBrains Mono', monospace" },
    font_sizes: { xs: '12px', sm: '14px', lg: '18px' },
    shadows: { cardMd: '0 12px 30px rgba(15, 23, 42, 0.05)' },
  },
};

const designMcpRules = {
  mustDo: [{ rule: 'Keep border radius in 22–32px range', why: 'Large radii define the premium feel.' }],
  mustNot: [{ rule: 'Never hardcode hex colors outside token system', why: 'Hardcoded values break dark mode.' }],
};

describe('design system', () => {
  it('paints the mockup in design tokens handed in by the host', async () => {
    const grey = (await callTool('harness_render', { project_path: project, output: 'webview' })) as any;
    expect(grey.html).toContain('Grey skeleton');

    const stored = (await callTool('harness_set_design_tokens', {
      project_path: project, tokens: designMcpTokens, rules: designMcpRules,
    })) as any;
    expect(stored.status).toBe('stored');
    expect(stored.tokens.radii.card).toBe('24px');
    expect(stored.tokens.colors.accent).toBe('#b1403c');

    const themed = (await callTool('harness_render', { project_path: project, output: 'webview' })) as any;
    expect(themed.html).toContain('--t-radius-card: 24px');
    expect(themed.html).toContain('panel themed');
    expect(themed.html).toContain('tokens from <b>design-mcp</b>');
  });

  it('imports design-system rules as proposals, not facts', async () => {
    const pending = (await callTool('harness_list_pending', { project_path: project })) as any;
    const imported = pending.changes.filter((c: any) => c.source.startsWith('design-system:'));
    expect(imported).toHaveLength(2);
    // A rule that can be checked mechanically arrives with its check attached.
    const hexRule = imported.find((c: any) => c.after.rule.includes('hardcode hex'));
    expect(hexRule.after.check.forbidden).toBe(true);

    // Not in the harness until a human says so.
    const rules = (await callTool('harness_get_spec', { project_path: project, type: 'design' })) as any;
    expect(rules.design_rules.some((r: any) => r.rule.includes('hardcode hex'))).toBe(false);

    await callTool('harness_approve', { project_path: project, change_ids: imported.map((c: any) => c.id) });
    const after = (await callTool('harness_get_spec', { project_path: project, type: 'design' })) as any;
    expect(after.design_rules.some((r: any) => r.rule.includes('hardcode hex'))).toBe(true);
  });

  it('does not queue the same imported rule twice', async () => {
    const again = (await callTool('harness_set_design_tokens', {
      project_path: project, tokens: designMcpTokens, rules: designMcpRules,
    })) as any;
    expect(again.imported_rules).toBe(0);
  });

  it('enforces an imported check during verification', async () => {
    fs.writeFileSync(path.join(project, 'src', 'Bad.tsx'), 'export const Bad = () => <Box bg="#ffffff" />;');
    const report = (await callTool('harness_verify', { project_path: project })) as any;
    expect(report.divergences.some((d: any) => d.kind === 'design_rule_violation' && d.ref === 'src/Bad.tsx')).toBe(true);
  });
});

describe('universal mode', () => {
  it('can be configured before the harness is assembled', async () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cfg-'));
    const res = (await callTool('harness_configure', {
      project_path: fresh, model: { mode: 'native' },
    })) as any;
    expect(res.resolved_model_mode).toBe('native');
    expect(fs.existsSync(path.join(fresh, 'harness', 'config.json'))).toBe(true);

    // And the pinned mode survives into the first assembly.
    const init = (await callTool('harness_init', { project_path: fresh, description: 'x' })) as any;
    expect(init.status).toBe('needs_agent');
    HarnessService.closeAll();
  });

  it('explains what is missing when no model is configured', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-univ-'));
    await callTool('harness_hello', { editor: 'cursor', agent_model: false, webview: false });
    const res = (await callTool('harness_init', { project_path: other, description: 'x' })) as any;
    expect(res.status).toBe('not_configured');
    expect(res.reason).toMatch(/config\.json/);
    HarnessService.closeAll();
    fs.rmSync(other, { recursive: true, force: true });
  });
});

describe('universal render', () => {
  it('serves the same HTML on localhost', async () => {
    const url = await renderServer.serve('<h1>Harness</h1>');
    const res = await fetch(url);
    expect(await res.text()).toContain('Harness');
    renderServer.stop();
  });
});

describe('helpers', () => {
  it('matches globs across directories', () => {
    expect(globToRegExp('src/**/*.tsx').test('src/a/b/C.tsx')).toBe(true);
    expect(globToRegExp('src/**/*.tsx').test('src/C.tsx')).toBe(true);
    expect(globToRegExp('src/*.tsx').test('src/a/C.tsx')).toBe(false);
  });

  it('renders a reviewable diff', () => {
    expect(renderDiff('a\nb', 'a\nc')).toBe('  a\n- b\n+ c');
  });
});
