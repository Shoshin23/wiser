"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const express = require("express");
const cors = require("cors");
const Busboy = require("busboy");
const Groq = require("groq-sdk").default || require("groq-sdk");
const { toFile } = require("groq-sdk");
const Anthropic = require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk");
const { SYSTEM } = require("./agent-config");
const orchestrator = require("./orchestrator");

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

// SYSTEM lives in ./agent-config (shared with setup/update scripts). It is the
// agent's *stored* system that actually runs in the managed path; kept here only
// so this module's notion of the prompt can't silently drift.
void SYSTEM;

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

/** Default-fill a handoff_to_glasses input into the card envelope we serve. */
function normalizeHandoff(h) {
  h = h || {};
  return {
    headline: h.headline || "Result",
    summary: h.summary || "",
    status: h.status || "done",
    detail: h.detail,
    actions: Array.isArray(h.actions) ? h.actions.slice(0, 4) : undefined,
  };
}

/**
 * Drive ONE turn on an EXISTING session and return a DISCRIMINATED result.
 * `sendEvents` is the array of events that opens this turn — either a fresh
 * [{user.message}] or a resume [{user.custom_tool_result}].
 *
 *   events.stream (OPEN BEFORE SEND) -> events.send(sendEvents)
 *   loop:
 *     agent.message                          -> accumulate text
 *     agent.custom_tool_use ask_user         -> RETURN {kind:"question"} WITHOUT replying
 *                                               (leaves the session in requires_action)
 *     agent.custom_tool_use handoff_to_glasses
 *                                            -> capture handoff, ack success, keep consuming
 *     agent.custom_tool_use <unknown>        -> reply is_error so the agent doesn't hang
 *     terminal idle (non-requires_action)    -> handoff if captured, else {kind:"answer"}
 *     session.status_terminated              -> handoff/answer if any, else {kind:"terminated"}
 *
 * Returns one of:
 *   {kind:"answer", answer}
 *   {kind:"handoff", handoff, answer}
 *   {kind:"question", question, options?, toolUseId, sessionThreadId?}
 *   {kind:"terminated"}
 */
async function runTurnRaw(client, sessionId, sendEvents) {
  // Stream BEFORE send — SSE has no replay. stream() returns an APIPromise that
  // resolves to an async-iterable Stream.
  const stream = await client.beta.sessions.events.stream(sessionId, MA_OPTS);

  await client.beta.sessions.events.send(sessionId, {
    ...MA_OPTS,
    events: sendEvents,
  });

  let answer = "";
  let handoff = null;

  for await (const event of stream) {
    if (event.type === "agent.message") {
      for (const b of event.content || []) {
        if (b.type === "text") answer += b.text;
      }
    } else if (event.type === "agent.custom_tool_use") {
      if (event.name === "ask_user") {
        // Pause the turn for human think-time. Do NOT reply — the session stays
        // in requires_action until a later resume request answers this tool use.
        const input = event.input || {};
        return {
          kind: "question",
          question: typeof input.question === "string" ? input.question : "",
          options: Array.isArray(input.options) ? input.options.slice(0, 4) : undefined,
          toolUseId: event.id,
          sessionThreadId: event.session_thread_id || undefined,
        };
      } else if (event.name === "handoff_to_glasses") {
        handoff = normalizeHandoff(event.input);
        // Ack inline so the agent reaches end_turn in this same turn.
        await client.beta.sessions.events.send(sessionId, {
          ...MA_OPTS,
          events: [
            {
              type: "user.custom_tool_result",
              custom_tool_use_id: event.id,
              content: [{ type: "text", text: "delivered" }],
              ...(event.session_thread_id ? { session_thread_id: event.session_thread_id } : {}),
            },
          ],
        });
        // keep consuming the same stream to terminal
      } else {
        // Unknown tool — reply with an error so the agent doesn't hang waiting.
        await client.beta.sessions.events.send(sessionId, {
          ...MA_OPTS,
          events: [
            {
              type: "user.custom_tool_result",
              custom_tool_use_id: event.id,
              content: [{ type: "text", text: `unknown tool: ${event.name}` }],
              is_error: true,
              ...(event.session_thread_id ? { session_thread_id: event.session_thread_id } : {}),
            },
          ],
        });
      }
    } else if (event.type === "session.status_idle") {
      // idle != done: break only on a TERMINAL stop_reason (not requires_action).
      const sr = event.stop_reason;
      if (sr && sr.type !== "requires_action") break;
    } else if (event.type === "session.status_terminated") {
      if (handoff) return { kind: "handoff", handoff, answer: answer.trim() };
      if (answer.trim()) return { kind: "answer", answer: answer.trim() };
      return { kind: "terminated" };
    }
  }

  // Terminal idle reached.
  if (handoff) return { kind: "handoff", handoff, answer: answer.trim() };
  return { kind: "answer", answer: answer.trim() };
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
 * Run one managed-agents turn and return { result, sessionId }.
 *
 * `buildEvents(sid)` returns the events that open the turn for a given session id
 * (a fresh user.message, or a resume custom_tool_result). `allowRecover` controls
 * the stale-session recover-and-retry: it applies ONLY to fresh user.message turns
 * (sessionId absent => we minted it, or a client-passed id that we can safely
 * recreate). A RESUME turn's toolUseId is bound to its specific session, so a gone
 * session on resume must surface a clean error, NOT silently start fresh.
 */
async function runManaged(buildEvents, sessionId, { allowRecover = true } = {}) {
  if (!AGENT_ID || !ENV_ID) {
    throw new Error("AGENT_ID/ENV_ID not configured (run setup-managed-agent.js)");
  }
  const client = anthropicClient();

  let sid = sessionId;
  const wasGiven = !!sessionId;
  if (!sid) sid = await createSession();

  try {
    const result = await runTurnRaw(client, sid, buildEvents(sid));
    return { result, sessionId: sid };
  } catch (err) {
    if (allowRecover && wasGiven && isMissingSession(err)) {
      // Client passed a stale/dead session id on a FRESH turn — recover.
      console.warn("session unusable, creating a fresh one:", err && err.message);
      const fresh = await createSession();
      const result = await runTurnRaw(client, fresh, buildEvents(fresh));
      return { result, sessionId: fresh };
    }
    throw err;
  }
}

// ============================================================================
// Session management — Managed Agents list / transcript / create
// ============================================================================
//
// SCOPING CAVEAT: client.beta.sessions.list() is API-KEY/ORG scoped. It returns
// EVERY session created with this ANTHROPIC_API_KEY — i.e. across ALL wiser
// end-users, not per-user. There is no end-user identity on a managed-agents
// session. If per-user history is needed, filter by a metadata tag set at
// session-create time, or keep an own index. For now this lists all key sessions.
//
// TIMESTAMP NOTE: list rows carry created_at/updated_at; per-event objects carry
// processed_at (not created_at). The transcript relies on the API's order:"asc"
// for chronology rather than per-event timestamps.

/**
 * Cheap best-effort preview: the first `user.message` text for a session, fetched
 * as one tiny page (limit 1, user.message only). Returns "" on any failure — a
 * preview must NEVER fail the list. Only called when the session has no title.
 */
async function sessionPreview(sessionId) {
  try {
    const page = await anthropicClient().beta.sessions.events.list(
      sessionId,
      { ...MA_OPTS, limit: 1, types: ["user.message"], order: "asc" }
    );
    for await (const ev of page) {
      if (ev.type === "user.message") {
        const txt = (ev.content || [])
          .filter((b) => b && b.type === "text")
          .map((b) => b.text)
          .join(" ")
          .trim();
        return txt.slice(0, 200);
      }
    }
  } catch (err) {
    console.warn(`preview failed for ${sessionId}:`, errMsg(err));
  }
  return "";
}

/**
 * List sessions (newest first) shaped to the iOS contract:
 *   { sessions: [{ id, title, preview, status, createdAt, updatedAt }] }
 * `title` may be "" (Managed Agents leaves it null until/unless one is set).
 * `preview` = title when non-empty, else a best-effort first-user-message snippet
 * (one extra tiny events.list per untitled session); falls back to "" — never
 * fails the list. sessions.list already returns newest-first.
 */
async function listSessions({ limit = 50 } = {}) {
  const page = await anthropicClient().beta.sessions.list({ ...MA_OPTS, limit });
  const rows = page.data || [];

  // Build previews only for untitled sessions; titled ones use the title verbatim.
  const previews = await Promise.all(
    rows.map((s) => (s.title ? Promise.resolve(s.title) : sessionPreview(s.id)))
  );

  const sessions = rows.map((s, i) => ({
    id: s.id,
    title: s.title || "",
    preview: previews[i] || "",
    status: s.status,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  }));

  return { sessions };
}

/**
 * Full transcript for one session shaped to the iOS contract:
 *   { id, status, messages: [{ role: "user"|"assistant", text }] }
 * Events are server-ordered chronologically (order: "asc"). Only user.message /
 * agent.message carry conversational text; agent.message -> "assistant". Text
 * blocks within an event are concatenated. Status comes from sessions.retrieve.
 */
async function sessionTranscript(sessionId, { limit = 500 } = {}) {
  const client = anthropicClient();

  // Status + existence check (404/410 here -> the route maps to a 404).
  const session = await client.beta.sessions.retrieve(sessionId, MA_OPTS);

  const page = await client.beta.sessions.events.list(
    sessionId,
    { ...MA_OPTS, limit, order: "asc", types: ["user.message", "agent.message"] }
  );

  const messages = [];
  for await (const ev of page) {
    const text = (ev.content || [])
      .filter((b) => b && b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (ev.type === "user.message") {
      messages.push({ role: "user", text });
    } else if (ev.type === "agent.message") {
      messages.push({ role: "assistant", text });
    }
    if (messages.length >= limit) break;
  }

  return { id: session.id, status: session.status, messages };
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

/** Best-effort TTS: synthesize ordered base64 WAV chunks, [] on any failure. */
async function tts(text) {
  if (!text) return [];
  try {
    return await synthesizeChunks(text);
  } catch (err) {
    console.warn("TTS failed (continuing without audio):", err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Build the HTTP body from a discriminated runTurnRaw result.
 *
 * EVERY kind keeps the back-compat envelope { card{title,summary}, answer,
 * audioChunks, sessionId } so the deployed iOS build still works; `kind` + the
 * question/handoff fields are purely additive.
 *
 *   question -> the lens shows + speaks the question; client answers via a resume
 *               request carrying toolUseId (+ sessionThreadId echo).
 *   handoff  -> the agent's own structured card; speaks the summary.
 *   answer   -> the legacy distilled card; speaks the answer.
 *   terminated -> degrade to an empty-ish answer card.
 */
async function shapeResponse(result, transcript, sid) {
  if (result.kind === "question") {
    const question = result.question || "";
    return {
      kind: "question",
      question,
      options: result.options || [],
      toolUseId: result.toolUseId,
      sessionThreadId: result.sessionThreadId,
      // back-compat envelope
      transcript,
      answer: question,
      audioChunks: await tts(question),
      card: { title: "Question", summary: question },
      sessionId: sid,
    };
  }

  if (result.kind === "handoff") {
    const h = result.handoff;
    return {
      kind: "handoff",
      headline: h.headline,
      summary: h.summary,
      status: h.status,
      detail: h.detail,
      actions: h.actions,
      // back-compat envelope
      transcript,
      answer: h.summary,
      audioChunks: await tts(h.summary),
      card: { title: h.headline, summary: h.summary },
      sessionId: sid,
    };
  }

  // "answer" (incl. fallback when the model forgot handoff) or "terminated".
  const answer = result.kind === "answer" ? result.answer : "";
  return {
    kind: "answer",
    transcript,
    answer,
    audioChunks: await tts(answer),
    card: distill(answer, transcript),
    sessionId: sid,
  };
}

/** Full voice pipeline: STT -> answer -> TTS -> card. */
async function runAsk(audio, opts = {}) {
  const transcript = await transcribe(audio, opts.filename, opts.contentType);
  return runAskText(transcript, opts.sessionId, opts.imageB64, opts.imageMediaType);
}

/**
 * Fresh turn from a typed prompt (skips STT). The client owns the session id:
 * pass it in to continue a conversation, omit it to start one. The (possibly new)
 * id is returned as `sessionId` so the client can persist it for the next turn.
 * imageB64 is accepted for API compatibility but unused (text-only for now).
 */
async function runAskText(transcript, sessionId, _imageB64, _imageMediaType) {
  const { result, sessionId: sid } = await runManaged(
    () => [{ type: "user.message", content: [{ type: "text", text: transcript }] }],
    sessionId,
    { allowRecover: true }
  );
  return shapeResponse(result, transcript, sid);
}

/**
 * RESUME an ask_user pause: answer the pending tool use and read the continuation.
 * The toolUseId is bound to THIS session, so recovery is disabled — a gone session
 * surfaces a clean "conversation expired" error rather than silently restarting.
 * `threadId` is echoed when the original ask_user came from a subagent thread.
 */
async function runAnswer(text, sessionId, toolUseId, threadId) {
  if (!sessionId || !toolUseId) {
    throw new Error("runAnswer requires sessionId and toolUseId");
  }
  const { result, sessionId: sid } = await runManaged(
    () => [
      {
        type: "user.custom_tool_result",
        custom_tool_use_id: toolUseId,
        content: [{ type: "text", text }],
        ...(threadId ? { session_thread_id: threadId } : {}),
      },
    ],
    sessionId,
    { allowRecover: false }
  );
  return shapeResponse(result, text, sid);
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

// Plain STT: multipart `audio` -> { transcript }. Used by the orchestrator Build
// surface for voice prompts / voice steer (no agent loop, just Groq STT).
app.post("/api/transcribe", async (req, res) => {
  try {
    const { files } = await parseMultipart(req);
    const audio = files.audio;
    if (!audio) return res.status(400).json({ error: "missing 'audio' file" });
    const transcript = await transcribe(
      audio.buffer,
      audio.filename || "recording.webm",
      audio.mimeType || "audio/webm"
    );
    res.json({ transcript });
  } catch (err) {
    console.error("/api/transcribe error:", err);
    res.status(500).json({ error: errMsg(err) });
  }
});

// Voice (+ optional image) -> spoken answer card. multipart: audio, image,
// optional `sessionId` field to continue a conversation (client owns the id).
// When `toolUseId` (+ optional `sessionThreadId`) is present, this is the spoken
// ANSWER to a pending ask_user question: STILL transcribe the audio, then resume
// the session with that transcript as the tool result.
app.post("/api/ask", async (req, res) => {
  try {
    const { fields, files } = await parseMultipart(req);
    const audio = files.audio;
    if (!audio) return res.status(400).json({ error: "missing 'audio' file" });
    const image = files.image;

    if (fields.toolUseId) {
      if (!fields.sessionId) {
        return res.status(400).json({ error: "answering a question requires 'sessionId'" });
      }
      const transcript = await transcribe(
        audio.buffer,
        audio.filename || "recording.webm",
        audio.mimeType || "audio/webm"
      );
      const result = await runAnswer(
        transcript,
        fields.sessionId,
        fields.toolUseId,
        fields.sessionThreadId || undefined
      );
      return res.json(result);
    }

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
    const expired = isMissingSession(err);
    res.status(expired ? 410 : 500).json({
      error: expired ? "conversation expired" : errMsg(err),
    });
  }
});

// Typed-prompt fallback (bypasses STT).
// JSON: { text, sessionId?, toolUseId?, sessionThreadId?, imageB64?, imageMediaType? }
// Pass `sessionId` from a previous response to continue the conversation; omit it
// to start fresh. When `toolUseId` is present it's the typed ANSWER to a pending
// ask_user question -> resume the session with that text as the tool result.
// The response echoes the (possibly new) `sessionId`.
app.post("/api/ask-text", express.json({ limit: "15mb" }), async (req, res) => {
  try {
    const { text, sessionId, toolUseId, sessionThreadId, imageB64, imageMediaType } =
      req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "missing 'text'" });
    }
    if (toolUseId) {
      if (!sessionId) {
        return res.status(400).json({ error: "answering a question requires 'sessionId'" });
      }
      const result = await runAnswer(text, sessionId, toolUseId, sessionThreadId);
      return res.json(result);
    }
    const result = await runAskText(text, sessionId, imageB64, imageMediaType);
    res.json(result);
  } catch (err) {
    console.error("/api/ask-text error:", err);
    const expired = isMissingSession(err);
    res.status(expired ? 410 : 500).json({
      error: expired ? "conversation expired" : errMsg(err),
    });
  }
});

// Cancel a pending ask_user question the user abandoned: error-out the dangling
// tool so the session isn't stuck in requires_action. Best-effort — swallow errors.
// JSON: { sessionId, toolUseId, sessionThreadId? }
app.post("/api/cancel", express.json({ limit: "1mb" }), async (req, res) => {
  const { sessionId, toolUseId, sessionThreadId } = req.body || {};
  if (!sessionId || !toolUseId) {
    return res.status(400).json({ error: "missing 'sessionId' or 'toolUseId'" });
  }
  try {
    await anthropicClient().beta.sessions.events.send(sessionId, {
      ...MA_OPTS,
      events: [
        {
          type: "user.custom_tool_result",
          custom_tool_use_id: toolUseId,
          content: [{ type: "text", text: "user cancelled" }],
          is_error: true,
          ...(sessionThreadId ? { session_thread_id: sessionThreadId } : {}),
        },
      ],
    });
    res.json({ ok: true });
  } catch (err) {
    console.warn("/api/cancel (best-effort) failed:", errMsg(err));
    res.json({ ok: false });
  }
});

// List past managed-agents sessions (newest first). KEY/ORG-SCOPED: returns every
// session created with this API key (all wiser users), not per-end-user.
// -> { sessions: [{ id, title, preview, status, createdAt, updatedAt }] }
app.get("/api/sessions", async (_req, res) => {
  try {
    const result = await listSessions({ limit: 50 });
    res.json(result);
  } catch (err) {
    console.error("/api/sessions error:", err);
    res.status(500).json({ error: errMsg(err) });
  }
});

// Create a NEW session against the durable agent/env. Returns its id so the
// client can drive the conversation via /api/ask-text { text, sessionId }.
// -> { sessionId }
app.post("/api/sessions", async (_req, res) => {
  try {
    if (!AGENT_ID || !ENV_ID) {
      return res
        .status(500)
        .json({ error: "AGENT_ID/ENV_ID not configured (run setup-managed-agent.js)" });
    }
    const sessionId = await createSession();
    res.json({ sessionId });
  } catch (err) {
    console.error("POST /api/sessions error:", err);
    res.status(500).json({ error: errMsg(err) });
  }
});

// Full transcript for one session (deep dive).
// -> { id, status, messages: [{ role: "user"|"assistant", text }] }
app.get("/api/sessions/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: "missing session id" });
    const result = await sessionTranscript(id);
    res.json(result);
  } catch (err) {
    console.error("/api/sessions/:id error:", err);
    // A gone (404/410) or malformed/invalid (400 "Invalid session ID") id is a
    // not-found from the client's perspective; anything else is a real 500.
    const s = err && err.status;
    const invalidId = s === 400 && /invalid session id/i.test(errMsg(err));
    const status = s === 404 || s === 410 || invalidId ? 404 : 500;
    res.status(status).json({ error: errMsg(err) });
  }
});

// ============================================================================
// Streaming orchestrator — /api/runs (a real coding agent, distilled to frames).
// Distinct namespace from the Q&A /api/sessions. See docs/orchestrator-spec.md.
// ============================================================================

// Create a run: a managed session against the CODING agent/env, send the prompt.
// JSON: { prompt, repo? }  (repo = url string or { url, token?, checkout? })
// -> { id }  (the session id; stream it via GET /api/runs/:id/events)
app.post("/api/runs", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const { prompt, repo } = req.body || {};
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "missing 'prompt'" });
    }
    const { id } = await orchestrator.createRun({ prompt, repo });
    res.json({ id });
  } catch (err) {
    console.error("POST /api/runs error:", err);
    res.status(500).json({ error: errMsg(err) });
  }
});

// SSE: distill the managed-agent event stream into {hud}|{card}|{done} frames.
// Reconnect with Last-Event-ID -> replay events.list after that id (re-distill to
// rebuild hud) then continue live. Keep-alive comment every ~15s. The managed
// session is durable, so a dropped SSE (Cloud Run 300s cap) is recovered by the
// client reconnecting with Last-Event-ID.
app.get("/api/runs/:id/events", async (req, res) => {
  const id = req.params.id;
  if (!id) return res.status(400).json({ error: "missing run id" });

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders && res.flushHeaders();

  const distiller = orchestrator.makeDistiller();
  let closed = false;

  // Write the frames a distiller batch produced. Frames carry { id, frame };
  // ack entries carry { ack } and are sent back to the session, not the client.
  async function writeFrames(frames) {
    for (const f of frames) {
      if (closed) return;
      if (f.ack) {
        // fire-and-forget ack so the agent continues; errors are non-fatal.
        orchestrator
          .ackCustomTool(id, f.ack)
          .catch((e) => console.warn("ack failed:", errMsg(e)));
        continue;
      }
      if (!f.frame) continue;
      if (f.id) res.write(`id: ${f.id}\n`);
      res.write(`data: ${JSON.stringify(f.frame)}\n\n`);
    }
  }

  const keepAlive = setInterval(() => {
    if (!closed) res.write(`: keep-alive\n\n`);
  }, 15000);

  const t0 = Date.now();
  const clock = setInterval(() => {
    if (closed) return;
    const frame = distiller.tick(Math.floor((Date.now() - t0) / 1000));
    if (frame && frame.frame) {
      if (frame.id) res.write(`id: ${frame.id}\n`);
      res.write(`data: ${JSON.stringify(frame.frame)}\n\n`);
    }
  }, 1000);

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    clearInterval(clock);
    try { res.end(); } catch (_) {}
  }
  req.on("close", cleanup);

  try {
    // Replay first (rebuild hud) if reconnecting. Last-Event-ID is the last SSE id
    // the client saw = the source event id.
    const lastId = req.get("Last-Event-ID");
    if (lastId) {
      const past = await orchestrator.listEventsAfter(id, lastId);
      for (const ev of past) await writeFrames(distiller.feed(ev));
      if (distiller.doneEmitted) return cleanup();
    }

    const stream = await orchestrator.openEventStream(id);
    for await (const ev of stream) {
      if (closed) break;
      await writeFrames(distiller.feed(ev));
      if (distiller.doneEmitted) break;
    }
  } catch (err) {
    console.error("/api/runs/:id/events error:", err);
    if (!closed) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: errMsg(err) })}\n\n`);
    }
  } finally {
    cleanup();
  }
});

// Stateless steer: answer the pending ask_user (or nudge). The held SSE on this
// or another instance picks up the resumed events. JSON: { gesture? | voiceText? }
// -> 202
app.post("/api/runs/:id/steer", express.json({ limit: "1mb" }), async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: "missing run id" });
    const { gesture, voiceText } = req.body || {};
    if (!gesture && !voiceText) {
      return res.status(400).json({ error: "missing 'gesture' or 'voiceText'" });
    }
    const result = await orchestrator.steer(id, { gesture, voiceText });
    res.status(202).json(result);
  } catch (err) {
    console.error("/api/runs/:id/steer error:", err);
    const expired = isMissingSession(err);
    res.status(expired ? 410 : 500).json({
      error: expired ? "run expired" : errMsg(err),
    });
  }
});

exports.wiser = onRequest(
  // Managed agents are slower than messages.create — give the loop headroom.
  { cors: true, timeoutSeconds: 300, memory: "512MiB", region: "us-central1" },
  app
);
