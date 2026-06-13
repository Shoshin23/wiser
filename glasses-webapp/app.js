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
    session: null, mode: "demo",
    hud: null, keyfact: "", history: [],
    running: false, awaiting: false, detail: false,
    recog: null, listening: false,
  };

  /* ---------- boot ---------- */
  function init() {
    cache();
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", function (e) {
      var t = e.target.closest && e.target.closest("[data-action]");
      if (t) handleAction(t.dataset.action);
    });
    var b = document.querySelector(".start .focusable"); if (b) b.focus();
  }
  function cache() {
    ["ambient","task-name","iter","goal-label","bar-fill","goal-count","decision",
     "sl-status","sl-act","sl-note","sl-cost","statusline","hint","detail","detail-body",
     "voice","voice-label","voice-text","start","mode-badge"].forEach(function (id) {
      els[camel(id)] = document.getElementById(id);
    });
  }
  function camel(s){ return s.replace(/-([a-z])/g,function(_,c){return c.toUpperCase();}); }

  /* ---------- kickoff: voice-prompt the task ---------- */
  var DEFAULT_PROMPT = "speed up the levenshtein hot path";
  function startPrompt() {
    if (state.running || state.starting) return;   // guard the listening/interpreting window
    state.starting = true;
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    // Voice is a best-effort nicety — it must NEVER block starting the loop.
    // No SR / no mic / SR backend unreachable → just begin with the default task.
    if (!SR) return interpret(DEFAULT_PROMPT);
    state.voiceMode = "prompt";
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
    state.promptCancel = function () { if (settled) return; settled = true; state.listening = false; state.starting = false; cleanupRecog(); hide(els.voice); show(els.start); };
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
    hide(els.start);
    var opened = await W.openSession();
    state.session = opened.session; state.mode = opened.mode;
    if (els.modeBadge) els.modeBadge.textContent = opened.mode;
    state.running = true; state.starting = false;
    state.session.on("hud", onHud);
    state.session.on("card", onCard);
    state.session.start("speed up the levenshtein hot path");
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
  function taskTitle() { return "levenshtein perf"; }

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
    if (!state.running) { if (e.key === "Enter") { startPrompt(); e.preventDefault(); } return; }
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
    // ambient
    if (e.key === "Enter") { openDetail(); e.preventDefault(); }
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
    // Calm state shows nothing — no persistent small text. Hints only when deciding.
    if (state.awaiting) els.hint.innerHTML = kbd("↕") + " pick  " + kbd("⏎") + " approve  " + kbd("⎋") + " reject";
    else els.hint.innerHTML = "";
  }
  function kbd(k) { return "<kbd>" + k + "</kbd>"; }

  function handleAction(a) {
    if (a === "start") startPrompt();
    else if (a === "back") closeDetail();
    else if (a === "voice") startVoice();
  }
  function show(e){ if(e) e.classList.remove("hidden"); }
  function hide(e){ if(e) e.classList.add("hidden"); }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
