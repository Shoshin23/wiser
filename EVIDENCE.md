# Evidence

> **Cost–quality is the thesis, so we measure it.** An offline harness runs each task three ways and reports
> pass-rate and dollars per arm, building a cost–quality Pareto.
>
> _Run in progress — numbers land here as it completes._

## The eval

Real and runnable today — `backend/src/eval/`. 10 Exercism Python tasks, graded by a **pytest verifier**
on held-out tests. Three arms:

- **Baseline** — one cheap agent, one shot.
- **Free-retry** — best-of-N cheap agents, verifier-gated.
- **+1 human steer** — the single mid-loop correction the glasses are built to deliver.

The bet: *cheap fleet + one steer ≈ one expensive run, at a fraction of the cost.*

| Arm | Pass rate | Cost / task |
|---|---|---|
| Baseline (1 cheap agent) | _running_ | _running_ |
| Best-of-N (verifier-gated) | _running_ | _running_ |
| + 1 human steer | _running_ | _running_ |

## Perf track

An agent-driven optimization loop on a real OSS target —
[`microsoft/llguidance`](https://github.com/microsoft/llguidance)'s `SimpleVob` token-mask bitset (the
constrained-decoding hot path behind structured outputs in vLLM / llama.cpp; pure scalar today, ~8× SIMD
headroom) — with a clean `criterion` before/after.
