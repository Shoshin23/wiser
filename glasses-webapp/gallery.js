/* wiser — view gallery.
   Realizes every candidate surface so the team can decide what ships. Glasses
   sections reuse the live renderers (cards.js); dashboard sections are cockpit
   mockups with demo-target numbers. Navigation uses the real glasses model
   (arrows + Enter + Esc, 1-D wrap, gated view-nav ⇄ in-view-focus). */
(function () {
  "use strict";
  var W = window.WISER;

  /* ---------- demo data (aligned with /demo-target hero) ---------- */
  var CARDS = {
    explain:  { kind: "explain", headline: "412 ns → 78 ns  (5.3× faster)",
                oneLiner: "SIMD rewrite of the hot levenshtein loop — criterion-verified, CI tight." },
    diff:     { kind: "diff", files: 1, added: 14, removed: 9,
                summary: "Replaced the byte-pair scan with a SIMD lane in levenshtein.rs." },
    tests:    { kind: "tests", passed: 7, total: 8, failing: ["bench_unicode"] },
    cost:     { kind: "cost", usd: 0.04, tokens: 12400, model: "nemotron-nano ×6 + sonnet judge" },
    question: { kind: "question", prompt: "Two perf approaches passed — ship which?",
                options: ["SIMD lanes (5.3×)", "Lookup table (3.1×)"] },
    checkpoint: { kind: "checkpoint", progress: "5 / 8 benches", iter: 1, tokens: 4200, usd: 0.018,
                note: "412 → 96 ns so far" },
    done:     { kind: "done", headline: "412 ns → 78 ns  (5.3×)",
                stats: [ { label: "speedup", value: "5.3×" }, { label: "benches", value: "8/8" },
                         { label: "iters", value: "3" }, { label: "cost", value: "$0.04" } ] },
  };
  var HUD_STATES = [
    { loop:"goal", iter:1, exit:{label:"5.3× faster",have:1,need:5}, costUsd:0.01, elapsedSec:14, status:"running" },
    { loop:"goal", iter:2, exit:{label:"5.3× faster",have:3,need:5}, costUsd:0.024, elapsedSec:51, status:"judging" },
    { loop:"goal", iter:3, exit:{label:"5.3× faster",have:3,need:5}, costUsd:0.031, elapsedSec:73, status:"retrying" },
    { loop:"goal", iter:3, exit:{label:"5.3× faster",have:4,need:5}, costUsd:0.036, elapsedSec:88, status:"awaiting_human" },
    { loop:"goal", iter:4, exit:{label:"5.3× faster",have:5,need:5}, costUsd:0.04, elapsedSec:102, status:"done" },
    { loop:"goal", iter:5, exit:{label:"5.3× faster",have:2,need:5}, costUsd:0.07, elapsedSec:140, status:"failed" },
  ];

  /* ---------- helpers ---------- */
  function node(html) { var d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstChild; }

  function panel(title, right, bodyHtml, cls) {
    return '<div class="panel ' + (cls || "") + '">' +
      '<div class="panel-h"><span class="t">' + title + '</span>' +
      (right ? '<span class="r">' + right + '</span>' : '') + '</div>' + bodyHtml + '</div>';
  }
  function kpi(v, l, d, vcls, dcls) {
    return '<div class="kpi"><span class="v ' + (vcls||"") + '">' + v + '</span>' +
      '<span class="l">' + l + '</span>' + (d ? '<span class="d ' + (dcls||"") + '">' + d + '</span>' : '') + '</div>';
  }
  function chip(label, statusKey) {
    var st = W.STATUS[statusKey] || { color: "var(--muted)", pulse:false };
    return '<span class="chip ' + (st.pulse?"pulse":"") + '"><i class="d" style="background:' + st.color + '"></i>' + label + '</span>';
  }
  function hbar(lab, pct, num, color) {
    return '<div class="hbar"><span class="lab">' + lab + '</span>' +
      '<span class="track"><i style="width:' + pct + '%;background:' + (color||"var(--accent)") + '"></i></span>' +
      '<span class="num">' + num + '</span></div>';
  }
  function pbar(pct, color, lg) {
    return '<span class="pbar ' + (lg?"lg":"") + '"><i style="width:' + pct + '%;background:' + (color||"var(--accent)") + '"></i></span>';
  }

  /* ---------- HUD element (mirrors index.html structure) ---------- */
  function buildHud(hud) {
    var el = node(
      '<div class="hud">' +
        '<div class="hud-top">' +
          '<span class="hud-status"><i class="dot"></i><span class="lbl"></span></span>' +
          '<span class="hud-meta"><span class="i"></span><span class="sep">·</span>' +
          '<span class="e"></span><span class="sep">·</span><span class="c"></span></span>' +
        '</div>' +
        '<div class="hud-goal"><span class="goal-tag">GOAL</span>' +
          '<span class="gl"></span><span class="goal-count gc"></span></div>' +
        '<div class="bar"><div class="bar-fill bf"></div></div>' +
        '<div class="ladder ld"></div>' +
      '</div>');
    W.renderHud(hud, {
      status: el.querySelector(".hud-status"),
      iter: el.querySelector(".i"), elapsed: el.querySelector(".e"), cost: el.querySelector(".c"),
      goalLabel: el.querySelector(".gl"), goalCount: el.querySelector(".gc"),
      barFill: el.querySelector(".bf"), ladder: el.querySelector(".ld"),
    });
    return el;
  }

  /* ===================================================================
     VIEW DEFINITIONS
     =================================================================== */
  var VIEWS = [
    /* ---------------- GLASSES ---------------- */
    { id:"cards", group:"GLASSES · the product", title:"Cards", surface:"glasses",
      sub:"The whole on-glass vocabulary. A card = one decision/approval/blocker, ~1 headline + 1–2 lines. Everything else is dropped or spoken.",
      build: buildCards },

    { id:"hud", group:"GLASSES · the product", title:"HUD states", surface:"glasses",
      sub:"Always-on progress-to-exit on the goal loop. Same status palette everywhere; only ‘needs you’ pulses for attention.",
      build: buildHudStates },

    /* ---------------- GROUND CONTROL ---------------- */
    { id:"loop", group:"OFF-GLASS · explored", title:"Loop Tracker", surface:"dash",
      sub:"The hero. Designing loops that do the work — token→turn→goal→meta→mission, each level zoomable. You steer at the goal tier.",
      build: buildLoopTracker },

    { id:"mission", group:"OFF-GLASS · explored", title:"Mission Control", surface:"dash",
      sub:"What the whole fleet is doing right now. High-signal feed; the only push is the blocked-on-human queue.",
      build: buildMission },

    { id:"sessions", group:"OFF-GLASS · explored", title:"Sessions", surface:"dash",
      sub:"Every run as a row; one expanded into detail (transcript, tools, diff, the loop tracker scoped to it).",
      build: buildSessions },

    { id:"goals", group:"OFF-GLASS · explored", title:"Goals & Progress", surface:"dash",
      sub:"Goal tree with acceptance criteria and definition-of-done. Burn-up of completed sub-goals.",
      build: buildGoals },

    { id:"tools", group:"OFF-GLASS · explored", title:"Tools & MCP", surface:"dash",
      sub:"MCP servers + custom tools (verifier/distiller). Usage, latency, cost attributed per tool, model mix.",
      build: buildTools },

    { id:"cost", group:"OFF-GLASS · explored", title:"Cost × Quality", surface:"dash",
      sub:"The evidence view. Cheap Nemotron fleet vs one Opus on the Pareto — same quality, ~1/16 the spend.",
      build: buildCost },

    { id:"inbox", group:"OFF-GLASS · explored", title:"Inbox", surface:"both",
      sub:"The card queue mirrored to the dashboard — the only thing the glasses render, with companion extras (snooze, bulk-approve).",
      build: buildInbox },

    { id:"settings", group:"OFF-GLASS · explored", title:"Settings", surface:"dash",
      sub:"Models per loop level, budgets & caps, permission defaults, and the attention dial — when to ping vs stay silent.",
      build: buildSettings },
  ];

  /* ---------------- GLASSES: cards ---------------- */
  function buildCards() {
    var wrap = node('<div class="lenses"></div>');
    var notes = {
      diff: "fixed template", tests: "fixed template", cost: "fixed template",
      explain: "✦ Nemotron-generated — the only gen slot", question: "the steer point — gesture/voice resolves it",
      checkpoint: "intermediate — auto-dismisses to calm", done: "gen-UI summary at an important point",
    };
    ["explain","tests","diff","checkpoint","question","done","cost"].forEach(function (k) {
      var lw = node('<div class="lens-wrap"></div>');
      var lens = node('<div class="lens"></div>');
      lens.appendChild(W.renderCard(CARDS[k], { active: k === "question" }));
      lw.appendChild(lens);
      lw.appendChild(node('<div class="lens-cap"><b>' + W.CARD_META[k].title + '</b> · ' + notes[k] + '</div>'));
      wrap.appendChild(lw);
    });
    return wrap;
  }

  /* ---------------- GLASSES: HUD states ---------------- */
  function buildHudStates() {
    var wrap = node('<div class="lenses"></div>');
    HUD_STATES.forEach(function (hud) {
      var lw = node('<div class="lens-wrap"></div>');
      var lens = node('<div class="lens hud-lens"></div>');
      lens.appendChild(buildHud(hud));
      lw.appendChild(lens);
      var st = W.STATUS[hud.status];
      lw.appendChild(node('<div class="lens-cap"><b>' + st.label + '</b> · iter ' + hud.iter + '</div>'));
      wrap.appendChild(lw);
    });
    return wrap;
  }

  /* ---------------- Loop Tracker (hero) ---------------- */
  function buildLoopTracker() {
    var levels = [
      { key:"token", name:"Token loop", mnem:"Tokens", scale:"seconds",
        meta:"312 tok/s · 18.2k out · 24% of context", active:false },
      { key:"turn", name:"Agent turn", mnem:"Turns", scale:"minutes",
        meta:"run_tests() → 7/8 · 3 files touched · turn 4/12", active:false },
      { key:"goal", name:"Goal loop", mnem:"Tasks", scale:"hours", active:true,
        meta:"run → judge → retry · iter 3 · judge wants: bench_unicode ≥ 3× · 78 ns / target 78 ns" },
      { key:"meta", name:"MetaLoop", mnem:"Teams", scale:"days",
        meta:"6 candidates spawned · best-of-N · pass@8 = 7/8 · SIMD-lane agent leads", active:false },
      { key:"mission", name:"Outer loop", mnem:"Mission", scale:"∞",
        meta:"3 goals active · ROI: perf-hero leads · frontier: 2 open threads", active:false },
    ];
    var stack = '<div class="lstack">' + levels.map(function (l) {
      return '<div class="lvl ' + (l.active?"active":"") + '">' +
        '<div class="lh"><span class="lname">' + l.name + '</span>' +
        '<span class="lmnem">' + l.mnem + '</span>' +
        (l.active ? '<span class="steerbadge">◆ you steer here</span>' : '') +
        '<span class="lscale">' + l.scale + '</span></div>' +
        '<div class="lmeta">' + l.meta + '</div></div>';
    }).join("") + '</div>';

    var attempts = '<div class="timeline">' +
      '<span class="attempt fail">✗</span><span class="attempt fail">✗</span>' +
      '<span class="attempt now">3</span><span class="attempt" style="color:var(--faint)">4</span>' +
      '<span class="muted" style="margin-left:8px;font-size:13px">judge: diff-based ✗ ✗ · goal-met pending</span></div>';

    var right =
      panel("Goal · run → judge → retry", "iter 3",
        attempts +
        '<div style="margin-top:16px" class="note">Distance to goal — <b>78 ns / 78 ns target</b>, 1 bench still red.</div>' +
        '<div style="margin-top:10px">' + pbar(80, "var(--accent)", true) + '</div>', "") +
      panel("Best-of-N (Team)", "N = 6",
        '<div class="grid g3">' +
          kpi("6","spawned","",null) + kpi("1","in review","", "warnc") + kpi("7/8","pass@8","+6 vs cold","up") +
        '</div>') ;

    var v = node('<div class="grid g2" style="align-items:start"></div>');
    v.innerHTML = panel("The loop stack — zoom across levels", "live", stack) +
      '<div class="grid" style="gap:18px;align-content:start">' + right + '</div>';
    return v;
  }

  /* ---------------- Mission Control ---------------- */
  function buildMission() {
    var v = node('<div class="grid" style="gap:18px"></div>');
    var kpis = '<div class="grid g4">' +
      panel("Active", "", kpi("4","sessions running","2 cheap · 2 judge","accentc")) +
      panel("Blocked on you", "", kpi("1","awaiting human","parser approach", "warnc")) +
      panel("Burn rate", "", kpi("$0.21","per hour","12.4k tok/min","goldc")) +
      panel("Fleet health", "", kpi("🟢","nominal","6/6 envs up","up")) +
    '</div>';
    var feed = panel("Activity — high-signal only", "live",
      ['<div class="tbl"><table class="tbl"><tbody>',
        feedRow("levenshtein perf", "criterion 78 ns — goal met", "running"),
        feedRow("simdutf8 validate", "judge rejected attempt 2", "retrying"),
        feedRow("parser fix", "needs you: approach A or B?", "awaiting_human"),
        feedRow("millify coverage", "0% → 100% lines", "done"),
        '</tbody></table></div>'].join(""));
    var goals = panel("Goals in flight", "3",
      goalBar("Perf hero · levenshtein", 80, "var(--accent)") +
      goalBar("Coverage · millify", 100, "var(--success)") +
      goalBar("Migration · 40 files", 55, "var(--accent2)"));
    var controls = panel("Controls", "",
      '<div class="legend-row"><span class="chip">⏸ pause all</span>' +
      '<span class="chip">⏹ kill switch</span><span class="chip">⚙ concurrency 8</span>' +
      '<span class="chip">▣ triage blocked (1)</span></div>');
    v.innerHTML = kpis + '<div class="grid g2">' + feed + '<div class="grid" style="gap:18px;align-content:start">' + goals + controls + '</div></div>';
    return v;
  }
  function feedRow(name, what, status) {
    return '<tr><td style="width:40px">' + chip("", status) + '</td>' +
      '<td><b>' + name + '</b></td><td class="muted">' + what + '</td></tr>';
  }
  function goalBar(label, pct, color) {
    return '<div style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px">' +
      '<span>' + label + '</span><span class="mono muted">' + pct + '%</span></div>' + pbar(pct, color, true) + '</div>';
  }

  /* ---------------- Sessions ---------------- */
  function buildSessions() {
    var rows = [
      ["levenshtein perf","goal · iter 3","sonnet","78 ns","12.4k","$0.04","running"],
      ["simdutf8 validate","goal · iter 2","nemotron","—","8.1k","$0.01","retrying"],
      ["parser fix","goal · iter 2","nemotron","6/8","9.0k","$0.02","awaiting_human"],
      ["millify coverage","done","haiku","100%","4.2k","$0.01","done"],
    ];
    var list = panel("Sessions", "newest first",
      '<table class="tbl"><thead><tr><th></th><th>task</th><th>loop</th><th>model</th><th>result</th><th>tokens</th><th>$</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td>' + chip("", r[6]) + '</td><td><b>' + r[0] + '</b></td><td class="muted">' + r[1] +
          '</td><td class="mono">' + r[2] + '</td><td class="mono">' + r[3] + '</td><td class="mono">' + r[4] +
          '</td><td class="mono">' + r[5] + '</td></tr>';
      }).join("") + '</tbody></table>');

    var detail = panel("Session detail · levenshtein perf", "sid 7f3a",
      '<div class="grid g3" style="margin-bottom:14px">' +
        kpi("3","iterations","run→judge→retry") + kpi("78 ns","best","from 412 ns","up") + kpi("$0.04","spent","12.4k tok","goldc") +
      '</div>' +
      '<div class="note" style="margin-bottom:12px"><b>tool log</b> — read_file → run_bench(412ns) → edit(simd) → run_bench(96ns) → edit → run_bench(78ns) → judge ✓</div>' +
      '<div class="legend-row"><span class="chip">⤺ interrupt</span><span class="chip">✎ inject steer</span>' +
      '<span class="chip">⑂ fork</span><span class="chip">↻ resume</span><span class="chip">⎘ open PR</span></div>');

    var v = node('<div class="grid" style="gap:18px"></div>');
    v.innerHTML = list + detail;
    return v;
  }

  /* ---------------- Goals ---------------- */
  function buildGoals() {
    var tree = panel("Goal tree", "3 active",
      goalNode("Ship a measurably faster levenshtein", 80, "var(--accent)", true,
        [["Beat 100 ns on the hot path", 100], ["All 8 benches green", 88], ["criterion CI < 5%", 60]]) +
      goalNode("100% coverage · millify", 100, "var(--success)", false, [["lines", 100], ["branches", 100]]) +
      goalNode("Migrate 40 files, suite green", 55, "var(--accent2)", false, [["files migrated", 55], ["suite green", 100]]));
    var dod = panel("Definition of done · perf hero", "rubric",
      checkRow("criterion before/after with CI", true) +
      checkRow("≥ 3× speedup on hot fn", true) +
      checkRow("all benches green", false) +
      checkRow("no allocation regressions", true));
    var burn = panel("Burn-up · sub-goals completed", "this run",
      sparkline([1,1,2,2,3,4,5,5,6,7]) + '<div class="note" style="margin-top:10px">7 / 9 sub-goals done · rubric trend ↑</div>');
    var v = node('<div class="grid g2" style="align-items:start"></div>');
    v.innerHTML = tree + '<div class="grid" style="gap:18px;align-content:start">' + dod + burn + '</div>';
    return v;
  }
  function goalNode(title, pct, color, active, subs) {
    return '<div class="lvl ' + (active?"active":"") + '" style="margin-bottom:12px">' +
      '<div class="lh"><span class="lname" style="font-size:15px">' + title + '</span>' +
      '<span class="lscale mono">' + pct + '%</span></div>' + pbar(pct, color) +
      '<div style="margin-top:10px;display:flex;flex-direction:column;gap:7px">' +
      subs.map(function (s) { return '<div class="hbar" style="grid-template-columns:1fr 70px 38px"><span class="lab">' + s[0] +
        '</span><span class="track"><i style="width:' + s[1] + '%;background:' + color + '"></i></span><span class="num">' + s[1] + '%</span></div>'; }).join("") +
      '</div></div>';
  }
  function checkRow(label, done) {
    return '<div style="display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)">' +
      '<span style="color:' + (done?"var(--success)":"var(--faint)") + ';font-family:var(--font-mono)">' + (done?"✓":"○") + '</span>' +
      '<span style="' + (done?"":"color:var(--muted)") + '">' + label + '</span></div>';
  }

  /* ---------------- Tools & MCP ---------------- */
  function buildTools() {
    var servers = panel("MCP servers", "health",
      '<table class="tbl"><thead><tr><th></th><th>server</th><th>calls</th><th>p50</th><th>errors</th></tr></thead><tbody>' +
      mcpRow("done","filesystem","214","12 ms","0") +
      mcpRow("done","git","88","9 ms","0") +
      mcpRow("running","cargo-bench","31","1.2 s","0") +
      mcpRow("retrying","nebius (nemotron)","402","340 ms","2") +
      '</tbody></table>');
    var tools = panel("Tool usage", "this run",
      '<div class="hbars">' +
        hbar("run_bench (verifier)", 100, "31", "var(--accent)") +
        hbar("edit_file", 72, "22", "var(--accent)") +
        hbar("read_file", 95, "29", "var(--muted)") +
        hbar("distill→card", 60, "18", "var(--accent2)") +
        hbar("emit_card", 40, "12", "var(--accent2)") +
      '</div>');
    var mix = panel("Model mix", "by work",
      '<div class="hbars">' +
        hbar("nemotron-nano", 78, "78%", "var(--accent)") +
        hbar("sonnet (judge)", 16, "16%", "var(--accent2)") +
        hbar("opus (escalate)", 6, "6%", "var(--gold)") +
      '</div>' + '<div class="note" style="margin-top:12px">Cheap-first: nano does the volume, sonnet judges, opus only on escalation.</div>');
    var envs = panel("Environments", "",
      '<div class="grid g3">' + kpi("6","sandboxes","cloud · net off") + kpi("0","stuck","") + kpi("2","retries","") + '</div>');
    var v = node('<div class="grid g2" style="align-items:start"></div>');
    v.innerHTML = servers + '<div class="grid" style="gap:18px;align-content:start">' + tools + mix + envs + '</div>';
    return v;
  }
  function mcpRow(status, name, calls, p50, err) {
    return '<tr><td>' + chip("", status) + '</td><td><b>' + name + '</b></td><td class="mono">' + calls +
      '</td><td class="mono">' + p50 + '</td><td class="mono ' + (err!=="0"?"down":"muted") + '">' + err + '</td></tr>';
  }

  /* ---------------- Cost × Quality (the evidence) ---------------- */
  // Real evidence — computed from W.FLEET (token usage × PRICING), see docs/sdk-metrics-alignment.md
  function costData() {
    var F = (W && W.FLEET) || { sessions: [], mission: {} }, S = F.sessions;
    var spend = F.mission.spendUsd || 0;
    var allOpus = S.reduce(function (a, s) { return a + W.agentCost("opus", s.goal.metrics.usage); }, 0);
    var avgPass = S.length ? Math.round(S.reduce(function (a, s) { return a + s.goal.pct; }, 0) / S.length) : 0;
    var greenN = S.filter(function (s) { return s.goal.pct === 100; }).length;
    return { S: S, spend: spend, allOpus: allOpus, ratio: spend ? allOpus / spend : 0,
             avgPass: avgPass, greenN: greenN, tok: F.mission.totalTokens || 0 };
  }
  function buildCost() {
    var d = costData(), v = node('<div class="grid" style="gap:18px"></div>');
    var kpis = '<div class="grid g4">' +
      panel("Saving", "", kpi("~" + d.ratio.toFixed(0) + "×", "the cost", "same work, cheap models", "accentc")) +
      panel("Spend", "", kpi("$" + d.spend.toFixed(2), "fleet total", "vs $" + d.allOpus.toFixed(2) + " all-Opus", "goldc")) +
      panel("Quality", "", kpi(d.avgPass + "%", "avg pass-rate", d.greenN + "/" + d.S.length + " goals green", "up")) +
      panel("Tokens", "", kpi(W.fmtTokens(d.tok), "in+out+cache", "model_usage (real)", null)) +
    '</div>';
    var chart = panel("Cost × Quality — Pareto frontier", "real runs · tokens × pricing", paretoSVG(d) +
      '<div class="legend-row">' +
        '<span class="k"><span class="s" style="background:var(--accent)"></span>fleet sessions (real $)</span>' +
        '<span class="k"><span class="s" style="background:var(--gold)"></span>same work, all-Opus</span>' +
      '</div>', "span2");
    // iterations-to-green / progress, per session (real)
    var bars = d.S.map(function (s) {
      var i2g = s.goal.metrics.itersToGreen;
      return hbar(s.task, s.goal.pct, i2g ? "green @ iter " + i2g : s.goal.pct + "%");
    }).join("");
    var iters = panel("Per session", "pass-rate · iterations-to-green", '<div class="hbars">' + bars + '</div>');
    var evals = panel("Evaluation", "Outcomes rubric",
      '<div class="note">' + d.greenN + ' / ' + d.S.length + ' goals green. Outcome score via ' +
      '<span class="mono">span.outcome_evaluation_end.result</span> — SDK-supported (<span class="mono">define_outcome</span>) but not yet wired in the orchestrator.</div>');
    var v2 = '<div class="grid g2" style="align-items:start">' + chart +
      '<div class="grid" style="gap:18px;align-content:start">' + iters + evals + '</div></div>';
    v.innerHTML = kpis + v2;
    return v;
  }
  function paretoSVG(d) {
    // x = cost on a log scale (cheap left), y = quality (pass-rate). One point per real
    // session; the gold square = the same token work priced at Opus (cheap-fleet story).
    var w=560,h=300,pad=46;
    var lo=Math.log10(0.004), hi=Math.log10(Math.max(d.allOpus, 8));
    function X(c){ var lc=Math.log10(Math.max(c,0.004)); return pad + (lc-lo)/(hi-lo)*(w-pad-20); }
    function Y(q){ return h-pad - q*(h-pad-20); }   // q in 0..1
    var s = '<svg class="chart" viewBox="0 0 ' + w + ' ' + h + '">';
    s += '<line x1="'+pad+'" y1="'+(h-pad)+'" x2="'+(w-10)+'" y2="'+(h-pad)+'" stroke="var(--line-2)"/>';
    s += '<line x1="'+pad+'" y1="'+(h-pad)+'" x2="'+pad+'" y2="10" stroke="var(--line-2)"/>';
    s += '<text x="'+(w/2)+'" y="'+(h-8)+'" text-anchor="middle">cost (log $)  →</text>';
    s += '<text x="14" y="'+(h/2)+'" text-anchor="middle" transform="rotate(-90 14 '+(h/2)+')">quality (pass-rate) →</text>';
    // fleet points (real cost, real pass)
    d.S.forEach(function (sn) {
      var m = sn.goal.metrics, cx = X(m.costUsd), cy = Y(sn.goal.pct/100);
      s += '<circle cx="'+cx+'" cy="'+cy+'" r="6" fill="var(--accent)"/>';
      s += '<text x="'+(cx+10)+'" y="'+(cy+4)+'" fill="var(--muted)" style="font-size:11px">'+sn.model+' · $'+m.costUsd.toFixed(2)+'</text>';
    });
    // all-Opus hypothetical at the fleet's avg quality
    var ox=X(d.allOpus), oy=Y(d.avgPass/100);
    s += '<rect x="'+(ox-6)+'" y="'+(oy-6)+'" width="12" height="12" fill="var(--gold)"/>';
    s += '<text x="'+(ox-10)+'" y="'+(oy-12)+'" text-anchor="end" fill="var(--gold)">all-Opus · $'+d.allOpus.toFixed(2)+'</text>';
    s += '</svg>';
    return s;
  }

  /* ---------------- Inbox (glasses mirror) ---------------- */
  function buildInbox() {
    var items = [
      ["question","Two perf approaches passed — ship which?","levenshtein perf","now","awaiting_human"],
      ["question","Parser fix: approach A or B?","parser fix","2m","awaiting_human"],
      ["explain","412 ns → 78 ns (5.3×)","levenshtein perf","just now","running"],
      ["tests","millify 100% coverage","millify","5m","done"],
    ];
    var inbox = panel("Inbox — the must-act queue", "2 pending",
      items.map(function (it) {
        var meta = W.CARD_META[it[0]];
        return '<div style="display:flex;gap:12px;align-items:center;padding:13px 8px;border-bottom:1px solid var(--line)">' +
          '<span class="card-icon" style="--card-accent:' + meta.color + ';color:' + meta.color + ';background:color-mix(in srgb,' + meta.color + ' 18%,transparent)">' + meta.icon + '</span>' +
          '<div style="flex:1"><div><b>' + it[1] + '</b></div><div class="muted" style="font-size:12px">' + it[2] + ' · ' + it[3] + '</div></div>' +
          chip(W.STATUS[it[4]].label, it[4]) + '</div>';
      }).join(""));
    var controls = panel("Gesture vocabulary (the 6 inputs)", "+ companion",
      '<div class="legend" style="display:flex;flex-direction:column;gap:8px;font-size:13px">' +
        '<div><span class="chip">⏎ approve</span> <span class="chip">⎋ reject</span> <span class="chip">↕ next/prev</span> <span class="chip">→ drill-in</span> <span class="chip">◉ ask/clarify</span></div>' +
      '</div>' +
      '<div class="note" style="margin-top:14px">Companion-only extras: <b>snooze</b>, <b>reassign</b>, <b>bulk-approve</b>. The glasses keep just the 6.</div>');
    var v = node('<div class="grid g2" style="align-items:start"></div>');
    v.innerHTML = inbox + controls;
    return v;
  }

  /* ---------------- Settings ---------------- */
  function buildSettings() {
    var models = panel("Models per loop level", "tiers",
      settingRow("Token / turn", "nemotron-nano", "fast + cheap") +
      settingRow("Goal judge", "claude-sonnet-4-6", "verifier") +
      settingRow("Escalation", "claude-opus-4-8", "on judge-fail only") +
      settingRow("Distill → card", "nemotron-nano", "JSON mode"));
    var budgets = panel("Budgets & caps", "",
      '<div class="grid g2">' + kpi("$5.00","global cap","$0.21 spent","goldc") + kpi("8","max concurrency","") +
      kpi("4","max iters / task","") + kpi("6","max N (best-of)","") + '</div>');
    var attention = panel("Attention dial — ping vs stay silent", "the thesis",
      '<div class="note" style="margin-bottom:14px">Only blockers, decisions and approvals earn a card. Everything else stays silent or goes to voice.</div>' +
      attDial("Interrupt threshold", 70) + attDial("Voice verbosity", 40) + attDial("Auto-approve confidence", 85));
    var perms = panel("Permissions", "default: ask",
      settingRow("Irreversible tools", "always_ask", "→ question card") +
      settingRow("Code edits", "allow", "in sandbox") +
      settingRow("Network", "off", "per-env opt-in") +
      settingRow("Routing", "glasses + dash", "quiet hours 22–08"));
    var v = node('<div class="grid g2" style="align-items:start"></div>');
    v.innerHTML = '<div class="grid" style="gap:18px;align-content:start">' + models + budgets + '</div>' +
      '<div class="grid" style="gap:18px;align-content:start">' + attention + perms + '</div>';
    return v;
  }
  function settingRow(label, val, note) {
    return '<div style="display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--line)">' +
      '<span style="flex:1">' + label + '</span><span class="chip">' + val + '</span>' +
      (note ? '<span class="muted" style="font-size:12px;min-width:120px;text-align:right">' + note + '</span>' : '') + '</div>';
  }
  function attDial(label, pct) {
    return '<div style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px">' +
      '<span>' + label + '</span><span class="mono accentc">' + pct + '</span></div>' + pbar(pct, "var(--accent)", true) + '</div>';
  }

  /* shared mini sparkline */
  function sparkline(data) {
    var w=260,h=54,max=Math.max.apply(null,data),min=Math.min.apply(null,data);
    var pts = data.map(function (d,i) {
      var x = (i/(data.length-1))*(w-6)+3;
      var y = h-4 - ((d-min)/((max-min)||1))*(h-10);
      return x.toFixed(1)+","+y.toFixed(1);
    }).join(" ");
    return '<svg class="chart" viewBox="0 0 '+w+' '+h+'" style="height:54px"><polyline points="'+pts+'" fill="none" stroke="var(--accent)" stroke-width="2"/></svg>';
  }

  /* ===================================================================
     RENDER + NAVIGATION (glasses model: arrows + Enter + Esc)
     =================================================================== */
  var state = { active: 0, focusMode: false, verdicts: loadVerdicts() };

  function init() {
    buildNav();
    buildViews();
    showView(0);
    document.addEventListener("keydown", onKey);
    refreshCounts();
  }

  function buildNav() {
    var nav = document.getElementById("nav");
    var html = "", lastGroup = null;
    VIEWS.forEach(function (v, i) {
      if (v.group !== lastGroup) {
        if (lastGroup !== null) html += '</div>';        // close previous group
        html += '<div class="nav-group-label">' + v.group + '</div><div class="nav-group">';
        lastGroup = v.group;
      }
      html += '<div class="nav-item" data-i="' + i + '">' +
        '<span class="nidx">' + pad2(i+1) + '</span><span class="nlabel">' + v.title + '</span>' +
        '<span class="vdot ' + (state.verdicts[v.id]||"") + '"></span></div>';
    });
    if (lastGroup !== null) html += '</div>';             // close last group
    nav.innerHTML = html;
    nav.addEventListener("click", function (e) {
      var it = e.target.closest("[data-i]"); if (!it) return;
      state.focusMode = false; showView(+it.dataset.i);
    });
  }

  function buildViews() {
    var stage = document.getElementById("stage");
    VIEWS.forEach(function (v, i) {
      var sec = node('<section class="view" data-i="' + i + '"></section>');
      var tagCls = v.surface === "glasses" ? "glasses" : v.surface === "both" ? "glasses" : "dash";
      var tagTxt = v.surface === "glasses" ? "GLASSES" : v.surface === "both" ? "GLASSES + DASH" : "DASHBOARD";
      var head = node(
        '<div class="view-head">' +
          '<span class="view-num">' + pad2(i+1) + ' / ' + VIEWS.length + '</span>' +
          '<div class="ht"><h2>' + v.title + '</h2><div class="sub">' + v.sub + '</div></div>' +
          '<span class="surface-tag ' + tagCls + '">' + tagTxt + '</span>' +
          verdictHtml(v.id) +
        '</div>');
      sec.appendChild(head);
      sec.appendChild(v.build());
      stage.appendChild(sec);
    });
    // wire verdict pills
    stage.addEventListener("click", function (e) {
      var b = e.target.closest(".verdict button"); if (!b) return;
      setVerdict(b.dataset.view, b.dataset.v);
    });
  }

  function verdictHtml(id) {
    var cur = state.verdicts[id] || "";
    function b(v){ return '<button class="gfocus ' + v + (cur===v?" on":"") + '" data-view="' + id + '" data-v="' + v + '" tabindex="0">' + v + '</button>'; }
    return '<div class="verdict">' + b("keep") + b("maybe") + b("drop") + '</div>';
  }

  function setVerdict(id, v) {
    state.verdicts[id] = state.verdicts[id] === v ? "" : v;
    saveVerdicts(state.verdicts);
    // update pills in active view
    document.querySelectorAll('.verdict button[data-view="' + id + '"]').forEach(function (btn) {
      btn.classList.toggle("on", btn.dataset.v === state.verdicts[id]);
    });
    // update rail dot
    var dot = document.querySelector('.nav-item[data-i="' + idOf(id) + '"] .vdot');
    if (dot) dot.className = "vdot " + (state.verdicts[id] || "");
    refreshCounts();
  }

  function showView(i) {
    state.active = (i + VIEWS.length) % VIEWS.length;
    document.querySelectorAll(".view").forEach(function (s) { s.classList.toggle("active", +s.dataset.i === state.active); });
    document.querySelectorAll(".nav-item").forEach(function (n) { n.classList.toggle("active", +n.dataset.i === state.active); });
    document.querySelector(".stage").scrollTop = 0;
    window.scrollTo(0, 0);
  }

  function onKey(e) {
    if (state.focusMode) {
      var f = focusables();
      if (e.key === "Escape") { state.focusMode = false; blurActive(); e.preventDefault(); }
      else if (e.key === "ArrowDown" || e.key === "ArrowRight") { stepFocus(f, 1); e.preventDefault(); }
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft") { stepFocus(f, -1); e.preventDefault(); }
      else if (e.key === "Enter") { if (document.activeElement && document.activeElement.click) document.activeElement.click(); e.preventDefault(); }
      return;
    }
    switch (e.key) {
      case "ArrowDown": case "ArrowRight": showView(state.active + 1); e.preventDefault(); break;
      case "ArrowUp": case "ArrowLeft": showView(state.active - 1); e.preventDefault(); break;
      case "Enter": enterFocus(); e.preventDefault(); break;
      case "Escape": showView(0); e.preventDefault(); break;
    }
  }
  function focusables() {
    var sec = document.querySelector('.view[data-i="' + state.active + '"]');
    return sec ? Array.prototype.slice.call(sec.querySelectorAll(".gfocus")) : [];
  }
  function enterFocus() {
    var f = focusables(); if (!f.length) return;
    state.focusMode = true; f[0].focus();
  }
  function stepFocus(f, d) {
    if (!f.length) return;
    var i = f.indexOf(document.activeElement);
    var n = i === -1 ? 0 : (i + d + f.length) % f.length;
    f[n].focus();
  }
  function blurActive() { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }

  function refreshCounts() {
    var c = { keep:0, maybe:0, drop:0 };
    Object.keys(state.verdicts).forEach(function (k) { if (c[state.verdicts[k]] != null) c[state.verdicts[k]]++; });
    document.getElementById("keep-count").textContent = c.keep;
    document.getElementById("maybe-count").textContent = c.maybe;
    document.getElementById("drop-count").textContent = c.drop;
  }

  /* utils */
  function idOf(id) { for (var i=0;i<VIEWS.length;i++) if (VIEWS[i].id===id) return i; return -1; }
  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function loadVerdicts() { try { return JSON.parse(localStorage.getItem("wiser.verdicts") || "{}"); } catch (e) { return {}; } }
  function saveVerdicts(v) { try { localStorage.setItem("wiser.verdicts", JSON.stringify(v)); } catch (e) {} }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
