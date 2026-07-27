import { afterEach, describe, expect, it } from 'vitest';
import { apiKeySource, resolveApiKey, universalModelReady } from '../src/config.js';
import { defaultConfig, type HarnessConfig } from '../src/types.js';

/**
 * A key belongs in the environment, not in a file inside the project. These lock
 * that preference in — and lock in that the key is never reported back.
 */
const cfg = (over: Partial<HarnessConfig['model']> = {}): HarnessConfig => {
  const c = defaultConfig();
  c.model = { ...c.model, mode: 'universal', provider: 'openrouter', model: 'x/y', ...over };
  return c;
};

const KEYS = ['HARNESS_MODEL_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY'] as const;
afterEach(() => { for (const k of KEYS) delete process.env[k]; });

describe('api key resolution', () => {
  it('takes the provider key from the environment', () => {
    process.env.OPENROUTER_API_KEY = 'sk-env';
    expect(resolveApiKey(cfg())).toBe('sk-env');
    expect(apiKeySource(cfg())).toBe('env');
  });

  it('prefers the environment over a key sitting in config.json', () => {
    process.env.OPENROUTER_API_KEY = 'sk-env';
    expect(resolveApiKey(cfg({ api_key: 'sk-file' }))).toBe('sk-env');
  });

  it('still accepts config.json when nothing is exported', () => {
    expect(resolveApiKey(cfg({ api_key: 'sk-file' }))).toBe('sk-file');
    expect(apiKeySource(cfg({ api_key: 'sk-file' }))).toBe('config');
  });

  it('reads the key matching the provider, not the other one', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant';
    // Provider is openrouter — an Anthropic key must not be sent to it.
    expect(resolveApiKey(cfg())).toBeNull();
    expect(resolveApiKey(cfg({ provider: 'anthropic' }))).toBe('sk-ant');
  });

  it('HARNESS_MODEL_API_KEY works for either provider', () => {
    process.env.HARNESS_MODEL_API_KEY = 'sk-any';
    expect(resolveApiKey(cfg())).toBe('sk-any');
    expect(resolveApiKey(cfg({ provider: 'anthropic' }))).toBe('sk-any');
  });

  it('an env key alone makes universal mode ready — no file edit needed', () => {
    expect(universalModelReady(cfg())).toBe(false);
    process.env.OPENROUTER_API_KEY = 'sk-env';
    expect(universalModelReady(cfg())).toBe(true);
    // Provider and model are still required; a key alone is not a configuration.
    expect(universalModelReady(cfg({ model: null }))).toBe(false);
  });

  it('reports the source without ever reporting the key', () => {
    expect(apiKeySource(cfg())).toBe('none');
    expect(JSON.stringify(apiKeySource(cfg({ api_key: 'sk-secret' })))).not.toContain('sk-secret');
  });
});
