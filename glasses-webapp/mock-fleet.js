/* wiser — fleet snapshot for the high-level lens views.
   Feeds the Sessions overview (home), the Mission-Control strip, the per-session
   Goal-progression view, and the analytics views.

   ⭑ METRICS ARE SDK-ALIGNED. Every number traces to something the Claude Managed
   Agents SDK actually exposes — see docs/sdk-metrics-alignment.md. Sources:
     • SDK-real     — span.model_request_end.model_usage.* (tokens), .model (id),
                      session.status_idle.stop_reason, span.outcome_evaluation_end.result
     • agent-tool   — the coding agent's custom tools report_tests / report_diff /
                      checkpoint / ask_user / done (orchestrator.js @ eb64fbe)
     • derived      — cost (tokens × PRICING), cache-hit rate, progress % (tests
                      passed/total), iterations-to-green
   The SDK does NOT report cost, a turn count, or wall-clock — those are derived or
   host-measured. The Outcomes rubric (outcome.score/satisfied) is SDK-supported via
   define_outcome but NOT yet wired in our orchestrator → modelled with wired:false.
*/
(function () {
  "use strict";
  var W = (window.WISER = window.WISER || {});

  /* ---- PRICING ($/MTok input/output) — claude-api skill ----
     Fable 5 = $10/$50 (skill-confirmed); Opus/Sonnet/Haiku = standard Anthropic
     rates (skill defers live numbers to the Models API); Nemotron via Nebius. */
  var PRICING = {
    opus:     { in: 15,   out: 75,  id: "claude-opus-4-8" },
    fable:    { in: 10,   out: 50,  id: "claude-fable-5" },
    sonnet:   { in: 3,    out: 15,  id: "claude-sonnet-4-6" },
    haiku:    { in: 1,    out: 5,   id: "claude-haiku-4-5" },
    nemotron: { in: 0.10, out: 0.30, id: "nvidia/nemotron-3-nano-30b-a3b" },
  };
  W.PRICING = PRICING;

  // cost = derived from real token usage × PRICING (cache read 0.1×, cache write 1.25×)
  W.agentCost = function (model, u) {
    var p = PRICING[model] || PRICING.sonnet;
    return (u.inputTokens / 1e6) * p.in
         + (u.outputTokens / 1e6) * p.out
         + (u.cacheReadTokens / 1e6) * p.in * 0.1
         + (u.cacheCreationTokens / 1e6) * p.in * 1.25;
  };
  W.cacheHitRate = function (u) {
    var denom = u.inputTokens + u.cacheCreationTokens + u.cacheReadTokens;
    return denom ? u.cacheReadTokens / denom : 0;
  };

  W.FLEET = {
    mission: { running: 3, blocked: 1, doneToday: 2 },   // burn/tok derived below

    sessions: [
      /* ── the LIVE hero: opening it runs the scripted mock/CMA loop ───────── */
      {
        id: "linear", task: "build a small Linear", live: true,
        status: "running", model: "sonnet", result: "23/31",
        // MetaLoop: N agents each building the MVP a different way (best-of-N),
        // ranked by outcome score. Zoom OUT from the task to see the team.
        team: {
          mode: "compete", goal: "issue-tracker MVP · highest outcome score wins",
          agents: [
            { label: "Optimistic + frac-index", model: "sonnet",   status: "running", score: ".72", lead: true },
            { label: "Server-authoritative",    model: "nemotron", status: "judging", score: ".64" },
            { label: "CRDT (yjs) sync",          model: "nemotron", status: "running", score: "—"   },
            { label: "Polling sync",             model: "nemotron", status: "done",    score: ".58" },
            { label: "WebSocket rooms",          model: "haiku",    status: "failed",  score: "err"  },
          ],
        },
        goal: {
          title: "Build a small Linear — issue-tracker MVP",
          metrics: {
            model: "sonnet", modelReqs: 16,           // # of model_request_end spans (real; not a "turn count")
            usage: { inputTokens: 38000, outputTokens: 22000, cacheReadTokens: 412000, cacheCreationTokens: 46000 },
            tests: { passed: 23, total: 31 },         // report_tests (agent-tool) → drives progress + hud.exit
            diff:  { files: 14, added: 412, removed: 88 },  // report_diff (agent-tool)
            stopReason: "tool_use",                   // session.status_idle.stop_reason.type
            doneStatus: null,                         // done custom tool not yet fired
            elapsedSec: 1840,                         // host tick (not SDK)
            outcome: { score: 0.72, satisfied: false, maxIterations: 6, wired: false }, // SDK outcome eval — not yet wired
          },
          attempts: [
            { n: 1, r: "fail", result: "scaffolded schema + CRUD API for issues", judge: "no board UI; issues aren't orderable", score: 0.30, tests: "8/31" },
            { n: 2, r: "fail", result: "board columns + draggable issue cards",   judge: "drag-drop missing; status not persisted", score: 0.45, tests: "15/31" },
            { n: 3, r: "fail", result: "drag-drop reorder + optimistic update",   judge: "order lost on refresh — not persisted", score: 0.55, tests: "19/31" },
            { n: 4, r: "run",  result: "persist order via fractional index",      judge: "verifying realtime sync across clients…", score: 0.72, tests: "23/31" },
          ],
          dod: [   // = define_outcome rubric.criteria (SDK Outcomes) — done == criterion satisfied
            { label: "create / edit / move issues", done: true  },
            { label: "order survives a refresh",     done: false },
            { label: "two clients stay in sync",     done: false },
            { label: "31 e2e tests green",           done: false },
          ],
          steps: [   // agent plan (checkpoint notes) — qualitative, no fake %
            { label: "Issues CRUD + schema",        done: true  },
            { label: "Board with columns",          done: true  },
            { label: "Drag-drop + persisted order", done: false },
            { label: "Realtime multi-client sync",  done: false },
          ],
          next: "make the persisted order survive a refresh, then prove two clients converge",
        },
      },

      /* ── retrying (cheap agent, working silently) ───────────────────────── */
      {
        id: "simd", task: "simdutf8 validate",
        status: "retrying", model: "nemotron", result: "2/3",
        hud: { loop: "goal", iter: 2, exit: { label: "checks green", have: 2, need: 3 },
               costUsd: 0, status: "retrying", activity: { verb: "edit", target: "validate.rs", note: "avx2 length guard" } },
        history: [
          { icon: "✦", text: "baseline 1.4 GB/s — scalar validate dominates" },
          { icon: "✎", text: "avx2 lane added" },
          { icon: "▶", text: "2 / 3 throughput checks" },
          { icon: "◷", text: "judge rejected — regression on short strings" },
        ],
        goal: {
          title: "Validate UTF-8 at ≥ 2× baseline",
          metrics: {
            model: "nemotron", modelReqs: 9,
            usage: { inputTokens: 14000, outputTokens: 7000, cacheReadTokens: 88000, cacheCreationTokens: 12000 },
            tests: { passed: 2, total: 3 },
            diff:  { files: 1, added: 36, removed: 4 },
            stopReason: "tool_use",
            doneStatus: null,
            elapsedSec: 420,
            outcome: { score: 0.51, satisfied: false, maxIterations: 4, wired: false },
          },
          attempts: [
            { n: 1, r: "fail", result: "avx2 lane for the long path", judge: "1.6× but short-string regression", score: 0.40, tests: "2/3" },
            { n: 2, r: "run",  result: "length-guard before the lane", judge: "re-checking the short-string bench…", score: 0.51, tests: "2/3" },
          ],
          dod: [
            { label: "≥ 2× on 1KB+ inputs",        done: false },
            { label: "no short-string regression", done: false },
            { label: "fuzz suite green",           done: true  },
          ],
          steps: [
            { label: "AVX2 long-path lane", done: true  },
            { label: "Short-string guard",  done: false },
            { label: "Fuzz suite",          done: true  },
          ],
          next: "kill the short-string regression without losing the long-path win",
        },
      },

      /* ── BLOCKED on you (the one push) ──────────────────────────────────── */
      {
        id: "parser", task: "parser fix",
        status: "awaiting_human", model: "nemotron", result: "6/8",
        hud: { loop: "goal", iter: 2, exit: { label: "tests green", have: 6, need: 8 },
               costUsd: 0, status: "awaiting_human", activity: { verb: "wait", target: "needs you", note: "pratt vs recursive" } },
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
          metrics: {
            model: "nemotron", modelReqs: 11,
            usage: { inputTokens: 16000, outputTokens: 9000, cacheReadTokens: 120000, cacheCreationTokens: 15000 },
            tests: { passed: 6, total: 8 },
            diff:  { files: 2, added: 54, removed: 21 },
            stopReason: "tool_use",                   // awaiting via ask_user custom tool
            doneStatus: null,
            elapsedSec: 760,
            outcome: { score: 0.68, satisfied: false, maxIterations: 5, wired: false },
          },
          attempts: [
            { n: 1, r: "fail", result: "hard depth cap on the recursion", judge: "rejects valid deeply-nested input", score: 0.50, tests: "5/8" },
            { n: 2, r: "wait", result: "two candidate fixes drafted", judge: "needs human: pratt vs recursive + guard", score: 0.68, tests: "6/8" },
          ],
          dod: [
            { label: "deep-nesting test passes", done: true  },
            { label: "no regression on suite",   done: false },
            { label: "approach chosen by human", done: false },
          ],
          steps: [
            { label: "Reproduce deep nesting", done: true  },
            { label: "Draft candidate fixes",  done: true  },
            { label: "Pick + finish approach", done: false },
          ],
          next: "pick an approach so the remaining 2 tests can go green",
        },
      },

      /* ── done (goal met — calm, no attention needed) ────────────────────── */
      {
        id: "millify", task: "millify coverage",
        status: "done", model: "haiku", result: "18/18",
        hud: { loop: "goal", iter: 4, exit: { label: "tests green", have: 18, need: 18 },
               costUsd: 0, status: "done", activity: { verb: "done", target: "goal met" } },
        history: [
          { icon: "✦", text: "0% coverage — no tests" },
          { icon: "✎", text: "18 unit tests across 4 files" },
          { icon: "▶", text: "100% lines · 96% branches" },
          { icon: "✓", text: "goal met" },
        ],
        done: { kind: "done", final: true, headline: "0% → 100% coverage", subline: "18 tests",
                stats: [ { label: "lines", value: "100%" }, { label: "tests", value: "18" } ] },
        goal: {
          title: "100% line coverage for millify",
          metrics: {
            model: "haiku", modelReqs: 12,
            usage: { inputTokens: 9000, outputTokens: 11000, cacheReadTokens: 64000, cacheCreationTokens: 8000 },
            tests: { passed: 18, total: 18 },
            diff:  { files: 4, added: 196, removed: 2 },
            stopReason: "end_turn",
            doneStatus: "done",
            elapsedSec: 510,
            outcome: { score: 1.0, satisfied: true, maxIterations: 6, wired: false },
          },
          attempts: [
            { n: 1, r: "fail", result: "tests for the happy path",      judge: "62% — error branches untested", score: 0.40, tests: "10/18" },
            { n: 2, r: "fail", result: "added rounding + suffix tests", judge: "88% — negative inputs missing", score: 0.62, tests: "15/18" },
            { n: 3, r: "fail", result: "negative + zero-edge tests",    judge: "97% — one locale branch left", score: 0.88, tests: "17/18" },
            { n: 4, r: "done", result: "locale-branch test",           judge: "100% lines, 96% branches — goal met", score: 1.0, tests: "18/18" },
          ],
          dod: [
            { label: "100% lines",        done: true },
            { label: "edge cases tested", done: true },
            { label: "suite green",       done: true },
          ],
          steps: [
            { label: "Happy-path tests", done: true },
            { label: "Edge-case tests",  done: true },
            { label: "Locale branch",    done: true },
          ],
          next: "goal met — ready to merge",
        },
      },
    ],
  };

  /* ---- derive everything that isn't a raw SDK field, at load ----
     cost from token usage × PRICING; progress % from tests; iterations-to-green
     from the attempt where tests first equal total. Change tokens → cost updates. */
  var totalBurn = 0, totalTok = 0;
  W.FLEET.sessions.forEach(function (s) {
    var m = s.goal.metrics, u = m.usage;
    m.totalTokens = u.inputTokens + u.outputTokens;
    m.costUsd = W.agentCost(m.model, u);
    m.cacheHitRate = W.cacheHitRate(u);
    s.costUsd = m.costUsd;
    s.goal.pct = m.tests.total ? Math.round((m.tests.passed / m.tests.total) * 100) : 0;
    // iterations-to-green: first attempt index (1-based) where tests passed == total
    m.itersToGreen = null;
    (s.goal.attempts || []).forEach(function (a, i) {
      if (m.itersToGreen == null && a.tests) {
        var pt = String(a.tests).split("/");
        if (pt.length === 2 && pt[0] === pt[1]) m.itersToGreen = i + 1;
      }
    });
    totalBurn += m.costUsd;
    totalTok += u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
  });
  W.FLEET.mission.spendUsd = totalBurn;       // Σ derived cost across the fleet
  W.FLEET.mission.totalTokens = totalTok;
  // running / needs-you counts — derived from real session statuses
  W.FLEET.mission.running = W.FLEET.sessions.filter(function (s) {
    return s.status === "running" || s.status === "retrying" || s.status === "judging";
  }).length;
  W.FLEET.mission.blocked = W.FLEET.sessions.filter(function (s) { return s.status === "awaiting_human"; }).length;

  W.findSession = function (id) {
    var ss = W.FLEET.sessions;
    for (var i = 0; i < ss.length; i++) if (ss[i].id === id) return ss[i];
    return null;
  };
})();
