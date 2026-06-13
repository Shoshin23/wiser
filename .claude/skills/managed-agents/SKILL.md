---
name: Claude Managed Agents (wiser)
description: How wiser runs its agent fleet on Anthropic's HOSTED Claude Managed Agents (client.beta.agents/sessions/environments) — Anthropic runs the loop AND a per-session container, so we delete our own sandbox infra. Use when building the orchestrator, creating agents/environments/sessions, streaming events, running agents in parallel, getting repos in and diffs out, wiring custom-tool verifiers/distillers, the Outcomes rubric loop, model selection, or computing token cost. This is wiser's CHOSEN fleet path (supersedes the self-hosted agent-sdk plan). Verified June 2026.
when_to_use: managed agents, hosted agents, client.beta.agents, sessions, environments, cloud sandbox, events stream, custom tool, outcomes, rubric, github_repository resource, fleet, parallel sessions, memory store, vault, model selection, agent_toolset
user-invocable: true
---

# Claude Managed Agents — wiser's fleet (chosen path)

**Anthropic runs the agent loop AND a sandboxed Linux container per session.** This is wiser's fleet
backend — it **supersedes** the self-hosted Claude Agent SDK plan in the `agent-sdk` skill. Beta header
`managed-agents-2026-04-01` (SDK sets it). Package: `anthropic` / `@anthropic-ai/sdk`. Namespace
`client.beta.agents.*` / `.sessions.*` / `.environments.*`.

## The two biggest changes vs the self-hosted plan

1. **Delete the gVisor sandbox subsystem.** The `cloud` environment *is* the sandbox (Ubuntu 22.04, ≤8 GB
   RAM / 10 GB disk, network OFF by default). No sandbox infra to build. (Keep your own via a
   `self_hosted` environment only if compliance demands — loop still runs on Anthropic.)
2. **Lose in-loop `PostToolUse` hooks.** The loop isn't hook-instrumentable per tool. Move verification to
   **Outcomes** (rubric grader loop), **`always_ask`** tool gating, or a **custom-tool verifier** the agent
   calls. See Verification below.

## Recommended architecture

```
Orchestrator (holds API key)
  ├─ setup ONCE:  agents.create() per persona → store agent_id    (model/system/tools live HERE)
  │               environments.create({type:"cloud", networking:{type:"unrestricted"}}) → env_id
  └─ per task (fan out N in parallel):
        sessions.create(agent=agent_id, environment_id=env_id,
                        resources=[{type:"github_repository", url, authorization_token, checkout}])
        events.stream(session.id)            ← OPEN FIRST
        events.send(user.message | user.define_outcome+rubric)
        consume SSE: agent.message · span.model_request_end (tokens) · agent.custom_tool_use
          └─ on custom_tool_use → run host-side verifier/distiller → user.custom_tool_result
        break on status_idle w/ TERMINAL stop_reason, or status_terminated
        agent commits/pushes a branch → pull diff from GitHub  (or write to /mnt/session/outputs/)
```
Use the **`ant` CLI + version-controlled YAML** for agent/env definitions (control plane), the **SDK** for
sessions/events (data plane).

## Core flow (agent ONCE, session per run)

```python
import anthropic
client = anthropic.Anthropic()

env = client.beta.environments.create(name="wiser-cloud",
    config={"type":"cloud", "networking":{"type":"unrestricted"}})           # network OFF by default!
agent = client.beta.agents.create(name="Coding Agent", model="claude-opus-4-8",
    system="Autonomous coding agent. Make the change, run tests, commit.",
    tools=[{"type":"agent_toolset_20260401"}])   # bash, read, write, edit, glob, grep, web_fetch, web_search

session = client.beta.sessions.create(agent=agent.id, environment_id=env.id,
    resources=[{"type":"github_repository","url":"https://github.com/wiser/repo",
                "authorization_token": GITHUB_TOKEN, "checkout":{"type":"branch","name":"main"}}])

with client.beta.sessions.events.stream(session_id=session.id) as stream:   # STREAM before SEND
    client.beta.sessions.events.send(session_id=session.id,
        events=[{"type":"user.message","content":[{"type":"text","text":"Add validation to auth.py, run tests."}]}])
    for event in stream:
        if event.type == "agent.message":
            for b in event.content:
                if b.type == "text": print(b.text, end="")
        elif event.type == "span.model_request_end":
            usage = event.model_usage            # per-call token counts
        elif event.type == "session.status_idle":
            if event.stop_reason.type != "requires_action": break   # idle ≠ done; see gate below
        elif event.type == "session.status_terminated":
            break
```
TS identical in shape (`client.beta.sessions.events.stream(id)` → async iterator).

> **`model`/`system`/`tools` live on the AGENT, never the session.** Session `agent` field takes a string ID.
> **Create the agent once**, store the ID — don't recreate per task.

**Idle-break gate (correctness):** `status_idle` fires transiently (between parallel tools, awaiting your
input). Break **only** on idle with a terminal `stop_reason` (`end_turn`/`retries_exhausted`) or
`status_terminated`. `stop_reason.type == "requires_action"` = waiting on YOU → handle, don't break.

**Receive 3 ways:** SSE `events.stream()` (primary, no replay — open first, dedupe by id on reconnect via
`events.list()`); polling `events.list()`; **webhooks** (Anthropic POSTs state transitions — best for a big
fleet, no held connections).

## Fleet / parallel

Each task = one `sessions.create()`; fire N concurrently. Limits: **300 RPM create / 600 RPM read** per org;
**model inference draws from your org ITPM/OTPM** — that token throughput, not a session count, is the real
ceiling. Subagents: `multiagent: {type:"coordinator", agents:[...]}` (≤25 concurrent, one delegation level,
share the container). Cross-session memory: attach a `memory_store` resource → mounts at `/mnt/memory/<name>/`,
survives across sessions (fleet-wide learnings).

## Tools — built-in, custom, MCP

- **Built-in** `agent_toolset_20260401`: bash, read, write, edit, glob, grep, web_fetch, web_search.
  Enable-all then disable per-tool via `default_config`/`configs`.
- **Custom tools = how wiser exposes its distiller / verifier / benchmark harness** (host-side, secrets stay
  off-container): declare `{"type":"custom","name":...,"input_schema":{...}}` on the agent → agent emits
  `agent.custom_tool_use`, session idles → you run it → reply `user.custom_tool_result`.
- **MCP:** `mcp_servers` on the agent + `mcp_toolset`; auth via **vaults** (`vault_ids` at session create;
  OAuth auto-refresh). GitHub *PR creation* needs the GitHub MCP server (the `github_repository` resource is
  filesystem + git only).

## Verification & structured output (changed from Agent SDK)

No `PostToolUse` hooks, no session-level `output_config.format`. Use:
- **Outcomes** (`user.define_outcome` + rubric) — native verifier loop: a separate grader scores each
  iteration vs the rubric and feeds gaps back, looping until `satisfied`/`max_iterations`. Closest equivalent
  to "verifier between steps" (grades *outcomes*, not every tool call). Events `span.outcome_evaluation_*`.
- **`always_ask` permission policy** — pause on a tool (e.g. `bash`), emit `agent.tool_use`, idle until you
  send `user.tool_confirmation` (allow/deny + `deny_message`). Your interception gate.
- **Custom-tool verifier** — give the agent a `run_tests`/`run_benchmark` custom tool; your host handler runs
  the real tests/`pytest-benchmark` and returns pass/fail or timings. The agent calls it; you own the logic.
- **Structured distiller→card:** a **custom tool with a JSON `input_schema` matching the card shape**
  (`emit_card`) — agent calls it, you get `event.input` pre-validated. OR keep the distiller *outside* CMA on
  the raw Messages API / **Nemotron** with `output_config.format` (often simplest — see `nemotron` skill).

## Files — repos in, diffs out

- **IN:** `resources:[{type:"github_repository", url, authorization_token, checkout:{type:"branch"|"commit"}}]`
  (cloned before start; token injected at egress, never in container; Contents:Read+Write PAT allows push).
  Or Files API upload → `resources:[{type:"file", file_id, mount_path}]` (read-only).
- **OUT (the git diff):** agent edits the cloned repo in `bash`, then **commits/pushes a branch** (cleanest —
  pull the diff from GitHub for review) or writes `git diff` / artifacts to `/mnt/session/outputs/`
  (`files.list({scope_id: session.id, betas:["managed-agents-2026-04-01"]})` → download; ~1–3 s indexing lag).

## Cost / models (cost-quality)

**Token-based, same rates as the Messages API — no documented per-session fee** (⚠️ confirm whether the cloud
sandbox carries a per-container-hour surcharge like the standalone code-exec tool's $0.05/hr; not stated in
CMA docs). Per-agent model on `agents.create(model=...)`: Opus 4.8 5/25 · Sonnet 4.6 3/15 · Haiku 4.5 1/5 ·
Fable 5 10/50 ($/1M in/out). **No pre-summed `total_cost_usd`** — sum `model_usage` token counts from
`span.model_request_end` × the rate table yourself (keeps cache-hit breakdown). This is the data for the
cost-quality pareto (`measurement` skill).

## First-hour gotchas

1. **Network OFF by default** — set `networking` on the env or pip/web/MCP silently fail. #1 trap.
2. **Agent first + ONCE; session per run** — `model/system/tools` on the agent, not the session.
3. **Stream before send** — SSE has no replay; dedupe by event id on reconnect.
4. **Idle ≠ done** — break only on terminal `stop_reason` / `terminated`.
5. **`files.list` needs BOTH beta headers** (SDK adds files; you add `managed-agents-2026-04-01`); SDK ≥ 0.88 TS / 0.92 Py.
6. **Auth:** `ANTHROPIC_API_KEY` (a stale exported key overrides `ant auth login` — check `ant auth status`).
7. **Archive is permanent** on agents/envs/memory-stores — sessions are disposable, agents/envs are not.
8. **No ZDR / no HIPAA BAA** (stateful by design) — flag if it matters.
9. **Secrets never enter the container** (git PAT/vaults injected at egress); never put secrets in prompts (persist in event history).

## Migration from the self-hosted `agent-sdk` plan

GAIN: delete gVisor sandboxes; native server-persisted resumable sessions; automatic caching/compaction.
LOSE/CHANGE: in-loop `PostToolUse` hooks → Outcomes/custom-tool verifier; one-line `outputFormat` → custom-tool
JSON schema; pre-summed `total_cost_usd` → sum token counts yourself. Keep: parallel fan-out, subagents
(`multiagent`), MCP/custom tools, per-agent model selection, prompt caching. The `agent-sdk` skill is now the
**alternative/contrast** path; this skill is primary.

## Confirm before locking

Per-container-hour surcharge for cloud sandboxes · max session wall-clock duration · max concurrent sessions
per org. Check `platform.claude.com/docs/en/pricing` + the CMA sessions page.

## Sources

[Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview) ·
[cloud containers](https://platform.claude.com/docs/en/managed-agents/cloud-containers) ·
[reference](https://platform.claude.com/docs/en/managed-agents/reference) · `claude-api` skill. Verified June 2026.
