# Harness MCP

**A durable project specification that a coding agent implements from — and cannot
quietly rewrite.**

An MCP server that owns the *harness*: your project's constitution, structure,
design rules, requirements and phased tasks. The agent reads it, writes code from
it, and may only **propose** changes to it. Nothing enters the harness until a
human accepts a diff.

Zero native dependencies · one runtime package · 21 tools · 103 tests · MIT

---

## The problem

You write a spec, the agent reads it, and forty turns later the code and the spec
have quietly parted ways. Not because anyone lied — because every reasonable local
decision ("this component needs a different radius", "let me put the API layer
here") is invisible until it accumulates. Then the spec is a historical document
and the only source of truth is whatever the code happens to say.

Regenerating the spec from the code does not fix this. It *ratifies* the drift: the
spec becomes a mirror, and a mirror cannot disagree with you.

## The principle

**The harness is the source of truth, not a mirror of the code.**

- It is assembled **once** — from your description for a new project
  (`harness_init`), or reverse-engineered from the code for an existing one
  (`harness_reverse`).
- After that it is **edited**, and every edit passes through **human approval**.
  An agent can only propose: the change lands in `pending_changes` with a diff,
  and is applied when a person accepts it.
- The agent writes code **from** the harness. A design or structure decision goes
  **into** the harness — where it becomes a permanent, project-wide rule — never
  straight into the code.
- Drift is therefore structurally impossible: the only route to a structural change
  is an approved harness change. `harness_verify` exists as a safety net, on
  demand, and never redraws the harness from code.

```
  new project                    existing project
  idea, in words                 code on disk
        │                              │
   harness_init                 harness_reverse
        └──────────────┬───────────────┘
                       ▼
        CONSTITUTION · STRUCTURE · DESIGN · SPEC · tasks/
                       │
        the agent implements FROM this
                       │
   "make the buttons green"  ──►  harness_chat
                       │              │
                       │       pending change + diff
                       │              │
                       │       human approves ──► permanent project-wide rule
                       │
        harness_verify  ──►  where the code and the harness disagree
```

## Quick start

Requires **Node 18+**.

```bash
git clone https://github.com/mykolariabokon/harness-mcp.git
cd harness-mcp
npm install
npm run build
```

Register it with any MCP client:

```json
{
  "mcpServers": {
    "harness": {
      "command": "node",
      "args": ["/absolute/path/to/harness-mcp/build/index.js"]
    }
  }
}
```

Then, in your editor's chat:

1. `harness_configure` with `model: { mode: "native" }` — creates `/harness` and
   tells the server to borrow your editor's own model (details below).
2. `harness_reverse` for an existing codebase, or `harness_init` with a
   description for a new one.
3. `harness_render` — look at what it understood, and correct it in words.

From then on, ask the agent to call `harness_get_spec` before it writes code.

In an agent editor that is all: the harness borrows the agent's own model —
**native mode, no API key**. Universal mode, for a client with no agent to lend,
additionally needs a provider and model:

```
harness_configure({ project_path, model: { mode: "universal", provider: "openrouter", model: "…" } })
```

and the key from the **environment**, so it never lands inside the project:

```bash
export OPENROUTER_API_KEY=…   # or ANTHROPIC_API_KEY, or HARNESS_MODEL_API_KEY
```

`model.api_key` in `config.json` still works and the environment wins over it, but
a key in a file is one careless `git add -f` away from being published. The key is
never echoed back — `harness_configure` reports only `api_key_source`
(`env` / `config` / `none`).

## The `/harness` folder

Created at the project root on first use:

```
harness/
├── harness.json      # state: entries, pending changes, design rules, approvals, checkpoints
├── config.json       # model + render settings
├── CONSTITUTION.md   # ┐
├── STRUCTURE.md      # │ committable markdown spec — a projection of the state,
├── DESIGN.md         # │ rewritten after every approved change
├── SPEC.md           # │
└── tasks/phase-N.md  # ┘
```

The markdown is meant to be **committed and reviewed in a pull request** — a
structural change shows up as a spec diff next to the code diff. The state file,
cache and pending changes are local working state, git-ignored by default.

The schema is versioned (`schema_version` + append-only migrations): a newer build
opens an older `/harness`, and an older build refuses a newer one with a clear
message instead of corrupting it.

## Two modes, one logic

The harness needs a model of its own to turn *"make the buttons green"* into
structured harness edits. It gets one of two ways, and everything downstream
consumes the same structured result:

| Mode | When | How |
|---|---|---|
| **native** | your editor already runs an agent | the harness returns a *generation request* (`status: "needs_agent"` with instructions and a JSON Schema); the editor's agent fulfils it with the model it is already running and calls `harness_submit_generation`. **No API key.** |
| **universal** | a bare MCP client, or autonomous use | the harness calls its own model from `config.json` (OpenRouter or Anthropic). One extra setup step, identical behaviour. |

The same split applies to the **visualization**: one generator, two deliveries —
the HTML is returned for a webview panel where the host has one, or served on
`127.0.0.1` and opened in a browser where it does not.

The picture is an **output**. There is deliberately no direct manipulation: you
criticise it in words through `harness_chat`, which turns the critique into
proposed harness changes. You cannot drag a box into a different specification.

## Design system

Without tokens the mockup renders as a **grey skeleton** — deliberately, so it
communicates layout intent and nothing more. Feed it design tokens and the same
layout tree is painted in your project's own visual language.

MCP servers do not call each other, so there are two ways in — both landing in the
same normalized token set:

| Path | When | How |
|---|---|---|
| **host** | your editor already has a design-system MCP connected | the agent passes the token payload to `harness_set_design_tokens` |
| **direct** | nothing wires the two together | set `design_mcp.command` in `config.json`; `harness_sync_design_system` connects to it as an MCP client itself |

Design-system rules can come along too. They are **proposals, not facts** — they
queue for approval like everything else. Rules that can be checked mechanically
(hardcoded hex values, off-token shadows) arrive with a `check` attached, so
`harness_verify` enforces them against the code.

Built against Design MCP's token shape (a Chakra-oriented design system); any
source that can fill the normalized set works.

## Tools

| Tool | Purpose |
|---|---|
| `harness_hello` | Handshake — the editor announces `agent_model` / `webview` |
| `harness_init` | Create `/harness`, assemble from a description (new project) |
| `harness_reverse` | Assemble from existing code; code wins over stale docs, guesses are `[assumption]` + a question |
| `harness_submit_generation` | Native-mode callback carrying the agent's structured result |
| `harness_get_spec` | Read the harness — the agent implements from this |
| `harness_chat` | "make the buttons green" → proposed harness changes |
| `harness_propose_structure` | Generate or extend the project structure |
| `harness_propose_change` | One precise proposal, no model involved |
| `harness_add_design_rule` | A rule that applies **globally** (optionally with a machine check) |
| `harness_set_design_tokens` | Design tokens handed in by the host |
| `harness_sync_design_system` | The harness pulls tokens and rules itself |
| `harness_list_pending` | Pending changes + the unapproved-count badge |
| `harness_history` | The decision record: every approval joined to what it decided |
| `harness_approve` / `harness_reject` | The human decision — the only thing that mutates the harness |
| `summarize_session_to_harness` | Structured session summary → per-item proposals |
| `harness_render` | The visualization (webview HTML or browser) |
| `harness_verify` | On-demand code ↔ harness divergence report |
| `harness_configure` | Read or update `config.json` |
| `harness_checkpoint` | Create, list or restore rollback points |

### Session summary contract

`summarize_session_to_harness` demands structure, not prose:

```json
{ "completed_tasks": [], "decisions": [], "open_questions": [], "touched_files": [] }
```

Each decision and each open question becomes its **own** pending item, so a human
approves the session point by point instead of accepting a blob of text. That is
the difference between "the agent wrote something down" and a specification.

## Prompts

The instructions that assembly runs on are the highest-leverage text here — they
decide what a harness ends up containing — so they live in markdown, not in string
concatenation:

```
src/prompts/
├── shared/     tree-rule · screen-layout · assumption-marking · harness-principle …
├── init/  reverse/  chat/  structure/  rework/
└── builder.ts  composes sections, resolves {{placeholders}}
```

Three rules hold it together:

- **One wording per rule.** Anything two tools both say lives in `shared/` and is
  composed into both. The tree rule and the screen-layout rule used to be stated
  twice, in their own words, free to drift apart.
- **A section exists only when its capability does** — the
  `inv-no-advice-without-capability` invariant. Not "if you have an index, trust
  it", but: no such section when there is no index. Advising an agent to use
  something absent costs a turn and teaches it to distrust the rest.
- **The instruction is provider-agnostic.** The same assembled text is handed to
  the editor's agent (native) or sent to the configured model (universal); a test
  pins the two to identical output and fails on any provider-shaped wording. The
  JSON Schema travels alongside and remains the only description of result shape.

Fragments are inlined into a generated module at build time — the server ships to
the editor as a single esbuild bundle, where loose markdown would not travel. The
generated file is git-ignored so a prompt change shows up as a prompt diff and
nothing else. Snapshot tests make changing one a deliberate act.

## Storage: a JSON file, not SQLite

This server is meant to ship *inside* an editor, so it must have **zero native
dependencies** — a native module has to be rebuilt for every Electron ABI on every
platform, and that debt never stops accruing. The data is dozens of records per
project, so a document is the right size of tool.

What [`src/db/store.ts`](src/db/store.ts) provides explicitly, since a file does not
give it for free:

- **Atomic writes** — temp file in the same directory, `fsync`, then `rename`. An
  interrupted write leaves the previous state standing. Approvals and checkpoints
  are not something a person should be able to lose to a crash.
- **Transactions** — a mutation is applied to a copy, persisted, and only then
  adopted in memory. If the write fails, neither disk nor memory moved.
- **Concurrency** — the in-memory document is authoritative for the process, and
  before every mutation the file's mtime/size are checked; if another process wrote
  in the meantime, the document is re-read and the mutation applied on fresh state.
  The residual race (two processes renaming within the same microseconds) is
  accepted rather than papered over with a lock file: contention here is
  human-paced, and a stale lock from a killed editor is the worse failure.
- **Loud refusal** — an empty, truncated or non-JSON state file raises a specific
  error instead of quietly reading as "no harness yet".

## Status and limitations

Early but real. Honest about where it stands:

- **Works today:** the full loop — assemble, propose, approve/reject, render,
  verify, checkpoint/restore — under both model modes and both render modes,
  covered by 103 tests. Every tool is exercised over real stdio JSON-RPC, not just
  through the internal function, and a test fails the build if a new one slips in
  uncovered.
- **Dogfooded.** The server has assembled a harness for itself, over the protocol,
  from an editor. That run found four defects the 60 tests of the day had not:
  decisions silently losing their `[assumption]` marker, an approval table nothing
  could read, no protocol-level tests at all, and a capability probe that measured
  before the handshake. Using it for real remains the best test it has.
- **Not yet battle-tested.** It has not lived through months of daily use. Expect
  rough edges in the assembly prompts before you expect them in the storage.
- **The universal model path is stubbed, not proven.** Its request shape, auth
  headers, response parsing, retry and error handling are covered against a
  stubbed transport, so the local risk is pinned down — but no test spends a real
  token against a live provider.
- **Editor integration exists for [Peregrine](https://github.com/mykolariabokon/project-mind-ui)**:
  panel, design tokens, and the review screen where diffs, approve/reject and a
  chat box live together. Any other client drives the server over plain MCP —
  announce the host with `harness_hello`, or pin the mode in `config.json`.
- **Token mapping assumes a palette shape** (`neutral.0/50/200/500/800`,
  `brand.500`). A design system with different scale names falls back to neutral
  defaults — it will not break, but it will not pick up your brand either.
- **`harness_verify` is structural, not semantic.** It checks declared paths,
  unaccounted top-level areas, regex-checkable design rules and steps with no
  verification command. It does not read your code's meaning.

## Development

```bash
npm run build     # tsc → build/
npm test          # regenerate prompts, tsc, then vitest — 103 tests:
                  #   lifecycle    assemble → propose → approve → verify → restore
                  #   protocol     every tool over real stdio JSON-RPC
                  #   store        torn write, corrupt file, migration, concurrency
                  #   quality      flat structure, orphan parent, mute assumption
                  #   universal    provider request shape, parsing, retry, refusal
                  #   prompts      composition, conditional sections, snapshots
                  #   render       per-type layout, no-JS switching, both token paths
```

`npm test` compiles first on purpose: the protocol suite drives the built server,
and a silent run against yesterday's compile is the exact failure it exists to
catch. It refuses to start if `src/` is newer than `build/`.

`"type": "module"` — relative imports need the `.js` extension. `tsc --noEmit` does
not catch a missing one; only running does.

The server must keep starting under an editor's runtime, which is Electron as Node
— the environment a native module dies in:

```bash
ELECTRON_RUN_AS_NODE=1 "<path to>/Your Editor.exe" build/index.js
```

Issues and pull requests are welcome. If you change the storage layer, the
durability tests in `tests/store.test.ts` are the contract — they exist because a
JSON file has to *earn* the guarantees SQLite handed over for free.

## Built with AI

This project was written by **Claude (Opus 4.8)** in
[Claude Code](https://claude.com/claude-code), working from specifications and
review by [@mykolariabokon](https://github.com/mykolariabokon) — who set the
direction, made the architectural calls, rejected what did not fit, and verified
the result.

Saying so plainly matters more than the badge. What it means in practice:

- **The tests are real and they run.** Every claim in this README about behaviour
  is backed by a test or by a command that was actually executed — including the
  Electron-runtime check, which exists precisely because *"it should work"* was not
  good enough.
- **Tests and use both caught real bugs, and use caught more.** A test found a
  migration that applied in memory but never persisted. Then the server was
  pointed at itself, over the protocol, from an editor — and that single session
  surfaced four defects the whole suite had missed, including an approval table
  written to on every decision and read by nothing. Writing tests is not the same
  as using the thing.
- **Read the code before you trust it.** That advice holds for any dependency; it
  holds here too. It is a small codebase — about 4,500 lines of TypeScript plus
  1,400 of tests — and the comments explain *why*, not *what*, so it is meant to
  be read.

There is a pleasing symmetry in a tool that exists to keep AI agents honest about
specifications having been built by one, under review, from a specification.

## License

[MIT](LICENSE)
