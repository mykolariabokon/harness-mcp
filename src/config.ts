import fs from 'node:fs';
import { defaultConfig, type HarnessConfig, type ModelMode } from './types.js';
import type { HarnessPaths } from './paths.js';

/**
 * `/harness/config.json` — only needed by the universal path (an editor that
 * cannot lend the harness its own model). In native mode the file exists but the
 * model block stays empty.
 */
export function loadConfig(paths: HarnessPaths): HarnessConfig {
  if (!fs.existsSync(paths.config)) {
    const cfg = defaultConfig();
    saveConfig(paths, cfg);
    return cfg;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(paths.config, 'utf8')) as Partial<HarnessConfig>;
    const base = defaultConfig();
    return {
      version: raw.version ?? base.version,
      model: { ...base.model, ...(raw.model ?? {}) },
      render: { ...base.render, ...(raw.render ?? {}) },
      design_mcp: { ...base.design_mcp, ...(raw.design_mcp ?? {}) },
      spec_files: { ...base.spec_files, ...(raw.spec_files ?? {}) },
    };
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(paths: HarnessPaths, cfg: HarnessConfig): void {
  fs.writeFileSync(paths.config, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

/**
 * Host capabilities announced by the editor at connect time (`harness_hello`).
 * Peregrine and VS Code-like extensions announce both; a bare MCP client announces
 * neither, and the harness falls back to its own model and a browser window.
 */
export interface HostCapabilities {
  /** The editor's agent will run generation on the harness's behalf. */
  agent_model: boolean;
  /** The editor can display returned HTML in a webview panel. */
  webview: boolean;
  name: string | null;
}

export const NO_HOST: HostCapabilities = { agent_model: false, webview: false, name: null };

/** One logic, two model sources — this picks the source. */
export function resolveModelMode(cfg: HarnessConfig, host: HostCapabilities): ModelMode {
  if (cfg.model.mode === 'native') return 'native';
  if (cfg.model.mode === 'universal') return 'universal';
  return host.agent_model ? 'native' : 'universal';
}

/** One visualization, two outputs — this picks the output. */
export function resolveRenderOutput(cfg: HarnessConfig, host: HostCapabilities): 'webview' | 'browser' {
  if (cfg.render.output !== 'auto') return cfg.render.output;
  return host.webview ? 'webview' : 'browser';
}

export function universalModelReady(cfg: HarnessConfig): boolean {
  return Boolean(cfg.model.provider && cfg.model.api_key && cfg.model.model);
}
