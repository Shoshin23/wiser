---
name: Demo target & task (wiser)
description: What the agent fleet should actually WORK ON during the wiser demo to produce the strongest measurable evidence. Use when choosing the demo task/repo, scoping what the fleet optimizes/fixes/migrates, planning the 2-minute demo narrative, or deciding which metric to headline. Recommends a Rust criterion perf-optimization loop (levenshtein/simdutf8) as the hero, with a parallel best-of-N fleet experiment. Verified June 2026.
when_to_use: demo, demo target, what to build, task selection, brownfield, perf optimization, criterion, levenshtein, simdutf8, best-of-N, pass@k, HumanEval, QuixBugs, codemod migration, headline metric, what repo
user-invocable: true
---

# Demo target & task — what the fleet works on

The strategic question: *what does the fleet actually do on stage so the evidence is convincing?* Picked to
maximize the judging axes (measurable impact, agent-loop quality, cost-quality, demo clarity, low live-flake).

## Hero: Rust `criterion` performance-optimization loop

**Task:** performance optimization with a benchmark loop. **Target:** a Rust crate with a `criterion`
harness + an **exact-correctness oracle**.

> **Headline metric:** `criterion` before/after on one hot function — e.g. **`412 ns → 78 ns (5.3× faster)`**
> — printed by the agent's own `cargo bench` compare, with the existing test suite proving output is still
> bit-identical to `std`.

Why it wins:
- **Measurable impact:** `criterion` gives a statistically clean before/after with % delta + CI. One number,
  one bar. *This is literally the brief's worked example* (profile→edit→benchmark→compare, µs→ns).
- **Agent-loop quality:** real, visible loop — profile → edit → `cargo bench` → compare-vs-baseline →
  iterate; a `PostToolUse` verifier re-runs tests after each edit so a fast-but-wrong change auto-rejects.
- **Agentic leverage + cost-quality:** fan out — N cheap Nemotron/Haiku agents each try a different
  optimization (bounds-check elision, buffer reuse, SIMD, lookup table); a verifier picks the fastest
  *correct* one. Feeds the cost-quality pareto chart (the `measurement` skill's headline).
- **Brownfield + low flake:** real widely-used crates, real test suites; Rust + criterion = no Docker, no
  network, deterministic; oracle = `std::str::from_utf8` or an exact integer → bulletproof verification.

**Targets (ranked, safest first):**
1. **`wooorm/levenshtein-rs` / `rapidfuzz/strsim-rs`** (MIT) — the `levenshtein()` DP loop; output is an exact
   integer (trivial oracle). Classic two-row→one-row buffer-reuse + bounds-check elision. **Safest first demo.**
2. **`rusticstuff/simdutf8`** (MIT/Apache) — scalar-fallback UTF-8 validation; oracle = `std::str::from_utf8`.
3. **`life4/textdistance.rs`** (MIT) — many algorithms; let the fleet attack whichever profiles hottest.
4. **Go alt:** **`valyala/fastjson`** (`go test -bench`) — show `allocs/op` dropping N→0 on a hot path.

> ⚠️ **Aim at fallback/leaf helpers, not hand-tuned SIMD/JIT cores** (memchr AVX2, sonic JIT have no
> headroom → demo dies). **Pre-scout the target function the night before** and confirm real slack exists.

**Credibility slides (AI has really done this):** Codeflash gs-quant PR #29 `has_feb_29` **12,694× faster**
(1.36 s→107 µs), verified by 9+65 tests; Pydantic **+34%** merged mainline. Benchmarks: GSO (102 perf tasks),
SWE-Perf (140 real perf PRs).

## Layer on top: parallel best-of-N, verifier-judged

**Metric:** **pass@1 vs pass@8** on a fixed set — "1 of 8 solved cold → 7 of 8 with the fleet." **Target:**
6–8 hand-picked **HumanEval** problems (MIT, in-process, sub-second), N=5–8 parallel samples, hidden tests
pick the winner. *Most on-theme for a fleet* — visible parallelism + verifier cashing the gain. Evidence:
Large Language Monkeys (SWE-bench-Lite 15.9%→56% via sampling); Codex pass@1 28.8%→pass@100 70.2%. Key
framing: **without an automatic verifier, best-of-N plateaus** → justifies the test-gated fleet design.
Cherry-pick problems where pass@1 reliably fails and pass@N reliably succeeds (gain is non-deterministic).

## Backup beat: bug-fix / coverage (deterministic)

**`jkoppel/QuixBugs`** (40 single-line bugs, sub-second, `--correct` flag to rehearse red→green) or
**`azaitsev/millify`** (tiny module, `pytest --cov` 0%→100%). Clean "K→K+M passing" metric, pairs with the
iterations-to-green chart. **Do NOT run SWE-bench live** (Docker per instance, 30–67 GiB images, dies on
conference WiFi) — keep 5–10 pre-cached SWE-bench-Lite results only as a recorded credibility number.

## Migration/codemod (best visual, medium risk)

**Metric:** N files migrated, suite stays green ("40/40 files green"). Targets ship fixtures + tests:
`reactjs/react-codemod` `pure-component`, `pyupgrade`, moment→dayjs. Best *visual* for structural change +
fan-out, but real-app migrations cascade into red mid-demo → constrain to the codemod's own fixtures / a
pre-scouted module. Avoid non-deterministic LLM codemods live.

## Glasses UX fit

- **Perf (#1) + best-of-N (#2) are the best fit:** the card is a real decision surface — *"Agent 3: 5.3×
  faster, tests green — approve?"* + a gesture to accept the winning diff. Fleet works, you **steer & approve**
  — exactly what hands-free glasses are for, with a real number + go/no-go (not gimmicky).
- Migration reads okay glanceably ("40/40 green") but per-file diffs are too dense to approve on-display —
  approve at batch level. Coverage/bug-fix is the weakest UX fit (little to steer).

## Live-risk summary

| Archetype | Reliable live? |
|---|---|
| #1 Rust criterion perf | **Most reliable** — deterministic, exact oracle; only risk = no-headroom function → pre-scout |
| #2 HumanEval best-of-N | **Reliable** — sub-second, cheap; cherry-pick problems (gain non-deterministic) |
| #3 QuixBugs/millify | **Reliable** — avoid SWE-bench live |
| #4 codemod migration | **Medium** — great visual, flakes on real apps; stick to fixtures |

**Bottom line:** lead with **#1 (Rust `criterion` perf on `levenshtein`/`simdutf8`)** as the hero — the
brief's own example, cleanest before/after number, bulletproof oracle, feeds the cost-quality pareto. Layer
**#2 best-of-N** as the explicit "cheap fleet beats one expensive agent" experiment; keep **#3 QuixBugs** as a
deterministic backup. Reserve SWE-bench purely as a cited slide, never a live run.

## Sources

[levenshtein-rs](https://github.com/wooorm/levenshtein-rs) · [simdutf8](https://github.com/rusticstuff/simdutf8) ·
[textdistance.rs](https://github.com/life4/textdistance.rs) · [fastjson](https://github.com/valyala/fastjson) ·
[Codeflash gs-quant PR#29](https://github.com/codeflash-ai/gs-quant/pull/29) · [GSO](https://gso-bench.github.io) ·
[SWE-Perf](https://swe-perf.github.io) · [Large Language Monkeys](https://arxiv.org/abs/2407.21787) ·
[HumanEval](https://github.com/openai/human-eval) · [QuixBugs](https://github.com/jkoppel/QuixBugs) ·
[react-codemod](https://github.com/reactjs/react-codemod). Verified June 2026.
