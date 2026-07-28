#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { callTool, setClientCapabilitiesProbe, setElicitor, TOOL_DEFS } from './tools.js';
import { HarnessService } from './HarnessService.js';

/**
 * Harness MCP — the project harness as the single source of truth.
 *
 * Speaks plain MCP over stdio, so it works the same in Peregrine, Claude Code,
 * Cursor or any other client. Everything project-specific arrives as
 * `project_path`; the server itself is stateless apart from the open databases.
 */

const server = new Server(
  { name: 'harness-mcp', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    // These reach EVERY session the server is registered for — including projects
    // that have no harness at all. So they must start by saying how to tell, and
    // must not push anyone into assembling one: an unwanted harness in a project
    // nobody asked to specify is worse than no harness.
    instructions:
      'Harness MCP holds a project harness — a durable specification a coding agent implements from. ' +
      'It is per-project: every tool takes an explicit project_path, and a project has a harness only if ' +
      '/harness exists in it. Check with harness_status; if there is none, say so and carry on normally — ' +
      'assemble one (harness_init / harness_reverse) only when the user asks for it.\n' +
      'Where a harness DOES exist it is the SOURCE OF TRUTH, not a mirror of the code: read it with ' +
      'harness_get_spec before writing code and implement from it. Never edit it directly and never work ' +
      'around it — a structure or design change is proposed with harness_propose_change (or harness_chat) ' +
      'and applied only after a human approves the diff.',
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const result = await callTool(name, (args ?? {}) as Record<string, unknown>);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }], isError: true };
  }
});

async function main(): Promise<void> {
  setClientCapabilitiesProbe(() => server.getClientCapabilities() as Record<string, unknown> | undefined);
  // The one place that knows how to ask the human. tools.ts stays free of the
  // Server instance, and a test can install a fake in its place.
  setElicitor((form) => server.elicitInput(form) as Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }>);
  await server.connect(new StdioServerTransport());

  // stdout is the protocol channel — diagnostics must go to stderr.
  //
  // Capabilities are NOT read here: `connect()` resolves once the pipe is open,
  // and the client sends `initialize` only afterwards, so anything read at this
  // point is empty. Measured the wrong moment once already and the log dutifully
  // reported "undeclared" for a client that had not been asked yet. The probe is
  // lazy instead, and harness_hello reports what it finds.
  console.error('harness-mcp ready (stdio)');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    HarnessService.closeAll();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('harness-mcp failed to start:', err);
  process.exit(1);
});
