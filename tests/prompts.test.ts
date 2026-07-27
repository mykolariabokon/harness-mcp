import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, composedFragments, PROMPT_KINDS, sectionsFor, type PromptKind } from '../src/prompts/builder.js';
import { FRAGMENTS } from '../src/prompts/generated.js';
import { initInstructions, reverseInstructions } from '../src/assembly.js';
import { reworkInstructions, MAX_ATTEMPTS } from '../src/assembly/quality.js';

/**
 * The prompts are the highest-leverage text in the project: they decide what a
 * harness ends up containing. These tests exist so a change to them is a
 * deliberate act with a visible diff, not a side effect of editing code nearby.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const promptsDir = path.join(here, '..', 'src', 'prompts');

const FULL: Record<PromptKind, Parameters<typeof build>[1]> = {
  init: { project_name: 'Demo', description: 'A small app.' },
  reverse: { project_name: 'Demo', hint: 'Roadmap says X.', inventory: 'analysis' },
  chat: { message: 'Make the buttons green.' },
  structure: { message: 'Add a settings screen.' },
  rework: { attempt: 2, max_attempts: 2, errors: ['flat structure'], warnings: ['no layout'], original: 'ORIGINAL' },
};

describe('composition', () => {
  it('builds each instruction from its declared sections, in order', () => {
    for (const kind of PROMPT_KINDS) {
      const text = build(kind, FULL[kind]);
      const ids = sectionsFor(kind);
      let cursor = 0;
      for (const id of ids) {
        const fragment = FRAGMENTS[id].replace(/\{\{\w+\}\}/g, '');
        const anchor = fragment.split('\n')[0].trim().slice(0, 40);
        if (!anchor) continue;
        const at = text.indexOf(anchor, cursor);
        expect(at, `${kind}: section ${id} missing or out of order`).toBeGreaterThanOrEqual(0);
        cursor = at;
      }
    }
  });

  it('shares one wording for rules used by more than one tool', () => {
    // The duplication this refactor removed: init and reverse both stated the
    // tree rule and the screen-layout rule, in their own words, free to drift.
    const init = build('init', FULL.init);
    const reverse = build('reverse', FULL.reverse);
    expect(init).toContain(FRAGMENTS['shared/tree-rule']);
    expect(reverse).toContain(FRAGMENTS['shared/tree-rule']);
    expect(init).toContain(FRAGMENTS['shared/screen-layout']);
    expect(reverse).toContain(FRAGMENTS['shared/screen-layout']);
  });
});

describe('a section exists only when its capability does', () => {
  it('drops the caller hint entirely when there is none', () => {
    const without = build('reverse', { project_name: 'Demo', inventory: 'scan' });
    // Absence, not a mention of absence: no heading, no empty section, nothing.
    expect(without).not.toContain('Extra context');
    expect(without).not.toContain('{{hint}}');
    expect(build('reverse', FULL.reverse)).toContain('Roadmap says X.');
  });

  it('says to trust the index only when an index was supplied', () => {
    const scanned = build('reverse', { project_name: 'Demo', inventory: 'scan' });
    expect(scanned).not.toContain('semantic analysis');
    expect(build('reverse', { project_name: 'Demo', inventory: 'analysis' })).toContain('semantic analysis');
  });

  it('drops the warnings heading when the draft had none', () => {
    const clean = reworkInstructions('ORIGINAL', { errors: ['flat'], warnings: [], ok: false }, 2);
    expect(clean).not.toContain('Also worth fixing');
    expect(clean).toContain('flat');

    const noisy = reworkInstructions('ORIGINAL', { errors: ['flat'], warnings: ['no layout'], ok: false }, 2);
    expect(noisy).toContain('Also worth fixing');
  });

  it('drops the description section when the project has no description yet', () => {
    const bare = build('init', { project_name: 'Demo' });
    expect(bare).not.toContain('Project description');
    expect(bare).toContain('Demo');
  });
});

describe('placeholders', () => {
  it('leaves none unresolved in any assembled instruction', () => {
    for (const kind of PROMPT_KINDS) {
      expect(build(kind, FULL[kind]), `${kind} has an unresolved placeholder`).not.toMatch(/\{\{\w+\}\}/);
    }
  });

  it('throws rather than shipping a literal {{name}} to a model', () => {
    // A surviving placeholder is not cosmetic: it asks the model to invent what
    // the caller failed to supply, and the answer looks plausible either way.
    expect(() => build('chat', {})).toThrow(/needs \{\{message\}\}/);
    expect(() => build('init', { description: 'x' })).toThrow(/needs \{\{project_name\}\}/);
  });

  it('substitutes real values, not their names', () => {
    const text = build('rework', FULL.rework);
    expect(text).toContain(`attempt 2 of ${MAX_ATTEMPTS}`);
    expect(text).toContain('- flat structure');
    expect(text).toContain('ORIGINAL');
  });
});

describe('one instruction, both modes', () => {
  it('is identical whether the agent or the harness will run it', () => {
    // The builder must not know which mode it is in: the same assembled text is
    // handed to the editor's agent (native) and sent to the configured model
    // (universal). Anything provider-shaped here would break one of them.
    const a = initInstructions('A small app.', 'Demo');
    const b = initInstructions('A small app.', 'Demo');
    expect(a).toBe(b);
    expect(a).toBe(build('init', { project_name: 'Demo', description: 'A small app.' }));
  });

  it('names no provider, endpoint or message format', () => {
    for (const kind of PROMPT_KINDS) {
      const text = build(kind, FULL[kind]).toLowerCase();
      for (const leak of ['openrouter', 'anthropic', 'openai', 'system prompt', 'assistant message', 'temperature']) {
        expect(text, `${kind} mentions ${leak}`).not.toContain(leak);
      }
    }
  });

  it('points at the schema instead of restating the result shape', () => {
    // The JSON Schema travels with the instruction and is the single source of
    // truth about shape; prose repeating it would be a second, driftable one.
    expect(build('init', FULL.init)).toContain('JSON Schema');
  });
});

describe('the rules an agent is judged by are the rules it was given', () => {
  it('states every condition the quality gate rejects on', () => {
    // inv-no-advice-without-capability, other direction: rejecting a draft for a
    // rule nobody stated is making the agent guess. Kept honest here, not by
    // remembering to update two files at once.
    const shown = `${build('init', FULL.init)}\n${build('reverse', FULL.reverse)}`.toLowerCase();
    expect(shown, 'flat structure is rejected but never demanded').toContain('tree, not a list');
    expect(shown, 'assumptions without questions are rejected but never explained').toContain('question');
    expect(shown, 'parent is required but never mentioned').toContain('parent');
  });
});

describe('no fragment goes uncomposed', () => {
  it('every markdown file reaches some instruction', () => {
    // The same self-enforcing shape as inv-protocol-test: add a fragment and
    // forget to compose it, and the build fails rather than the file rotting.
    const composed = composedFragments();
    const orphans = Object.keys(FRAGMENTS).filter(
      // session-summary holds rationale strings for proposals, not model
      // instructions — it has no recipe by design, and is covered where it is used.
      (id) => !composed.has(id) && !id.startsWith('session-summary/'),
    );
    expect(orphans, `fragments no recipe uses: ${orphans.join(', ')}`).toEqual([]);
  });

  it('every composed section has a file behind it', () => {
    for (const id of composedFragments()) {
      expect(FRAGMENTS[id], `recipe references missing fragment ${id}`).toBeDefined();
    }
  });

  it('the generated module matches the markdown on disk', () => {
    // Guards the build step itself: an edited .md that never regenerated would
    // otherwise pass every other test while the server used yesterday's words.
    const onDisk: string[] = [];
    const walk = (dir: string, prefix = ''): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(dir, e.name), prefix ? `${prefix}/${e.name}` : e.name);
        else if (e.name.endsWith('.md')) onDisk.push(`${prefix}/${e.name.replace(/\.md$/, '')}`);
      }
    };
    walk(promptsDir);
    expect(Object.keys(FRAGMENTS).sort()).toEqual(onDisk.sort());

    for (const id of onDisk) {
      const file = fs.readFileSync(path.join(promptsDir, `${id}.md`), 'utf8').replace(/\s+$/, '');
      expect(FRAGMENTS[id], `${id}.md changed without regenerating`).toBe(file);
    }
  });
});

describe('snapshots — a prompt change must be deliberate', () => {
  for (const kind of PROMPT_KINDS) {
    it(`${kind} reads as expected`, () => {
      expect(build(kind, FULL[kind])).toMatchSnapshot();
    });
  }

  it('reverse without hint or index reads as expected', () => {
    expect(reverseInstructions('Demo', null)).toMatchSnapshot();
  });
});
