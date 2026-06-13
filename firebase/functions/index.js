"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const express = require("express");
const cors = require("cors");
const Busboy = require("busboy");
const Groq = require("groq-sdk").default || require("groq-sdk");
const { toFile } = require("groq-sdk");
const Anthropic = require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk");

// ---- Config (firebase-functions v2 auto-loads functions/.env) ----
const ANSWER_MODEL = process.env.ANSWER_MODEL || "claude-sonnet-4-6";
const STT_MODEL = process.env.STT_MODEL || "whisper-large-v3-turbo";
const TTS_MODEL = process.env.TTS_MODEL || "canopylabs/orpheus-v1-english";
const TTS_VOICE = process.env.TTS_VOICE || "Hannah";
const TTS_MAX_CHARS = 200; // Groq Orpheus TTS hard limit per request

// Claude Managed Agents (hosted): the answer step runs on Anthropic's hosted
// agent loop. The agent + cloud environment are created ONCE out-of-band
// (setup-managed-agent.js) — model/system/tools live on the AGENT, not here.
const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";
const AGENT_ID = process.env.AGENT_ID;
const ENV_ID = process.env.ENV_ID;

// Clients are created lazily: at deploy time the CLI loads this module to analyze
// it WITHOUT functions/.env in process.env, so constructing SDK clients at module
// top-level would throw on the missing key. At runtime the env vars are present.
let _groq;
let _anthropic;
function groqClient() {
  if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _groq;
}
function anthropicClient() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

const SYSTEM =
  "You are wiser, a concise voice assistant heard through smart glasses. " +
  "Answer in 1-3 short spoken sentences. Plain text only — no markdown, lists, or emoji.";

// ============================================================================
// Groq STT + TTS (ported verbatim from backend/src/groq.ts)
// ============================================================================

/** Speech -> text. Whisper needs a filename+content-type or it 400s. */
async function transcribe(buffer, filename = "recording.webm", contentType = "audio/webm") {
  const file = await toFile(buffer, filename, { type: contentType });
  const res = await groqClient().audio.transcriptions.create({
    file,
    model: STT_MODEL,
    language: "en",
  });
  return res.text.trim();
}

/** One <=200-char chunk -> base64 WAV. */
async function synthesize(text) {
  const res = await groqClient().audio.speech.create({
    model: TTS_MODEL,
    voice: TTS_VOICE,
    input: text,
    response_format: "wav",
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString("base64");
}

/** Synthesize a full answer as ordered base64 WAV chunks (parallel calls, order preserved). */
async function synthesizeChunks(text) {
  const chunks = chunkBySentence(text);
  return Promise.all(chunks.map(synthesize));
}

/** Split into <=maxChars pieces: pack sentences, then hard-wrap any oversized piece at word boundaries. */
function chunkBySentence(text, maxChars = TTS_MAX_CHARS) {
  const sentences = text.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) ?? [text];
  const chunks = [];
  let cur = "";

  const flush = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = "";
  };

  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (sentence.length > maxChars) {
      flush();
      chunks.push(...hardWrap(sentence, maxChars));
      continue;
    }
    if ((cur + " " + sentence).trim().length > maxChars) {
      flush();
      cur = sentence;
    } else {
      cur = cur ? `${cur} ${sentence}` : sentence;
    }
  }
  flush();
  return chunks.filter(Boolean);
}

function hardWrap(s, maxChars) {
  const out = [];
  let cur = "";
  for (const word of s.split(/\s+/)) {
    if (word.length > maxChars) {
      if (cur) { out.push(cur); cur = ""; }
      for (let i = 0; i < word.length; i += maxChars) out.push(word.slice(i, i + maxChars));
      continue;
    }
    if ((cur + " " + word).trim().length > maxChars) {
      out.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ============================================================================
// Answer step: Claude Managed Agents (hosted) — replaces the Messages API call
// ============================================================================

const MA_OPTS = { betas: [MANAGED_AGENTS_BETA] };

/** Create a fresh managed-agents session against the durable agent/env. */
async function createSession() {
  const session = await anthropicClient().beta.sessions.create(
    { agent: AGENT_ID, environment_id: ENV_ID },
    MA_OPTS
  );
  return session.id;
}

/**
 * Send one user turn to an EXISTING session and collect the agent's answer:
 *   events.stream (OPEN BEFORE SEND) -> events.send(user.message)
 *   -> collect agent.message text
 *   -> break only on TERMINAL idle (non-requires_action stop_reason) / terminated.
 */
async function runTurn(sessionId, text) {
  const client = anthropicClient();

  // Stream BEFORE send — SSE has no replay. stream() returns an APIPromise that
  // resolves to an async-iterable Stream.
  const stream = await client.beta.sessions.events.stream(sessionId, MA_OPTS);

  await client.beta.sessions.events.send(sessionId, {
    ...MA_OPTS,
    events: [{ type: "user.message", content: [{ type: "text", text }] }],
  });

  let answer = "";
  for await (const event of stream) {
    if (event.type === "agent.message") {
      for (const b of event.content || []) {
        if (b.type === "text") answer += b.text;
      }
    } else if (event.type === "session.status_idle") {
      // idle != done: break only on a TERMINAL stop_reason (not requires_action).
      const sr = event.stop_reason;
      if (sr && sr.type !== "requires_action") break;
    } else if (event.type === "session.status_terminated") {
      break;
    }
  }

  return answer.trim();
}

/** A session id is gone (expired/terminated/invalid/never existed) — start fresh. */
function isMissingSession(err) {
  const status = err && err.status;
  if (status === 404 || status === 410) return true;
  const msg = ((err && err.message) || "").toLowerCase();
  const mentionsSession = msg.includes("session");
  const looksGone = /(not found|invalid|terminat|expir|archiv|does not exist)/.test(msg);
  return mentionsSession && looksGone;
}

/**
 * Run a single answer turn on Anthropic's HOSTED agent loop.
 * Option A — the CLIENT owns the session id (conversation memory):
 *   - sessionId given  -> reuse it (the agent remembers the conversation)
 *   - sessionId absent -> create a new session
 * If a provided session is gone (expired/terminated), transparently create a
 * fresh one and retry once. Returns { answer, sessionId } so the caller can
 * persist the (possibly new) id and keep the conversation going.
 *
 * imageB64 is accepted for API compatibility but unused (text-only for now).
 */
async function askAnthropic(text, sessionId, _imageB64, _mediaType = "image/jpeg") {
  if (!AGENT_ID || !ENV_ID) {
    throw new Error("AGENT_ID/ENV_ID not configured (run setup-managed-agent.js)");
  }

  let sid = sessionId;
  if (!sid) sid = await createSession();

  try {
    const answer = await runTurn(sid, text);
    return { answer, sessionId: sid };
  } catch (err) {
    // Client passed a stale/dead session id — recover by starting a new one.
    if (sessionId && isMissingSession(err)) {
      console.warn("session unusable, creating a fresh one:", err && err.message);
      const fresh = await createSession();
      const answer = await runTurn(fresh, text);
      return { answer, sessionId: fresh };
    }
    throw err;
  }
}

// ============================================================================
// Browse past sessions (read-only) — Managed Agents list + transcript
// ============================================================================
//
// SCOPING CAVEAT: client.beta.sessions.list() is API-KEY/ORG scoped. It returns
// EVERY session created with this ANTHROPIC_API_KEY — i.e. across ALL wiser
// end-users, not per-user. There is no end-user identity on a managed-agents
// session. If per-user history is needed, filter by a metadata tag set at
// session-create time, or keep an own index. For now this lists all key sessions.

/** Pull the first `user.message` text for a session as a cheap preview (one tiny page). */
async function sessionPreview(sessionId) {
  try {
    const page = await anthropicClient().beta.sessions.events.list(
      sessionId,
      { ...MA_OPTS, limit: 1, types: ["user.message"], order: "asc" }
    );
    for await (const ev of page) {
      if (ev.type === "user.message") {
        const txt = (ev.content || [])
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join(" ")
          .trim();
        return txt.slice(0, 200) || null;
      }
    }
  } catch (err) {
    console.warn(`preview failed for ${sessionId}:`, errMsg(err));
  }
  return null;
}

/**
 * List sessions (newest first), with a cheap per-session preview built from the
 * first user message. Cursor-paginated: pass `cursor` (opaque), get `nextCursor`.
 * `withPreview=false` skips the extra per-session events.list calls (faster).
 */
async function listSessions({ limit = 20, cursor, withPreview = true } = {}) {
  const params = { ...MA_OPTS, limit };
  if (cursor) params.page = cursor;
  const page = await anthropicClient().beta.sessions.list(params);

  const rows = (page.data || []).map((s) => ({
    id: s.id,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    status: s.status,
    title: s.title || null,
    agentId: (s.agent && (s.agent.id || s.agent.agent_id)) || null,
  }));

  if (withPreview) {
    const previews = await Promise.all(rows.map((r) => sessionPreview(r.id)));
    rows.forEach((r, i) => {
      r.preview = previews[i];
    });
  }

  return { sessions: rows, nextCursor: page.next_page || null };
}

/** Full transcript for one session: ordered events flattened to {type, role, text, at}. */
async function sessionTranscript(sessionId, { limit = 500 } = {}) {
  const page = await anthropicClient().beta.sessions.events.list(
    sessionId,
    { ...MA_OPTS, limit, order: "asc" }
  );

  const messages = [];
  for await (const ev of page) {
    const text = (ev.content || [])
      .filter((b) => b && b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (ev.type === "user.message") {
      messages.push({ role: "user", type: ev.type, text, at: ev.created_at });
    } else if (ev.type === "agent.message") {
      messages.push({ role: "agent", type: ev.type, text, at: ev.created_at });
    }
    if (messages.length >= limit) break;
  }
  return messages;
}

// ============================================================================
// Card distillation (ported verbatim from backend/src/card.ts)
// ============================================================================

function distill(answer, transcript) {
  const words = answer.split(/\s+/).filter(Boolean);
  const title = words.slice(0, 6).join(" ") + (words.length > 6 ? "…" : "");
  return {
    title: title || transcript.slice(0, 40) || "Result",
    summary: answer,
  };
}

// ============================================================================
// Pipeline (ported from backend/src/pipeline.ts; answer -> Managed Agents)
// ============================================================================

/** Full voice pipeline: STT -> answer -> TTS -> card. */
async function runAsk(audio, opts = {}) {
  const transcript = await transcribe(audio, opts.filename, opts.contentType);
  return runAskText(transcript, opts.sessionId, opts.imageB64, opts.imageMediaType);
}

/**
 * Same pipeline from a typed prompt (skips STT). The client owns the session id:
 * pass it in to continue a conversation, omit it to start one. The (possibly new)
 * id is returned as `sessionId` so the client can persist it for the next turn.
 */
async function runAskText(transcript, sessionId, imageB64, imageMediaType) {
  const { answer, sessionId: sid } = await askAnthropic(
    transcript,
    sessionId,
    imageB64,
    imageMediaType
  );
  // TTS is best-effort: a failure must not sink the card.
  let audioChunks = [];
  try {
    audioChunks = await synthesizeChunks(answer);
  } catch (err) {
    console.warn("TTS failed (continuing without audio):", err instanceof Error ? err.message : err);
  }
  const card = distill(answer, transcript);
  return { transcript, answer, audioChunks, card, sessionId: sid };
}

// ============================================================================
// multipart/form-data parsing via busboy over req.rawBody
// ============================================================================

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files = {};
    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { fileSize: 30 * 1024 * 1024 } });
    } catch (err) {
      return reject(err);
    }

    bb.on("file", (name, stream, info) => {
      const chunks = [];
      stream.on("data", (d) => chunks.push(d));
      stream.on("end", () => {
        files[name] = {
          buffer: Buffer.concat(chunks),
          filename: info.filename,
          mimeType: info.mimeType,
        };
      });
      stream.on("error", reject);
    });

    bb.on("field", (name, val) => {
      fields[name] = val;
    });

    bb.on("error", reject);
    bb.on("finish", () => resolve({ fields, files }));

    // In Cloud Functions the body is already buffered as req.rawBody.
    if (req.rawBody) {
      bb.end(req.rawBody);
    } else {
      req.pipe(bb);
    }
  });
}

// ============================================================================
// Express app -> single function
// ============================================================================

const app = express();
app.use(cors({ origin: true }));

function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// Voice (+ optional image) -> spoken answer card. multipart: audio, image,
// optional `sessionId` field to continue a conversation (client owns the id).
app.post("/api/ask", async (req, res) => {
  try {
    const { fields, files } = await parseMultipart(req);
    const audio = files.audio;
    if (!audio) return res.status(400).json({ error: "missing 'audio' file" });
    const image = files.image;

    const result = await runAsk(audio.buffer, {
      filename: audio.filename || "recording.webm",
      contentType: audio.mimeType || "audio/webm",
      sessionId: fields.sessionId || undefined,
      imageB64: image ? image.buffer.toString("base64") : undefined,
      imageMediaType: image ? image.mimeType : undefined,
    });
    res.json(result);
  } catch (err) {
    console.error("/api/ask error:", err);
    res.status(500).json({ error: errMsg(err) });
  }
});

// Typed-prompt fallback (bypasses STT).
// JSON: { text, sessionId?, imageB64?, imageMediaType? }
// Pass `sessionId` from a previous response to continue the conversation; omit
// it to start fresh. The response echoes the (possibly new) `sessionId`.
app.post("/api/ask-text", express.json({ limit: "15mb" }), async (req, res) => {
  try {
    const { text, sessionId, imageB64, imageMediaType } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "missing 'text'" });
    }
    const result = await runAskText(text, sessionId, imageB64, imageMediaType);
    res.json(result);
  } catch (err) {
    console.error("/api/ask-text error:", err);
    res.status(500).json({ error: errMsg(err) });
  }
});

// Browse past managed-agents sessions (read-only). KEY/ORG-SCOPED: returns every
// session created with this API key (all wiser users), newest first.
// Query: ?limit=20&cursor=<opaque>&preview=0  (preview=0 skips per-session lookups)
// -> { sessions: [{ id, createdAt, updatedAt, status, title, agentId, preview }], nextCursor }
app.get("/api/sessions", async (req, res) => {
  try {
    if (!AGENT_ID || !ENV_ID) {
      // Not strictly required to list, but signals the function is configured.
      // listing works without them; we still allow it.
    }
    const rawLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 20;
    const cursor = req.query.cursor || undefined;
    const withPreview = req.query.preview !== "0" && req.query.preview !== "false";
    const result = await listSessions({ limit, cursor, withPreview });
    res.json(result);
  } catch (err) {
    console.error("/api/sessions error:", err);
    res.status(500).json({ error: errMsg(err) });
  }
});

// Full transcript for one session (deep dive).
// -> { id, messages: [{ role, type, text, at }] }
app.get("/api/sessions/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: "missing session id" });
    const messages = await sessionTranscript(id);
    res.json({ id, messages });
  } catch (err) {
    console.error("/api/sessions/:id error:", err);
    const status = err && (err.status === 404 || err.status === 410) ? 404 : 500;
    res.status(status).json({ error: errMsg(err) });
  }
});

exports.wiser = onRequest(
  // Managed agents are slower than messages.create — give the loop headroom.
  { cors: true, timeoutSeconds: 300, memory: "512MiB", region: "us-central1" },
  app
);
