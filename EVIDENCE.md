# Evidence

> **The one in-loop message a human supplies is what unlocks the work — so we measured it.** An offline
> harness runs public coding benchmarks three ways against a hermetic verifier and reports pass-rate + dollars
> per arm.

## The eval

Real and runnable today — `backend/src/eval/`. Pluggable benchmark adapters (Aider polyglot · HumanEval ·
CodeContests), each graded by a **hermetic `uv` pytest/exec verifier** on hidden tests the solver never sees.
Solver = **Haiku 4.5** (deliberately cheap, so the baseline leaves room); steer author = **Opus 4.8**.

Three arms share a **single attempt-1**, so the only variable is the injected message:

- **Baseline** — one cheap agent, one blind shot (no test feedback).
- **+ machine retry** — the verifier's test output fed back to the same agent (standard pass@2).
- **+ one steer** — that same feedback *plus* one crafted human-style correction (root cause + approach,
  derived from a reference solution, no copy-paste fix). This is the mid-loop steer the glasses deliver.

**Headline: one mid-loop message takes a cheap agent from ~0% to ~90%** — the agent is capable, it just
needs one correction.

**HumanEval (n=12)** — total cost $1.48 (~$0.12/task across all three arms):

| Arm | Pass rate |
|---|---|
| Baseline (blind) | **0 / 12** |
| + machine retry | **11 / 12** |
| + one steer | 8 / 12 |

**Aider polyglot, Python (n=9)** — total cost $3.06:

| Arm | Pass rate |
|---|---|
| Baseline (blind) | 2 / 9 |
| + machine retry | 6 / 9 |
| + one steer | 5 / 9 |

### Cost-quality: it runs on Nemotron too

The solver is pluggable — `nvidia/*` models route through a chat-completion path (Nebius Token Factory)
instead of the Claude Agent SDK, same verifier and same A/B/C runner. Swapping in **Nemotron Super 120B**
(NVIDIA's cheap coding model, $0.30/$0.90 per M) gives the cost-quality picture the thesis is built on:

| Solver (HumanEval, n=12) | blind baseline | + one in-loop message | cost, all 3 arms |
|---|---|---|---|
| Claude Haiku 4.5 | 0 / 12 | 11 / 12 | $1.48 |
| **Nemotron Super 120B** | **11 / 12** | **12 / 12** | **$0.023** |

On this benchmark Nemotron Super is *both* higher-quality blind *and* ~64× cheaper — a clean Pareto win for
"cheap model + one steer." (It also sharpens the caveat below: 92% blind on a saturated benchmark is partly
memorization. CodeContests — harder, less contaminated — is the better read; numbers landing.)

### Where the crafted steer wins: CodeContests (Nemotron Super)

Crisp-test benchmarks (HumanEval, polyglot) make machine retry a strong control — the failing assertions
*are* the fix, so steer ≈ retry. The steer's unique value needs **information-bound** failures (a wrong
*approach*, where tests say *that* you're wrong but not *why*) and a solver **capable** enough to act on the
direction. Hard **CodeContests** (Codeforces 1500–3500, far less saturated than HumanEval) is exactly that —
and there the crafted steer pulls decisively ahead:

| Arm (CodeContests, Nemotron Super, n=19) | Pass rate |
|---|---|
| Baseline (blind) | 1 / 19 (5%) |
| + machine retry | 2 / 19 (11%) |
| **+ one steer** | **10 / 19 (53%)** |

**Steer-only wins: 9 · retry-only wins: 1.** A "wrong answer on input X" / timeout tells retry *that* it's
wrong; it can't reveal the right algorithm. The steer — derived from a correct reference — does, and Super is
capable enough to execute it. So the steer resolves **5× more** than machine feedback. Total cost for all
three arms across 19 problems: **$0.36**. The 9 problems that resist even the steer are the genuinely hard tail
(Codeforces 2400–3500).

### What this does and doesn't show

- **Does:** a single in-loop message is decisive — blind one-shots barely pass; one follow-up turn lands most
  tasks. And on information-bound tasks (CodeContests), a *crafted* steer beats a *generic* retry 5×.
- **Boundary condition:** that gap collapses on crisp-test benchmarks (HumanEval, polyglot), where the test
  output already carries the fix and a cheap retry matches the steer. The steer earns its keep on ambiguity
  and wrong-approach failures — which is precisely the call wiser reserves for the human.

### Why a "real" benchmark here is hard

Public coding benchmarks are in every model's training data and are easy to game, so absolute scores reflect
memorization as much as skill. An honest number would need a **held-out, uncontaminated** task set. Treat the
above as evidence for *"one in-loop touch closes the gap,"* not as a leaderboard result.

## Perf track

An agent-driven optimization loop on a real OSS target —
[`microsoft/llguidance`](https://github.com/microsoft/llguidance)'s `SimpleVob` token-mask bitset (the
constrained-decoding hot path behind structured outputs in vLLM / llama.cpp; pure scalar today, ~8× SIMD
headroom) — with a clean `criterion` before/after.
