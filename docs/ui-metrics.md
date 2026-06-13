# wiser — UI metrics, progress & controls (ideation)

Catalog of everything the UI *could* surface — metrics (read-only state), progress (in-flight
indicators), and controls (actions the user can take) — organized by view. The backbone is the
**stacked-loop** model (see diagram / [Loopcraft](https://www.latent.space/p/ainews-loopcraft-the-art-of-stacking)):
you don't prompt agents, you design loops that prompt them, and the UI's job is to make those loops
*observable and steerable*.

> **Two surfaces, one model.** The **glasses** show only the compressed, must-act signal (a card =
> decision/approval/blocker). The **companion dashboard** (desktop/web) is where the full metrics below
> live. Rule of thumb: *if it's a number you watch, it's dashboard; if it's a number that demands you
> act, it pings a card.* Don't put dashboards on glasses — that breaks the non-distracting thesis.

---

## The loop stack (organizing backbone)

| # | Loop | Action verb | Exit condition | Timescale | Mnemonic |
|---|------|-------------|----------------|-----------|----------|
| 1 | **Token loop** | sample, append, repeat | stop token | seconds | **Tokens** |
| 2 | **Agent turn** | call tool, feed result | no more tool calls | minutes | **Turns** |
| 3 | **Goal loop** | run, judge, retry | goal reached | hours | **Tasks** |
| 4 | **MetaLoop** | spawn, review, respawn | collaboration & competition | days | **Teams** |
| 5 | **Outer loop** | set goals, allocate, cull | open exploration | ∞ | **Mission** |

Each higher loop *contains* the ones below it. The UI should let you **zoom** across levels: glance at the
Mission, drill into a Team, into a Task, into a Turn, into the token stream.

---

## Cross-cutting status vocabulary

States any session/agent/loop can be in — reuse the same colors/icons everywhere:

- **Running** — actively looping (sampling / calling tools).
- **Judging / reviewing** — output produced, verifier or judge evaluating.
- **Blocked — needs human** — waiting on an approval, a decision, or a clarification (→ fires a card).
- **Retrying** — judge rejected, looping again (show attempt N).
- **Waiting / queued** — allocated but not yet started (concurrency cap, dependency).
- **Done — goal met** ✓ / **Failed — gave up** ✗ / **Culled** (killed by outer loop).
- **Paused / stopped** — by user.

---

## View 1 — Loop / Workflow Tracker (the centerpiece)

The view that makes the *loop-oriented workflow* legible: progress **in steps** at every level. Think of
it as a vertical stack (or nested rings) mirroring the table above, each level showing its own progress.

**Level 1 · Token loop** *(mostly aggregate — rarely shown raw)*
- Metrics: tokens/sec, output tokens so far, context window used (% of model max).
- Progress: live streaming indicator (typing pulse), stop-reason when it ends.
- Controls: — (too fast to steer; surfaced only as throughput).

**Level 2 · Agent turn**
- Metrics: current tool being called, tools used this turn, files touched, lines read/written, tests run → passed/failed, turn N of budget.
- Progress: step trail — `read_file() → 240 lines → run_tests() → 3 passed` (exactly the diagram); turn timer.
- Controls: interrupt turn, inspect a tool call's args/result, approve/deny a permissioned tool call.

**Level 3 · Goal loop (Task)**
- Metrics: iteration count (run→judge→retry), judge verdict per attempt (`diff-based ✗`, `goal met ✓`), **iterations-to-green**, time-on-task, tests passing K/N, diff size.
- Progress: attempt timeline (✗ ✗ ✓), distance-to-goal / rubric score trend, "what the judge wants next."
- Controls: approve diff, reject + give steer, force-retry, change the goal/acceptance criteria, abandon task.

**Level 4 · MetaLoop (Team)**
- Metrics: agents spawned, in-review, respawned, killed; **best-of-N** candidate count; pass@1 vs pass@N; leaderboard (which agent leads on the rubric); collaboration vs competition mode.
- Progress: fan-out fan-in viz (N candidates → verifier → 1 winner); per-candidate status chips.
- Controls: spawn more / fewer, pick winner, merge winner, re-run losers with a hint, set N, switch collaborate↔compete.

**Level 5 · Outer loop (Mission)**
- Metrics: active goals, allocated budget per goal, culled goals, exploration frontier (open threads), ROI per goal (progress ÷ cost).
- Progress: portfolio view — goals ranked by traction; budget burn-down.
- Controls: add/retire goal, (re)allocate budget/agents, cull a goal, set exploration vs exploitation bias.

---

## View 2 — Fleet Overview / Mission Control

Top-level "what's the whole fleet doing right now."

- **Metrics:** active sessions, queued, blocked-on-human count, total agents running, parallelism / concurrency in use vs cap, aggregate token & $ burn rate, goals in flight, overall health (🟢/🟡/🔴).
- **Progress:** live activity feed (high-signal only), per-goal completion bars, time-since-last-human-touch.
- **Controls:** pause-all / resume-all, kill-switch, global concurrency limit, jump to any session, triage the blocked queue.

## View 3 — Sessions list & Session detail

- **Sessions list — Metrics:** one row per session: status chip, goal/task, model, current loop level, iteration, tokens/$ so far, elapsed, last-event timestamp.
- **Sessions list — Controls:** filter (status/goal/model), sort (cost, age, traction), bulk pause/kill, resume from checkpoint.
- **Session detail — Metrics:** full transcript / event stream, tool-call log, files changed (diff), test results, resume/session id, model + params, permission mode.
- **Session detail — Progress:** the Loop Tracker (View 1) scoped to this session.
- **Session detail — Controls:** interrupt, inject a message / steer, fork/branch, resume, approve permissioned action, export diff / open PR.

## View 4 — Goals & Progress

- **Metrics:** goal tree (goal → sub-goals → tasks), per-goal acceptance criteria / rubric, % complete, owning agents, blockers, deadline/timescale band.
- **Progress:** burn-up of completed sub-goals, rubric-score trend, "definition of done" checklist.
- **Controls:** create/edit/retire goal, set acceptance criteria, prioritize, assign agents/budget, mark done, split into sub-goals.

## View 5 — MCP / Tools & Management

- **MCP servers — Metrics:** connected servers + health, per-server tool-call count, latency, error rate, rate-limit headroom, auth/permission status.
- **Tools — Metrics:** tool usage histogram (which tools, how often), verifier/distiller (custom-tool) invocation counts, token cost attributed per tool, denied-call count.
- **Management — Metrics:** sandbox/environment count & status, queue depth, retries, dead/stuck sessions, model-mix (how much work on which model).
- **Controls:** enable/disable a server or tool, set permission mode (ask / allow / bypass), per-tool rate limit, restart a server, revoke creds, scope tools per agent.

## View 6 — Cost & Quality (the evidence view)

- **Metrics:** total $ and tokens (in/out/cache), cost per goal/task/session, cache-hit rate, model price mix, **cost-quality pareto** (cheap vs expensive A/B), pass-rate, iterations-to-green distribution, latency percentiles.
- **Progress:** budget burn-down vs cap, quality trend over time.
- **Controls:** set budget caps (per goal / global), choose default model tier, toggle cheap-vs-expensive experiment, export the evidence chart/CSV.

## View 7 — Cards / Inbox (the glasses surface + companion mirror)

The compressed must-act queue — the only thing the glasses render; mirrored as an inbox on the dashboard.

- **Metrics (per card):** headline, one-liner, source session/goal, age, urgency.
- **Progress:** queue depth (how many decisions pending), unread/seen.
- **Controls (the 6 gesture inputs):** approve ✓, reject/cancel ✕, drill-in (deep-dive), next/prev, ask-for-clarification. Companion adds: snooze, reassign, bulk-approve.

## View 8 — Settings

- Models & tiers (default per loop level / per agent), API keys & vault.
- Budgets & caps ($, tokens, concurrency, max iterations per task, max N for best-of-N).
- Permission defaults (ask / allow / bypass), tool allowlists, autonomy level (how much it acts without asking).
- Distillation / card settings (verbosity, voice on/off, when to ping vs stay silent — the attention dial).
- Notification routing (glasses vs dashboard vs both), quiet hours.
- Connected repos / sandboxes / MCP servers, goal templates.

---

## Design notes (keep aligned with the thesis)

- **Attention is the scarce resource.** Most metrics are *pull* (dashboard, on demand). Only blockers,
  decisions, and approvals are *push* (cards). A metric earns a card only if a human must act on it.
- **Same vocabulary everywhere.** One status palette, one loop-level color scheme across all views so a
  glance is enough.
- **Zoomable, not separate.** Mission → Team → Task → Turn → Tokens is one continuous drill-down, not eight
  unrelated dashboards.
- **The Loop Tracker is the hero view** — it's the literal picture of "designing loops that do the work,"
  and the clearest demo of agent-loop quality (a judging axis).
