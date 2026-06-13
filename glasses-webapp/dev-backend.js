/* wiser — dev/reference orchestrator backend (zero dependencies).
   Implements the build-spec §5 contract so the glasses webapp's LiveSession
   works end-to-end with WISER_DEMO=false:

     GET  /api/health
     POST /api/sessions                 { prompt }            -> { id }   (starts a run)
     WS   /api/sessions/:id/events                            -> {hud} | {card} | {done}
     POST /api/sessions/:id/steer       { gesture | voiceText }-> 202     (continues the loop)

   It replays the same vertical-slice timeline as the in-browser mock, but over
   a REAL WebSocket (hand-rolled RFC 6455 — no `ws` dep), so it doubles as the
   reference transport the real CMA-backed backend can mirror.

   Run:  node dev-backend.js        (port 8787 — matches config default)
   Then: WISER_DEMO=false node server.js   and open the app.
*/
"use strict";
const http = require("node:http");
const crypto = require("node:crypto");

const PORT = process.env.PORT || 8787;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/* ───────────────────────── session store ───────────────────────── */
/** id -> { sockets:Set, hud, cards:[], steer:(s)=>void|null, alive:bool } */
const sessions = new Map();
let counter = 1000;

function newId() { return "s" + (++counter).toString(36); }

function broadcast(sess, msg) {
  const frame = encodeFrame(JSON.stringify(msg));
  for (const sock of sess.sockets) { try { sock.write(frame); } catch (_) {} }
}

/* ───────────────────────── the run (timeline) ─────────────────────────
   Mirrors mock.js — the /demo-target levenshtein perf hero. Pauses at the
   question card until a steer arrives, then visibly changes course. */
async function runSession(sess) {
  const hud = sess.hud = {
    loop: "goal", iter: 1, tokens: 0,
    exit: { label: "benches green", have: 5, need: 8 },
    costUsd: 0, elapsedSec: 0, status: "running",
  };
  const t0 = Date.now();
  const tick = setInterval(() => {
    hud.elapsedSec = (Date.now() - t0) / 1000;
    broadcast(sess, { hud: clone(hud) });
  }, 1000);

  const pushHud = (patch) => {
    Object.assign(hud, patch);
    if (patch.exit) hud.exit = Object.assign({}, hud.exit, patch.exit);
    broadcast(sess, { hud: clone(hud) });
  };
  const pushCard = (card) => broadcast(sess, { card });
  const act = (verb, target, note) => pushHud({ activity: { verb, target, note } });
  // Resolve immediately if a steer already arrived (client can steer before we
  // reach this await); otherwise park the resolver for resolveSteer() to call.
  const waitForSteer = () => new Promise((res) => {
    if (sess.pendingSteer) { const s = sess.pendingSteer; sess.pendingSteer = null; res(s); }
    else sess.steer = res;
  });

  try {
    pushHud({ status: "running", tokens: 0 });
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
    pushCard({ kind: "diff", files: 1, added: 14, removed: 9, summary: "Replaced the inner byte-pair scan with a SIMD lane." });

    await wait(800);
    act("test", "cargo bench");
    await wait(900);
    pushHud({ tokens: 4200, costUsd: 0.018 });
    pushCard({ kind: "tests", passed: 5, total: 8, failing: ["bench_long", "bench_unicode", "bench_ascii"] });

    await wait(600);
    pushCard({ kind: "checkpoint", progress: "5 / 8 benches", iter: 1, tokens: 4200, usd: 0.018, note: "412 → 96 ns so far" });

    await wait(900);
    pushHud({ status: "judging", tokens: 5200, costUsd: 0.024, exit: { have: 6 } });
    act("judge", "verifier", "412 → 96 ns");
    pushCard({ kind: "explain", headline: "412 ns → 96 ns  (4.3×)", oneLiner: "criterion-verified; one bench still over budget." });

    await wait(900);
    pushHud({ status: "awaiting_human", activity: { verb: "wait", target: "needs you" } });
    pushCard({ kind: "question", prompt: "Two candidates beat target — ship which?",
      options: ["SIMD lanes (5.3×)", "Lookup table (3.1×)"] });

    const choice = interpretSteer(await waitForSteer());

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

    await wait(700);
    pushHud({ status: "done", activity: { verb: "done", target: "goal met" } });
    pushCard({ kind: "done", headline: choice.finalHeadline,
      stats: [
        { label: "speedup", value: choice.label === "SIMD lanes" ? "5.3×" : "3.1×" },
        { label: "benches", value: "8/8" }, { label: "iters", value: "3" },
        { label: "tokens", value: "12.4k" }, { label: "cost", value: "$0.04" },
      ] });

    await wait(1400);
    pushCard({ kind: "question", prompt: "Goal met — ship it?", options: ["Approve & ship", "Keep iterating"] });
    const ship = interpretSteer(await waitForSteer());

    if (ship.index === 1) {
      pushHud({ status: "running", activity: { verb: "plan", target: "another pass" } });
      pushCard({ kind: "explain", headline: "Back to the loop", oneLiner: "Re-opening the goal loop for another pass." });
    } else {
      pushCard({ kind: "done", final: true, headline: choice.finalHeadline,
        subline: "$0.04 · ~1/16 the cost of one Opus run",
        stats: [{ label: "merged", value: "PR #128" }, { label: "benches", value: "8/8" }, { label: "cost", value: "$0.04" }] });
    }
    broadcast(sess, { done: true, hud: clone(hud) });
  } finally {
    clearInterval(tick);
  }
}

// Deliver a steer to a session's parked resolver, or buffer it until one parks.
function resolveSteer(sess, s) {
  if (sess.steer) { const r = sess.steer; sess.steer = null; r(s); }
  else sess.pendingSteer = s;
}

function interpretSteer(steer) {
  let idx = 0;
  if (steer && steer.gesture) idx = steer.gesture === "reject" ? 1 : 0;
  else if (steer && steer.voiceText) {
    const t = steer.voiceText.toLowerCase();
    if (/lookup|table|second|option b|\bb\b/.test(t)) idx = 1;
    else if (/simd|lane|first|fast|option a|\ba\b/.test(t)) idx = 0;
    else if (/keep|iterate|again|no\b/.test(t)) idx = 1;
  }
  const branches = [
    { index: 0, label: "SIMD lanes", detail: "Vectorize the hot loop — 5.3× on the long bench.",
      added: 18, diffSummary: "SIMD-lane levenshtein; 4 lanes per step.", finalHeadline: "412 ns → 78 ns  (5.3× faster)" },
    { index: 1, label: "Lookup table", detail: "Precompute the cost table — simpler, 3.1× faster.",
      added: 22, diffSummary: "Lookup-table levenshtein; no SIMD intrinsics.", finalHeadline: "412 ns → 133 ns  (3.1× faster)" },
  ];
  return branches[idx] || branches[0];
}

/* ───────────────────────── HTTP ───────────────────────── */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true });

  if (req.method === "POST" && url.pathname === "/api/sessions") {
    return readBody(req).then((body) => {
      const id = newId();
      const sess = { id, sockets: new Set(), hud: null, steer: null, prompt: (body && body.prompt) || "" };
      sessions.set(id, sess);
      // start the run on next tick (clients connect to the WS right after)
      setTimeout(() => runSession(sess).catch((e) => console.error("run error", e)), 250);
      json(res, 201, { id });
    });
  }

  let m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/steer$/);
  if (req.method === "POST" && m) {
    const sess = sessions.get(m[1]);
    if (!sess) return json(res, 404, { error: "no session" });
    return readBody(req).then((body) => {
      resolveSteer(sess, body || {});
      json(res, 202, { ok: true });
    });
  }

  json(res, 404, { error: "not found" });
});

/* ───────────────────────── WebSocket upgrade ─────────────────────────
   Hand-rolled RFC 6455 (text frames, server→client unmasked, ping/pong). */
server.on("upgrade", (req, socket) => {
  const m = req.url.match(/^\/api\/sessions\/([^/?]+)\/events/);
  const key = req.headers["sec-websocket-key"];
  if (!m || !key) { socket.destroy(); return; }
  const sess = sessions.get(m[1]);
  if (!sess) { socket.destroy(); return; }

  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + accept + "\r\n\r\n");
  socket.setNoDelay(true);

  sess.sockets.add(socket);
  // replay current HUD so a late joiner isn't blank
  if (sess.hud) socket.write(encodeFrame(JSON.stringify({ hud: clone(sess.hud) })));

  // heartbeat: ping every 20s; drop sockets that error
  const ping = setInterval(() => { try { socket.write(encodeFrame("", 0x9)); } catch (_) {} }, 20000);

  socket.on("data", (buf) => { try { handleFrames(buf, sess); } catch (_) {} });
  const cleanup = () => { clearInterval(ping); sess.sockets.delete(socket); };
  socket.on("close", cleanup);
  socket.on("error", cleanup);
});

// Minimal inbound frame handling: close + optional steer-over-WS (we use POST,
// but accept JSON text frames as steer too for flexibility).
function handleFrames(buf, sess) {
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off], b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f; let p = off + 2;
    if (len === 126) { len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { len = Number(buf.readBigUInt64BE(p)); p += 8; }
    let mask; if (masked) { mask = buf.slice(p, p + 4); p += 4; }
    const payload = buf.slice(p, p + len);
    if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    if (opcode === 0x8) { /* close */ return; }
    if (opcode === 0x1 && payload.length) {        // text → treat as steer
      try { resolveSteer(sess, JSON.parse(payload.toString())); } catch (_) {}
    }
    off = p + len;
  }
}

function encodeFrame(str, opcode) {
  opcode = opcode == null ? 0x1 : opcode;
  const payload = Buffer.from(str);
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.from([0x80 | opcode, len]); }
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

/* ───────────────────────── helpers ───────────────────────── */
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (_) { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
function clone(o) { return JSON.parse(JSON.stringify(o)); }

/* ───────────────────────── lifecycle ───────────────────────── */
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

server.listen(PORT, () => console.log("wiser dev-backend (WS) on http://localhost:" + PORT));

function shutdown(sig) {
  console.log("\n" + sig + " — closing dev-backend");
  for (const sess of sessions.values()) for (const s of sess.sockets) { try { s.end(); } catch (_) {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
