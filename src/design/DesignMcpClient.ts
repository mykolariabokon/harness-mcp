import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Direct path to a design system: the harness itself speaks MCP to Design MCP.
 *
 * Needed where no host orchestrates the two servers (universal mode, autonomous
 * runs). Where the editor already has Design MCP connected, prefer the host path —
 * it hands the payload in through `harness_set_design_tokens` and no second
 * process is spawned. Both end up in the same normalized token set.
 */
export interface DesignMcpConfig {
  enabled?: boolean;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface DesignSystemPayload {
  tokens: unknown;
  rules: unknown;
}

export async function fetchDesignSystem(cfg: DesignMcpConfig): Promise<DesignSystemPayload> {
  const client = new Client({ name: 'harness-mcp', version: '0.1.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args ?? [],
    env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) },
  });

  await client.connect(transport);
  try {
    const [tokens, rules] = await Promise.all([
      call(client, 'get_tokens', { category: 'all' }),
      call(client, 'get_rules', { section: 'all' }),
    ]);
    return { tokens, rules };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = res.content?.find((c) => c.type === 'text')?.text;
  if (!text) throw new Error(`Design MCP returned no text content for ${name}.`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
