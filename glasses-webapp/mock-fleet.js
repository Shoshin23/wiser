/* wiser — fleet snapshot for the high-level lens views.
   Feeds the Sessions overview (home), the Mission-Control summary strip, and the
   per-session Goal-progression view. One session is `live:true` (driven by the
   real mock/CMA loop in mock.js); the rest are frozen snapshots so the overview
   reads like a believable multi-agent fleet — many agents, quiet by default,
   only one needing you. (See docs/ui-metrics.md: View 2/3 Sessions, View 4 Goals.)

   Per session:
     row    — task / status / iter / model / result / cost   (Sessions overview)
     hud    — frozen loop state                              (loop snapshot)
     history— compressed activity trail                      (deep-dive)
     goal   — { title, pct, subs[], attempts[], dod[] }      (Goal progression)
*/
(function () {
  "use strict";
  var W = (window.WISER = window.WISER || {});

  W.FLEET = {
    // Mission Control summary — the one-glance fleet header on the home view.
    mission: { running: 3, blocked: 1, doneToday: 2, burnUsd: 0.21, tokRate: "12.4k tok/min" },

    sessions: [
      /* ── the LIVE one: opening it runs the scripted mock/CMA loop ───────── */
      {
        id: "lev", task: "levenshtein perf", live: true,
        status: "running", iter: 3, model: "sonnet", result: "78 ns", costUsd: 0.04,
        // The MetaLoop: 6 cheap agents racing the same goal (best-of-N) — the
        // multi-agent punchline. Zoom OUT from the task to see the team.
        team: {
          mode: "compete", goal: "5.3× faster levenshtein",
          agents: [
            { label: "SIMD lanes",   model: "sonnet",   status: "done",    score: "5.3×", lead: true },
            { label: "Lookup table", model: "nemotron", status: "done",    score: "3.1×" },
            { label: "Loop unroll",  model: "nemotron", status: "judging", score: "2.4×" },
            { label: "Bit-parallel", model: "nemotron", status: "running", score: "—"    },
            { label: "Myers diff",   model: "nemotron", status: "running", score: "—"    },
            { label: "Rayon split",  model: "haiku",    status: "failed",  score: "regress" },
          ],
        },
        goal: {
          title: "Ship a measurably faster levenshtein",
          pct: 62,
          subs: [
            { label: "Beat 100 ns on the hot path", pct: 100 },
            { label: "All 8 benches green",          pct: 62  },
            { label: "criterion CI < 5%",            pct: 60  },
          ],
          attempts: [
            { r: "fail", t: "412 ns — over budget" },
            { r: "fail", t: "96 ns — 1 bench red" },
            { r: "run",  t: "78 ns — judging" },
          ],
          dod: [
            { label: "criterion before/after with CI", done: true  },
            { label: "≥ 3× speedup on hot fn",          done: true  },
            { label: "all 8 benches green",             done: false },
          ],
        },
      },

      /* ── retrying (cheap agent, working silently) ───────────────────────── */
      {
        id: "simd", task: "simdutf8 validate",
        status: "retrying", iter: 2, model: "nemotron", result: "1.6×", costUsd: 0.01,
        hud: { loop: "goal", iter: 2, exit: { label: "throughput ≥ 2×", have: 1, need: 3 },
               costUsd: 0.01, status: "retrying", activity: { verb: "edit", target: "validate.rs", note: "avx2 length guard" } },
        history: [
          { icon: "✦", text: "baseline 1.4 GB/s — scalar validate dominates" },
          { icon: "✎", text: "avx2 lane added" },
          { icon: "▶", text: "2 / 3 throughput targets" },
          { icon: "◷", text: "judge rejected — regression on short strings" },
        ],
        goal: {
          title: "Validate UTF-8 at ≥ 2× baseline",
          pct: 33,
          subs: [
            { label: "AVX2 path for long input",  pct: 80  },
            { label: "No regression on short",     pct: 20  },
            { label: "All fuzz cases pass",        pct: 100 },
          ],
          attempts: [
            { r: "fail", t: "1.6× — short-string regression" },
            { r: "run",  t: "retrying with length guard" },
          ],
          dod: [
            { label: "≥ 2× on 1KB+ inputs",        done: false },
            { label: "no short-string regression", done: false },
            { label: "fuzz suite green",           done: true  },
          ],
        },
      },

      /* ── BLOCKED on you (the one push) ──────────────────────────────────── */
      {
        id: "parser", task: "parser fix",
        status: "awaiting_human", iter: 2, model: "nemotron", result: "6/8", costUsd: 0.02,
        hud: { loop: "goal", iter: 2, exit: { label: "all tests green", have: 6, need: 8 },
               costUsd: 0.02, status: "awaiting_human", activity: { verb: "wait", target: "needs you", note: "pratt vs recursive" } },
        history: [
          { icon: "✦", text: "stack overflow on deep nesting" },
          { icon: "✎", text: "two candidate fixes drafted" },
          { icon: "▶", text: "6 / 8 tests pass on both" },
          { icon: "◆", text: "needs you: pratt or recursive + guard?" },
        ],
        decision: { kind: "question", prompt: "Parser: which approach?",
                    options: ["Pratt (iterative)", "Recursive + depth guard"] },
        goal: {
          title: "Fix the parser stack-overflow",
          pct: 75,
          subs: [
            { label: "Reproduce on deep nesting", pct: 100 },
            { label: "All 8 parser tests green",  pct: 75  },
            { label: "No perf regression",        pct: 50  },
          ],
          attempts: [
            { r: "fail", t: "depth cap — breaks valid input" },
            { r: "wait", t: "two approaches — needs you" },
          ],
          dod: [
            { label: "deep-nesting test passes", done: true  },
            { label: "no regression on suite",   done: false },
            { label: "approach chosen by human", done: false },
          ],
        },
      },

      /* ── done (goal met — calm, no attention needed) ────────────────────── */
      {
        id: "millify", task: "millify coverage",
        status: "done", iter: 4, model: "haiku", result: "100%", costUsd: 0.01,
        hud: { loop: "goal", iter: 4, exit: { label: "100% line coverage", have: 100, need: 100 },
               costUsd: 0.01, status: "done", activity: { verb: "done", target: "goal met" } },
        history: [
          { icon: "✦", text: "0% coverage — no tests" },
          { icon: "✎", text: "18 unit tests across 4 files" },
          { icon: "▶", text: "100% lines · 96% branches" },
          { icon: "✓", text: "goal met" },
        ],
        done: { kind: "done", final: true, headline: "0% → 100% coverage", subline: "18 tests · $0.01",
                stats: [ { label: "lines", value: "100%" }, { label: "tests", value: "18" }, { label: "cost", value: "$0.01" } ] },
        goal: {
          title: "100% line coverage for millify",
          pct: 100,
          subs: [
            { label: "Line coverage",   pct: 100 },
            { label: "Branch coverage", pct: 96  },
            { label: "Edge cases",      pct: 100 },
          ],
          attempts: [
            { r: "fail", t: "62%" },
            { r: "fail", t: "88%" },
            { r: "fail", t: "97%" },
            { r: "done", t: "100% — goal met" },
          ],
          dod: [
            { label: "100% lines",        done: true },
            { label: "edge cases tested", done: true },
            { label: "suite green",       done: true },
          ],
        },
      },
    ],
  };

  W.findSession = function (id) {
    var ss = W.FLEET.sessions;
    for (var i = 0; i < ss.length; i++) if (ss[i].id === id) return ss[i];
    return null;
  };
})();
