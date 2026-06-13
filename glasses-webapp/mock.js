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
      exit: { label: "a working tracker", have: 0, need: 5 },
      costUsd: 0.0, elapsedSec: 0, status: "running",
    };
    var clock = null, started = 0;

    function emit(ev, payload) {
      (listeners[ev] || []).forEach(function (fn) { try { fn(payload); } catch (e) {} });
    }
    function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return api; }

    function pushHud(patch) {
      // Merge a partial exit into the EXISTING exit before Object.assign clobbers
      // it — otherwise exit:{have:2} wipes label/need and blanks the ambient.
      if (patch && patch.exit) patch = Object.assign({}, patch, { exit: Object.assign({}, hud.exit, patch.exit) });
      Object.assign(hud, patch);
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

    // Precise, recording-friendly beats. T() is the dwell after each step (ms),
    // tuned so the statusline/cards read cleanly in the hero GIF. Maps 1:1 to the
    // README "day in the life": say it → works silently → meeting catch → the one
    // decision → result.
    var T = {
      beat: 1500,   // a working step the eye should catch in the statusline
      quick: 900,   // a fast follow-up
      settle: 700,  // small breath before a takeover card
      preAsk: 1200, // hold calm just before an interruption
      readDone: 1700, // let the summary card land
    };

    async function run() {
      startClock();
      pushHud({ status: "running", iter: 1, tokens: 0, exit: { label: "a working tracker", have: 0, need: 5 } });

      // ── 1+2. "build a small Linear" → it works silently (rolling statusline) ──
      act("plan", "planning", "scaffolding the app");
      await wait(T.beat);
      act("read", "package.json");
      await wait(T.quick);
      pushHud({ tokens: 1800, costUsd: 0.006 });
      pushCard({ kind: "explain", headline: "Building a small issue tracker",
        oneLiner: "Vite + React + a local store. Fanning out 4 cheap agents." });

      await wait(T.beat);
      act("edit", "IssueList.tsx", "list + create form");
      await wait(T.beat);
      pushHud({ tokens: 3600, costUsd: 0.012, exit: { have: 2 } });
      pushCard({ kind: "diff", files: 3, added: 128, removed: 0,
        summary: "Issue list, create form, and a local store." });

      await wait(T.beat);
      act("test", "vitest");
      await wait(T.quick);
      pushHud({ tokens: 4200, costUsd: 0.016, exit: { have: 3 } });
      pushCard({ kind: "tests", passed: 4, total: 5, failing: ["create issue"] });

      // ── intermediate checkpoint (where are we) ──────────────────────────
      await wait(T.settle);
      pushCard({ kind: "checkpoint", progress: "3 / 5 built", iter: 1, tokens: 4200, usd: 0.016,
        note: "list + form rendering" });

      // ── 3. in a meeting — work catches itself ───────────────────────────
      await wait(2900);   // ride out the checkpoint card (auto-dismiss 2800ms)
      pushHud({ status: "awaiting_human", activity: { verb: "wait", target: "heard a task" } });
      pushCard({ kind: "question", prompt: 'Heard in your meeting — capture "add SSO for the launch"?',
        options: ["Capture it", "Not now"] });
      var cap = pickIndex(await waitForSteer());

      pushHud({ status: "running", activity: { verb: "plan", target: cap === 0 ? "filed the issue" : "skipped it" } });
      if (cap === 0) pushCard({ kind: "explain", headline: "Filed: add SSO for the launch",
        oneLiner: "Queued as the first issue in the tracker being built." });

      await wait(T.beat);
      act("edit", "store.ts", "seed first issue");
      await wait(T.quick);
      pushHud({ tokens: 6400, costUsd: 0.022, exit: { have: 4 } });

      // ── 4. the one interruption that matters ────────────────────────────
      await wait(T.preAsk);
      pushHud({ status: "awaiting_human", activity: { verb: "wait", target: "needs you" } });
      pushCard({ kind: "question", prompt: "Keep issues local, or sync a real backend?",
        options: ["Keep it local", "Sync a backend"] });
      var choice = interpretBackend(await waitForSteer());

      // ── visibly change course based on the steer ────────────────────────
      pushHud({ status: "retrying", iter: 2 });
      act("edit", choice.file, choice.note);
      await wait(T.beat);
      pushHud({ tokens: 8800, costUsd: 0.03 });
      pushCard({ kind: "diff", files: choice.files, added: choice.added, removed: 2, summary: choice.diffSummary });

      await wait(T.quick);
      act("test", "vitest");
      pushHud({ status: "judging" });
      await wait(T.quick);
      pushHud({ tokens: 10200, costUsd: 0.04, exit: { have: 5 } });
      pushCard({ kind: "tests", passed: 5, total: 5, failing: [] });

      // ── 5. work done: the "how much got done" summary ───────────────────
      await wait(T.settle);
      pushHud({ status: "done", activity: { verb: "done", target: "shipped" } });
      pushCard({ kind: "done", headline: "Issue tracker — built",
        stats: [
          { label: "files", value: "7" },
          { label: "tests", value: "5/5" },
          { label: "issues", value: "1" },
          { label: "tokens", value: "10.2k" },
          { label: "cost", value: "$0.04" },
        ] });

      await wait(T.readDone);
      pushHud({ status: "awaiting_human", activity: { verb: "wait", target: "ship it" } });
      pushCard({ kind: "question", prompt: "Done — ship it?", options: ["Approve & ship", "Keep iterating"] });
      var ship = pickIndex(await waitForSteer());
      stopClock();

      if (ship === 1) {
        pushHud({ status: "running", activity: { verb: "plan", target: "another pass" } });
        pushCard({ kind: "explain", headline: "Back to the loop", oneLiner: "Re-opening the goal loop for another pass." });
        emit("done", clone(hud));
        return;
      }
      // ── final screen ────────────────────────────────────────────────────
      pushCard({ kind: "done", final: true, headline: "A working issue tracker, hands-free",
        subline: "$0.04 · ~1/16 the cost of one Opus run",
        stats: [
          { label: "first issue", value: "add SSO" },
          { label: "tests", value: "5/5" },
          { label: "cost", value: "$0.04" },
        ] });
      emit("done", clone(hud));
    }

    // approve → 0, reject → 1 (with a light voice fallback).
    function pickIndex(steer) {
      if (steer && steer.type === "gesture") return steer.action === "reject" ? 1 : 0;
      if (steer && steer.type === "voice") {
        var t = (steer.text || "").toLowerCase();
        if (/not now|skip|no\b|later|keep iterat/.test(t)) return 1;
      }
      return 0;
    }

    // The one real decision: local store vs a synced backend.
    function interpretBackend(steer) {
      var idx = (steer && steer.type === "gesture") ? (steer.action === "reject" ? 1 : 0) : 0;
      if (steer && steer.type === "voice") {
        var t = (steer.text || "").toLowerCase();
        if (/backend|sync|server|auth|database|\bdb\b|cloud/.test(t)) idx = 1;
        else if (/local|simple|keep|now/.test(t)) idx = 0;
      }
      var branches = [
        { index: 0, label: "local", file: "store.ts", note: "localStorage persistence",
          files: 1, added: 24, diffSummary: "Persist issues to localStorage — no backend, ships now." },
        { index: 1, label: "backend", file: "api.ts", note: "Firestore + auth",
          files: 4, added: 96, diffSummary: "Synced backend: Firestore + auth + an API client." },
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
