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

// ── the repo this brainstorm is about (the agent pulls it in and builds on it) ──
const LINNY_REPO = process.env.LINNY_REPO || "https://github.com/Evgastap/linny.git";
const LINNY_BASE = path.join(__dirname, "linny-base");        // pristine clone (read-only base)
const PROTOTYPES_DIR = path.join(__dirname, "prototypes");    // one previewable copy per build
// The coding-agent fleet runs Sonnet in FAST MODE via the API: model=claude-sonnet-4-6 plus
// settings.fastMode=true on the Agent SDK query() (see buildPrototype). That's "Sonnet fast".
const BUILD_MODEL = process.env.BUILD_MODEL || "claude-sonnet-4-6";
const BUILD_TIMEOUT_MS = Number(process.env.BUILD_TIMEOUT_MS || 6 * 60 * 1000);

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

// ───────────────────────── linny: pull in the repo + run the coding fleet ─────────────────────────
const { spawnSync } = require("node:child_process");

// Pull in the repo the brainstorm is about. Clones a pristine, read-only base copy the
// fleet branches from. Best-effort + idempotent so the demo just works on a fresh checkout.
function ensureLinnyBase() {
  if (fs.existsSync(path.join(LINNY_BASE, "index.html"))) return true;
  try {
    fs.mkdirSync(PROTOTYPES_DIR, { recursive: true });
    console.log("linny: cloning", LINNY_REPO, "->", LINNY_BASE);
    const r = spawnSync("git", ["clone", "--depth", "1", LINNY_REPO, LINNY_BASE], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("git clone failed (status " + r.status + ")");
    fs.rmSync(path.join(LINNY_BASE, ".git"), { recursive: true, force: true }); // detach from origin
    return true;
  } catch (e) {
    console.error("linny: could not clone base repo —", e && e.message ? e.message : e);
    return false;
  }
}

// The Claude Agent SDK is ESM-only; server.js is CommonJS, so load it via dynamic import once.
let _agentQuery;
async function agentQuery() {
  if (!_agentQuery) {
    const mod = await import("@anthropic-ai/claude-agent-sdk");
    _agentQuery = mod.query;
  }
  return _agentQuery;
}

// Coding-agent persona: build the prototype on the real linny repo, make assumptions, never ask.
const CODING_SYSTEM =
  "You are an autonomous Claude coding agent in a team brainstorm. You have the FULL linny repository " +
  "checked out in your working directory and your job is to BUILD the prototype described in the prompt " +
  "directly on top of it.\n\n" +
  "linny is a tiny static, no-build Linear-style kanban issue tracker — three files:\n" +
  "- index.html : markup; the header has an (empty) #searchSlot search seam.\n" +
  "- styles.css : dark, Linear-esque theme; label colors live in LABEL_COLORS.\n" +
  "- app.js     : a seeded ISSUES array ({id,title,status,priority,assignee,labels,archived}); " +
  "boardIssues() (filters out archived); render(issues) (draws Backlog/In-Progress/Done + open " +
  "counter); a click-to-open detail modal with a status dropdown; labelPill()/avatarColor() helpers; " +
  "and a // SEAM (search) sketch of filterIssues(query).\n\n" +
  "Rules:\n" +
  "- Read the files you need, then implement the prototype end to end with real, working code.\n" +
  "- DO NOT ask the user any questions. If a detail is unspecified, make a reasonable assumption, note " +
  "it in one short sentence, and build it.\n" +
  "- Keep linny a PURE static front-end app: no build step, no server, no new dependencies, no " +
  "frameworks. It must still open by double-clicking index.html. Edit only index.html / styles.css / " +
  "app.js (add small files only if truly needed and still static).\n" +
  "- Match the existing dark theme and code style. Keep the seed data working.\n" +
  "- When done, end with ONE short sentence: what you built and any assumption you made.";

// In-memory registry of fleet builds (lost on restart — fine for a hackathon demo).
//   build: { id, title, status:"building"|"done"|"failed", line, previewUrl, prompt, startedAt, finishedAt }
const builds = new Map();

// Recursively copy the pristine base into a fresh per-prototype dir the agent can mutate.
function freshPrototypeDir(id) {
  const dest = path.join(PROTOTYPES_DIR, id);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(LINNY_BASE, dest, { recursive: true });
  return dest;
}

// Kick off ONE coding agent on a fresh copy of linny; resolves the build registry entry when done.
// Runs detached (caller doesn't await) — the browser polls /api/builds/:id and opens the preview.
async function buildPrototype(id, prompt, title) {
  const entry = builds.get(id);
  if (!ensureLinnyBase()) {
    Object.assign(entry, { status: "failed", line: "linny repo unavailable", finishedAt: Date.now() });
    return;
  }
  let dest;
  try { dest = freshPrototypeDir(id); }
  catch (e) {
    Object.assign(entry, { status: "failed", line: "copy failed: " + (e && e.message), finishedAt: Date.now() });
    return;
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), BUILD_TIMEOUT_MS);
  try {
    const query = await agentQuery();
    let result = null;
    for await (const m of query({
      prompt:
        prompt + "\n\nThe linny repository is your current working directory. Build the prototype now; " +
        "do not ask questions.",
      options: {
        model: BUILD_MODEL,                 // Sonnet, via the API
        settings: { fastMode: true },       // "Sonnet fast" — enable fast mode for the fleet
        systemPrompt: CODING_SYSTEM,
        cwd: dest,
        permissionMode: "bypassPermissions", // autonomous: no approval prompts, no follow-up questions
        maxTurns: 60,
        abortController: abort,
        // settingSources left unset → the SDK does NOT load wiser's CLAUDE.md; the agent stays
        // focused on linny, not the glasses-first rules of the host repo. The inline `settings`
        // object only injects fastMode into the flag-settings layer — no project files are loaded.
      },
    })) {
      if (m && m.type === "result") result = m;
    }
    if (result && result.subtype === "success") {
      const summary = String(result.result || "").trim().replace(/\s+/g, " ");
      Object.assign(entry, {
        status: "done",
        line: summary.slice(0, 200) || "Prototype built — open the preview.",
        previewUrl: "/preview/" + id + "/",
        finishedAt: Date.now(),
      });
      console.log("build:", id, "done in", (result.num_turns || "?"), "turns");
    } else {
      Object.assign(entry, {
        status: "failed",
        line: "agent did not finish: " + (result ? result.subtype : "no result"),
        finishedAt: Date.now(),
      });
    }
  } catch (e) {
    Object.assign(entry, { status: "failed", line: (e && e.message) || "build error", finishedAt: Date.now() });
    console.error("build:", id, "failed —", e && e.message ? e.message : e);
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────── live brainstorm registry (in-memory) ─────────────────────────
// A brainstorm is a server-side session the glasses (a separate phone client over an
// ngrok tunnel) can contribute voice+photo into; the browser folds new contributions
// into its next /api/scan. Lost on restart — fine for a hackathon demo.
//   session: { id, title, status:"active"|"ended",
//              contributions:[{id,text,imageB64,mode:"inject",at}], createdAt, updatedAt }
const brainstorms = new Map(); // id -> session
function activeBrainstorm() {
  return [...brainstorms.values()].filter(b => b.status === "active")
    .sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
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
  "You are an always-listening agent that is brainstorming live with a team of developers about the " +
  "GitHub repository github.com/Evgastap/linny (\"linny\"). As the brainstorm advances, you spot " +
  "concrete PROTOTYPES you can build from what the team is saying, and you immediately kick off a " +
  "Claude coding-agent fleet to build each one. Each agent has the FULL linny repo checked out and " +
  "builds the prototype on top of it.\n\n" +
  "About linny, so you ground every prototype in its real parts:\n" +
  "- linny is a tiny, static, no-build Linear-style kanban issue tracker — just three files: " +
  "index.html (markup + an empty #searchSlot in the header), styles.css (dark, Linear-esque theme; " +
  "label colors via LABEL_COLORS), and app.js (all the logic).\n" +
  "- app.js holds: a seeded ISSUES array (~11 issues, each {id,title,status,priority,assignee," +
  "labels,archived}); boardIssues() which filters OUT archived issues; render(issues) which draws the " +
  "Backlog/In-Progress/Done columns and an open-issue counter; a click-to-open detail modal with a " +
  "status dropdown; labelPill()/avatarColor() helpers.\n" +
  "- Known seams the team may riff on: SEARCH is not implemented (there's a #searchSlot in the header " +
  "and a // SEAM(search) sketch of filterIssues(query) in app.js), and there's an ARCHIVED bug seam " +
  "(a naive search reading the full ISSUES array vs boardIssues() decides whether search wrongly " +
  "surfaces/skips archived issues).\n" +
  "- It is a pure front-end app: every prototype must stay previewable by just opening index.html in a " +
  "browser (no build step, no server, no new dependencies).\n\n" +
  "You are given a rolling transcript of the team's spoken brainstorm (plus any direct contributions). " +
  "The team thinks out loud and their ideas are often ASPIRATIONAL or broad ('make it mobile', 'a " +
  "glasses view', 'cooler design', 'add emojis to the titles'). Your job is to turn each such idea into " +
  "ONE concrete, buildable front-end prototype ON linny — YOU supply the missing specifics. Be eager: " +
  "whenever the team voices any UI / UX / feature / fix idea about the issue tracker, surface a " +
  "prototype. Do NOT reject an idea for being 'too vague' or 'not specific enough', and do NOT ask " +
  "follow-up questions — make reasonable assumptions and bake them into the proposedPrompt. Return null " +
  "ONLY for pure chit-chat or talk that is not about the software at all.\n\n" +
  "linny is a static web app that runs in a browser, so broad ideas map to concrete front-end " +
  "prototypes you CAN build — never treat them as out of scope. For example:\n" +
  "- 'a mobile interface' / 'make it responsive' -> a mobile-first responsive layout (single-column " +
  "board, touch-friendly cards) via CSS + small JS.\n" +
  "- 'an interface for the glasses' / 'a glasses view' -> a compact ~600x600 dark, glanceable board " +
  "mode (a few words per card, high contrast) — still just a static page/view in the repo.\n" +
  "- 'cooler / nicer design' -> restyle the theme, cards, and labels.\n" +
  "- 'emojis on the titles' -> prefix each issue title with a relevant emoji.\n\n" +
  "If (and only if) there is a buildable prototype, return an opportunity:\n" +
  "  title          — a glanceable name for the prototype, at most 6 words\n" +
  "  summary        — one short line on what it adds/changes and why\n" +
  "  proposedPrompt — a clear, SELF-CONTAINED build instruction to a Claude coding agent working in the " +
  "linny repo. Name the specific files/parts of linny to change (index.html #searchSlot, app.js " +
  "ISSUES/boardIssues/render/filterIssues, styles.css, the detail modal, LABEL_COLORS). Tell it to " +
  "make reasonable assumptions for anything unstated and NOT ask questions, to keep linny a static " +
  "no-build app that still opens directly in a browser, and to actually implement the prototype end to " +
  "end.\n" +
  "Otherwise return opportunity = null.\n\n" +
  "You may also be given a list of prototypes ALREADY PROPOSED earlier in this session. Never " +
  "re-propose one of those, or anything that substantially overlaps with one — return null in that " +
  "case. Only surface a genuinely NEW, distinct prototype.";

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
function buildScanUserContent(transcript, proposed, contributions) {
  const window = String(transcript || "").slice(-SCAN_MAX_CHARS).trim();
  const contribs = (Array.isArray(contributions) ? contributions : []).filter(Boolean);
  if (!window && !contribs.length) return null;
  let userContent = "Recent conversation transcript:\n\n" + (window || "(none yet)");
  // Already-proposed tasks (dynamic, per-request). Bounded so the prompt can't grow unbounded.
  const prior = (Array.isArray(proposed) ? proposed : []).filter(Boolean).slice(-25);
  if (prior.length) {
    userContent +=
      "\n\nTasks ALREADY PROPOSED this session — do NOT propose these again or anything substantially overlapping:\n" +
      prior.map((p, i) => (i + 1) + ". " + (p.title ? p.title + " — " : "") + (p.proposedPrompt || "")).join("\n");
  }
  // Direct contributions from the team (voice + optional photo) — high signal.
  if (contribs.length) {
    userContent +=
      "\n\nDIRECT CONTRIBUTIONS the team JUST made (high-signal — strongly prefer surfacing an opportunity from these, and if an image is attached, ground the opportunity in what it shows):\n" +
      contribs.map((c, i) => (i + 1) + ". " + c).join("\n");
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

// ── Anthropic (Claude Haiku) — the live default. Accepts an optional POV image
// (a glasses contribution) as a vision block; Haiku is vision-capable. ──
async function scanWithAnthropic(userContent, imageB64) {
  const res = await anthropicClient().messages.create({
    model: SCAN_MODEL,
    max_tokens: 400,
    system: SCAN_SYSTEM,
    output_config: { format: { type: "json_schema", schema: SCAN_SCHEMA } },
    messages: [{ role: "user", content: imageB64
      ? [{ type: "text", text: userContent },
         { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageB64 } }]
      : userContent }],
  });
  const text = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return normalizeOpportunity(text);
}

// ── Nemotron via Nebius — written but not the default; set SCAN_PROVIDER=nemotron to use it.
// Text-only (no vision); a contributed image is ignored on this path. ──
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

// A scan can be driven purely by a fresh contribution (voice/photo) even if the
// browser transcript hasn't grown — so allow an image-only scan too.
async function scanForOpportunity(transcript, proposed, contributions, imageB64) {
  let userContent = buildScanUserContent(transcript, proposed, contributions);
  if (!userContent) {
    if (!imageB64) return null;
    userContent = "Recent conversation transcript:\n\n(none yet)";
  }
  return SCAN_PROVIDER === "nemotron"
    ? scanWithNemotron(userContent)
    : scanWithAnthropic(userContent, imageB64);
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
      const { transcript, proposed, contributions, imageB64 } = body;
      const opportunity = await scanForOpportunity(transcript, proposed, contributions, imageB64);
      return json(res, 200, { opportunity });
    }

    // ── kick off a Claude coding-agent fleet to BUILD a prototype on the linny repo ──
    if (req.method === "POST" && p === "/api/build") {
      const body = await readJson(req);
      if (!body.prompt) return json(res, 400, { error: "missing 'prompt'" });
      const id = "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const title = body.title || "Prototype";
      builds.set(id, {
        id, title, prompt: body.prompt,
        status: "building", line: "spinning up a Claude coding agent on linny…",
        previewUrl: null, startedAt: Date.now(), finishedAt: null,
      });
      console.log("build:", id, "—", title);
      buildPrototype(id, body.prompt, title); // detached; client polls /api/builds/:id
      return json(res, 200, { id, status: "building", previewUrl: "/preview/" + id + "/" });
    }

    // ── list ALL fleet builds (most-recent-first) so the glasses can show the deck ──
    if (req.method === "GET" && p === "/api/builds") {
      const list = [...builds.values()]
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((b) => ({ id: b.id, title: b.title, status: b.status, line: b.line, previewUrl: b.previewUrl }));
      return json(res, 200, { builds: list });
    }

    {
      const m = p.match(/^\/api\/builds\/([^/]+)$/);
      if (req.method === "GET" && m) {
        const b = builds.get(m[1]);
        if (!b) return json(res, 404, { error: "no such build" });
        return json(res, 200, {
          id: b.id, title: b.title, status: b.status, line: b.line, previewUrl: b.previewUrl,
        });
      }
    }

    // ── serve a built prototype so it previews live on localhost ──
    {
      const m = p.match(/^\/preview\/([^/]+)(\/.*)?$/);
      if (req.method === "GET" && m) {
        const id = m[1];
        if (!builds.has(id)) return json(res, 404, { error: "no such prototype" });
        let rel = m[2] && m[2] !== "/" ? m[2] : "/index.html";
        const root = path.join(PROTOTYPES_DIR, id);
        const filePath = path.join(root, rel);
        if (!filePath.startsWith(root)) { res.writeHead(403); return res.end("forbidden"); }
        return fs.readFile(filePath, (err, content) => {
          if (err) { res.writeHead(404, { "Content-Type": "text/html" }); return res.end("<h1>404</h1>"); }
          res.writeHead(200, {
            "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
            "Cache-Control": "no-store",
          });
          res.end(content);
        });
      }
    }

    // ── live brainstorm sessions (stateful; glasses contribute into the active one) ──
    if (req.method === "POST" && p === "/api/brainstorms") {
      const body = await readJson(req);
      const now = Date.now();
      const id = "bs_" + now.toString(36) + Math.random().toString(36).slice(2, 6);
      brainstorms.set(id, {
        id,
        title: body.title || "Brainstorm",
        status: "active",
        contributions: [],
        createdAt: now,
        updatedAt: now,
      });
      console.log("brainstorm: created", id, "—", brainstorms.get(id).title);
      return json(res, 200, { id });
    }

    if (req.method === "POST" && p === "/api/brainstorms/active/end") {
      const b = activeBrainstorm();
      if (b) { b.status = "ended"; b.updatedAt = Date.now(); console.log("brainstorm: ended", b.id); }
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && p === "/api/brainstorms/active/contribute") {
      const body = await readJson(req);
      const b = activeBrainstorm();
      if (!b) return json(res, 409, { error: "no active brainstorm" });
      const text = body.text || (body.audioB64
        ? await transcribe(Buffer.from(body.audioB64, "base64"), "contribution.m4a", body.audioType || "audio/m4a")
        : "");
      const contributionId = "c_" + Date.now().toString(36);
      b.contributions.push({
        id: contributionId,
        text,
        imageB64: body.imageB64 || null,
        mode: "inject",
        at: Date.now(),
      });
      b.updatedAt = Date.now();
      console.log("brainstorm: contribution", contributionId, "->", b.id,
        (body.imageB64 ? "[+photo] " : ""), JSON.stringify((text || "").slice(0, 200)));
      return json(res, 200, { ok: true, contributionId });
    }

    {
      const m = p.match(/^\/api\/brainstorms\/([^/]+)\/contributions$/);
      if (req.method === "GET" && m) {
        const b = brainstorms.get(m[1]);
        if (!b) return json(res, 404, { error: "no such brainstorm" });
        const since = Number(url.searchParams.get("since") || 0) || 0;
        return json(res, 200, { contributions: b.contributions.filter(c => c.at > since) });
      }
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
        // no-store: this is a fast-iterating demo app — never let the browser serve a stale
        // ambient.js/index.html, or UI fixes silently won't show up after a plain reload.
        res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream", "Cache-Control": "no-store" });
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
  console.log("  scan provider:", SCAN_PROVIDER, " scan model:", scanModel, " stt:", STT_MODEL);
  console.log("  brainstorm repo:", LINNY_REPO, " fleet model:", BUILD_MODEL);
  console.log("  linny base ready:", ensureLinnyBase());
  console.log("  Nebius key:", !!process.env.NEBIUS_API_KEY);
});

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("SIGINT", () => { console.log("\nshutting down"); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000).unref(); });
process.on("SIGTERM", () => server.close(() => process.exit(0)));
