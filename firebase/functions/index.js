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

/**
 * Run a single answer turn on Anthropic's HOSTED agent loop:
 *   sessions.create(agent, environment_id) -> events.stream (OPEN BEFORE SEND)
 *   -> events.send(user.message) -> collect agent.message text
 *   -> break only on TERMINAL idle (non-requires_action stop_reason) / terminated.
 * The agent (model/system) + cloud environment are provisioned once and reused
 * via AGENT_ID / ENV_ID. Returns the final assistant text.
 *
 * imageB64 is accepted for API compatibility but unused (text-only for now).
 */
async function askAnthropic(text, _imageB64, _mediaType = "image/jpeg") {
  if (!AGENT_ID || !ENV_ID) {
    throw new Error("AGENT_ID/ENV_ID not configured (run setup-managed-agent.js)");
  }

  const client = anthropicClient();
  const opts = { betas: [MANAGED_AGENTS_BETA] };

  // One disposable session per run; the durable agent/env are reused.
  const session = await client.beta.sessions.create(
    { agent: AGENT_ID, environment_id: ENV_ID },
    opts
  );

  // Stream BEFORE send — SSE has no replay. stream() returns an APIPromise that
  // resolves to an async-iterable Stream.
  const stream = await client.beta.sessions.events.stream(session.id, opts);

  await client.beta.sessions.events.send(session.id, {
    ...opts,
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
  return runAskText(transcript, opts.imageB64, opts.imageMediaType);
}

/** Same pipeline from a typed prompt (skips STT). */
async function runAskText(transcript, imageB64, imageMediaType) {
  const answer = await askAnthropic(transcript, imageB64, imageMediaType);
  // TTS is best-effort: a failure must not sink the card.
  let audioChunks = [];
  try {
    audioChunks = await synthesizeChunks(answer);
  } catch (err) {
    console.warn("TTS failed (continuing without audio):", err instanceof Error ? err.message : err);
  }
  const card = distill(answer, transcript);
  return { transcript, answer, audioChunks, card };
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

// Voice (+ optional image) -> spoken answer card. multipart: audio, image
app.post("/api/ask", async (req, res) => {
  try {
    const { files } = await parseMultipart(req);
    const audio = files.audio;
    if (!audio) return res.status(400).json({ error: "missing 'audio' file" });
    const image = files.image;

    const result = await runAsk(audio.buffer, {
      filename: audio.filename || "recording.webm",
      contentType: audio.mimeType || "audio/webm",
      imageB64: image ? image.buffer.toString("base64") : undefined,
      imageMediaType: image ? image.mimeType : undefined,
    });
    res.json(result);
  } catch (err) {
    console.error("/api/ask error:", err);
    res.status(500).json({ error: errMsg(err) });
  }
});

// Typed-prompt fallback (bypasses STT). JSON: { text, imageB64?, imageMediaType? }
app.post("/api/ask-text", express.json({ limit: "15mb" }), async (req, res) => {
  try {
    const { text, imageB64, imageMediaType } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "missing 'text'" });
    }
    const result = await runAskText(text, imageB64, imageMediaType);
    res.json(result);
  } catch (err) {
    console.error("/api/ask-text error:", err);
    res.status(500).json({ error: errMsg(err) });
  }
});

exports.wiser = onRequest(
  // Managed agents are slower than messages.create — give the loop headroom.
  { cors: true, timeoutSeconds: 300, memory: "512MiB", region: "us-central1" },
  app
);
