/* wiser — scripted mock session.
   Drives the §7 vertical slice end-to-end with NO backend, so the webapp is
   demoable on a laptop today. Emits the same {hud}/{card}/{status} events a
   live CMA session would, pauses at the question card (awaiting_human), and
   visibly changes course based on the steer it receives.

   Interface (mirrors session.js LiveSession):
     s = createMockSession()
     s.on("hud", fn) / s.on("card", fn) / s.on("status", fn) / s.on("done", fn)
     s.start(prompt)
     s.steer({ type:"gesture", action } | { type:"voice", text })
*/
(function () {
  "use strict";
  var W = (window.WISER = window.WISER || {});

  function createMockSession() {
    var listeners = { hud: [], card: [], status: [], done: [] };
    var pending = null;        // resolve fn while we await a steer
    var hud = {
      loop: "goal", iter: 1,
      exit: { label: "benches green", have: 5, need: 8 },
      costUsd: 0.0, elapsedSec: 0, status: "running",
    };
    var clock = null, started = 0;

    function emit(ev, payload) {
      (listeners[ev] || []).forEach(function (fn) { try { fn(payload); } catch (e) {} });
    }
    function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return api; }

    function pushHud(patch) {
      Object.assign(hud, patch);
      if (patch && patch.exit) hud.exit = Object.assign({}, hud.exit, patch.exit);
      emit("hud", clone(hud));
      if (patch && patch.status) emit("status", hud.status);
    }
    function pushCard(card) { emit("card", card); }

    function startClock() {
      started = perfNow();
      clock = setInterval(function () {
        hud.elapsedSec = (perfNow() - started) / 1000;
        emit("hud", clone(hud));
      }, 1000);
    }
    function stopClock() { if (clock) { clearInterval(clock); clock = null; } }

    function waitForSteer() {
      return new Promise(function (resolve) { pending = resolve; });
    }

    var act = function (verb, target, note) { pushHud({ activity: { verb: verb, target: target, note: note } }); };

    async function run() {
      startClock();
      pushHud({ status: "running", iter: 1, tokens: 0, exit: { label: "benches green", have: 5, need: 8 } });

      // ── working: the firehose, compressed to the rolling statusline ──────
      act("plan", "planning", "scoping the hot loop");
      await wait(800);
      act("read", "levenshtein.rs");
      await wait(700);
      pushHud({ tokens: 2100, costUsd: 0.008 });
      pushCard({ kind: "explain", headline: "Hot loop in levenshtein.rs",
        oneLiner: "criterion baseline 412 ns — the byte-pair scan dominates. Fanning out 6 cheap agents." });

      await wait(900);
      act("edit", "levenshtein.rs", "SIMD lane");
      await wait(900);
      pushHud({ tokens: 3800, costUsd: 0.014 });
      pushCard({ kind: "diff", files: 1, added: 14, removed: 9,
        summary: "Replaced the inner byte-pair scan with a SIMD lane." });

      await wait(800);
      act("test", "cargo bench");
      await wait(900);
      pushHud({ tokens: 4200, costUsd: 0.018 });
      pushCard({ kind: "tests", passed: 5, total: 8, failing: ["bench_long", "bench_unicode", "bench_ascii"] });

      // ── intermediate checkpoint (cost + session tokens) ─────────────────
      await wait(600);
      pushCard({ kind: "checkpoint", progress: "5 / 8 benches", iter: 1, tokens: 4200, usd: 0.018,
        note: "412 → 96 ns so far" });

      await wait(900);
      pushHud({ status: "judging", tokens: 5200, costUsd: 0.024, exit: { have: 6 } });
      act("judge", "verifier", "412 → 96 ns");
      pushCard({ kind: "explain", headline: "412 ns → 96 ns  (4.3×)",
        oneLiner: "criterion-verified; one bench still over budget." });

      // ── uncertainty → ask the human (the steer point) ───────────────────
      await wait(900);
      pushHud({ status: "awaiting_human", activity: { verb: "wait", target: "needs you" } });
      pushCard({ kind: "question", prompt: "Two candidates beat target — ship which?",
        options: ["SIMD lanes (5.3×)", "Lookup table (3.1×)"] });

      var choice = interpretSteer(await waitForSteer());

      // ── visibly change course based on the steer ────────────────────────
      pushHud({ status: "retrying", iter: 2, exit: { have: 6 } });
      act("edit", "levenshtein.rs", choice.label);
      await wait(1200);
      pushHud({ tokens: 8600, costUsd: 0.031, exit: { have: 7 } });
      pushCard({ kind: "diff", files: 1, added: choice.added, removed: 4, summary: choice.diffSummary });

      await wait(800);
      act("test", "cargo bench");
      pushHud({ status: "judging" });
      await wait(700);
      pushCard({ kind: "tests", passed: 7, total: 8, failing: ["bench_unicode"] });

      await wait(900);
      pushHud({ status: "retrying", iter: 3, tokens: 10800, costUsd: 0.038 });
      act("edit", "levenshtein.rs", "NFC normalize");
      await wait(900);
      pushCard({ kind: "diff", files: 1, added: 6, removed: 1, summary: "NFC-normalize before the lane — fixes the unicode bench." });

      await wait(800);
      act("test", "cargo bench");
      pushHud({ status: "judging", tokens: 12400, costUsd: 0.04, exit: { have: 8 } });
      await wait(800);
      pushCard({ kind: "tests", passed: 8, total: 8, failing: [] });

      // ── work done: the "how much got done" summary card ─────────────────
      await wait(700);
      pushHud({ status: "done", activity: { verb: "done", target: "goal met" } });
      pushCard({ kind: "done", headline: choice.finalHeadline,
        stats: [
          { label: "speedup", value: choice.label === "SIMD lanes" ? "5.3×" : "3.1×" },
          { label: "benches", value: "8/8" },
          { label: "iters", value: "3" },
          { label: "tokens", value: "12.4k" },
          { label: "cost", value: "$0.04" },
        ] });

      await wait(1400);
      pushCard({ kind: "question", prompt: "Goal met — ship it?", options: ["Approve & ship", "Keep iterating"] });
      var ship = interpretSteer(await waitForSteer());
      stopClock();

      if (ship.index === 1) {
        pushHud({ status: "running", activity: { verb: "plan", target: "another pass" } });
        pushCard({ kind: "explain", headline: "Back to the loop", oneLiner: "Re-opening the goal loop for another pass." });
        emit("done", clone(hud));
        return;
      }
      // ── final screen ────────────────────────────────────────────────────
      pushCard({ kind: "done", final: true, headline: choice.finalHeadline,
        subline: "$0.04 · ~1/16 the cost of one Opus run",
        stats: [
          { label: "merged", value: "PR #128" },
          { label: "benches", value: "8/8" },
          { label: "cost", value: "$0.04" },
        ] });
      emit("done", clone(hud));
    }

    // Map a steer onto one of the current question's branches.
    function interpretSteer(steer) {
      var idx = 0;
      if (steer && steer.type === "gesture") {
        idx = steer.action === "reject" ? 1 : 0;   // approve → 0, reject → 1
      } else if (steer && steer.type === "voice") {
        var t = (steer.text || "").toLowerCase();
        // voice can override: mention of lookup/table/second/B → option 1
        if (/lookup|table|second|option b|\bb\b/.test(t)) idx = 1;
        else if (/simd|lane|first|option a|fast|\ba\b/.test(t)) idx = 0;
        else if (/keep|iterate|again|no\b/.test(t)) idx = 1;
      }
      var branches = [
        { index: 0, label: "SIMD lanes", detail: "Vectorize the hot loop — 5.3× on the long bench.",
          added: 18, diffSummary: "SIMD-lane levenshtein; 4 lanes per step.",
          finalHeadline: "412 ns → 78 ns  (5.3× faster)" },
        { index: 1, label: "Lookup table", detail: "Precompute the cost table — simpler, 3.1× faster.",
          added: 22, diffSummary: "Lookup-table levenshtein; no SIMD intrinsics.",
          finalHeadline: "412 ns → 133 ns  (3.1× faster)" },
      ];
      return branches[idx] || branches[0];
    }

    var api = {
      on: on,
      start: function () { run(); return api; },
      steer: function (s) {
        if (pending) { var r = pending; pending = null; r(s); }
      },
      stop: function () { stopClock(); pending = null; },
      isMock: true,
    };
    return api;
  }

  /* utils — avoid Date.now()/Math.random() so behaviour is deterministic */
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function perfNow() { return (window.performance && performance.now) ? performance.now() : 0; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  W.createMockSession = createMockSession;
})();
