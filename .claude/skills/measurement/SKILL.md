---
name: Measurement & evals (wiser)
description: How wiser produces the quantitative evidence the hackathon rewards — benchmarks, cost-quality charts, the verifier loop, and per-run instrumentation. Use when building the metrics/eval harness, instrumenting agent runs into SQLite, designing the cheap-vs-expensive cost-quality A/B, wiring a benchmark loop (pytest-benchmark/pyperf/SWE-bench/Aider), logging iterations-to-green, or writing the README "Evidence" section. The judging criteria explicitly reward measurable impact + agent-loop quality. Verified June 2026.
when_to_use: measurement, evals, benchmark, metrics, evidence, cost-quality, pareto, swe-bench, aider, pytest-benchmark, pyperf, iterations to green, instrumentation, sqlite, verifier loop, demo numbers, baseline
user-invocable: true
---

# Measurement & evals — wiser's evidence

Judges reward **measurable impact** + **agent-loop quality** explicitly. This is the highest-leverage work
after the core loop. Build the evidence *as you build*, not at the end.

## The headline metric

> **A cost-quality pareto point: wiser's fleet of N cheap Nemotron/Haiku agents reaches the same test-pass
> rate as 1 Opus/Fable agent at a fraction of the $.** Quality on Y (test-pass / resolve rate), total $ on X;
> our dot sits **up-and-left** of the single-expensive baseline.

Hits both judging axes at once and is the most defensible honest claim.

> **Do NOT lead with "faster than a human."** The METR RCT (2025, [arXiv 2507.09089](https://arxiv.org/abs/2507.09089))
> found experienced devs were **19% slower** with AI while *believing* they were faster. A sharp judge will
> use it against you. Use human-speedup only on a fixed test-gated task, never as the headline.

## Build order (one day)

1. **Instrument first (1 hr)** — every agent run → one SQLite row. The substrate for every chart.
2. **Custom micro-benchmark = hero demo (1 hr)** — profile → agent edits → `pytest-benchmark compare` →
   "2.4× faster." Deterministic, no Docker, never flakes live.
3. **Cost-quality A/B (2 hr)** — fixed task set; vary model tier + N parallel cheap agents; select by tests
   passing; plot the frontier. **← headline.**
4. **PostToolUse verifier loop logging iterations-to-green (1–2 hr)** — tests after each edit, feed failures
   back, log each turn → "improvement over iterations" chart.
5. **(Stretch) 5–10 SWE-bench-Lite instances** for an externally-recognized number — only if Docker time allows.

**Three charts to show:** (A) cost-quality pareto scatter · (B) iterations-to-green line climbing to all-pass
· (C) micro-bench before/after bar (µs→ns).

## Metrics (as reputable sources define them)

| Metric | Definition | Source |
|---|---|---|
| **Resolve rate** | % tasks where the patch makes FAIL_TO_PASS pass AND keeps PASS_TO_PASS green (strict binary) | SWE-bench |
| **pass@1 / pass@2** | Aider's 2 attempts; attempt 2 sees failing test output → pass@2 *is* iterate-on-feedback | Aider |
| **pass@k** | P(≥1 of k correct); `pass@k = E[1 − C(n−c,k)/C(n,k)]` | Codex/HumanEval |
| **Edit-format accuracy** | % tasks emitting an applyable diff (`percent_cases_well_formed`) | Aider |
| **$ / task** | total $ ÷ tasks **solved** (denominator = solved keeps it honest) | Aider |
| **Iterations-to-green** | agent turns until tests pass (your own loop metric) | — |
| **Cost-quality pareto** | quality (Y) vs $ (X); frontier = points not dominated | AA/Epoch |

Citable framing: Devin **13.86%** SWE-bench resolve vs **1.96%** unassisted
([Cognition](https://cognition.ai/blog/swe-bench-technical-report)); METR agent time-horizon doubling
**~every 7 months** ([metr.org](https://metr.org/blog/2025-03-19-measuring-ai-ability-to-complete-long-tasks/)).

## Hero: custom micro-benchmark (do first, never flakes)

`pytest-benchmark` (best for the demo):
```bash
pip install pytest-benchmark
# test_perf.py:  def test_x(benchmark): benchmark(my_func, args)
pytest --benchmark-autosave        # BEFORE -> .benchmarks/0001
# ... agent optimizes the function ...
pytest --benchmark-autosave        # AFTER  -> 0002
pytest-benchmark compare 0001 0002 # table + % delta ("2.4x faster")
```
`pyperf` for a "X.XXx faster, statistically significant" headline (CPython uses it):
`python -m pyperf timeit ... -o before.json` → `compare_to before.json after.json`.
`hyperfine --warmup 3 ./old ./new` if the artifact is a binary/CLI. Plain `timeit` = sanity check only.

## SWE-bench Lite (stretch — externally recognized)

```bash
git clone https://github.com/SWE-bench/SWE-bench && cd SWE-bench && pip install -e .
# smoke-test Docker with gold patches (should resolve 100%):
python -m swebench.harness.run_evaluation --predictions_path gold --max_workers 1 \
  --instance_ids sympy__sympy-20590 --run_id validate-gold
# score YOUR agent's patches (preds.jsonl: {instance_id, model_name_or_path, model_patch=<diff>}):
python -m swebench.harness.run_evaluation --dataset_name princeton-nlp/SWE-bench_Lite \
  --predictions_path preds.jsonl --instance_ids astropy__astropy-14539 --max_workers 2 --run_id my_run
```
Run **5–10 instances via `--instance_ids`**, not a full split. Needs Docker, ~120 GB/16 GB for full (fewer
for a handful). **Apple Silicon: add `--namespace ''`.** Wire wiser's per-sandbox git diff into `preds.jsonl`.
Alternative: **Aider polyglot** (the harness *is* the agent — easiest glue) → `pass_rate_2`.

## The verifier loop (agent-loop-quality points)

Agent SDK `PostToolUse` hook matched on `Edit|Write` → run tests/benchmark → feed failures back as context
so the agent fixes until green. **Log each iteration** to SQLite (`run_id, turn_index, tests_total,
tests_passing, elapsed_s, cost_so_far`) → plot turn (X) vs tests_passing (Y) = a line climbing to green.
Termination: natural finish / `max_turns` / `maxBudgetUsd` / perf target met. Reviewer = read-only
`code-reviewer` subagent (cheap model) or a separate `query()` over the same `cwd` → verdict card.
(Exact feedback field `additionalContext` — confirm vs hooks ref.)

## Cost-quality A/B (the headline experiment)

**Precedent to cite:** "More Agents Is All You Need" (Li et al. 2024,
[arXiv 2402.05120](https://arxiv.org/pdf/2402.05120)) — sampling+voting scaled small models to match
GPT-3.5; gain grows with difficulty. Anthropic's multi-agent post: orchestrator + 3–5 subagents beat single
Opus **90.2%** but used **~15× tokens** (token usage explained ~80% of variance) — *confirm figures before
quoting*. The honest takeaway: **parallelism wins because it spends more tokens → measure quality per dollar.**

- **Hold constant:** fixed task set (test-gated), harness/pass criteria, prompt+tools, max wall-clock; ≥3
  seeds, report mean±range.
- **Vary:** model tier (cheap Nemotron/Haiku vs Opus/Fable); number of parallel cheap agents N; aggregation
  = **select the candidate passing the most tests**.
- **Chart:** Y = test-pass rate, X = total $ (twin X = tokens); draw the frontier; cheap×N landing up-and-left
  of expensive×1.
- **Pre-empt judges:** N agents multiply token cost — the win is real only if cheap×N total $ < expensive×1 $
  at equal quality. Report **total $**, not per-agent.

Pricing gap to exploit ($/1M in/out): Nemotron Nano 0.06/0.24 · Super 0.30/0.90 · Haiku 1/5 · Sonnet 3/15 ·
Opus 5/25 · Fable 10/50. ~16–17× per-token gap → ~15 Nano agents for less than one Opus run.

## Instrument first — SQLite (build before anything else)

`ResultMessage` (one per `query()`): `total_cost_usd` (⚠️ client-side **estimate**, not billing), `usage`,
`modelUsage` (per-model breakdown = the cost-quality data). **Dedupe usage by message id** (parallel tool
calls repeat usage) — prefer `result.total_cost_usd`.

```python
import sqlite3, time
from claude_agent_sdk import query, ClaudeAgentOptions, ResultMessage
db = sqlite3.connect("results.db")
db.execute("""CREATE TABLE IF NOT EXISTS runs(run_id,task_id,model,n_agents,cost_usd,
  in_tokens,out_tokens,cache_read,wall_s,turns,tests_total,tests_passing,resolved,subtype)""")
async def run(task, model, run_id):
    t0=time.time()
    async for m in query(prompt=task["prompt"], options=ClaudeAgentOptions(
            cwd=task["repo"], permission_mode="bypassPermissions", model=model, max_turns=40, max_budget_usd=2.0)):
        if isinstance(m, ResultMessage):
            u=m.usage or {}
            db.execute("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",(run_id,task["id"],model,1,
                m.total_cost_usd,u.get("input_tokens"),u.get("output_tokens"),u.get("cache_read_input_tokens"),
                time.time()-t0,None,None,None,None,m.subtype)); db.commit(); return m
```
Nebius/Nemotron (OpenAI-compatible): capture `resp.usage` + time it; cost =
`prompt_tokens/1e6*0.06 + completion_tokens/1e6*0.24` (Nano). Every chart = one SQL query → matplotlib;
dump the table + 3 PNGs into the README "Evidence" section.

## Anti-cherry-pick hygiene

Fix the task list *before* runs; ≥3 seeds with mean±range; report failures too; show total $ (not best-case);
state subset / assisted-vs-unassisted caveats explicitly (the Devin pattern) so judges trust the numbers.

## Sources

[SWE-bench](https://github.com/SWE-bench/SWE-bench) · [Aider benchmark](https://github.com/Aider-AI/aider/blob/main/benchmark/README.md) ·
[pytest-benchmark](https://pytest-benchmark.readthedocs.io/en/latest/comparing.html) · [pyperf](https://pyperf.readthedocs.io/en/latest/run_benchmark.html) ·
[hyperfine](https://github.com/sharkdp/hyperfine) · [More Agents Is All You Need](https://arxiv.org/pdf/2402.05120) ·
[METR slower-with-AI](https://arxiv.org/abs/2507.09089) · [Aider leaderboards](https://aider.chat/docs/leaderboards/). Verified June 2026.
