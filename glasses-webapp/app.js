/* wiser — glasses-only agent-coding UI. The lens is the ONLY screen.

   Three layers by attention demand:
     1. AMBIENT   — calm center: just the goal + progress-to-exit (stable target).
     2. STATUSLINE — always-on dense line: status · current file/tool · latest fact · $.
        (the rolling present-tense, like Claude Code's statusline — glance, don't read)
     3. DECISION  — a card takes the center ONLY when the agent needs you.

   Pull, not push: the full history/diff is one gesture away (Enter → activity trail);
   voice can ask anything. The firehose never becomes a feed.

   6 inputs: ←/→ unused in calm · ↑/↓ pick options in a decision · Enter = open/approve ·
   Esc = back/reject · M (or mic chip) = voice steer.
*/
(function () {
  "use strict";
  var W = window.WISER;

  var els = {};
  var state = {
    view: "home",                 // home | loop | goals  (home is the root)
    session: null, activeSession: null, mode: "demo",
    hud: null, keyfact: "", history: [],
    running: false, awaiting: false, detail: false,
    recog: null, listening: false,
  };

  /* ---------- boot ---------- */
  function init() {
    cache();
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", function (e) {
      var row = e.target.closest && e.target.closest("[data-sid]");
      if (row) { var s = W.findSession(row.dataset.sid); if (s) openSession(s); return; }
      var t = e.target.closest && e.target.closest("[data-action]");
      if (t) handleAction(t.dataset.action);
    });
    renderHome();
    setView("home");
  }
  function cache() {
    ["home","goals","goals-body","goals-task","team","team-body","team-title",
     "ambient","task-name","iter","goal-label","bar-fill","goal-count","decision",
     "sl-status","sl-act","sl-note","sl-cost","statusline","hint","detail","detail-body",
     "voice","voice-label","voice-text","start","mode-badge"].forEach(function (id) {
      els[camel(id)] = document.getElementById(id);
    });
  }

  /* ---------- view router (one screen at a time on the lens) ---------- */
  function setView(v) {
    state.view = v;
    hide(els.home); hide(els.goals); hide(els.team); hide(els.start);
    hide(els.detail); hide(els.voice);
    var loopCore = [els.ambient, els.statusline, els.hint];
    if (v === "home") { show(els.home); hide(els.decision); loopCore.forEach(hide); }
    else if (v === "goals") { show(els.goals); hide(els.decision); loopCore.forEach(hide); }
    else if (v === "team") { show(els.team); hide(els.decision); loopCore.forEach(hide); }
    else { loopCore.forEach(show); }   // loop: moment logic owns ambient↔decision
    paintHint();
  }

  /* ---------- HOME: Sessions overview + Mission-Control glance ---------- */
  function renderHome() {
    var f = W.FLEET, m = f.mission, body = els.home;
    body.innerHTML = "";
    var strip = W.el("div", "mc-strip");
    strip.appendChild(mcStat(String(m.running), "running", "var(--accent)", false));
    strip.appendChild(mcStat(String(m.blocked), "needs you", "var(--attn)", m.blocked > 0));
    strip.appendChild(mcStat("$" + m.burnUsd.toFixed(2), "/ hr", "var(--gold)", false));
    body.appendChild(strip);
    body.appendChild(W.el("div", "mc-sub", m.tokRate + "  ·  " + f.sessions.length + " sessions"));

    var list = W.el("div", "sess-list");
    // Sort by attention: what needs you floats up, finished work sinks — so the
    // top of home is always the highest-signal row (the non-distracting thesis).
    f.sessions.slice().sort(function (a, b) { return attnRank(a) - attnRank(b); }).forEach(function (s) {
      var st = W.STATUS[s.status] || W.STATUS.running;
      var row = W.el("div", "sess-row focusable"); row.tabIndex = 0; row.dataset.sid = s.id;
      var dot = W.el("span", "sess-dot"); dot.style.background = st.color;
      if (st.pulse) dot.classList.add("pulse");
      row.appendChild(dot);
      var main = W.el("div", "sess-main");
      main.appendChild(W.el("div", "sess-task", s.task));
      main.appendChild(W.el("div", "sess-meta", statusVerb(s.status) + " · iter " + s.iter + " · " + s.model));
      row.appendChild(main);
      var res = W.el("div", "sess-res");
      res.appendChild(W.el("div", "sess-res-v", s.result));
      res.appendChild(W.el("div", "sess-res-c", "$" + s.costUsd.toFixed(2)));
      row.appendChild(res);
      list.appendChild(row);
    });
    var nrow = W.el("div", "sess-row new focusable"); nrow.tabIndex = 0; nrow.dataset.action = "new";
    nrow.appendChild(W.el("span", "sess-dot plus", "＋"));
    var nmain = W.el("div", "sess-main");
    nmain.appendChild(W.el("div", "sess-task", "New session"));
    nmain.appendChild(W.el("div", "sess-meta", "voice a task for the fleet"));
    nrow.appendChild(nmain);
    list.appendChild(nrow);
    body.appendChild(list);

    var first = body.querySelector(".focusable"); if (first) first.focus();
  }
  // attention tiers: needs-you ▸ active ▸ done ▸ failed
  function attnRank(s) {
    var r = { awaiting_human: 0, retrying: 1, judging: 1, running: 1, done: 2, failed: 3 }[s.status];
    return r === undefined ? 2 : r;
  }
  function mcStat(value, label, color, pulse) {
    var s = W.el("div", "mc-stat" + (pulse ? " pulse" : ""));
    var v = W.el("div", "mc-v", value); v.style.color = color;
    s.appendChild(v); s.appendChild(W.el("div", "mc-l", label));
    return s;
  }
  function homeFocusables() { return Array.prototype.slice.call(els.home.querySelectorAll(".focusable")); }
  function moveHome(d) {
    var o = homeFocusables(); if (!o.length) return;
    var i = o.indexOf(document.activeElement);
    o[i === -1 ? 0 : (i + d + o.length) % o.length].focus();
  }
  function activateHome() {
    var el = document.activeElement;
    if (el && el.dataset && el.dataset.action === "new") { startPrompt(); return; }
    if (el && el.dataset && el.dataset.sid) { var s = W.findSession(el.dataset.sid); if (s) openSession(s); }
  }

  /* ---------- open a session from the overview ---------- */
  function openSession(s) {
    state.activeSession = s;
    if (s.live) { startLoop(); return; }   // the live one drives the real loop
    openStaticSession(s);                   // others are frozen snapshots
  }
  function openStaticSession(s) {
    state.session = null;
    state.hud = s.hud || null;
    state.history = (s.history || []).slice();
    state.keyfact = (s.hud && s.hud.activity && s.hud.activity.note) ||
      (state.history.length ? state.history[state.history.length - 1].text : "");
    state.running = true; state.awaiting = false; state.detail = false;
    setView("loop");
    paintAmbient(); paintStatusline();
    if (s.status === "awaiting_human" && s.decision) showMoment(s.decision, { interactive: true });
    else if (s.status === "done" && s.done) showFinal(s.done);
  }

  /* ---------- GOALS: goal progression / steps for the active session ---------- */
  function openGoals() {
    var s = state.activeSession; if (!s || !s.goal) return;
    var g = s.goal, body = els.goalsBody;
    els.goalsTask.textContent = s.task;
    body.innerHTML = "";

    body.appendChild(W.el("div", "goal-title", g.title));
    var overall = W.el("div", "goal-overall");
    var track = W.el("span", "goal-track"); var fill = W.el("i"); fill.style.width = g.pct + "%"; track.appendChild(fill);
    overall.appendChild(track); overall.appendChild(W.el("span", "goal-pct", g.pct + "%"));
    body.appendChild(overall);

    if (g.attempts && g.attempts.length) {
      var at = W.el("div", "block");
      at.appendChild(W.el("div", "block-l", "attempts · run → judge → retry"));
      var line = W.el("div", "attempts");
      g.attempts.forEach(function (a) {
        var as = attemptStatus(a.r);
        var node = W.el("div", "attempt");
        var ic = W.el("span", "attempt-ic", as.icon); ic.style.color = as.color;
        if (as.pulse) ic.classList.add("pulse");
        node.appendChild(ic); node.appendChild(W.el("span", "attempt-tx", a.t));
        line.appendChild(node);
      });
      at.appendChild(line); body.appendChild(at);
    }

    var subsBlk = W.el("div", "block");
    subsBlk.appendChild(W.el("div", "block-l", "steps"));
    g.subs.forEach(function (s2) {
      var r = W.el("div", "subgoal");
      r.appendChild(W.el("span", "subgoal-lab", s2.label));
      var tr = W.el("span", "subgoal-track"); var fi = W.el("i"); fi.style.width = s2.pct + "%";
      if (s2.pct >= 100) fi.classList.add("full"); tr.appendChild(fi); r.appendChild(tr);
      r.appendChild(W.el("span", "subgoal-pct", s2.pct + "%"));
      subsBlk.appendChild(r);
    });
    body.appendChild(subsBlk);

    if (g.dod && g.dod.length) {
      var dod = W.el("div", "block");
      dod.appendChild(W.el("div", "block-l", "definition of done"));
      g.dod.forEach(function (d) {
        var row = W.el("div", "dod-row" + (d.done ? " done" : ""));
        row.appendChild(W.el("span", "dod-ic", d.done ? "✓" : "○"));
        row.appendChild(W.el("span", "dod-tx", d.label));
        dod.appendChild(row);
      });
      body.appendChild(dod);
    }

    body.scrollTop = 0;
    setView("goals");
    var b = els.goals.querySelector(".back-btn"); if (b) b.focus();
  }
  function backFromGoals() { setView("loop"); paintAmbient(); paintStatusline(); }
  function attemptStatus(r) {
    return {
      fail: { icon: "✗", color: "var(--danger)",  pulse: false },
      run:  { icon: "●", color: "var(--accent)",  pulse: true  },
      wait: { icon: "◆", color: "var(--attn)",    pulse: true  },
      done: { icon: "✓", color: "var(--success)", pulse: false },
    }[r] || { icon: "•", color: "var(--muted)", pulse: false };
  }

  /* ---------- TEAM: MetaLoop zoom-out — the fan-out racing the goal ---------- */
  function openTeam() {
    var s = state.activeSession; if (!s || !s.team) return;   // only sessions that fanned out
    var t = s.team, body = els.teamBody;
    els.teamTitle.textContent = "Team · " + (t.mode === "compete" ? "best-of-N" : "fan-out");
    body.innerHTML = "";
    body.appendChild(W.el("div", "goal-title", t.goal));
    var leadN = t.agents.filter(function (a) { return a.lead; }).length;
    body.appendChild(W.el("div", "mc-sub", t.agents.length + " agents · " + t.mode + " · " + (leadN ? leadN + " leads" : "racing")));

    var list = W.el("div", "cand-list");
    t.agents.forEach(function (a) {
      var st = W.STATUS[a.status] || W.STATUS.running;
      var row = W.el("div", "cand focusable" + (a.lead ? " lead" : "")); row.tabIndex = 0;
      var dot = W.el("span", "sess-dot"); dot.style.background = st.color; if (st.pulse) dot.classList.add("pulse");
      row.appendChild(dot);
      var main = W.el("div", "sess-main");
      main.appendChild(W.el("div", "cand-lab", a.label + (a.lead ? "  ◆" : "")));
      main.appendChild(W.el("div", "sess-meta", statusVerb(a.status) + " · " + a.model));
      row.appendChild(main);
      row.appendChild(W.el("div", "cand-score", a.score));
      list.appendChild(row);
    });
    body.appendChild(list);

    body.scrollTop = 0;
    setView("team");
    var first = list.querySelector(".cand.lead") || list.querySelector(".focusable");
    if (first) first.focus();
  }
  function teamCandidates() { return Array.prototype.slice.call(els.team.querySelectorAll(".cand.focusable")); }
  function moveCandidate(d) {
    var o = teamCandidates(); if (!o.length) return;
    var i = o.indexOf(document.activeElement);
    o[i === -1 ? 0 : (i + d + o.length) % o.length].focus();
  }
  function focusCandidate() {
    // picking a candidate zooms back into the task, now focused on that agent
    var o = teamCandidates(), i = o.indexOf(document.activeElement);
    var a = state.activeSession.team.agents[Math.max(0, i)];
    if (a) state.keyfact = "focused: " + a.label + (a.score && a.score !== "—" ? " · " + a.score : "");
    setView("loop"); paintAmbient(); paintStatusline();
  }
  function backFromTeam() { setView("loop"); paintAmbient(); paintStatusline(); }

  /* ---------- back to the fleet overview ---------- */
  function backToHome() {
    if (state.session && state.session.stop) { try { state.session.stop(); } catch (e) {} }
    if (state.momentTimer) { clearTimeout(state.momentTimer); state.momentTimer = null; }
    state.session = null; state.activeSession = null;
    state.running = false; state.awaiting = false; state.detail = false;
    state.currentQuestion = null; state.hud = null; state.history = []; state.keyfact = "";
    renderHome();
    setView("home");
  }
  function camel(s){ return s.replace(/-([a-z])/g,function(_,c){return c.toUpperCase();}); }

  /* ---------- kickoff: voice-prompt the task ---------- */
  var DEFAULT_PROMPT = "build a small issue tracker — a tiny Linear";
  function startPrompt() {
    if (state.running || state.starting) return;   // guard the listening/interpreting window
    state.starting = true;
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    // Voice is a best-effort nicety — it must NEVER block starting the loop.
    // No SR / no mic / SR backend unreachable → just begin with the default task.
    if (!SR) return interpret(DEFAULT_PROMPT);
    state.voiceMode = "prompt";
    hide(els.start);                   // don't let the idle screen sit under the voice overlay
    showVoice("What should I build?");
    var settled = false;
    var go = function (text) { if (settled) return; settled = true; state.listening = false; cleanupRecog(); interpret(text || DEFAULT_PROMPT); };
    var r = new SR(); state.recog = r;
    r.lang = "en-US"; r.interimResults = true; r.maxAlternatives = 1;
    r.onresult = function (ev) {
      var txt = ""; for (var i = 0; i < ev.results.length; i++) txt += ev.results[i][0].transcript;
      els.voiceText.textContent = txt;
      if (ev.results[ev.results.length - 1].isFinal) go(txt);
    };
    r.onerror = function () { go(DEFAULT_PROMPT); };   // proceed, don't dead-end at idle
    r.onend = function () { if (!settled && state.listening) go(els.voiceText.textContent || DEFAULT_PROMPT); };
    state.promptGo = go;                               // Enter/click accepts what's been said
    state.promptCancel = function () { if (settled) return; settled = true; state.listening = false; state.starting = false; cleanupRecog(); hide(els.voice); renderHome(); setView("home"); };
    state.listening = true;
    try { r.start(); } catch (e) { go(DEFAULT_PROMPT); }
    // safety net: never hang on the listening screen
    setTimeout(function () { if (!settled) go(els.voiceText.textContent || DEFAULT_PROMPT); }, 8000);
  }
  // Nemotron intent→task: show we're translating the spoken prompt, then run.
  function interpret(text) {
    hide(els.start);
    showVoice("interpreting…"); els.voiceText.textContent = text || "";
    setTimeout(function () { hide(els.voice); startLoop(); }, 1000);
  }

  /* ---------- session ---------- */
  async function startLoop() {
    if (state.running) return;
    if (!state.activeSession) state.activeSession = W.findSession("lev");  // the live mock loop
    setView("loop");
    var opened = await W.openSession();
    state.session = opened.session; state.mode = opened.mode;
    if (els.modeBadge) els.modeBadge.textContent = opened.mode;
    state.running = true; state.starting = false;
    show(els.ambient); show(els.statusline);   // reveal the lens now that the loop is live
    state.session.on("hud", onHud);
    state.session.on("card", onCard);
    state.session.start(DEFAULT_PROMPT);
  }

  function onHud(hud) {
    state.hud = hud;
    // Only "awaiting" while an interactive question is actually on screen — a 1s
    // clock tick still carrying status:"awaiting_human" must not re-arm it post-pick.
    state.awaiting = hud.status === "awaiting_human" && !!state.currentQuestion;
    if (hud.activity && hud.activity.note) state.keyfact = hud.activity.note;
    paintAmbient();
    paintStatusline();
  }

  function onCard(card) {
    if (card.kind === "question") { state.history.push(trailEntry(card)); showMoment(card, { interactive: true }); return; }
    if (card.kind === "done" && card.final) { state.history.push(trailEntry(card)); showFinal(card); return; }
    if (card.kind === "checkpoint") { state.history.push(trailEntry(card)); showMoment(card, { autoMs: 2800 }); bumpStatus(card); return; }
    if (card.kind === "done") { state.history.push(trailEntry(card)); showMoment(card, { sticky: true }); bumpStatus(card); return; }
    // diff / tests / cost / explain → milestone: record + surface as the latest fact
    state.history.push(trailEntry(card));
    bumpStatus(card);
    if (state.detail) renderTrail();
  }
  function bumpStatus(card) { state.keyfact = W.cardOneLiner(card); paintStatusline(); }

  /* ---------- AMBIENT (calm center) ---------- */
  function paintAmbient() {
    var h = state.hud; if (!h) return;
    els.taskName.textContent = taskTitle();
    els.iter.textContent = h.iter ? "iter " + h.iter : "";
    els.goalLabel.textContent = h.exit.label;
    els.goalCount.textContent = h.exit.need ? h.exit.have + " / " + h.exit.need : "";
    var st = W.STATUS[h.status] || W.STATUS.running;
    var pct = h.exit.need ? Math.round((h.exit.have / h.exit.need) * 100) : 0;
    els.barFill.style.width = pct + "%";
    els.barFill.style.background = "linear-gradient(90deg, " + st.color + ", var(--accent2))";
  }
  function taskTitle() { return "issue tracker"; }

  /* ---------- STATUSLINE (rolling present) ---------- */
  function paintStatusline() {
    var h = state.hud; if (!h) return;
    var st = W.STATUS[h.status] || W.STATUS.running;
    els.slStatus.querySelector(".dot").style.background = st.color;
    els.slStatus.classList.toggle("pulse", !!st.pulse);
    // left: current activity (icon + file/tool) or a status verb
    if (h.activity && h.activity.target) {
      els.slAct.textContent = W.activityIcon(h.activity.verb) + " " + h.activity.target;
    } else {
      els.slAct.textContent = statusVerb(h.status);
    }
    els.slAct.style.color = st.color;
    // mid: latest fact
    els.slNote.textContent = state.keyfact || "";
    // right: running cost (tokens live in the checkpoint card, not the calm line)
    els.slCost.textContent = "$" + (h.costUsd || 0).toFixed(2);
  }
  function statusVerb(s) {
    return { running:"working", judging:"judging", retrying:"retrying",
             awaiting_human:"needs you", done:"done", failed:"failed" }[s] || s;
  }

  /* ---------- MOMENT (center takeover: checkpoint / done / question) ---------- */
  function showMoment(card, opts) {
    opts = opts || {};
    if (state.momentTimer) { clearTimeout(state.momentTimer); state.momentTimer = null; }
    state.awaiting = !!opts.interactive;
    state.currentQuestion = opts.interactive ? card : null;
    hide(els.ambient);
    els.decision.innerHTML = "";
    var node = W.renderCard(card, { active: !!opts.interactive, onPick: function (i) { pickOption(i); } });
    node.classList.add("enter");
    if (card.kind === "checkpoint") node.classList.add("flash-card");
    els.decision.appendChild(node);
    show(els.decision);
    paintStatusline(); paintHint();
    if (opts.interactive) { var first = node.querySelector(".q-option.focusable"); if (first) first.focus(); }
    if (opts.autoMs) state.momentTimer = setTimeout(clearMoment, opts.autoMs);
  }
  function clearMoment() {
    if (state.momentTimer) { clearTimeout(state.momentTimer); state.momentTimer = null; }
    state.awaiting = false; state.currentQuestion = null;
    hide(els.decision); show(els.ambient);
    paintHint();
  }
  var clearDecision = clearMoment;  // alias used by steer paths

  /* ---------- FINAL screen (conclusive, no return) ---------- */
  function showFinal(card) {
    clearMoment();
    hide(els.ambient); hide(els.statusline); hide(els.hint);
    els.decision.innerHTML = "";
    var wrap = W.el("div", "final");
    wrap.appendChild(W.el("div", "gen-badge", "✦ generated by Nemotron"));
    wrap.appendChild(W.el("div", "final-check", "✓"));
    wrap.appendChild(W.el("div", "final-head", card.headline || "Shipped"));
    if (card.subline) wrap.appendChild(W.el("div", "final-sub", card.subline));
    var grid = W.el("div", "done-stats");
    (card.stats || []).forEach(function (s) {
      var st = W.el("div", "stat"); st.appendChild(W.el("span", "stat-v", s.value)); st.appendChild(W.el("span", "stat-l", s.label)); grid.appendChild(st);
    });
    wrap.appendChild(grid);
    els.decision.appendChild(wrap);
    show(els.decision);
  }
  function questionOptions() {
    return Array.prototype.slice.call(els.decision.querySelectorAll(".q-option.focusable"));
  }
  function pickOption(i) {
    var label = state.currentQuestion ? (state.currentQuestion.options[i] || "") : "";
    steer({ type: "gesture", action: i === 1 ? "reject" : "approve" }, "picked: " + label);
    clearDecision();
  }

  /* ---------- STEER ---------- */
  function steer(s, trailText) {
    if (state.session && state.session.steer) state.session.steer(s);
    state.history.push({ icon: "◆", text: trailText || (s.type === "voice" ? "you: " + s.text : "you: " + s.action), you: true });
    if (state.detail) renderTrail();
  }

  /* ---------- DEEP-DIVE (activity trail — the only list, pulled) ---------- */
  function openDetail() {
    state.detail = true;
    renderTrail();
    show(els.detail);
    var b = els.detail.querySelector(".back-btn"); if (b) b.focus();
  }
  function closeDetail() { state.detail = false; hide(els.detail); }
  function renderTrail() {
    var body = els.detailBody; body.innerHTML = "";
    var h = state.hud;
    if (h) {
      var g = W.el("div", "trail-goal");
      g.appendChild(W.el("span", "trail-goal-l", h.exit.label));
      g.appendChild(W.el("span", "trail-goal-c", h.exit.need ? h.exit.have + " / " + h.exit.need : ""));
      body.appendChild(g);
    }
    if (!state.history.length) { body.appendChild(W.el("div", "trail-empty", "no activity yet")); return; }
    var list = W.el("div", "trail");
    state.history.forEach(function (e) {
      var row = W.el("div", "trail-row" + (e.you ? " you" : ""));
      row.appendChild(W.el("span", "trail-ic", e.icon));
      row.appendChild(W.el("span", "trail-tx", e.text));
      list.appendChild(row);
    });
    body.appendChild(list);
    body.scrollTop = body.scrollHeight;
  }
  function trailEntry(card) {
    var icon = { diff:"✎", tests:"▶", cost:"$", explain:"✦", checkpoint:"◷", done:"✓", question:"◆" }[card.kind] || "•";
    return { icon: icon, text: W.cardOneLiner(card) };
  }

  /* ---------- VOICE ---------- */
  function showVoice(label) { if (els.voiceLabel) els.voiceLabel.textContent = label || "Listening…"; els.voiceText.textContent = ""; show(els.voice); }
  function cleanupRecog() { if (state.recog) { try { state.recog.stop(); } catch (e) {} state.recog = null; } }

  function startVoice() {           // voice STEER (mid-run)
    if (state.listening) return;
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    state.voiceMode = "steer"; showVoice("Listening…"); state.listening = true;
    if (!SR) { state.listening = false; hide(els.voice); var t = window.prompt("Voice steer:"); if (t) submitVoice(t); return; }
    var r = new SR(); state.recog = r;
    r.lang = "en-US"; r.interimResults = true; r.maxAlternatives = 1;
    r.onresult = function (ev) {
      var txt = ""; for (var i = 0; i < ev.results.length; i++) txt += ev.results[i][0].transcript;
      els.voiceText.textContent = txt;
      if (ev.results[ev.results.length - 1].isFinal) { stopVoice(false); submitVoice(txt); }
    };
    r.onerror = function () { stopVoice(true); };
    r.onend = function () { if (state.listening) stopVoice(true); };
    try { r.start(); } catch (e) { stopVoice(true); }
  }
  function stopVoice(cancel) {
    state.listening = false; cleanupRecog(); hide(els.voice);
    if (cancel) {} // submit path handles success
  }
  function submitVoice(text) {
    if (!text) return;
    steer({ type: "voice", text: text }, "you: " + text);
    if (state.awaiting) clearDecision();
  }

  /* ---------- gestures ---------- */
  function onKey(e) {
    if (state.listening) {
      if (state.voiceMode === "prompt") {
        if (e.key === "Enter" && state.promptGo) { state.promptGo(els.voiceText.textContent); e.preventDefault(); }
        else if (e.key === "Escape" && state.promptCancel) { state.promptCancel(); e.preventDefault(); }
      } else if (e.key === "Escape") { stopVoice(true); }
      return;
    }

    // HOME — the fleet overview (root)
    if (state.view === "home") {
      if (e.key === "ArrowDown") { moveHome(1); e.preventDefault(); }
      else if (e.key === "ArrowUp") { moveHome(-1); e.preventDefault(); }
      else if (e.key === "Enter") { activateHome(); e.preventDefault(); }
      else if (e.key === "m" || e.key === "M") { startPrompt(); e.preventDefault(); }
      return;
    }

    // GOALS — goal progression for the active session
    if (state.view === "goals") {
      if (e.key === "Escape" || e.key === "ArrowLeft") { backFromGoals(); e.preventDefault(); }
      else if (e.key === "ArrowDown") { els.goalsBody.scrollTop += 60; e.preventDefault(); }
      else if (e.key === "ArrowUp") { els.goalsBody.scrollTop -= 60; e.preventDefault(); }
      return;
    }

    // TEAM — MetaLoop zoom-out: pick a candidate (↑/↓), drill in (⏎), zoom back (↓-at-edge/⎋)
    if (state.view === "team") {
      if (e.key === "ArrowUp") { moveCandidate(-1); e.preventDefault(); }
      else if (e.key === "ArrowDown") { moveCandidate(1); e.preventDefault(); }
      else if (e.key === "Enter" || e.key === "ArrowRight") { focusCandidate(); e.preventDefault(); }
      else if (e.key === "Escape" || e.key === "ArrowLeft") { backFromTeam(); e.preventDefault(); }
      return;
    }

    // LOOP — the live coding session
    if (state.detail) {
      if (e.key === "Escape" || e.key === "Enter") { closeDetail(); e.preventDefault(); }
      else if (e.key === "ArrowDown") { els.detailBody.scrollTop += 60; e.preventDefault(); }
      else if (e.key === "ArrowUp") { els.detailBody.scrollTop -= 60; e.preventDefault(); }
      return;
    }
    if (e.key === "m" || e.key === "M") { startVoice(); e.preventDefault(); return; }
    if (state.awaiting) {
      if (e.key === "ArrowUp") { moveOption(-1); e.preventDefault(); }
      else if (e.key === "ArrowDown") { moveOption(1); e.preventDefault(); }
      else if (e.key === "Enter") { var o = questionOptions(); var i = Math.max(0, o.indexOf(document.activeElement)); pickOption(i); e.preventDefault(); }
      else if (e.key === "Escape") { pickReject(); e.preventDefault(); }
      return;
    }
    // calm loop (Task altitude) — the zoom axis:
    //   ↑ team (zoom out) · ↓/⏎ activity (zoom in) · → goal · ⎋/← fleet
    if (e.key === "ArrowUp") { if (state.activeSession && state.activeSession.team) openTeam(); e.preventDefault(); }
    else if (e.key === "ArrowDown" || e.key === "Enter") { openDetail(); e.preventDefault(); }
    else if (e.key === "ArrowRight") { openGoals(); e.preventDefault(); }
    else if (e.key === "Escape" || e.key === "ArrowLeft") { backToHome(); e.preventDefault(); }
  }
  function moveOption(d) {
    var o = questionOptions(); if (!o.length) return;
    var i = o.indexOf(document.activeElement);
    var n = i === -1 ? 0 : (i + d + o.length) % o.length;
    o[n].focus();
  }
  function pickReject() {
    steer({ type: "gesture", action: "reject" }, "rejected");
    clearDecision();
  }

  function paintHint() {
    if (state.awaiting) { els.hint.innerHTML = kbd("↕") + " pick  " + kbd("⏎") + " approve  " + kbd("⎋") + " reject"; return; }
    // Calm loop (Task altitude): surface the zoom axis faintly (still just the 6 inputs).
    if (state.view === "loop") {
      var team = state.activeSession && state.activeSession.team ? kbd("↑") + " team  " : "";
      els.hint.innerHTML = team + kbd("↓") + " activity  " + kbd("→") + " goal  " + kbd("⎋") + " fleet";
    } else els.hint.innerHTML = "";
  }
  function kbd(k) { return "<kbd>" + k + "</kbd>"; }

  function handleAction(a) {
    if (a === "start" || a === "new") startPrompt();
    else if (a === "back") closeDetail();
    else if (a === "goals-back") backFromGoals();
    else if (a === "team-back") backFromTeam();
    else if (a === "voice") startVoice();
  }
  function show(e){ if(e) e.classList.remove("hidden"); }
  function hide(e){ if(e) e.classList.add("hidden"); }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
