/* wiser ambient — the app.
   1. Live transcription: rolling 5s MediaRecorder segments → /api/transcribe (Groq
      Whisper, server-side) → growing on-screen transcript.
   2. Background scanner: every ~8s (debounced on transcript growth) POST the recent
      window → /api/scan (Claude Haiku, server-side) → an opportunity card or null.
   3. Opportunity cards: swipe-right/→ approve (dispatch to the agent via /api/ask-text),
      swipe-left/← dismiss, tap/⏎ edit-then-send.

   No keys in the browser — it talks only to this origin's backend.
*/
(function () {
  "use strict";
  var W = window.WISER || {};
  var CFG = window.WISER_CONFIG || {};
  var BACKEND = CFG.BACKEND_URL || "";
  var CHUNK_MS = CFG.CHUNK_MS || 5000;
  var SCAN_INTERVAL_MS = CFG.SCAN_INTERVAL_MS || 8000;

  var els = {};
  var state = {
    listening: false,
    stream: null,
    recorder: null,
    transcript: "",
    lastScanLen: 0,
    scanInFlight: false,
    scanTimer: null,
    scans: 0,
    seen: Object.create(null),   // normalized proposedPrompt -> true (fast client dedup)
    proposed: [],                // [{ title, proposedPrompt }] sent to the scanner so Haiku won't re-propose
    opps: [],                    // [{ opp }] — pending opportunities, not yet approved/rejected
    idx: 0,                      // which pending card is shown (one at a time; newest by default)
    resultSeq: 0,
    brainstormId: null,          // server-side live brainstorm the glasses contribute into
    contribSince: 0,             // high-water mark (max contribution .at) we've pulled
  };

  /* ---------- boot ---------- */
  function init() {
    [
      "status", "status-label", "transcript", "opp-deck", "opp-hint", "results",
      "toggle", "note", "editor", "editor-text", "editor-cancel", "editor-send",
      "start", "start-btn", "start-note",
    ].forEach(function (id) { els[camel(id)] = document.getElementById(id); });

    els.startBtn.addEventListener("click", start);
    els.toggle.addEventListener("click", function () { state.listening ? stop() : start(); });
    els.editorCancel.addEventListener("click", closeEditor);
    document.addEventListener("keydown", onKey);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      els.startNote.textContent = "Mic unavailable — needs a secure context (localhost or https).";
    }
  }
  function camel(s) { return s.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); }); }

  /* ---------- listening lifecycle ---------- */
  async function start() {
    if (state.listening) return;
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      var msg = "Mic blocked: " + (e && e.message ? e.message : e) + " (needs localhost/https).";
      els.startNote.textContent = msg; els.note.textContent = msg;
      console.error("getUserMedia failed:", e);
      return;
    }
    state.listening = true;
    hide(els.start);
    els.toggle.textContent = "Stop listening";
    setStatus("live", "listening");
    els.note.textContent = "listening… scanning every " + Math.round(SCAN_INTERVAL_MS / 1000) + "s";
    if (els.transcript.querySelector(".transcript-empty")) els.transcript.innerHTML = "";
    recordSegment();
    state.scanTimer = setInterval(maybeScan, SCAN_INTERVAL_MS);

    // Open a server-side brainstorm so the glasses can contribute voice+photo into it.
    // Best-effort: if this fails the local browser brainstorm still works.
    (async function () {
      try {
        var res = await fetch(BACKEND + "/api/brainstorms", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Brainstorm " + new Date().toLocaleTimeString() }),
        });
        var data = await res.json();
        if (data && data.id) { state.brainstormId = data.id; state.contribSince = 0; }
      } catch (e) {
        console.warn("brainstorm create failed (local-only mode):", e);
      }
    })();
  }

  function stop() {
    state.listening = false;
    if (state.scanTimer) { clearInterval(state.scanTimer); state.scanTimer = null; }
    try { if (state.recorder && state.recorder.state !== "inactive") state.recorder.stop(); } catch (_) {}
    if (state.stream) { state.stream.getTracks().forEach(function (t) { t.stop(); }); state.stream = null; }
    els.toggle.textContent = "Start listening";
    setStatus("", "idle");
    // Best-effort: close the server-side brainstorm.
    if (state.brainstormId) {
      fetch(BACKEND + "/api/brainstorms/active/end", { method: "POST" }).catch(function () {});
      state.brainstormId = null;
    }
  }

  // Rolling segments: each MediaRecorder run produces ONE self-contained blob
  // (per-timeslice chunks aren't independently decodable), so we stop→upload→restart.
  function recordSegment() {
    if (!state.listening || !state.stream) return;
    var mime = pickMime();
    var rec;
    try { rec = new MediaRecorder(state.stream, mime ? { mimeType: mime } : undefined); }
    catch (e) { console.error("MediaRecorder init failed:", e); stop(); return; }
    state.recorder = rec;
    var chunks = [];
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = function () {
      if (chunks.length) {
        var blob = new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" });
        if (blob.size > 800) uploadSegment(blob);
      }
      if (state.listening) recordSegment(); // immediately roll the next segment
    };
    try { rec.start(); } catch (e) { console.error("recorder.start failed:", e); stop(); return; }
    setTimeout(function () { try { if (rec.state !== "inactive") rec.stop(); } catch (_) {} }, CHUNK_MS);
  }

  function pickMime() {
    var cands = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
    for (var i = 0; i < cands.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(cands[i])) return cands[i];
    }
    return "";
  }

  async function uploadSegment(blob) {
    try {
      var res = await fetch(BACKEND + "/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": blob.type || "audio/webm" },
        body: blob,
      });
      if (!res.ok) { console.warn("transcribe HTTP", res.status); return; }
      var data = await res.json();
      var text = (data && data.text || "").trim();
      if (text) appendTranscript(text);
    } catch (e) {
      console.error("transcribe failed:", e);
    }
  }

  function appendTranscript(text) {
    state.transcript += (state.transcript ? " " : "") + text;
    var prev = els.transcript.querySelector(".t-line.latest");
    if (prev) prev.classList.remove("latest");
    var line = W.el ? W.el("div", "t-line latest", text) : (function () { var n = document.createElement("div"); n.className = "t-line latest"; n.textContent = text; return n; })();
    els.transcript.appendChild(line);
    els.transcript.scrollTop = els.transcript.scrollHeight;
  }

  /* ---------- scanner ---------- */
  async function maybeScan() {
    if (!state.listening || state.scanInFlight) return;

    // Pull any new contributions the glasses pushed into the active brainstorm.
    var contribTexts = [], contribImage = null;
    if (state.brainstormId) {
      try {
        var cres = await fetch(BACKEND + "/api/brainstorms/" + state.brainstormId +
          "/contributions?since=" + state.contribSince);
        if (cres.ok) {
          var cdata = await cres.json();
          var contribs = (cdata && cdata.contributions) || [];
          if (contribs.length) {
            contribTexts = contribs.map(function (c) { return c.text; }).filter(Boolean);
            // use the LAST contribution that carries a photo
            for (var i = contribs.length - 1; i >= 0; i--) {
              if (contribs[i].imageB64) { contribImage = contribs[i].imageB64; break; }
            }
            var maxAt = contribs.reduce(function (m, c) { return Math.max(m, c.at || 0); }, state.contribSince);
            state.contribSince = Math.max(state.contribSince, maxAt);
          }
        }
      } catch (e) { console.warn("contributions fetch failed:", e); }
    }

    var hasNewContribs = contribTexts.length > 0 || !!contribImage;
    // Skip only when there's nothing new to look at: no transcript growth AND no
    // fresh contribution. (A glasses contribution can drive a scan on its own.)
    if (state.transcript.length === state.lastScanLen && !hasNewContribs) return;
    if (state.transcript.trim().length < 40 && !hasNewContribs) return; // too little to judge
    state.scanInFlight = true;
    state.lastScanLen = state.transcript.length;
    state.scans++;
    setStatus("scanning", "scanning…");
    try {
      var res = await fetch(BACKEND + "/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: state.transcript,
          proposed: state.proposed,
          contributions: contribTexts,
          imageB64: contribImage,
        }),
      });
      if (!res.ok) { noteScan("scan HTTP " + res.status); return; }
      var data = await res.json();
      if (data && data.opportunity) {
        var surfaced = offerOpportunity(data.opportunity);
        noteScan(surfaced ? "✦ opportunity surfaced" : "· already proposed");
      } else {
        noteScan("· nothing actionable yet");
      }
    } catch (e) {
      console.error("scan failed:", e);
      noteScan("· scan error — " + ((e && e.message) || e));
    } finally {
      state.scanInFlight = false;
      if (state.listening) setStatus("live", "listening");
    }
  }

  /* ---------- opportunity cards — one at a time; ↑↓ browse pending, ←/→/⏎ act ---------- */
  function offerOpportunity(opp) {
    var key = normalize(opp.proposedPrompt || opp.title);
    if (state.seen[key]) return false;    // dedup — already surfaced/acted
    state.seen[key] = true;
    // remember it so the scanner won't re-propose this (or anything overlapping)
    state.proposed.push({ title: opp.title, proposedPrompt: opp.proposedPrompt });
    state.opps.push({ opp: opp });
    state.idx = state.opps.length - 1;    // jump to the newest ("show the last")
    renderDeck();
    return true;
  }

  // Render ONLY the current pending card + a position indicator when there are several.
  function renderDeck() {
    els.oppDeck.innerHTML = "";
    if (!state.opps.length) { hide(els.oppHint); return; }
    state.idx = Math.max(0, Math.min(state.idx, state.opps.length - 1));
    var entry = state.opps[state.idx];

    if (state.opps.length > 1) {
      var nav = W.el("div", "opp-nav");
      nav.appendChild(W.el("span", "opp-count", (state.idx + 1) + " / " + state.opps.length + " pending"));
      var dots = W.el("div", "dots");
      state.opps.forEach(function (_, i) { dots.appendChild(W.el("span", "dot-pip" + (i === state.idx ? " on" : ""))); });
      nav.appendChild(dots);
      els.oppDeck.appendChild(nav);
    }

    entry.node = W.renderOpportunity(entry.opp, {
      onApprove: function () { approve(entry); },
      onDismiss: function () { dismiss(entry); },
      onEdit:    function () { editOpp(entry); },
      onPrev:    function () { navigate(-1); },
      onNext:    function () { navigate(1); },
    });
    entry.node.classList.add("enter");
    els.oppDeck.appendChild(entry.node);
    show(els.oppHint);
    entry.node.focus();
  }

  // ↑ = previous (older), ↓ = next (newer)
  function navigate(delta) {
    if (state.opps.length < 2) return;
    var n = Math.max(0, Math.min(state.idx + delta, state.opps.length - 1));
    if (n === state.idx) return;
    state.idx = n;
    renderDeck();
  }

  function removeEntry(entry, dir) {
    if (entry.node) entry.node.classList.add(dir === "right" ? "swipe-out-right" : "swipe-out-left");
    setTimeout(function () {
      var j = state.opps.indexOf(entry);
      if (j !== -1) state.opps.splice(j, 1);
      if (state.idx > state.opps.length - 1) state.idx = state.opps.length - 1;
      renderDeck();
    }, 280);
  }

  function approve(entry) { dispatch(entry.opp.proposedPrompt, entry.opp.title); removeEntry(entry, "right"); }
  function dismiss(entry) { removeEntry(entry, "left"); }
  function editOpp(entry) {
    openEditor(entry.opp.proposedPrompt, function (text) { dispatch(text, entry.opp.title); removeEntry(entry, "right"); });
  }

  /* ---------- dispatch to the agent fleet (via the backend proxy) ---------- */
  async function dispatch(prompt, title) {
    var id = "r" + (++state.resultSeq);
    var card = renderResult({ id: id, title: title || firstWords(prompt), status: "working", line: "dispatching to the fleet…" });
    els.results.insertBefore(card, els.results.firstChild);
    try {
      var res = await fetch(BACKEND + "/api/ask-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: prompt }),
      });
      var data = await res.json();
      if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
      var head = (data.card && data.card.title) || title || firstWords(prompt);
      var line = data.answer || (data.card && data.card.summary) || "done";
      updateResult(id, { title: head, status: "done", line: line });
    } catch (e) {
      console.error("dispatch failed:", e);
      updateResult(id, { title: title || firstWords(prompt), status: "failed", line: (e && e.message) || "failed" });
    }
  }

  // result card — built from the .card primitives so it matches the theme
  function renderResult(r) {
    var el = W.el;
    var node = el("div", "card enter"); node.id = "res-" + r.id;
    node.style.setProperty("--card-accent", accentFor(r.status));
    var head = el("div", "card-head");
    head.appendChild(el("span", "card-icon", iconFor(r.status)));
    head.appendChild(el("span", "card-kind", "agent"));
    node.appendChild(head);
    var body = el("div", "card-body");
    body.appendChild(el("div", "explain-head clamp2", r.title));
    body.appendChild(el("div", "card-line muted", r.line));
    node.appendChild(body);
    return node;
  }
  function updateResult(id, r) {
    var node = document.getElementById("res-" + id);
    if (!node) return;
    node.style.setProperty("--card-accent", accentFor(r.status));
    node.querySelector(".card-icon").textContent = iconFor(r.status);
    node.querySelector(".explain-head").textContent = r.title;
    node.querySelector(".card-line").textContent = r.line;
  }
  function accentFor(s) { return s === "failed" ? "var(--danger)" : s === "done" ? "var(--success)" : "var(--accent)"; }
  function iconFor(s) { return s === "failed" ? "✗" : s === "done" ? "✓" : "⟳"; }

  /* ---------- editor ---------- */
  var editorSend = null;
  function openEditor(prefill, onSend) {
    editorSend = onSend;
    els.editorText.value = prefill || "";
    show(els.editor);
    els.editorText.focus();
    els.editorText.setSelectionRange(els.editorText.value.length, els.editorText.value.length);
    els.editorSend.onclick = function () { var t = els.editorText.value.trim(); closeEditor(); if (t && editorSend) editorSend(t); };
  }
  function closeEditor() { hide(els.editor); editorSend = null; }

  /* ---------- gestures (keyboard) ---------- */
  function onKey(e) {
    if (!els.editor.classList.contains("hidden")) {
      if (e.key === "Escape") { closeEditor(); e.preventDefault(); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { els.editorSend.click(); e.preventDefault(); }
      return;
    }
    if (!state.opps.length) return;
    var cur = state.opps[state.idx];
    if (e.key === "ArrowRight") { approve(cur); e.preventDefault(); }
    else if (e.key === "ArrowLeft") { dismiss(cur); e.preventDefault(); }
    else if (e.key === "ArrowUp") { navigate(-1); e.preventDefault(); }
    else if (e.key === "ArrowDown") { navigate(1); e.preventDefault(); }
    else if (e.key === "Enter") { editOpp(cur); e.preventDefault(); }
  }

  /* ---------- helpers ---------- */
  function setStatus(cls, label) { els.status.className = "amb-status" + (cls ? " " + cls : ""); els.statusLabel.textContent = label; }
  function noteScan(msg) { els.note.textContent = "scan " + state.scans + " · " + state.transcript.length + " chars · " + msg; }
  function normalize(s) { return String(s || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120); }
  function firstWords(s) { var w = String(s || "").split(/\s+/).slice(0, 6).join(" "); return w + (String(s || "").split(/\s+/).length > 6 ? "…" : ""); }
  function show(e) { if (e) e.classList.remove("hidden"); }
  function hide(e) { if (e) e.classList.add("hidden"); }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
