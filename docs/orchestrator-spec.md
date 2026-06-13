# wiser streaming orchestrator — shared contract (the seam)

Goal: bring the `glasses-webapp/` Card/Hud/Steer streaming model into the **native iOS** app, driven
by a **real Claude Managed Agent doing real coding**. Backend distills the managed-agent event stream
into cards + HUD and streams them; iOS renders them on the lens via `MWDATDisplay` and steers by tap/voice.

This file is the SINGLE SOURCE OF TRUTH for the data contract. Backend and iOS both code to it. It
mirrors `glasses-webapp/contract.js` (shapes) and `glasses-webapp/cards.js` (card fields). When in doubt,
those files are the design reference for the card layouts.

## Verified platform facts (test-coding-agent.js, ran 2026-06-13 — PASS in 16s)
- `agent_toolset_20260401` runs real `bash`/`write`/`edit`/`read` in a network-on cloud container (`python3` preinstalled; Rust/cargo NOT).
- Event stream exposes (sample shapes verified):
  - `agent.tool_use` = `{ id, name, input, evaluated_permission, type }`. `write`/`edit` → `input.file_path` + `input.content`; `bash` → `input.command`.
  - `agent.tool_result` = `{ content:[{text}], tool_use_id, is_error }` (command output).
  - `agent.thinking`, `agent.message` (text).
  - `span.model_request_end.model_usage` = `{ input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }`.
  - `agent.custom_tool_use` = `{ id, name, input }`; reply `user.custom_tool_result { custom_tool_use_id, content:[{type:"text",text}], is_error? }`.
  - `session.status_idle { stop_reason }` — break only on terminal (`end_turn`/`retries_exhausted`); `requires_action` = waiting (also has `stop_reason.event_ids`). `session.status_terminated` terminal. (`session.thread_status_*` are subagent-thread mirrors — gate on `session.status_*`.)

## Data contract

### Hud (always-on; emitted as `{hud}` SSE frames)
```
{ loop:"goal", iter:number, tokens:number,
  exit:{ label:string, have:number, need:number },   // progress-to-done, e.g. "tests green" 5/8
  costUsd:number, elapsedSec:number,
  status:"running"|"judging"|"retrying"|"awaiting_human"|"done"|"failed",
  activity?:{ verb:"plan"|"read"|"edit"|"test"|"judge"|"wait"|"done"|"fail", target:string, note?:string } }
```

### Card union (emitted as `{card}` SSE frames) — fields exactly per cards.js
- `{ kind:"diff", files:number, added:number, removed:number, summary:string }`
- `{ kind:"tests", passed:number, total:number, failing:string[] }`
- `{ kind:"cost", usd:number, tokens:number, model:string }`
- `{ kind:"explain", headline:string, oneLiner:string }`
- `{ kind:"question", prompt:string, options:string[] }`        // steer point (= ask_user)
- `{ kind:"checkpoint", progress:string, iter?:number, tokens:number, usd:number, note?:string }`
- `{ kind:"done", headline:string, stats:[{label,value}], final?:boolean, subline?:string }`  // = handoff

### Steer (client → backend)
`{ gesture:"approve"|"reject" }` OR `{ voiceText:string }`.

### SSE frames (server → client), one JSON object per `data:` line
`{hud:Hud}` | `{card:Card}` | `{done:true, hud:Hud}`. Each frame SHOULD carry an SSE `id:` (the source
event id) so reconnects can resume via `Last-Event-ID`.

## Coding agent (created once → CODING_AGENT_ID, CODING_ENV_ID)
- Env: `{ type:"cloud", networking:{ type:"unrestricted" } }`.
- Agent: `model:"claude-sonnet-4-6"` (swappable to opus), `tools`:
  - `{ type:"agent_toolset_20260401" }`
  - `report_diff { files, added, removed, summary }` (required: summary)
  - `report_tests { passed, total, failing? }` (required: passed, total)
  - `checkpoint { progress, note? }` (required: progress)
  - `ask_user { question, options? }` (required: question)   // REUSE existing semantics
  - `done { headline, summary, status:"done"|"blocked", stats?:[{label,value}] }` (required: headline, summary)
- System prompt: "Autonomous coding agent in a Linux sandbox. Do the task with bash/file tools — make real
  edits and actually run the tests/benches. After substantive edits call report_diff; after running tests
  call report_tests; at milestones call checkpoint. When you need a human decision call ask_user (≤3 short
  options) and wait. Finish by calling done exactly once with a ≤6-word headline, a 1-sentence summary, and
  stats. Do not narrate progress in prose — the tools are the output."

## Distiller (managed-agent events → SSE frames) — backend
Maintain per-connection `hud` state; emit `{hud}` on meaningful change (NOT per second — event-driven; the
elapsed clock may tick at most ~1/sec while connected, optional).
- start → `hud = { loop:"goal", iter:1, tokens:0, exit:{label:"tests green", have:0, need:1}, costUsd:0, elapsedSec:0, status:"running" }`; emit.
- `agent.thinking` → activity `{verb:"plan", target:"planning"}`.
- `agent.tool_use` write|edit|str_replace → activity `{verb:"edit", target: basename(input.file_path)}`; add file to a changed-set.
- `agent.tool_use` read|glob|grep → activity `{verb:"read", target: basename(file_path||pattern)}`.
- `agent.tool_use` bash → if `input.command` matches `/test|pytest|bench|cargo|go test|npm test/i` → `{verb:"test", target: shortCmd}` else `{verb:"edit", target: shortCmd}`.
- `span.model_request_end` → accumulate cost: `usd += (input + cache_creation*1.25 + cache_read*0.1)/1e6*IN + output/1e6*OUT` (Sonnet IN=3,OUT=15; Opus 5/25; Haiku 1/5 per 1M); `tokens += input+output`; update hud.tokens/costUsd.
- `agent.custom_tool_use`:
  - report_diff → `{card:{kind:"diff",...input}}`; ack `user.custom_tool_result "ok"`.
  - report_tests → `{card:{kind:"tests", passed, total, failing:failing||[]}}`; set `hud.exit={label:"tests green", have:passed, need:total}`; ack.
  - checkpoint → `{card:{kind:"checkpoint", progress, iter:hud.iter, tokens:hud.tokens, usd:hud.costUsd, note}}`; ack.
  - ask_user → `{card:{kind:"question", prompt:question, options:options||[]}}`; `hud.status="awaiting_human"`, activity `{verb:"wait",target:"needs you"}`; **DO NOT ack** — leave pending for steer.
  - done → `{card:{kind:"done", headline, stats:stats||[…derived: tokens,cost], }}`; ack; remember done emitted.
  - unknown → ack `is_error:true`.
- terminal idle `end_turn`/`retries_exhausted` or terminated → if no done card seen, synthesize a done card; `hud.status="done"`; emit `{done:true, hud}`.

## Backend endpoints (namespace `/api/runs` — distinct from the existing Q&A `/api/sessions`)
- `POST /api/runs { prompt, repo? }` → create a managed session (agent=CODING_AGENT_ID, env=CODING_ENV_ID,
  `resources:[github_repository]` only if `repo` given), send the prompt as `user.message`, return `{ id: session.id }`. Do NOT stream here.
- `GET /api/runs/:id/events` → SSE. Open `events.stream(id)`; if `Last-Event-ID` header present, first replay
  via `events.list(id)` after that id (re-distill to rebuild hud) then continue on the live stream. Run the
  distiller; write SSE frames. Keep-alive comment every ~15s. The managed session is durable, so a dropped
  SSE (e.g. 300s Cloud Run cap) is recovered by the client reconnecting with `Last-Event-ID`.
- `POST /api/runs/:id/steer { gesture? | voiceText? }` → **stateless**: `events.list(id)`, find the latest
  `agent.custom_tool_use` named `ask_user` with no following `user.custom_tool_result` (the pending question);
  map the steer to an answer (gesture approve→option 0, reject→option 1; voiceText→matched option text or the
  raw text) and send `user.custom_tool_result` for that tool_use_id. If no pending question, send the
  voiceText (or a nudge) as a `user.message`. The held SSE on (possibly) another instance sees the resumed
  events on its open stream. Return 202.

## iOS surface (native, MWDATDisplay)
- Mirror the contract as Swift structs (Hud, Card enum, Steer). New file e.g. `OrchestratorRun.swift`; add a
  new tab/mode "Build" in `Views/MainAppView.swift` (keep Ask + Camera).
- SSE client over `URLSessionWebSocketTask`? No — SSE: use `URLSession` bytes/dataTask streaming, parse
  `data:`/`id:` lines; reconnect with `Last-Event-ID` on drop.
- Lens render (re-implement cards.js in FlexBox, per the §3 attention layers):
  - AMBIENT (calm): task title + GOAL label + progress bar (have/need) — when no card is up.
  - STATUSLINE (event-driven): status dot + activity verb/target + latest fact + `$cost`.
  - MOMENT cards: diff/tests/cost/explain/checkpoint/done as distinct FlexBox cards (Text styles/colors,
    simple bars via Text or proportion; no CSS gradients). `question` is interactive.
- Decision input (DAT 0.7.0 has NO cursor API): `question` card = one Button per option (≤3, first =
  implicit cursor) + a "Speak" Button + whole-card tap → option 0. Tap/speak → `POST /api/runs/:id/steer`.
- Start a run: voice prompt (phone mic → existing STT, or send text) → `POST /api/runs` → open SSE.
- Glasses-first: the lens shows ambient/statusline/cards; phone UI is minimal.

## Verification
- Backend: a node script (no deploy) that `POST`-equivalent creates a run with a small coding prompt and
  prints the distilled `{hud}`/`{card}`/`{done}` frames the SSE would emit; confirm a `diff`, `tests`, and
  `done` card appear with real numbers, and that a simulated steer answers an `ask_user`.
- iOS: `xcodebuild ... CODE_SIGNING_ALLOWED=NO build` → BUILD SUCCEEDED.
- End-to-end (orchestrator gates deploy): deploy, then on-device — speak a task, watch the statusline move
  through edit→test, a tests card appear, answer an ask_user by tap+voice, see the done card.
