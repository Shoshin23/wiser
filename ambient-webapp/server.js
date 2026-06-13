/* wiser — ambient-webapp backend (standalone, prototype-first).
   Serves the static webapp AND three small API endpoints, so the browser
   talks only to this origin and NO model/STT keys ever reach the client.

   Endpoints:
     GET  /api/health                 -> { ok, groq, anthropic }   (key presence, no values)
     GET  /config.js                  -> generated runtime config (tunables; same-origin)
     POST /api/transcribe             (raw audio body)  -> { text }        (Groq Whisper)
     POST /api/scan      { transcript }                 -> { opportunity }  (Claude Haiku)
     POST /api/ask-text  { text, sessionId? }           -> Firebase fn response (proxied)

   Keys: loaded from ambient-webapp/.env first, then firebase/functions/.env
   (both in-project), then the real environment wins over both. Nothing is
   logged or sent to the browser.

   Run:  npm install && node server.js     (default port 8788)
*/
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

// ───────────────────────── env loading (in-project only) ─────────────────────────
// Fill missing vars from ambient .env, then firebase .env. A var already present
// in the real environment is never overwritten; ambient .env wins over firebase.
function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (_) { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvFile(path.join(__dirname, ".env"));
loadEnvFile(path.join(__dirname, "..", "firebase", "functions", ".env"));

// ───────────────────────── config ─────────────────────────
const PORT = process.env.PORT || 8788;
const STT_MODEL = process.env.STT_MODEL || "whisper-large-v3-turbo";
const SCAN_MODEL = process.env.SCAN_MODEL || "claude-haiku-4-5";
// Which provider runs the cheap scan step. "anthropic" (Haiku) is the live default;
// flip to "nemotron" to route the scan through Nebius without touching the route code.
const SCAN_PROVIDER = process.env.SCAN_PROVIDER || "anthropic";
const NEBIUS_BASE_URL = process.env.NEBIUS_BASE_URL || "https://api.tokenfactory.nebius.com/v1/";
const NEMOTRON_SCAN_MODEL = process.env.NEMOTRON_SCAN_MODEL || "nvidia/nemotron-3-nano-30b-a3b";
const FIREBASE_BASE_URL =
  process.env.WISER_FIREBASE_URL ||
  "https://us-central1-wiser-1a319.cloudfunctions.net/wiser";
const MAX_AUDIO_BYTES = 30 * 1024 * 1024; // 30 MB / chunk — generous for ~5s segments
const SCAN_MAX_CHARS = 1500; // rolling transcript window fed to Haiku

// Lazy SDK clients — constructed on first use so a missing key fails the request
// (with a clear message) instead of crashing boot.
const Groq = require("groq-sdk").default || require("groq-sdk");
const { toFile } = require("groq-sdk");
const Anthropic = require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk");
const OpenAI = require("openai").default || require("openai");
let _groq, _anthropic, _nebius;
function groqClient() {
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY not configured");
  if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _groq;
}
function anthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured");
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}
// Nemotron via Nebius Token Factory (OpenAI-SDK compatible).
function nebiusClient() {
  if (!process.env.NEBIUS_API_KEY) throw new Error("NEBIUS_API_KEY not configured");
  if (!_nebius) _nebius = new OpenAI({ baseURL: NEBIUS_BASE_URL, apiKey: process.env.NEBIUS_API_KEY });
  return _nebius;
}

// ───────────────────────── STT (Groq Whisper, same pattern as backend/src/groq.ts) ─────────────────────────
async function transcribe(buffer, filename, contentType) {
  const file = await toFile(buffer, filename || "chunk.webm", { type: contentType || "audio/webm" });
  const res = await groqClient().audio.transcriptions.create({
    file,
    model: STT_MODEL,
    language: "en",
  });
  return (res.text || "").trim();
}

// ───────────────────────── opportunity scan (Claude Haiku) ─────────────────────────
const SCAN_SYSTEM =
  "You are the background opportunity scanner for wiser. wiser dispatches an autonomous Claude " +
  "coding agent that HAS DIRECT ACCESS TO THE wiser CODEBASE ITSELF and can change it — fix a bug, " +
  "add or change a feature, optimize performance, write or fix tests, refactor, or improve docs.\n\n" +
  "About wiser, so you can ground proposals in its real parts:\n" +
  "- A voice-driven fleet of autonomous coding agents, surfaced as glanceable 'cards' on Meta " +
  "Ray-Ban Display glasses — available everywhere but quiet by default; the display pings you, it " +
  "doesn't narrate.\n" +
  "- Pieces: the glasses display app (renders cards, Neural-Band gestures, deep-dive); the " +
  "orchestrator backend (turns voice intent into tasks, runs the Claude agent fleet via Managed " +
  "Agents, distills results into cards); the agent fleet; and an ambient webapp that live-transcribes " +
  "the conversation and scans it for tasks — that is where YOU run.\n" +
  "- Cheap models (Nemotron / Claude Haiku) do the fast translate / distill / scan steps.\n\n" +
  "You are given a rolling transcript of an ongoing spoken conversation — typically the wiser team " +
  "talking about the product. Decide: is there a CLEAR, ACTIONABLE change to the wiser software the " +
  "speakers would plausibly want to hand to the coding agent right now? Be conservative — attention " +
  "is the scarce resource, so only surface a high-signal opportunity. Return null for chit-chat, " +
  "vague musing, non-software topics, or anything you'd have to invent details for.\n\n" +
  "If (and only if) there is one, return an opportunity:\n" +
  "  title          — a glanceable headline, at most 6 words\n" +
  "  summary        — one short line on what/why\n" +
  "  proposedPrompt — a clear, self-contained instruction to the coding agent working IN THE wiser " +
  "repo; name the specific part of wiser to change (e.g. the glasses card UI, the orchestrator, the " +
  "scanner) so it can act without guessing\n" +
  "Otherwise return opportunity = null.\n\n" +
  "You may also be given a list of tasks ALREADY PROPOSED earlier in this session. Never re-propose " +
  "one of those, or anything that substantially overlaps with one — return null in that case. Only " +
  "surface a genuinely NEW, distinct opportunity.";

const SCAN_SCHEMA = {
  type: "object",
  properties: {
    opportunity: {
      anyOf: [
        {
          type: "object",
          properties: {
            title: { type: "string" },
            summary: { type: "string" },
            proposedPrompt: { type: "string" },
          },
          required: ["title", "summary", "proposedPrompt"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    },
  },
  required: ["opportunity"],
  additionalProperties: false,
};

// Build the per-request user turn (kept separate so the cached system prefix is stable).
function buildScanUserContent(transcript, proposed) {
  const window = String(transcript || "").slice(-SCAN_MAX_CHARS).trim();
  if (!window) return null;
  let userContent = "Recent conversation transcript:\n\n" + window;
  // Already-proposed tasks (dynamic, per-request). Bounded so the prompt can't grow unbounded.
  const prior = (Array.isArray(proposed) ? proposed : []).filter(Boolean).slice(-25);
  if (prior.length) {
    userContent +=
      "\n\nTasks ALREADY PROPOSED this session — do NOT propose these again or anything substantially overlapping:\n" +
      prior.map((p, i) => (i + 1) + ". " + (p.title ? p.title + " — " : "") + (p.proposedPrompt || "")).join("\n");
  }
  return userContent;
}

// Parse a model's JSON text into a clean opportunity (or null).
function normalizeOpportunity(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) {
    console.warn("scan: could not parse model JSON:", String(text).slice(0, 200));
    return null;
  }
  const opp = parsed && parsed.opportunity;
  if (!opp || !opp.title || !opp.proposedPrompt) return null;
  return { title: opp.title, summary: opp.summary || "", proposedPrompt: opp.proposedPrompt };
}

// ── Anthropic (Claude Haiku) — the live default ──
async function scanWithAnthropic(userContent) {
  const res = await anthropicClient().messages.create({
    model: SCAN_MODEL,
    max_tokens: 400,
    system: SCAN_SYSTEM,
    output_config: { format: { type: "json_schema", schema: SCAN_SCHEMA } },
    messages: [{ role: "user", content: userContent }],
  });
  const text = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return normalizeOpportunity(text);
}

// ── Nemotron via Nebius — written but not the default; set SCAN_PROVIDER=nemotron to use it ──
async function scanWithNemotron(userContent) {
  const res = await nebiusClient().chat.completions.create({
    model: NEMOTRON_SCAN_MODEL,
    max_tokens: 400,
    temperature: 0.2,
    // Schema in the param AND the prompt — small MoE models occasionally emit a stray prefix.
    response_format: { type: "json_schema", json_schema: { name: "scan", schema: SCAN_SCHEMA } },
    messages: [
      { role: "system", content: SCAN_SYSTEM + "\n\nRespond ONLY as JSON matching: { \"opportunity\": { title, summary, proposedPrompt } | null }." },
      { role: "user", content: userContent },
    ],
  });
  const text = (res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content) || "";
  return normalizeOpportunity(text);
}

async function scanForOpportunity(transcript, proposed) {
  const userContent = buildScanUserContent(transcript, proposed);
  if (!userContent) return null;
  return SCAN_PROVIDER === "nemotron"
    ? scanWithNemotron(userContent)
    : scanWithAnthropic(userContent);
}

// ───────────────────────── HTTP ─────────────────────────
const MIME = {
  ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
  ".json": "application/json", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".ico": "image/x-icon",
};

function configJs() {
  const cfg = {
    BACKEND_URL: "", // same origin — the static app is served by this server
    CHUNK_MS: Number(process.env.WISER_CHUNK_MS || 5000),
    SCAN_INTERVAL_MS: Number(process.env.WISER_SCAN_INTERVAL_MS || 8000),
  };
  return "// generated from env by server.js\nwindow.WISER_CONFIG = " + JSON.stringify(cfg, null, 2) + ";\n";
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let len = 0;
    req.on("data", (c) => {
      len += c.length;
      if (len > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJson(req) {
  const buf = await readRawBody(req, 2 * 1024 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString("utf8")); } catch (_) { return {}; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  try {
    if (req.method === "GET" && p === "/api/health") {
      return json(res, 200, { ok: true, groq: !!process.env.GROQ_API_KEY, anthropic: !!process.env.ANTHROPIC_API_KEY });
    }

    if (req.method === "GET" && p === "/config.js") {
      res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-store" });
      return res.end(configJs());
    }

    if (req.method === "POST" && p === "/api/transcribe") {
      const buf = await readRawBody(req, MAX_AUDIO_BYTES);
      if (!buf.length) return json(res, 400, { error: "empty audio body" });
      const ct = req.headers["content-type"] || "audio/webm";
      const ext = ct.includes("ogg") ? "ogg" : ct.includes("mp4") ? "mp4" : ct.includes("wav") ? "wav" : "webm";
      const text = await transcribe(buf, "chunk." + ext, ct);
      return json(res, 200, { text });
    }

    if (req.method === "POST" && p === "/api/scan") {
      const body = await readJson(req);
      const opportunity = await scanForOpportunity(body.transcript, body.proposed);
      return json(res, 200, { opportunity });
    }

    if (req.method === "POST" && p === "/api/ask-text") {
      const body = await readJson(req);
      if (!body.text) return json(res, 400, { error: "missing 'text'" });
      const upstream = await fetch(FIREBASE_BASE_URL + "/api/ask-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await upstream.json().catch(() => ({ error: "bad upstream response" }));
      return json(res, upstream.status, data);
    }

    // ── static files ──
    if (req.method === "GET") {
      const rel = p === "/" ? "/index.html" : p;
      const filePath = path.join(__dirname, rel);
      // prevent path traversal outside the webapp dir
      if (!filePath.startsWith(__dirname)) { res.writeHead(403); return res.end("forbidden"); }
      return fs.readFile(filePath, (err, content) => {
        if (err) { res.writeHead(404, { "Content-Type": "text/html" }); return res.end("<h1>404</h1>"); }
        res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
        res.end(content);
      });
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    console.error(req.method, p, "->", err && err.message ? err.message : err);
    json(res, 500, { error: (err && err.message) || "internal error" });
  }
});

server.listen(PORT, () => {
  console.log("wiser ambient-webapp on http://localhost:" + PORT);
  console.log("  Groq key:", !!process.env.GROQ_API_KEY, " Anthropic key:", !!process.env.ANTHROPIC_API_KEY);
  const scanModel = SCAN_PROVIDER === "nemotron" ? NEMOTRON_SCAN_MODEL : SCAN_MODEL;
  console.log("  scan provider:", SCAN_PROVIDER, " scan model:", scanModel, " stt:", STT_MODEL, " agent proxy ->", FIREBASE_BASE_URL);
  console.log("  Nebius key:", !!process.env.NEBIUS_API_KEY);
});

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("SIGINT", () => { console.log("\nshutting down"); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000).unref(); });
process.on("SIGTERM", () => server.close(() => process.exit(0)));
