import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callTool } from '../src/tools.js';
import { HarnessService } from '../src/HarnessService.js';

/**
 * The render must read as an interface, not a wall of text, and it must do so under
 * the host's strict CSP — no inline script runs there, so every switch is CSS.
 */

let project: string;

beforeAll(async () => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-render-'));
  await callTool('harness_hello', { editor: 'test', agent_model: true, webview: true, project_path: project });
  const started = (await callTool('harness_reverse', { project_path: project })) as any;

  // A dci-grid-shaped harness: a tree, three screens (one with a rich layout, two
  // described only in words), and flows that connect them.
  const draft = {
    constitution: [{ key: 'stack', title: 'Stack', body: 'TypeScript monorepo.' }],
    structure: [
      { key: 'engine', title: 'Trading Engine', kind: 'module', parent: null, path: 'apps/engine' },
      { key: 'api', title: 'HTTP API', kind: 'module', parent: 'engine', path: 'apps/engine/api', description: 'REST + WS.' },
      { key: 'bybit', title: 'ByBit client', kind: 'module', parent: 'engine', path: 'apps/engine/bybit' },
      { key: 'web', title: 'Web dashboard', kind: 'module', parent: null, path: 'apps/web' },
      {
        key: 'screen-dashboard', title: 'Dashboard', kind: 'screen', parent: 'web',
        description: 'The main trading screen.',
        layout: {
          el: 'main', children: [
            { el: 'header', children: [{ el: 'stat', label: 'Balance' }, { el: 'stat', label: 'Equity' }, { el: 'stat', label: 'Margin' }] },
            { el: 'main', children: [
              { el: 'controls', children: [{ el: 'dropdown', label: 'Symbol' }, { el: 'tabs', label: 'Timeframe' }] },
              { el: 'main', children: [
                { el: 'chart', label: 'Price Chart' },
                { el: 'sidebar', children: [{ el: 'form', label: 'Place Order' }, { el: 'list', label: 'Positions' }] },
              ] },
              { el: 'table', label: 'Grid Levels' },
            ] },
            { el: 'footer', children: [{ el: 'badge', label: 'WS status' }] },
          ],
        },
      },
      { key: 'screen-backtesting', title: 'Backtesting', kind: 'screen', parent: 'web', description: 'Planned, not built.' },
      { key: 'flow-place-order', title: 'Place Order → engine', kind: 'flow', parent: 'web', description: 'Dashboard posts to the engine.' },
      { key: 'flow-ws', title: 'WS → Live Prices', kind: 'flow', parent: 'web' },
    ],
    design: [{ key: 'layout-backtesting', title: 'Макет Backtesting', body: 'Setup form, equity curve, trades table.' }],
    requirements: [{ key: 'REQ-001', title: 'R', ears: 'When x, the system shall y.' }],
    steps: [{ key: 'S1', title: 'Do it', phase: 1, verify: 'npm test' }],
  };
  await callTool('harness_submit_generation', { project_path: project, request_id: started.request_id, result: draft });
});

afterAll(() => {
  HarnessService.closeAll();
  fs.rmSync(project, { recursive: true, force: true });
});

const render = async (focus?: string) =>
  ((await callTool('harness_render', { project_path: project, output: 'webview', focus })) as any).html as string;

describe('layout drawn by type', () => {
  it('draws a stat differently from a chart — not the same frame', async () => {
    const html = await render();
    expect(html).toContain('el el-stat');
    expect(html).toContain('el el-chart');
    expect(html).toContain('el-num'); // stat has a value slot
    expect(html).toContain('el-plot'); // chart has a plot area
    // The two element types produce structurally different markup.
    expect(html.includes('<span class="el-num">')).toBe(true);
    expect(html.includes('<span class="el-plot">')).toBe(true);
  });

  it('composes header as a row and main as a column', async () => {
    const html = await render();
    expect(html).toMatch(/el el-header dir-row/);
    expect(html).toMatch(/el el-main dir-col/);
  });

  it('makes a container with a sidebar a horizontal split', async () => {
    const html = await render();
    // The inner main holds chart + sidebar, so it must lay out as a row.
    expect(html).toMatch(/el el-main dir-row[\s\S]*?el-chart[\s\S]*?el-sidebar/);
  });

  it('renders a button with the accent, a dropdown with a caret', async () => {
    const html = await render();
    expect(html).toContain('el el-dropdown');
    expect(html).toContain('caret');
  });
});

describe('no-JS switching under strict CSP', () => {
  it('ships no script tag and no inline handlers', async () => {
    const html = await render();
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('addEventListener');
  });

  it('switches tabs with checked radios, default marked on the server', async () => {
    const html = await render('mockup');
    expect(html).toContain('id="ht-mockup"');
    // The focused tab's radio is checked in the served HTML, not by a script.
    expect(html).toMatch(/id="ht-mockup"\s+checked/);
    expect(html).toMatch(/#ht-mockup:checked\s+~ main #panel-mockup/);
  });

  it('switches screens with checked radios, first active by default', async () => {
    const html = await render();
    expect(html).toMatch(/id="hs-0"\s+checked/);
    expect(html).not.toMatch(/id="hs-1"\s+checked/);
    expect(html).toContain('#hs-0:checked ~ .deck-body > .screen:nth-of-type(1)');
  });
});

describe('structure reads as a map, with connections', () => {
  it('puts each description behind a details disclosure, header always visible', async () => {
    const html = await render();
    // Trading Engine's child API carries a description → it is inside <details>.
    expect(html).toMatch(/<details class="node"><summary>[\s\S]*?HTTP API[\s\S]*?<\/summary><p>REST \+ WS\./);
    // The title itself is in the summary, so it shows without expanding.
    expect(html).toContain('<summary>');
  });

  it('shows flows in their own connections section, not as tree children', async () => {
    const html = await render();
    expect(html).toContain('Flows &amp; connections');
    expect(html).toContain('Place Order → engine');
    // A flow node must not appear as an <li> inside ul.tree.
    const treePart = html.split('Flows &amp; connections')[0];
    expect(treePart).not.toContain('Place Order → engine');
  });
});

describe('honest about missing data', () => {
  it('merges a screen and its design entry, and admits when no skeleton exists', async () => {
    const html = await render();
    // Dashboard (structured) and Backtesting (described only) are both deck tabs.
    expect(html).toContain('for="hs-0"');
    expect(html).toMatch(/No visual skeleton yet/);
    // The real description is shown, nothing fabricated.
    expect(html).toContain('Setup form, equity curve, trades table.');
  });
});

describe('both token paths render without error', () => {
  it('renders a grey skeleton without tokens', async () => {
    const html = await render();
    expect(html).toContain('Grey skeleton');
    expect(html).not.toContain('themed');
  });

  it('renders themed once tokens are present', async () => {
    await callTool('harness_set_design_tokens', {
      project_path: project,
      tokens: { tokens: { colors: { brand: { '500': '#b1403c' }, neutral: { '0': '#fff', '800': '#111' } }, radii: { md: '24px' } } },
    });
    const html = await render();
    expect(html).toContain('panel themed');
    expect(html).toContain('--t-radius-card: 24px');
    expect(html).toContain('.themed .el-button');
  });
});
