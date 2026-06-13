/* wiser — session factory.
   Unifies the mock session and a live CMA-backed session behind one interface,
   so app.js never branches on transport.

   Live wire (from build-spec §5):
     POST /api/sessions                  { prompt }            → { id }
     GET  /api/sessions/:id/events  (WS or SSE)               → {hud}|{card}
     POST /api/sessions/:id/steer        { gesture?|voiceText? }

   DEMO (config.js → window.WISER_CONFIG.DEMO, env WISER_DEMO):
     true  → seeded demo data (mock session), no live coding session needed
     false → live app; if the backend is unreachable it falls back to demo data
             (badged clearly) so an on-stage run never hard-fails.
   Per-load override: ?demo=1 / ?demo=0
*/
(function () {
  "use strict";
  var W = (window.WISER = window.WISER || {});
  var CFG = window.WISER_CONFIG || {};
  var BACKEND = CFG.BACKEND_URL || "http://localhost:8787";

  function resolveDemo() {
    try {
      var q = new URLSearchParams(window.location.search).get("demo");
      if (q === "1" || q === "true") return true;
      if (q === "0" || q === "false") return false;
    } catch (e) {}
    return !!CFG.DEMO;
  }

  function createLiveSession() {
    var listeners = { hud: [], card: [], status: [], done: [], error: [] };
    var id = null, ws = null, closed = false, done = false, retries = 0;
    function emit(ev, p) { (listeners[ev] || []).forEach(function (fn) { try { fn(p); } catch (e) {} }); }
    function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return api; }

    async function start(prompt) {
      var res = await fetch(BACKEND + "/api/sessions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: prompt }),
      });
      if (!res.ok) throw new Error("create session HTTP " + res.status);
      id = (await res.json()).id;
      openStream();
      return api;
    }

    function openStream() {
      if (closed || done) return;
      var wsUrl = BACKEND.replace(/^http/, "ws") + "/api/sessions/" + id + "/events";
      ws = new WebSocket(wsUrl);
      ws.onopen = function () { retries = 0; };
      ws.onmessage = function (e) {
        var msg = safeJson(e.data);
        if (!msg) return;
        if (msg.hud) { emit("hud", msg.hud); if (msg.hud.status) emit("status", msg.hud.status); }
        if (msg.card) emit("card", msg.card);
        if (msg.done) { done = true; emit("done", msg.hud || {}); }
      };
      ws.onerror = function () { emit("error", new Error("ws error")); };
      // reconnect with capped backoff unless the run finished or we were stopped
      ws.onclose = function () {
        if (closed || done) return;
        var delay = Math.min(8000, 500 * Math.pow(2, retries++));
        setTimeout(openStream, delay);
      };
    }

    function steer(s) {
      if (!id) return;
      var body = s.type === "gesture" ? { gesture: s.action } : { voiceText: s.text };
      fetch(BACKEND + "/api/sessions/" + id + "/steer", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(function () {});
    }

    var api = { on: on, start: start, steer: steer,
      stop: function () { closed = true; if (ws) try { ws.close(); } catch (e) {} }, isMock: false };
    return api;
  }

  // Reachability probe: is the backend up? (short timeout → fall back to mock)
  function backendUp(timeoutMs) {
    return new Promise(function (resolve) {
      var done = false, t = setTimeout(function () { if (!done) { done = true; resolve(false); } }, timeoutMs);
      fetch(BACKEND + "/api/health", { method: "GET" })
        .then(function (r) { if (!done) { done = true; clearTimeout(t); resolve(r.ok); } })
        .catch(function () { if (!done) { done = true; clearTimeout(t); resolve(false); } });
    });
  }

  // Returns { session, mode } — DEMO uses seeded data; live falls back gracefully.
  W.openSession = async function () {
    if (resolveDemo()) return { session: W.createMockSession(), mode: "demo" };
    var up = await backendUp(1200);
    return up ? { session: createLiveSession(), mode: "live" }
              : { session: W.createMockSession(), mode: "demo · no backend" };
  };

  function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }
})();
