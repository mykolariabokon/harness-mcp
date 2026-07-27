import path from 'node:path';
import { HarnessService } from './HarnessService.js';
import { harnessExists } from './paths.js';
import { apiKeySource, NO_HOST, saveConfig, universalModelReady, type HostCapabilities } from './config.js';
import {
  applyDraft,
  HARNESS_DRAFT_SCHEMA,
  initInstructions,
  reverseInstructions,
  type HarnessDraft,
} from './assembly.js';
import { checkDraft, MAX_ATTEMPTS, reworkInstructions, type QualityReport } from './assembly/quality.js';
import { scanCode } from './codeScan.js';
import { coerceTokens, rulesFromDesignMcp, type ImportedRule } from './design/tokens.js';
import { fetchDesignSystem } from './design/DesignMcpClient.js';
import { verifyHarness } from './verify.js';
import { renderHarnessHtml } from './render/html.js';
import { openBrowser, renderServer } from './render/server.js';
import type { GenerationOutcome } from './model/LlmBridge.js';
import type { ChangeOp, EntryType, SessionSummary } from './types.js';
import { ENTRY_TYPES } from './types.js';
import fs from 'node:fs';

/** Capabilities of the editor we are plugged into — set by `harness_hello`. */
let HOST: HostCapabilities = { ...NO_HOST };

/**
 * What the MCP client itself declared at connect time, as opposed to what the
 * editor claimed in `harness_hello`.
 *
 * The distinction matters for STEP-06: elicitation is a protocol capability the
 * client either has or does not, and branching on it must read the declaration
 * rather than the editor's name. Injected from index.ts so tools.ts stays free of
 * the server instance.
 */
let CLIENT_CAPS: () => Record<string, unknown> | undefined = () => undefined;

export function setClientCapabilitiesProbe(fn: () => Record<string, unknown> | undefined): void {
  CLIENT_CAPS = fn;
}

/** Does the client support being asked a question mid-call? */
function clientCanElicit(): boolean {
  return Boolean(CLIENT_CAPS()?.elicitation);
}

const PROJECT_PATH = {
  type: 'string',
  description: 'Absolute path to the project root. Always pass it explicitly.',
} as const;

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties: props,
  required,
});

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'harness_hello',
    description:
      'Handshake. The editor announces what it can lend the harness: its own agent model (native mode — no API key needed) ' +
      'and a webview panel (native render). Call once at session start. Without it the harness assumes a bare MCP client ' +
      'and falls back to its own model from config.json plus a browser window.',
    inputSchema: obj({
      editor: { type: 'string', description: 'Editor name, e.g. "peregrine", "cursor", "claude-code".' },
      agent_model: { type: 'boolean', description: 'The editor agent will fulfil generation requests with its own model.' },
      webview: { type: 'boolean', description: 'The editor can display returned HTML in a panel.' },
      project_path: PROJECT_PATH,
    }),
  },
  {
    name: 'harness_status',
    description: 'What the harness currently holds: entry counts, design rules, pending changes, open questions.',
    inputSchema: obj({ project_path: PROJECT_PATH }, ['project_path']),
  },
  {
    name: 'harness_init',
    description:
      'Create /harness and assemble the initial harness for a NEW project from the user description. ' +
      'One-time: once a harness exists, changes go through harness_propose_change and human approval.',
    inputSchema: obj(
      {
        project_path: PROJECT_PATH,
        description: { type: 'string', description: "The user's description of the project to build." },
        project_name: { type: 'string' },
      },
      ['project_path', 'description'],
    ),
  },
  {
    name: 'harness_reverse',
    description:
      'Create /harness and reverse-assemble the harness from EXISTING code. Code is the evidence and wins over stale docs; ' +
      'inferred intent is marked [assumption] with a question for the human. Pass ProjectMind analysis in `analysis` when available.',
    inputSchema: obj(
      {
        project_path: PROJECT_PATH,
        hint: { type: 'string', description: 'Extra context: roadmap, product intent, anything the code cannot contain.' },
        analysis: {
          type: 'object',
          description: 'Optional richer analysis (e.g. ProjectMind MCP overview / symbol graph) to use instead of a shallow scan.',
        },
      },
      ['project_path'],
    ),
  },
  {
    name: 'harness_submit_generation',
    description:
      'Native mode callback: the editor agent ran the requested generation with its own model and returns the result here. ' +
      'The request_id comes from a previous tool call that answered with status "needs_agent".',
    inputSchema: obj(
      {
        project_path: PROJECT_PATH,
        request_id: { type: 'integer' },
        result: { type: 'object', description: 'The JSON matching the schema that came with the request.' },
      },
      ['project_path', 'request_id', 'result'],
    ),
  },
  {
    name: 'harness_get_spec',
    description:
      'Read the harness. The agent implements FROM this and must not depart from it. ' +
      'Call it before writing code; the constitution belongs in every turn.',
    inputSchema: obj(
      {
        project_path: PROJECT_PATH,
        type: { enum: [...ENTRY_TYPES, 'all'], description: 'Restrict to one section. Default: all.' },
        format: { enum: ['json', 'markdown'], description: 'Default json.' },
      },
      ['project_path'],
    ),
  },
  {
    name: 'harness_chat',
    description:
      'The way a human edits the harness with words: "make the buttons green", "move the sidebar left". ' +
      'Turns the message into proposed harness changes — queued for approval, never applied directly. ' +
      'Uses the editor model (native) or the configured model (universal).',
    inputSchema: obj(
      { project_path: PROJECT_PATH, message: { type: 'string' } },
      ['project_path', 'message'],
    ),
  },
  {
    name: 'harness_propose_structure',
    description:
      'Generate or extend the project structure (modules, entities, screens, flows) from an instruction. ' +
      'Result lands in pending changes for review.',
    inputSchema: obj(
      { project_path: PROJECT_PATH, instruction: { type: 'string' } },
      ['project_path', 'instruction'],
    ),
  },
  {
    name: 'harness_propose_change',
    description:
      'Propose one precise change to the harness without involving a model. The change is NOT applied — ' +
      'it waits in pending_changes with a diff for a human to accept or reject.',
    inputSchema: obj(
      {
        project_path: PROJECT_PATH,
        target: { enum: ['entry', 'design_rule'] },
        op: { enum: ['create', 'update', 'delete'] },
        entry_type: { enum: ENTRY_TYPES, description: 'Required when target is "entry".' },
        key: { type: 'string', description: 'Entry key, or the design rule id when target is "design_rule".' },
        title: { type: 'string' },
        body: { type: 'string' },
        data: { type: 'object', description: 'Entry payload: kind, parent, path, layout, verify, why.' },
        phase: { type: 'integer' },
        rule: { type: 'string', description: 'Design rule text (target "design_rule").' },
        scope: { type: 'string' },
        rationale: { type: 'string', description: 'Why this change — shown to the human on the review screen.' },
      },
      ['project_path', 'target', 'op', 'rationale'],
    ),
  },
  {
    name: 'harness_add_design_rule',
    description:
      'Record a design rule ("all buttons have an 8px radius"). Once approved it applies GLOBALLY to the whole project — ' +
      'the agent must satisfy it in any UI it writes. Optionally attach a machine check so harness_verify can enforce it.',
    inputSchema: obj(
      {
        project_path: PROJECT_PATH,
        rule: { type: 'string' },
        scope: { type: 'string', description: 'Default "global". Otherwise a component/screen key.' },
        check: obj({
          glob: { type: 'string', description: 'e.g. "src/**/*.tsx"' },
          pattern: { type: 'string', description: 'Regex source.' },
          forbidden: { type: 'boolean', description: 'true: a match is a violation. false: absence is a violation.' },
        }),
        apply_now: {
          type: 'boolean',
          description: 'Skip review and apply immediately. Only for a rule the human just dictated. Default false.',
        },
      },
      ['project_path', 'rule'],
    ),
  },
  {
    name: 'harness_set_design_tokens',
    description:
      "Host path to a design system: pass the payload of Design MCP's get_tokens({category:\"all\"}) (or an already " +
      'normalized token set) and the mockup renders in the project\'s own visual language instead of a grey skeleton. ' +
      'Optionally pass the get_rules payload as `rules` to queue the design-system rules for approval.',
    inputSchema: obj(
      {
        project_path: PROJECT_PATH,
        tokens: { type: 'object', description: 'Design MCP get_tokens payload, or a normalized DesignTokens object.' },
        rules: { type: 'object', description: 'Optional Design MCP get_rules payload to import as global design rules.' },
        source: { type: 'string', description: 'Where the tokens came from. Default "design-mcp".' },
      },
      ['project_path', 'tokens'],
    ),
  },
  {
    name: 'harness_sync_design_system',
    description:
      'Direct path to a design system: the harness itself connects to the Design MCP server configured in ' +
      'config.json (design_mcp.command/args), pulls tokens and rules, stores the tokens and queues the rules for ' +
      'approval. Use where no host wires the two servers together; otherwise prefer harness_set_design_tokens.',
    inputSchema: obj(
      {
        project_path: PROJECT_PATH,
        import_rules: { type: 'boolean', description: 'Queue the design-system rules as pending changes. Default true.' },
      },
      ['project_path'],
    ),
  },
  {
    name: 'harness_history',
    description:
      'The decision record: every approval and rejection with the change it decided, who decided, when, and any note — ' +
      'plus the stored session summaries. The harness says WHAT the project is; this says why it says that, and when ' +
      'it was settled. Read it before re-opening a question that already has an answer.',
    inputSchema: obj(
      {
        project_path: PROJECT_PATH,
        limit: { type: 'integer', description: 'How many entries per section. Default 50.' },
        include: { enum: ['approvals', 'sessions', 'all'], description: 'Default "all".' },
      },
      ['project_path'],
    ),
  },
  {
    name: 'harness_list_pending',
    description: 'Pending changes with their diffs, plus the unapproved-count badge.',
    inputSchema: obj(
      { project_path: PROJECT_PATH, status: { enum: ['pending', 'approved', 'rejected', 'all'] } },
      ['project_path'],
    ),
  },
  {
    name: 'harness_approve',
    description:
      'A human accepts a pending change: it is applied to the harness, the markdown spec is rewritten, ' +
      'and a checkpoint is taken first so it can be rolled back. Agents must not call this on their own behalf.',
    inputSchema: obj(
      {
        project_path: PROJECT_PATH,
        change_id: { type: 'integer' },
        change_ids: { type: 'array', items: { type: 'integer' }, description: 'Approve several at once.' },
        note: { type: 'string' },
        actor: { type: 'string', description: 'Default "human".' },
      },
      ['project_path'],
    ),
  },
  {
    name: 'harness_reject',
    description: 'A human rejects a pending change. Nothing is applied; the reason is kept in the approval history.',
    inputSchema: obj(
      {
        project_path: PROJECT_PATH,
        change_id: { type: 'integer' },
        change_ids: { type: 'array', items: { type: 'integer' } },
        note: { type: 'string' },
        actor: { type: 'string' },
      },
      ['project_path'],
    ),
  },
  {
    name: 'summarize_session_to_harness',
    description:
      'Bridge between the ephemeral chat and the durable spec. The editor agent returns a STRUCTURED summary of the ' +
      'current session — completed_tasks, decisions, open_questions, touched_files — which is stored and turned into ' +
      'per-item proposals a human approves point by point. Amorphous prose is rejected.',
    inputSchema: obj(
      {
        project_path: PROJECT_PATH,
        completed_tasks: { type: 'array', items: { type: 'string' } },
        decisions: { type: 'array', items: { type: 'string' } },
        open_questions: { type: 'array', items: { type: 'string' } },
        touched_files: { type: 'array', items: { type: 'string' } },
      },
      ['project_path', 'completed_tasks', 'decisions', 'open_questions', 'touched_files'],
    ),
  },
  {
    name: 'harness_render',
    description:
      'Render the structure + mockup visualization. Returns HTML for a webview (native hosts) or serves it on ' +
      'localhost and opens a browser (everywhere else). The picture is an output: critique goes back in words through harness_chat.',
    inputSchema: obj(
      {
        project_path: PROJECT_PATH,
        focus: { enum: ['structure', 'mockup', 'spec', 'review'] },
        output: { enum: ['auto', 'webview', 'browser'] },
      },
      ['project_path'],
    ),
  },
  {
    name: 'harness_verify',
    description:
      'On demand only: compare the real code against the harness and report divergences. ' +
      'The harness is never redrawn from code — this is the safety net for when the agent drifted.',
    inputSchema: obj({ project_path: PROJECT_PATH }, ['project_path']),
  },
  {
    name: 'harness_configure',
    description:
      'Read or update /harness/config.json — the model for universal mode (provider, model, api_key) and render preferences.',
    inputSchema: obj(
      {
        project_path: PROJECT_PATH,
        model: obj({
          mode: { enum: ['auto', 'native', 'universal'] },
          provider: { enum: ['openrouter', 'anthropic'] },
          model: { type: 'string' },
          api_key: { type: 'string' },
          base_url: { type: 'string' },
        }),
        render: obj({ output: { enum: ['auto', 'webview', 'browser'] }, port: { type: 'integer' } }),
        design_mcp: obj({
          enabled: { type: 'boolean' },
          command: { type: 'string', description: 'e.g. "node"' },
          args: { type: 'array', items: { type: 'string' }, description: 'e.g. ["F:/Projects/09012026/Design-MCP/dist/index.js"]' },
          env: { type: 'object' },
        }),
      },
      ['project_path'],
    ),
  },
  {
    name: 'harness_checkpoint',
    description: 'Take a rollback point, list them, or restore one.',
    inputSchema: obj(
      {
        project_path: PROJECT_PATH,
        action: { enum: ['create', 'list', 'restore'] },
        label: { type: 'string' },
        checkpoint_id: { type: 'integer' },
      },
      ['project_path', 'action'],
    ),
  },
];

// ---------------------------------------------------------------- dispatch

type Args = Record<string, any>;

export async function callTool(name: string, args: Args): Promise<unknown> {
  switch (name) {
    case 'harness_hello':
      return hello(args);
    case 'harness_status':
      return open(args).status();
    case 'harness_init':
      return init(args);
    case 'harness_reverse':
      return reverse(args);
    case 'harness_submit_generation':
      return submitGeneration(args);
    case 'harness_get_spec':
      return getSpec(args);
    case 'harness_chat':
      return chat(args, args.message, 'chat');
    case 'harness_propose_structure':
      return chat(args, args.instruction, 'structure');
    case 'harness_propose_change':
      return proposeChange(args);
    case 'harness_add_design_rule':
      return addDesignRule(args);
    case 'harness_set_design_tokens':
      return setDesignTokens(args);
    case 'harness_sync_design_system':
      return syncDesignSystem(args);
    case 'harness_history':
      return history(args);
    case 'harness_list_pending':
      return listPending(args);
    case 'harness_approve':
      return decide(args, 'approve');
    case 'harness_reject':
      return decide(args, 'reject');
    case 'summarize_session_to_harness':
      return summarize(args);
    case 'harness_render':
      return render(args);
    case 'harness_verify':
      return verify(args);
    case 'harness_configure':
      return configure(args);
    case 'harness_checkpoint':
      return checkpoint(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function open(args: Args, create = false): HarnessService {
  if (!args.project_path) throw new Error('project_path is required.');
  return HarnessService.open(args.project_path, create);
}

const projectName = (root: string) => path.basename(path.resolve(root));

// ------------------------------------------------------------------ tools

function hello(args: Args) {
  HOST = {
    agent_model: Boolean(args.agent_model),
    webview: Boolean(args.webview),
    name: args.editor ?? null,
  };
  const result: Record<string, unknown> = {
    host: HOST,
    model_source: HOST.agent_model
      ? 'native — the harness will hand generation back to your agent via status "needs_agent"'
      : 'universal — the harness will use the model in /harness/config.json',
    render_output: HOST.webview ? 'webview — HTML is returned to you' : 'browser — served on localhost',
  };
  if (args.project_path && harnessExists(args.project_path)) {
    result.status = HarnessService.open(args.project_path).status();
  } else if (args.project_path) {
    result.status = 'no harness yet — run harness_init or harness_reverse';
  }
  return result;
}

async function init(args: Args) {
  const svc = HarnessService.open(args.project_path, true);
  if (!svc.isEmpty()) {
    return {
      error: 'A harness already exists for this project.',
      hint: 'The harness is assembled once and then edited through harness_chat / harness_propose_change with human approval.',
      status: svc.status(),
    };
  }
  const name = args.project_name ?? projectName(args.project_path);
  return runAssembly(svc, 'init', initInstructions(String(args.description), name), {
    project_name: name,
    project_path: svc.paths.projectRoot,
  });
}

async function reverse(args: Args) {
  const svc = HarnessService.open(args.project_path, true);
  if (!svc.isEmpty()) {
    return {
      error: 'A harness already exists for this project.',
      hint: 'Use harness_verify to compare it with the code; use harness_chat to change it.',
      status: svc.status(),
    };
  }
  const name = projectName(args.project_path);
  const inventory = args.analysis ?? scanCode(svc.paths.projectRoot);
  return runAssembly(svc, 'reverse', reverseInstructions(name, args.hint ?? null), {
    project_name: name,
    inventory,
  });
}

/**
 * Both assembly paths converge here — native hands the work to the editor's agent,
 * universal calls the configured model — and both results go through the same
 * quality gate before anything is written.
 */
async function runAssembly(
  svc: HarnessService,
  purpose: string,
  originalInstructions: string,
  baseContext: Record<string, unknown>,
  instructions: string = originalInstructions,
  attempt = 1,
): Promise<unknown> {
  const context = { ...baseContext, attempt, original_instructions: originalInstructions };
  const outcome: GenerationOutcome = await svc
    .bridge(HOST)
    .generate({ purpose, instructions, schema: HARNESS_DRAFT_SCHEMA, context });

  if (outcome.status === 'needs_agent') {
    return {
      status: 'needs_agent',
      purpose,
      attempt,
      request_id: outcome.request_id,
      instructions: outcome.instructions,
      schema: outcome.schema,
      context: outcome.context,
      next: 'Produce the JSON with your own model, then call harness_submit_generation with this request_id.',
      note: 'The result is checked before it is written: a flat structure, an orphan parent, or an assumption without a question comes back for rework.',
    };
  }
  if (outcome.status === 'not_configured') return { status: 'not_configured', reason: outcome.reason };
  return gradeAndApply(svc, outcome.data as HarnessDraft, purpose, originalInstructions, baseContext, attempt, true);
}

/**
 * Grade the draft, then either write it, send it back, or — once the attempts are
 * spent — write it anyway with its problems recorded. Never silently, never fixed
 * by guesswork.
 */
async function gradeAndApply(
  svc: HarnessService,
  draft: HarnessDraft,
  purpose: string,
  originalInstructions: string,
  baseContext: Record<string, unknown>,
  attempt: number,
  canRetryInline: boolean,
): Promise<unknown> {
  const report = checkDraft(draft);
  if (report.ok || attempt >= MAX_ATTEMPTS) return applyAssembly(svc, draft, purpose, report, attempt);

  const next = attempt + 1;
  const nextInstructions = reworkInstructions(originalInstructions, report, next);

  // Universal mode owns the model, so it just asks again.
  if (canRetryInline) {
    return runAssembly(svc, purpose, originalInstructions, baseContext, nextInstructions, next);
  }

  // Native mode: the editor's agent does the rework and resubmits.
  const req = svc.db.openGeneration(purpose, nextInstructions, HARNESS_DRAFT_SCHEMA, {
    ...baseContext,
    attempt: next,
    original_instructions: originalInstructions,
  });
  return {
    status: 'rework_needed',
    purpose,
    attempt: next,
    rejected_because: report.errors,
    warnings: report.warnings,
    request_id: req.id,
    instructions: nextInstructions,
    schema: HARNESS_DRAFT_SCHEMA,
    next: `Nothing was written. Fix the problems above and call harness_submit_generation with request_id ${req.id}. This is the last attempt before the draft is accepted as it stands.`,
  };
}

function applyAssembly(
  svc: HarnessService,
  draft: HarnessDraft,
  purpose: string,
  report: QualityReport = { errors: [], warnings: [], ok: true },
  attempt = 1,
) {
  const applied = applyDraft(svc.db, draft);

  // Out of attempts but still not right: the harness gets written, and the fact
  // that it was written under protest becomes part of it — visible in
  // CONSTITUTION.md, so nobody approves it later believing it was clean.
  if (!report.ok) {
    svc.db.upsertEntry({
      type: 'decision',
      key: 'assembly-quality',
      title: 'Harness accepted with unresolved assembly problems',
      body: [
        `The ${purpose} assembly was accepted after ${attempt} attempts without these being fixed:`,
        ...report.errors.map((e) => `- ${e}`),
        '',
        'Fix them through harness_chat — the structure below is not trustworthy until you do.',
      ].join('\n'),
      confidence: 'assumption',
      question: 'The generated structure did not meet the quality bar. Rebuild it, or correct it by hand?',
    });
  }

  svc.db.createCheckpoint(`${purpose} assembly`);
  const files = svc.syncSpecFiles();
  return {
    status: report.ok ? 'assembled' : 'assembled_with_problems',
    purpose,
    attempts: attempt,
    harness_dir: svc.paths.dir,
    ...applied,
    problems: report.errors,
    warnings: report.warnings,
    spec_files: files,
    open_questions: svc.status().open_questions,
    next: report.ok
      ? 'Show it to the human with harness_render, then refine through harness_chat — every change goes through approval.'
      : 'Show it to the human with harness_render and say plainly that the structure did not pass its own quality check.',
  };
}

async function submitGeneration(args: Args) {
  const svc = open(args);
  const req = svc.db.getGeneration(Number(args.request_id));
  if (!req) throw new Error(`Generation request #${args.request_id} not found.`);
  if (req.status === 'closed') throw new Error(`Generation request #${args.request_id} was already fulfilled.`);
  svc.db.closeGeneration(req.id, args.result);

  if (req.purpose === 'init' || req.purpose === 'reverse') {
    const ctx = (req.context ?? {}) as Record<string, unknown>;
    return gradeAndApply(
      svc,
      args.result as HarnessDraft,
      req.purpose,
      String(ctx.original_instructions ?? req.instructions),
      ctx,
      Number(ctx.attempt ?? 1),
      false,
    );
  }
  return queueChanges(svc, args.result as ChangeSet, req.purpose);
}

function getSpec(args: Args) {
  const svc = open(args);
  const type = args.type && args.type !== 'all' ? (args.type as EntryType) : undefined;

  if (args.format === 'markdown') {
    const files = [svc.paths.constitution, svc.paths.structure, svc.paths.design, svc.paths.spec];
    const out: Record<string, string> = {};
    for (const f of files) if (fs.existsSync(f)) out[path.basename(f)] = fs.readFileSync(f, 'utf8');
    if (fs.existsSync(svc.paths.tasks)) {
      for (const f of fs.readdirSync(svc.paths.tasks)) {
        out[`tasks/${f}`] = fs.readFileSync(path.join(svc.paths.tasks, f), 'utf8');
      }
    }
    return out;
  }

  return {
    entries: svc.db.listEntries(type),
    design_rules: type && type !== 'design' ? undefined : svc.db.listDesignRules(),
    pending_changes: svc.db.pendingCount(),
    reminder:
      'Implement from this. Do not depart from it: a design or structure change belongs in the harness ' +
      '(harness_propose_change), not straight into the code.',
  };
}

// The shape a model returns when asked to turn words into harness edits.
interface ChangeSet {
  changes?: Array<{
    target?: 'entry' | 'design_rule';
    op?: ChangeOp;
    entry_type?: EntryType;
    key?: string;
    title?: string;
    body?: string;
    data?: Record<string, unknown>;
    phase?: number;
    rule?: string;
    scope?: string;
    rationale?: string;
  }>;
  reply?: string;
}

const CHANGESET_SCHEMA = {
  type: 'object',
  required: ['changes'],
  properties: {
    reply: { type: 'string', description: 'One or two sentences back to the human about what you propose.' },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['target', 'op', 'rationale'],
        properties: {
          target: { enum: ['entry', 'design_rule'] },
          op: { enum: ['create', 'update', 'delete'] },
          entry_type: { enum: ENTRY_TYPES },
          key: { type: 'string', description: 'Existing key to update, or a new slug. For design_rule: the rule id.' },
          title: { type: 'string' },
          body: { type: 'string' },
          data: { type: 'object', description: 'kind, parent, path, layout, verify, why' },
          phase: { type: 'integer' },
          rule: { type: 'string' },
          scope: { type: 'string' },
          rationale: { type: 'string' },
        },
      },
    },
  },
} as const;

async function chat(args: Args, message: string, purpose: string) {
  const svc = open(args);
  if (!message) throw new Error('message is required.');

  const instructions = [
    purpose === 'structure'
      ? 'Extend or revise the project STRUCTURE according to the instruction below.'
      : 'The human is editing the harness with words. Turn the message below into precise harness changes.',
    '',
    'The harness is the source of truth: a change here becomes a permanent rule for the whole project,',
    'and code is written from it afterwards. Never propose a code edit — propose the harness edit.',
    'A styling wish that should hold everywhere ("buttons are green") is a design_rule, not a per-screen note.',
    'Reuse existing keys when revising; only invent a key for something genuinely new.',
    '',
    `Message: ${message}`,
  ].join('\n');

  const outcome = await svc.bridge(HOST).generate({
    purpose,
    instructions,
    schema: CHANGESET_SCHEMA,
    context: {
      structure: svc.db.listEntries('structure'),
      design: svc.db.listEntries('design'),
      design_rules: svc.db.listDesignRules(),
      requirements: svc.db.listEntries('requirement'),
    },
  });

  if (outcome.status === 'needs_agent') {
    return {
      status: 'needs_agent',
      purpose,
      request_id: outcome.request_id,
      instructions: outcome.instructions,
      schema: outcome.schema,
      context: outcome.context,
      next: 'Produce the JSON with your own model, then call harness_submit_generation with this request_id.',
    };
  }
  if (outcome.status === 'not_configured') return { status: 'not_configured', reason: outcome.reason };
  return queueChanges(svc, outcome.data as ChangeSet, purpose);
}

function queueChanges(svc: HarnessService, set: ChangeSet, source: string) {
  const queued = [];
  for (const c of set.changes ?? []) {
    const rationale = c.rationale ?? '';
    if (c.target === 'design_rule') {
      queued.push(
        svc.proposeDesignRule(
          c.op ?? 'create',
          c.key ?? 'new',
          { rule: c.rule ?? c.title ?? c.body, scope: c.scope },
          rationale,
          source,
        ),
      );
    } else {
      if (!c.entry_type || !c.key) continue;
      queued.push(
        svc.proposeEntry(
          c.entry_type,
          c.key,
          c.op ?? 'update',
          { title: c.title, body: c.body, data: c.data as never, phase: c.phase },
          rationale,
          source,
        ),
      );
    }
  }
  return {
    status: 'pending_review',
    reply: set.reply ?? null,
    queued: queued.map((q) => ({ id: q.id, op: q.op, ref: q.ref, rationale: q.rationale, diff: q.diff })),
    pending_total: svc.db.pendingCount(),
    next: 'Nothing changed yet. Show the diffs (harness_render focus="review") and let the human approve or reject.',
  };
}

function proposeChange(args: Args) {
  const svc = open(args);
  const change =
    args.target === 'design_rule'
      ? svc.proposeDesignRule(
          args.op as ChangeOp,
          args.key ?? 'new',
          { rule: args.rule ?? args.title, scope: args.scope, check: args.check ?? null },
          args.rationale,
          args.source ?? 'agent',
        )
      : svc.proposeEntry(
          args.entry_type as EntryType,
          args.key,
          args.op as ChangeOp,
          { title: args.title, body: args.body, data: args.data, phase: args.phase },
          args.rationale,
          args.source ?? 'agent',
        );
  return {
    status: 'pending_review',
    change: { id: change.id, op: change.op, ref: change.ref, diff: change.diff },
    pending_total: svc.db.pendingCount(),
    next: 'Not applied. A human must call harness_approve or harness_reject.',
  };
}

function addDesignRule(args: Args) {
  const svc = open(args);
  const check = args.check?.glob && args.check?.pattern ? args.check : null;

  if (args.apply_now) {
    const rule = svc.db.addDesignRule(args.rule, args.scope ?? 'global', check);
    const files = svc.syncSpecFiles();
    return {
      status: 'applied',
      rule,
      spec_files: files,
      note: 'Applies globally: every screen and component in this project must satisfy it from now on.',
    };
  }

  const change = svc.proposeDesignRule('create', 'new', { rule: args.rule, scope: args.scope ?? 'global', check }, args.rationale ?? 'New global design rule.');
  return {
    status: 'pending_review',
    change: { id: change.id, diff: change.diff },
    pending_total: svc.db.pendingCount(),
    next: 'A human approves it, then it applies to the whole project.',
  };
}

function setDesignTokens(args: Args) {
  const svc = open(args);
  const tokens = coerceTokens(args.tokens, args.source ?? 'design-mcp');
  svc.db.setDesignTokens(tokens);
  const queued = args.rules ? queueDesignRules(svc, rulesFromDesignMcp(args.rules), tokens.source) : [];
  return {
    status: 'stored',
    source: tokens.source,
    tokens: { ...tokens, raw: undefined },
    imported_rules: queued.length,
    queued: queued.map((c) => ({ id: c.id, diff: c.diff })),
    pending_total: svc.db.pendingCount(),
    next: 'harness_render now paints the mockup in these tokens. Imported rules wait for approval.',
  };
}

async function syncDesignSystem(args: Args) {
  const svc = open(args);
  const cfg = svc.config.design_mcp;
  if (!cfg.command) {
    return {
      status: 'not_configured',
      reason:
        'No design system server in /harness/config.json. Set design_mcp.command (and args) with harness_configure, ' +
        'or have your editor pass the payload in through harness_set_design_tokens.',
    };
  }

  const payload = await fetchDesignSystem({ command: cfg.command, args: cfg.args, env: cfg.env });
  const tokens = coerceTokens(payload.tokens, 'design-mcp');
  svc.db.setDesignTokens(tokens);

  const importRules = args.import_rules !== false;
  const queued = importRules ? queueDesignRules(svc, rulesFromDesignMcp(payload.rules), 'design-mcp') : [];
  return {
    status: 'synced',
    source: tokens.source,
    tokens: { ...tokens, raw: undefined },
    imported_rules: queued.length,
    queued: queued.map((c) => ({ id: c.id, diff: c.diff })),
    pending_total: svc.db.pendingCount(),
    next: 'Rules are proposals, not facts — a human approves the ones that belong in this project.',
  };
}

/** Design-system rules enter through the same approval queue as everything else. */
function queueDesignRules(svc: HarnessService, rules: ImportedRule[], source: string) {
  const existing = new Set(svc.db.listDesignRules(true).map((r) => r.rule));
  const alreadyQueued = new Set(
    svc.db
      .listPending('pending')
      .filter((c) => c.target === 'design_rule')
      .map((c) => (c.after as { rule?: string } | null)?.rule),
  );
  return rules
    .filter((r) => !existing.has(r.rule) && !alreadyQueued.has(r.rule))
    .map((r) =>
      svc.proposeDesignRule('create', 'new', r, `Imported from ${source}.`, `design-system:${source}`),
    );
}

/**
 * The decision record (REQ-013).
 *
 * Approvals were being written on every decision and read by nothing — the table
 * was write-only, so the harness recorded accountability nobody could exercise.
 *
 * An approval on its own says "change 5 was approved", which means nothing once
 * the queue has moved on, so each one is joined back to the change it decided.
 * That is the whole point: the record has to answer "why is the harness like
 * this", not just "something was approved".
 */
function history(args: Args) {
  const svc = open(args);
  const limit = Number(args.limit ?? 50);
  const include = (args.include ?? 'all') as 'approvals' | 'sessions' | 'all';
  const out: Record<string, unknown> = {};

  if (include !== 'sessions') {
    out.approvals = svc.db.listApprovals(limit).map((a) => {
      const change = svc.db.getChange(a.change_id);
      return {
        decided_at: a.created_at,
        decision: a.decision,
        actor: a.actor,
        note: a.note,
        change_id: a.change_id,
        // Null when the change predates a checkpoint restore, which wipes the
        // queue but keeps the approvals: say so rather than imply it never existed.
        ref: change?.ref ?? null,
        op: change?.op ?? null,
        rationale: change?.rationale ?? null,
      };
    });
  }
  if (include !== 'approvals') out.sessions = svc.db.listSessionSummaries(limit);

  return {
    ...out,
    checkpoints: svc.db.listCheckpoints(),
    note:
      'This is the record of decisions already made. A question answered here does not need re-deciding — ' +
      'and a change that contradicts one should say why.',
  };
}

function listPending(args: Args) {
  const svc = open(args);
  const list = svc.db.listPending(args.status ?? 'pending');
  return { badge: svc.db.pendingCount(), changes: list };
}

function decide(args: Args, kind: 'approve' | 'reject') {
  const svc = open(args);
  const ids: number[] = args.change_ids ?? (args.change_id !== undefined ? [args.change_id] : []);
  if (!ids.length) throw new Error('Pass change_id or change_ids.');

  const actor = args.actor ?? 'human';
  const results = ids.map((id) => {
    if (kind === 'approve') {
      const { change, files } = svc.approve(id, actor, args.note ?? null);
      return { id, status: change.status, ref: change.ref, spec_files: files };
    }
    const change = svc.reject(id, actor, args.note ?? null);
    return { id, status: change.status, ref: change.ref };
  });
  return { results, pending_total: svc.db.pendingCount() };
}

function summarize(args: Args) {
  const svc = open(args);
  const summary: SessionSummary = {
    completed_tasks: asArray(args.completed_tasks),
    decisions: asArray(args.decisions),
    open_questions: asArray(args.open_questions),
    touched_files: asArray(args.touched_files),
  };
  const id = svc.db.addSessionSummary(summary);

  // Each decision becomes its own reviewable item — that is the difference between
  // "the agent wrote something" and a specification a human approves point by point.
  const stamp = new Date().toISOString().slice(0, 10);
  const queued = summary.decisions.map((text, i) =>
    svc.proposeEntry(
      'decision',
      `session-${id}-${i + 1}`,
      'create',
      { title: firstSentence(text), body: text, data: { session: id, date: stamp, touched_files: summary.touched_files } as never },
      `Recorded from the session summary of ${stamp}.`,
      'session-summary',
    ),
  );

  const questions = summary.open_questions.map((q, i) =>
    svc.proposeEntry(
      'decision',
      `question-${id}-${i + 1}`,
      'create',
      { title: firstSentence(q), body: q, confidence: 'assumption', question: q },
      'Open question raised during the session — needs a human answer before it becomes a rule.',
      'session-summary',
    ),
  );

  return {
    status: 'pending_review',
    session_id: id,
    summary,
    queued: [...queued, ...questions].map((c) => ({ id: c.id, ref: c.ref, diff: c.diff })),
    pending_total: svc.db.pendingCount(),
    next: 'Approve the items that belong in the harness; reject the rest. Completed tasks and touched files are kept as history.',
  };
}

async function render(args: Args) {
  const svc = open(args);
  const html = renderHarnessHtml(svc.db, { projectName: projectName(args.project_path), focus: args.focus });
  const cached = path.join(svc.paths.cache, 'render.html');
  fs.writeFileSync(cached, html, 'utf8');

  const output = args.output && args.output !== 'auto' ? args.output : svc.renderOutput(HOST);
  if (output === 'webview') {
    return {
      output: 'webview',
      html,
      file: cached,
      note: 'Display this HTML in your panel. It is read-only: critique comes back through harness_chat in words.',
    };
  }

  const url = await renderServer.serve(html, svc.config.render.port);
  const opened = openBrowser(url);
  return {
    output: 'browser',
    url,
    opened,
    file: cached,
    note: opened ? 'Opened in the default browser.' : `Open ${url} manually.`,
  };
}

function verify(args: Args) {
  const svc = open(args);
  const report = verifyHarness(svc.db, svc.paths.projectRoot);
  return {
    ...report,
    note: report.in_sync
      ? 'Code matches the harness.'
      : 'Divergences found. The harness is not redrawn from code — either fix the code, or propose a harness change and have it approved.',
  };
}

function configure(args: Args) {
  // Creates /harness if needed: the mode and the model must be settable BEFORE the
  // first assembly, otherwise harness_init has no model to reach for.
  const svc = open(args, true);
  if (args.model || args.render || args.design_mcp) {
    svc.config = {
      ...svc.config,
      model: { ...svc.config.model, ...(args.model ?? {}) },
      render: { ...svc.config.render, ...(args.render ?? {}) },
      design_mcp: { ...svc.config.design_mcp, ...(args.design_mcp ?? {}) },
    };
    saveConfig(svc.paths, svc.config);
  }
  // The key never leaves this process — not in a tool result, not in a log.
  const redacted = { ...svc.config, model: { ...svc.config.model, api_key: svc.config.model.api_key ? '***' : null } };
  return {
    config: redacted,
    resolved_model_mode: svc.modelMode(HOST),
    resolved_render_output: svc.renderOutput(HOST),
    universal_model_ready: universalModelReady(svc.config),
    api_key_source: apiKeySource(svc.config),
    host: HOST,
  };
}

function checkpoint(args: Args) {
  const svc = open(args);
  if (args.action === 'create') return svc.db.createCheckpoint(args.label ?? 'manual');
  if (args.action === 'list') return { checkpoints: svc.db.listCheckpoints() };
  if (args.action === 'restore') {
    if (args.checkpoint_id === undefined) throw new Error('checkpoint_id is required to restore.');
    svc.db.restoreCheckpoint(Number(args.checkpoint_id));
    return { status: 'restored', checkpoint_id: args.checkpoint_id, spec_files: svc.syncSpecFiles() };
  }
  throw new Error(`Unknown action: ${args.action}`);
}

const asArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const firstSentence = (s: string) => {
  const t = s.trim().split(/(?<=[.!?])\s/)[0] ?? s;
  return t.length > 80 ? `${t.slice(0, 77)}...` : t;
};
