/* wiser glasses webapp — STT -> agent -> TTS, shown as a card.
   Vanilla JS, classic script. D-pad = arrow keys + Enter + Escape. */

(function () {
  "use strict";

  var BACKEND_URL = (window.WISER_CONFIG && window.WISER_CONFIG.BACKEND_URL) || "http://localhost:8787";

  var state = {
    screen: "home",      // 'home' | 'detail'
    recording: false,
    withImage: false,
    mediaRecorder: null,
    recChunks: [],
    micStream: null,
    pendingImage: null,  // Blob | null
    last: null,          // AskResponse | null
    audioQueue: [],      // Audio elements playing in sequence
    audioIdx: 0,
  };

  /* ---------- helpers ---------- */

  function $(id) { return document.getElementById(id); }
  function show(el) { el.classList.remove("hidden"); }
  function hide(el) { el.classList.add("hidden"); }
  function setStatus(t) { $("status").textContent = t; }

  function activeScreenEl() { return state.screen === "detail" ? $("detail") : $("home"); }
  function focusables() {
    return Array.prototype.slice.call(
      activeScreenEl().querySelectorAll(".focusable:not([disabled])")
    ).filter(function (el) { return el.offsetParent !== null; });
  }
  function focusFirst() {
    var f = focusables();
    if (f.length) f[0].focus();
  }

  function showLoading(text) {
    $("loading-text").textContent = text || "Thinking…";
    show($("loading"));
  }
  function hideLoading() { hide($("loading")); }
  function showError(msg) {
    $("error-text").textContent = msg || "Something went wrong";
    show($("error"));
    var btn = $("error").querySelector(".focusable");
    if (btn) btn.focus();
  }

  /* ---------- D-pad navigation ---------- */

  function moveFocus(delta) {
    var f = focusables();
    if (!f.length) return;
    var idx = f.indexOf(document.activeElement);
    var next = idx === -1 ? 0 : (idx + delta + f.length) % f.length;
    f[next].focus();
    f[next].scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function onKeyDown(e) {
    // If an error overlay is up, Enter/Escape dismisses it.
    if (!$("error").classList.contains("hidden")) {
      if (e.key === "Enter" || e.key === "Escape") { dismissError(); e.preventDefault(); }
      return;
    }
    // Let typing flow in the text input (except Enter to send / Escape to leave).
    var typing = document.activeElement && document.activeElement.id === "text-input";

    switch (e.key) {
      case "ArrowUp": case "ArrowLeft":
        if (typing) return;
        moveFocus(-1); e.preventDefault(); break;
      case "ArrowDown": case "ArrowRight":
        if (typing) return;
        moveFocus(1); e.preventDefault(); break;
      case "Enter":
        if (typing) { sendText(); e.preventDefault(); break; }
        if (document.activeElement && document.activeElement.dataset.action) {
          handleAction(document.activeElement.dataset.action);
          e.preventDefault();
        }
        break;
      case "Escape":
        if (state.recording) { cancelRecording(); }
        else if (state.screen === "detail") { goHome(); }
        e.preventDefault();
        break;
    }
  }

  /* ---------- actions ---------- */

  var lastAction = { name: null, t: 0 };
  function handleAction(action) {
    // Dedupe Enter-keydown + synthesized button click (and any EMG key repeats).
    var now = Date.now();
    if (action === lastAction.name && now - lastAction.t < 250) return;
    lastAction = { name: action, t: now };
    switch (action) {
      case "ask": toggleRecord(false); break;
      case "ask-image": toggleRecord(true); break;
      case "toggle-text": toggleTextRow(); break;
      case "send-text": sendText(); break;
      case "back": goHome(); break;
      case "replay": if (state.last) playChunks(state.last.audioChunks); break;
      case "open-detail": openDetail(); break;
      case "dismiss-error": dismissError(); break;
    }
  }

  function toggleTextRow() {
    var row = $("text-row");
    row.classList.toggle("hidden");
    if (!row.classList.contains("hidden")) $("text-input").focus();
  }

  /* ---------- recording ---------- */

  async function toggleRecord(withImage) {
    if (state.recording) { return stopRecording(); }
    try {
      if (withImage) { await captureImage(); state.withImage = true; }
      else { state.withImage = false; state.pendingImage = null; }
      await startRecording();
    } catch (err) {
      resetRecordButtons();
      showError("Mic/camera unavailable. Try the Type fallback. (" + (err && err.message ? err.message : err) + ")");
    }
  }

  async function startRecording() {
    state.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    var mime = pickAudioMime();
    state.mediaRecorder = mime ? new MediaRecorder(state.micStream, { mimeType: mime })
                               : new MediaRecorder(state.micStream);
    state.recChunks = [];
    state.mediaRecorder.ondataavailable = function (ev) {
      if (ev.data && ev.data.size) state.recChunks.push(ev.data);
    };
    state.mediaRecorder.onstop = onRecordingStopped;
    state.mediaRecorder.start();
    state.recording = true;
    setStatus(state.withImage ? "Listening… (+image)" : "Listening…");
    markRecordButton(true);
  }

  function stopRecording() {
    if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
      state.mediaRecorder.stop();
    }
    stopMic();
    state.recording = false;
    markRecordButton(false);
  }

  function cancelRecording() {
    if (state.mediaRecorder) state.mediaRecorder.onstop = null;
    if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") state.mediaRecorder.stop();
    stopMic();
    state.recording = false;
    state.recChunks = [];
    state.pendingImage = null;
    markRecordButton(false);
    setStatus("Ready");
  }

  function onRecordingStopped() {
    var type = (state.mediaRecorder && state.mediaRecorder.mimeType) || "audio/webm";
    var blob = new Blob(state.recChunks, { type: type });
    state.recChunks = [];
    if (!blob.size) { setStatus("Ready"); return; }
    sendAsk(blob, state.pendingImage);
    state.pendingImage = null;
  }

  function stopMic() {
    if (state.micStream) {
      state.micStream.getTracks().forEach(function (t) { t.stop(); });
      state.micStream = null;
    }
  }

  function pickAudioMime() {
    var prefs = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
    if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
    for (var i = 0; i < prefs.length; i++) {
      if (MediaRecorder.isTypeSupported(prefs[i])) return prefs[i];
    }
    return "";
  }

  function markRecordButton(on) {
    var btns = activeScreenEl().querySelectorAll('[data-action="ask"],[data-action="ask-image"]');
    btns.forEach(function (b) {
      if (on) { b.classList.add("recording"); b.dataset.label = b.textContent; b.textContent = "Stop"; }
      else { b.classList.remove("recording"); if (b.dataset.label) b.textContent = b.dataset.label; }
    });
  }
  function resetRecordButtons() { markRecordButton(false); }

  /* ---------- camera ---------- */

  async function captureImage() {
    var stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    var video = $("cam");
    video.srcObject = stream;
    await video.play();
    await new Promise(function (r) { setTimeout(r, 350); }); // let exposure settle
    var canvas = $("frame");
    var w = video.videoWidth || 640, h = video.videoHeight || 640;
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(video, 0, 0, w, h);
    stream.getTracks().forEach(function (t) { t.stop(); });
    video.srcObject = null;
    state.pendingImage = await new Promise(function (resolve) {
      canvas.toBlob(function (b) { resolve(b); }, "image/jpeg", 0.8);
    });
  }

  /* ---------- backend calls ---------- */

  async function sendAsk(audioBlob, imageBlob) {
    showLoading("Thinking…");
    setStatus("Thinking…");
    try {
      var fd = new FormData();
      fd.append("audio", audioBlob, "recording.webm");
      if (imageBlob) fd.append("image", imageBlob, "frame.jpg");
      var res = await fetch(BACKEND_URL + "/api/ask", { method: "POST", body: fd });
      if (!res.ok) throw new Error("HTTP " + res.status);
      var data = await res.json();
      onResult(data);
    } catch (err) {
      hideLoading();
      setStatus("Ready");
      showError("Request failed: " + (err && err.message ? err.message : err));
    }
  }

  async function sendText() {
    var input = $("text-input");
    var text = (input.value || "").trim();
    if (!text) return;
    showLoading("Thinking…");
    setStatus("Thinking…");
    try {
      var body = { text: text };
      if (state.pendingImage) {
        body.imageB64 = await blobToBase64(state.pendingImage);
        body.imageMediaType = "image/jpeg";
      }
      var res = await fetch(BACKEND_URL + "/api/ask-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      var data = await res.json();
      input.value = "";
      state.pendingImage = null;
      onResult(data);
    } catch (err) {
      hideLoading();
      setStatus("Ready");
      showError("Request failed: " + (err && err.message ? err.message : err));
    }
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onloadend = function () { resolve(String(r.result).split(",")[1]); };
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  /* ---------- result + playback ---------- */

  function onResult(data) {
    hideLoading();
    state.last = data;
    renderCard(data);
    setStatus("Speaking…");
    playChunks(data.audioChunks, function () { setStatus("Ready"); });
  }

  function renderCard(data) {
    hide($("hint"));
    var slot = $("card-slot");
    slot.innerHTML = "";
    var card = document.createElement("div");
    card.className = "card focusable";
    card.setAttribute("tabindex", "0");
    card.dataset.action = "open-detail";
    card.innerHTML =
      '<div class="card-title"></div>' +
      '<div class="card-transcript"></div>' +
      '<div class="card-answer"></div>';
    card.querySelector(".card-title").textContent = (data.card && data.card.title) || "Result";
    card.querySelector(".card-transcript").textContent = "You: " + (data.transcript || "");
    card.querySelector(".card-answer").textContent = data.answer || "";
    slot.appendChild(card);
    card.focus();
  }

  function openDetail() {
    if (!state.last) return;
    $("detail-title").textContent = (state.last.card && state.last.card.title) || "Result";
    $("detail-transcript").textContent = "You: " + (state.last.transcript || "");
    $("detail-answer").textContent = state.last.answer || "";
    state.screen = "detail";
    hide($("home")); show($("detail"));
    focusFirst();
  }

  function goHome() {
    state.screen = "home";
    hide($("detail")); show($("home"));
    focusFirst();
  }

  function stopPlayback() {
    state.audioQueue.forEach(function (a) { try { a.pause(); } catch (e) {} });
    state.audioQueue = [];
    state.audioIdx = 0;
  }

  function playChunks(chunks, done) {
    stopPlayback();
    if (!chunks || !chunks.length) { if (done) done(); return; }
    state.audioQueue = chunks.map(function (b64) {
      return new Audio("data:audio/wav;base64," + b64);
    });
    state.audioIdx = 0;
    var playNext = function () {
      if (state.audioIdx >= state.audioQueue.length) { if (done) done(); return; }
      var a = state.audioQueue[state.audioIdx++];
      a.onended = playNext;
      a.onerror = playNext;
      a.play().catch(function () { playNext(); }); // autoplay blocked -> skip ahead
    };
    playNext();
  }

  function dismissError() {
    hide($("error"));
    setStatus("Ready");
    focusFirst();
  }

  /* ---------- init ---------- */

  function init() {
    document.addEventListener("keydown", onKeyDown);
    // Click/tap also works (useful on laptop).
    document.addEventListener("click", function (e) {
      var el = e.target.closest && e.target.closest("[data-action]");
      if (el) handleAction(el.dataset.action);
    });
    focusFirst();
    setStatus("Ready");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
