/* wiser — the §3 contract (JS mirror of backend/src/types.ts).
   This is the seam every piece codes against: Card / Hud / Steer.
   Classic script: everything hangs off window.WISER.

   Card   = what comes back (fixed templates + one Nemotron-generated `explain`)
   Hud    = always-on, progress-to-exit on the goal loop
   Steer  = human input back into the loop (gesture | voice)
*/
(function () {
  "use strict";
  var W = (window.WISER = window.WISER || {});

  /* ---- status vocabulary (shared colours/icons everywhere; from ui-metrics) ---- */
  // Reused by the HUD, the cards, and the loop ladder so one state always reads the same.
  W.STATUS = {
    running:        { label: "running",  color: "var(--accent)",  icon: "●", pulse: true  },
    judging:        { label: "judging",  color: "var(--judge)",   icon: "◐", pulse: true  },
    retrying:       { label: "retrying", color: "var(--retry)",   icon: "↻", pulse: true  },
    awaiting_human: { label: "needs you",color: "var(--attn)",    icon: "◆", pulse: true  },
    done:           { label: "done",     color: "var(--success)", icon: "✓", pulse: false },
    failed:         { label: "failed",   color: "var(--danger)",  icon: "✗", pulse: false },
  };

  /* ---- ACTIVITY: the rolling present-tense (the statusline, à la Claude Code) ----
     The firehose of tool calls is compressed to ONE current line: verb + target.
     Lives on Hud.activity = { verb, target, note? }. Glanceable, never a feed. */
  W.ACTIVITY = {
    plan:  "✦",   // thinking / planning
    read:  "▸",   // reading files
    edit:  "✎",   // editing a file
    test:  "▶",   // running tests / benches
    judge: "◐",   // verifier judging
    wait:  "◆",   // awaiting human
    done:  "✓",
    fail:  "✗",
  };
  W.activityIcon = function (verb) { return W.ACTIVITY[verb] || "•"; };

  /* ---- the loop stack (organizing backbone; glasses only ever steers the goal tier) ---- */
  W.LOOP_STACK = [
    { key: "token",   label: "Tokens",  scale: "s"    },
    { key: "turn",    label: "Turns",   scale: "min"  },
    { key: "goal",    label: "Tasks",   scale: "hrs"  }, // ← human steers here
    { key: "meta",    label: "Teams",   scale: "days" },
    { key: "mission", label: "Mission", scale: "∞"    },
  ];

  /* ---- card metadata: title + accent per kind (fixed vocabulary) ---- */
  W.CARD_META = {
    diff:       { title: "Diff",        icon: "±", color: "var(--accent)"  },
    tests:      { title: "Tests",       icon: "✓", color: "var(--success)" },
    cost:       { title: "Cost",        icon: "$", color: "var(--gold)"    },
    explain:    { title: "Explain",     icon: "✦", color: "var(--accent2)" }, // Nemotron
    question:   { title: "Decision",    icon: "◆", color: "var(--attn)"    }, // steer point
    checkpoint: { title: "Checkpoint",  icon: "◷", color: "var(--accent)"  }, // intermediate "where are we"
    done:       { title: "Done",        icon: "✓", color: "var(--success)" }, // work-complete summary
  };

  /* ---- one-line compression of any card for the carousel peek / HUD ---- */
  W.cardOneLiner = function (c) {
    switch (c.kind) {
      case "diff":
        return c.files + " file" + (c.files === 1 ? "" : "s") + "  +" + c.added + " −" + c.removed;
      case "tests":
        return c.passed + "/" + c.total + " passing" +
          (c.failing && c.failing.length ? "  · " + c.failing.length + " red" : "");
      case "cost":
        return "$" + c.usd.toFixed(2) + "  ·  " + fmtTokens(c.tokens) + "  ·  " + c.model;
      case "explain":
        return c.oneLiner || c.headline || "";
      case "question":
        return c.prompt;
      case "checkpoint":
        return c.progress + "  ·  " + fmtTokens(c.tokens) + "  ·  $" + (c.usd || 0).toFixed(2);
      case "done":
        return c.headline || "done";
      default:
        return "";
    }
  };

  W.cardTitle = function (c) {
    if (c.kind === "explain") return c.headline || "Explain";
    return (W.CARD_META[c.kind] || { title: "Card" }).title;
  };

  function fmtTokens(n) {
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k tok";
    return n + " tok";
  }
  W.fmtTokens = fmtTokens;

  W.fmtElapsed = function (sec) {
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
  };
})();
