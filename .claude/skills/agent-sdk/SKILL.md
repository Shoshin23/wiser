---
name: Claude Agent SDK — fleet (wiser)
description: How wiser runs its fleet of autonomous Claude coding agents on the Claude Agent SDK. Use when building the orchestrator, spawning/parallelizing agents, wiring sandboxes, adding verifier/reviewer agents, getting structured results for the distiller→card step, choosing models per agent, or tracking token cost. Covers query() fan-out, subagents, sessions/resume, permission modes, hooks, structured output, MCP/custom tools, and per-model pricing. Verified against official docs June 2026.
when_to_use: agent sdk, claude agent sdk, fleet, orchestrator, query, subagent, parallel agents, sandbox, bypassPermissions, hooks, verifier, reviewer agent, structured output, distiller, model selection, token cost, prompt caching, permission mode, MCP tools
user-invocable: true
---

# Claude Agent SDK — `wiser`'s agent fleet

> ⚠️ **wiser's chosen fleet path is hosted Claude Managed Agents — see the `managed-agents` skill.** That
> deletes the self-hosted sandbox work below. Keep this skill as the **self-hosted alternative/contrast**
> (and the source of the verifier-loop / structured-output / cost concepts the `measurement` skill reuses).

The fleet = **many autonomous Claude coding agents**, each in its own sandbox, orchestrated from a backend.
This (self-hosted) path builds on the **Claude Agent SDK** ("Claude Code as a library"), **not** the
low-level `anthropic` client — *we* own the loop and the gVisor sandboxes (reusing our existing per-env
sandbox proxy).

> For model IDs / pricing / first-party `anthropic` SDK, the `claude-api` skill is authoritative. This skill
> is specifically the **Agent SDK** (`@anthropic-ai/claude-agent-sdk` / `claude-agent-sdk`), which the
> `claude-api` skill does **not** cover.

## Recommended architecture

```
Orchestrator (Python or TS backend)
  └─ fans out N independent query() calls  (asyncio.gather / Promise.all + a concurrency cap YOU set)
       ├─ env A: gVisor Docker, query({ cwd: repoA, permissionMode: 'bypassPermissions',
       │          model: 'sonnet', outputFormat: CARD_SCHEMA, hooks: PostToolUse→run tests })
       ├─ env B: …
       └─ each returns a ResultMessage → structured_output (the card) + total_cost_usd
            └─ distiller → compress to glanceable card → Ray-Ban Display
```

Core decisions (all verified from docs unless noted):
- **One `query()` per agent**, each pinned to its own `cwd` = a repo checked out inside a gVisor-sandboxed
  Docker container. **No built-in cross-agent concurrency cap** — fan out yourself, cap with a semaphore.
- **`permissionMode: 'bypassPermissions'`** for full autonomy — the **container is the safety boundary**,
  not SDK prompts. (TS also needs `allowDangerouslySkipPermissions: true`.)
- **`outputFormat` (JSON Schema)** → `result.structured_output` is the **distiller→card payload**. Single
  most important feature for the glanceable-card step.
- **`PostToolUse` / `Stop` hooks** = the in-loop verifier (run tests, feed failures back).
- **Per-agent `model`** + cheap **subagents** = the cost-quality lever.

## Minimal run (headless — no TTY, set `ANTHROPIC_API_KEY`)

```python
# pip install claude-agent-sdk   (Python ≥ 3.10)
from claude_agent_sdk import query, ClaudeAgentOptions, ResultMessage
async for m in query(prompt="Fix the bug in auth.py",
        options=ClaudeAgentOptions(cwd="/workspace/repo",
            permission_mode="bypassPermissions", model="sonnet")):
    if isinstance(m, ResultMessage): print(m.result, m.total_cost_usd)
```
```typescript
// npm i @anthropic-ai/claude-agent-sdk  (bundles a native Claude Code binary)
import { query } from "@anthropic-ai/claude-agent-sdk";
for await (const m of query({ prompt: "Fix the bug in auth.ts",
    options: { cwd: "/workspace/repo", permissionMode: "bypassPermissions", model: "sonnet" } }))
  if ("result" in m) console.log(m.result);
```

`query()` = async generator, **one call = one session**. Branch on message types: `system/init` (carries
`session_id` — capture it), `assistant`, `user` (tool results), `result`/`ResultMessage` (terminal, exactly
one; carries `result`, `structured_output`, `total_cost_usd`, `usage`, `subtype`). Stops on natural finish,
`max_turns`, `maxBudgetUsd`, or error (you always get a `result`).

## Fleet fan-out (you cap concurrency)

```python
sem = asyncio.Semaphore(8)
async def run(task):
    async with sem:
        async for m in query(prompt=task["prompt"], options=ClaudeAgentOptions(
                cwd=task["repo"], permission_mode="bypassPermissions",
                model=task.get("model","sonnet"),
                output_format={"type":"json_schema","schema": CARD_SCHEMA},
                max_turns=40, max_budget_usd=2.0)):
            if isinstance(m, ResultMessage):
                return {"card": m.structured_output, "cost": m.total_cost_usd, "subtype": m.subtype}
results = await asyncio.gather(*(run(t) for t in tasks))
```
TS = same with `Promise.all` + `p-limit`. Each `query()` is its own subprocess → real per-agent memory cost;
cap concurrency and size containers accordingly.

## Structured output — the card payload (critical)

```python
CARD_SCHEMA = {"type":"object","required":["task_id","status","headline","tests_passing"],
  "properties":{"task_id":{"type":"string"},
    "status":{"type":"string","enum":["done","blocked","needs_review"]},
    "headline":{"type":"string"}, "summary":{"type":"string"},
    "tests_passing":{"type":"boolean"}, "risks":{"type":"array","items":{"type":"string"}}}}
# → message.structured_output is a validated dict; SDK re-prompts on mismatch.
```
Use Pydantic `.model_json_schema()` / Zod `z.toJSONSchema()`. JSON-Schema limits match the API (no
`minLength`/`maximum`/recursion). Handle failure subtype `error_max_structured_output_retries`.

## Verifier / reviewer loop (judges reward this)

- **Hooks** (`PreToolUse`, `PostToolUse`, `Stop`, `SessionStart/End`, `UserPromptSubmit`): register with a
  `matcher` regex on tool name. `PostToolUse` on `Edit|Write` → run `pytest` → return failures as
  `additionalContext` so the agent sees them and keeps fixing. (`PreToolUse` can `deny` / rewrite input.)
  *(exact feedback field name — confirm against hooks ref.)*
- **Reviewer**: either a read-only `code-reviewer` **subagent** (`tools:[Read,Grep,Glob]`, cheap model) the
  implementer delegates to, **or** a separate `query()` over the same `cwd` prompted "review the git diff",
  `outputFormat`-ing a verdict → just another fleet card.

## Subagents (built-in)

Define via the `agents` option; main agent delegates through the **`Agent` tool** (renamed from `Task`,
v2.1.63 — match both). **Put `"Agent"` in `allowedTools`** or they won't auto-invoke. `AgentDefinition`:
`description`+`prompt` (required), `tools`, `model` (per-subagent), `background: true` (non-blocking),
`maxTurns`, `effort`, `permissionMode`. Subagents get **fresh isolated context**; only their final message
returns to the parent (survives parent compaction).

## Sessions / sandbox / permissions

- **Resume:** capture `session_id` from `init`; pass `resume`; `forkSession: true` to branch without
  mutating. Transcripts persist as JSONL keyed by `session_id`+`cwd` = memory across iterations.
- **Isolation:** `cwd` = the lever; `additionalDirectories` for extra read paths. Run **one `query()` per
  Docker/gVisor container** + `bypassPermissions`; the container is the real sandbox. (Built-in `sandbox`
  option exists — confirm `SandboxSettings` shape if used.)
- **Permission modes:** `default` · `acceptEdits` · `plan` · `dontAsk` · `bypassPermissions` (full
  autonomy). `canUseTool` async callback to allow/rewrite/deny specific calls (e.g. block `git push`).

## Custom tools / MCP

In-process tools the orchestrator exposes to agents: Python `@tool` + `create_sdk_mcp_server`; TS
`createSdkMcpServer` + Zod. e.g. a `report_progress` tool that pushes a card to the glasses mid-run. External
MCP servers via `mcpServers` (stdio/URL). Allow with `"mcp__<server>__<tool>"` in `allowedTools`.

## Cost-quality (model mixing)

Set `model` per `query()` and per subagent (`'fable'|'opus'|'sonnet'|'haiku'|'inherit'` or full ID);
`fallbackModel` for failover. **Pricing (from `claude-api` skill, 2026-06):**

| Model | ID | $/1M in | $/1M out | Fleet role |
|---|---|---|---|---|
| Fable 5 | `claude-fable-5` | 10 | 50 | hardest long-horizon only |
| Opus 4.8 | `claude-opus-4-8` | 5 | 25 | implementer on hard tasks |
| Sonnet 4.6 | `claude-sonnet-4-6` | 3 | 15 | **default fleet workhorse** |
| Haiku 4.5 | `claude-haiku-4-5` | 1 | 5 | cheap reviewers / triage |

**Cache-correct mixing:** one model per top-level `query()`, push cheaper models into **subagents** —
switching model mid-loop invalidates the prompt cache. Prompt caching is **automatic**; watch
`cache_read_input_tokens`. Per-task `effort` (`low`→`max`) is a second lever on Opus-tier.
**Cost tracking:** `ResultMessage.total_cost_usd` (⚠️ client-side **estimate**, not billing) + `usage` +
`modelUsage` per-model breakdown. Caps: `maxBudgetUsd` / `max_turns` (per-`query()`; sum across calls
yourself). This per-model breakdown is exactly the data for the **"many cheap Nemotron/Haiku agents vs one
Opus" cost-quality experiment** the brief wants.

## First-hour gotchas

1. **Auth:** `ANTHROPIC_API_KEY` (or Bedrock/Vertex/Foundry env flags). **claude.ai subscription login is NOT
   allowed for third-party products — use an API key.** Per-agent keys via `options.env`.
2. **`settingSources` defaults to loading NOTHING** — no `CLAUDE.md`/skills/settings unless you pass
   `settingSources:['project']` (TS) / `setting_sources=["project"]` (Py). Pass `[]` for a hermetic sandbox.
3. **`"Agent"` must be in `allowedTools`** for subagents; detect calls by matching `"Agent"` **and** `"Task"`.
4. **Dedupe usage by message id** (parallel tool calls repeat usage) — prefer `result.total_cost_usd`.
5. TS bundles a **native binary** → Docker base must be glibc-compatible (watch Alpine/musl). Python ≥ 3.10.

```bash
npm install @anthropic-ai/claude-agent-sdk    # TS
pip install claude-agent-sdk                  # Python ≥3.10
export ANTHROPIC_API_KEY=sk-ant-...
```

## Confirm before locking design

`sandbox`/`SandboxSettings` sub-schema · exact `PostToolUse` feedback field · TS v2 session API stability ·
orchestrator language (Python = simpler `asyncio.gather` fan-out + Pydantic; TS = ahead on the `Workflow`
massive-fan-out primitive). Both first-class.

## Sources

[Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) ·
[Python](https://code.claude.com/docs/en/agent-sdk/python) ·
[TypeScript](https://platform.claude.com/docs/en/agent-sdk/typescript) ·
[Subagents](https://code.claude.com/docs/en/agent-sdk/subagents) ·
[Structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs) ·
[Cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking) ·
[Permissions](https://code.claude.com/docs/en/agent-sdk/permissions) · GitHub `anthropics/claude-agent-sdk-python`.
Verified June 2026.
