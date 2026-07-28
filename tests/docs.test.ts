import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_DEFS } from '../src/tools.js';

/**
 * The README makes checkable claims about the server. These check them.
 *
 * Not pedantry: this file exists because the tools table had quietly lost
 * `harness_status`, and a reader would have concluded the tool did not exist. A
 * project whose whole argument is that documentation drifts from code unless
 * something holds them together should not rely on remembering.
 *
 * Only mechanically verifiable claims belong here. Prose about intent is not
 * testable and should not be faked into looking testable.
 */

const readme = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'README.md'),
  'utf8',
);

describe('the README describes the server that exists', () => {
  it('documents every tool', () => {
    const undocumented = TOOL_DEFS.map((t) => t.name).filter((name) => !readme.includes(`\`${name}\``));
    expect(
      undocumented,
      `tools missing from the README: ${undocumented.join(', ')}`,
    ).toEqual([]);
  });

  it('invents none', () => {
    const real = new Set(TOOL_DEFS.map((t) => t.name));
    const claimed = [...readme.matchAll(/`(harness_[a-z_]+|summarize_session_to_harness)`/g)].map((m) => m[1]);
    const phantom = [...new Set(claimed)].filter((name) => !real.has(name));
    expect(phantom, `README names tools that do not exist: ${phantom.join(', ')}`).toEqual([]);
  });

  it('counts them correctly in the header', () => {
    const claimed = /·\s*(\d+)\s*tools\s*·/.exec(readme);
    expect(claimed, 'the header no longer states a tool count').toBeTruthy();
    expect(Number(claimed![1])).toBe(TOOL_DEFS.length);
  });
});
