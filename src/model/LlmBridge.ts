import type { HarnessConfig } from '../types.js';
import type { HarnessDb } from '../db/HarnessDb.js';
import { resolveApiKey, universalModelReady } from '../config.js';

/**
 * The harness needs a model to turn "make the buttons green" into structured
 * harness edits. Two sources, one logic:
 *
 *  - native    — the editor already runs a model (Peregrine, VS Code-like
 *                extensions). The harness does not call any API: it returns a
 *                generation REQUEST, the editor's agent fulfils it with its own
 *                model and calls `harness_submit_generation` with the result.
 *                No extra key.
 *  - universal — no such integration (Cursor, Grok Build, a bare MCP client).
 *                The harness calls its own model configured in
 *                `/harness/config.json`. One extra setup step, works everywhere.
 *
 * Everything downstream consumes `GenerationOutcome` and does not care which
 * branch produced it.
 */

export type GenerationOutcome =
  | { status: 'ready'; data: unknown }
  | { status: 'needs_agent'; request_id: number; instructions: string; schema: unknown; context: unknown }
  | { status: 'not_configured'; reason: string };

export interface GenerationSpec {
  purpose: string;
  instructions: string;
  /** JSON Schema the result must satisfy. Both branches are held to it. */
  schema: unknown;
  context: Record<string, unknown>;
}

export class LlmBridge {
  constructor(
    private readonly db: HarnessDb,
    private readonly cfg: HarnessConfig,
    private readonly mode: 'native' | 'universal',
  ) {}

  async generate(spec: GenerationSpec): Promise<GenerationOutcome> {
    if (this.mode === 'native') {
      const req = this.db.openGeneration(spec.purpose, spec.instructions, spec.schema, spec.context);
      return {
        status: 'needs_agent',
        request_id: req.id,
        instructions: spec.instructions,
        schema: spec.schema,
        context: spec.context,
      };
    }

    if (!universalModelReady(this.cfg)) {
      return {
        status: 'not_configured',
        reason:
          'Universal mode needs a provider and model in /harness/config.json (model.provider = "openrouter" | "anthropic", model.model) ' +
          'plus an API key. Prefer the environment — OPENROUTER_API_KEY / ANTHROPIC_API_KEY, or HARNESS_MODEL_API_KEY — so the key stays ' +
          'out of the project; model.api_key in config.json also works. Set the rest with harness_configure, or connect from an editor ' +
          'that lends the harness its own agent (native mode, no key at all).',
      };
    }

    const text = await this.callModel(spec);
    return { status: 'ready', data: parseJson(text) };
  }

  private async callModel(spec: GenerationSpec): Promise<string> {
    const system =
      'You maintain a project harness — a durable specification that is the single source of truth for a coding agent. ' +
      'Answer with JSON only, matching the provided JSON Schema exactly. No prose, no markdown fences.';
    const user =
      `${spec.instructions}\n\nJSON Schema:\n${JSON.stringify(spec.schema, null, 2)}\n\n` +
      `Context:\n${JSON.stringify(spec.context, null, 2)}`;

    const { provider, model, base_url } = this.cfg.model;
    const api_key = resolveApiKey(this.cfg);
    if (provider === 'anthropic') {
      const res = await fetch(`${base_url ?? 'https://api.anthropic.com'}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': api_key!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 8000,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      });
      const json = (await res.json()) as { content?: Array<{ text?: string }>; error?: { message?: string } };
      if (!res.ok) throw new Error(`Anthropic ${res.status}: ${json.error?.message ?? 'request failed'}`);
      return json.content?.map((c) => c.text ?? '').join('') ?? '';
    }

    // OpenRouter (and any OpenAI-compatible endpoint pointed at by base_url).
    const res = await fetch(`${base_url ?? 'https://openrouter.ai/api'}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${api_key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
      }),
    });
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    if (!res.ok) throw new Error(`Model ${res.status}: ${json.error?.message ?? 'request failed'}`);
    return json.choices?.[0]?.message?.content ?? '';
  }
}

/** Models occasionally wrap JSON in fences however firmly you ask them not to. */
export function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/[[{]/);
    const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error(`Model did not return JSON: ${text.slice(0, 200)}`);
  }
}
