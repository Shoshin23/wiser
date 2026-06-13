# wiser — metric alignment to the Claude Managed Agents SDK

What the goals view + analytics view are *allowed* to show, grounded in what the
Managed Agents SDK (`client.beta.agents/sessions/environments`, beta header
`managed-agents-2026-04-01`) and wiser's real orchestrator
(`firebase/functions/orchestrator.js` @ `eb64fbe`) actually expose. Produced from a
research+verify pass (the `sdk-metric-alignment` workflow); cited sources below.

> Rule: a metric may be shown only if it is **real-sdk** (a field the SDK emits),
> **derived** (computed from real fields), or **agent-reported** (a value the coding
> agent hands back via a custom tool). Everything else is fabricated and must go.

## A. Real — directly from the SDK (`span.*` events)

| Metric | Field | Notes |
|---|---|---|
| input tokens | `span.model_request_end.model_usage.input_tokens` | per model request; sum for cumulative |
| output tokens | `span.model_request_end.model_usage.output_tokens` | |
| cache read tokens | `…model_usage.cache_read_input_tokens` | |
| cache creation tokens | `…model_usage.cache_creation_input_tokens` | |
| model id | `span.model_request_end.model` | drives pricing |
| session / env / agent id | `session.id` · `environment.id` · `agent.id` | |
| stop reason | `session.status_idle.stop_reason.type` | also `session.status_terminated` |
| session status | `event.type` (`session.status_idle` / `…_terminated`) | run lifecycle |
| tool call / activity | `agent.tool_use.{name,input}` | file_path/command/pattern |
| planning | `agent.thinking` | event, no payload |
| **outcome score** | `span.outcome_evaluation_end.result.score` | the rubric/eval — see §D |
| **outcome satisfied** | `span.outcome_evaluation_end.result.satisfied` | bool pass/fail |
| outcome max iters | `user.define_outcome.max_iterations` | the cap |
| rubric criteria | `user.define_outcome.rubric.criteria` | → maps to "definition of done" |

## B. Agent-reported — via our coding agent's custom tools (orchestrator.js @ eb64fbe)

These are real values the agent hands back; the orchestrator distills them into Cards.

| Metric | Custom tool → Card |
|---|---|
| tests passed / total / failing | `report_tests{passed,total,failing}` → `{kind:tests}` **+ `hud.exit{have:passed,need:total}`** |
| diff files / added / removed | `report_diff{files,added,removed,summary}` → `{kind:diff}` |
| checkpoint progress / note | `checkpoint{progress,note}` → `{kind:checkpoint}` (host injects tokens/usd) |
| decision prompt / options | `ask_user{question,options}` → `{kind:question}` |
| done headline / status / stats | `done{headline,summary,status:"done"\|"blocked",stats}` → `{kind:done}` |

→ **Goal progress %** is therefore *real* = `round(tests.passed / tests.total * 100)`
(the same thing `hud.exit.have/need` already encodes). Not a magic number.

## C. Derived — computed from real fields

| Metric | Formula |
|---|---|
| total tokens | `Σ(input + output)` across `model_request_end` |
| **cost (USD)** | `in/1e6·p.in + out/1e6·p.out + cacheRead/1e6·p.in·0.1 + cacheWrite/1e6·p.in·1.25` — the SDK does **not** report cost |
| cache-hit rate | `cacheRead / (input + cacheCreation + cacheRead)` |
| iterations-to-green | own loop metric: turn index where `passed == total` (needs the loop to iterate — see §E) |
| latency / wall-clock | host-measured (`tick()`), not from SDK |
| cost-quality pareto | quality (pass rate) vs $; non-dominated frontier |

### Pricing (`PRICING`, $/MTok input/output) — claude-api skill
Fable 5 = **$10 / $50** (confirmed in skill). Others = standard Anthropic rates
(skill defers live numbers to the Models API; encode as a tweakable constant):
`opus-4-8 15/75 · sonnet-4-6 3/15 · haiku-4-5 1/5 · fable-5 10/50`.
Nemotron via Nebius (Token Factory): `nemotron-3-nano-30b ≈ 0.10/0.30 · super-120b ≈ 0.25/0.80`.

## D. The evaluation (what "evaluations" means here)

The SDK has a first-class **Outcomes** eval: you `define_outcome` with a rubric +
`max_iterations`; each iteration emits `outcome_evaluation_end.result.{score,satisfied}`.
**This is the rubric/score the analytics view should surface.** Caveat: our current
orchestrator (`eb64fbe`) does **not** wire `define_outcome` yet — it ends via the `done`
custom tool's `status: done|blocked`. So model the outcome eval in the data with
`wired:false` and show it honestly (it's SDK-supported, not yet emitted by our run).

## E. Fabricated today → the honest fix

| Current (mock-fleet.js) | Verdict | Fix |
|---|---|---|
| `goal.pct` (magic %) | fabricated | derive from `tests.passed/total` |
| `goal.metrics.iter` | fabricated | `hud.iter` is **hardcoded to 1**; no SDK turn count. Use **model-request count** (real) or outcome iteration (once wired) |
| `goal.metrics.rubric` + `rubricTrend` | not-yet-wired | model as `outcome.score` (+ per-iteration trend) with `wired:false` |
| `goal.metrics.itersToGreen` | derived | keep, computed from attempts where tests go green |
| `goal.metrics.tests {passed,total}` | **real** (report_tests) | keep |
| `goal.metrics.costUsd` | **derived** | keep — compute from token usage × PRICING |
| `goal.metrics.diff {files,added,removed}` | **real** (report_diff) | keep + render |
| `goal.metrics.timeSec` | host-derived | keep as elapsed |
| `goal.subs[].pct` | fabricated | no sub-goal % in SDK — reframe as plan/checklist (qualitative) or drop the % |
| `goal.attempts[].score/tests` | mixed | tests = real per-iteration `report_tests`; score = outcome eval (wired:false) |
| gallery cost KPIs / pareto / latency / tool & model-mix | fabricated | recompute from token usage + PRICING + the pass rate; label model-mix from real `model` ids |

## Sources
- `.claude/skills/managed-agents/SKILL.md` (SDK events, Outcomes)
- `firebase/functions/orchestrator.js`, `coding-agent-config.js`, `agent-config.js` @ `eb64fbe`; `docs/orchestrator-spec.md` @ `82b3ebe`
- `.claude/skills/measurement/SKILL.md` (cost-quality, pass@k, iterations-to-green)
- claude-api bundled skill `shared/models.md` (model ids, Fable 5 pricing)
- `backend/src/{types,card,pipeline,agent}.ts` (current front-end contract)
