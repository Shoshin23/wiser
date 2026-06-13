"use strict";
// wiser streaming orchestrator — the DISTILLER + run/steer helpers.
//
// A real Claude Managed Agent (CODING_AGENT_ID) does real coding in a network-on
// cloud container (CODING_ENV_ID). This module turns its raw managed-agent event
// stream into the tiny Card/Hud/Steer frames the glasses render. Everything here
// codes to docs/orchestrator-spec.md (the shared seam with iOS).
//
// Exports:
//   - makeDistiller()            -> a stateful per-connection distiller (events -> frames)
//   - createRun({prompt, repo})  -> { id } (creates a session, sends the prompt)
//   - openEventStream(id, after) -> live SSE Stream of managed-agent events
//   - listEventsAfter(id, after) -> replay page (for Last-Event-ID reconnect)
//   - ackCustomTool(...)         -> reply user.custom_tool_result for a tool_use
//   - steer(id, {gesture|voiceText}) -> stateless steer via events.list
//
// It REUSES the managed-agents wiring style from index.js (anthropicClient/MA_OPTS)
// but is self-contained so it can be unit-driven by test-orchestrator.js with no
// HTTP server.

const A = require("@anthropic-ai/sdk");
const Anthropic = A.default || A;

const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";
const MA_OPTS = { betas: [MANAGED_AGENTS_BETA] };

const CODING_AGENT_ID = process.env.CODING_AGENT_ID;
const CODING_ENV_ID = process.env.CODING_ENV_ID;

// Lazy client (same reason as index.js: deploy-time analysis loads this module
// without functions/.env, so don't construct the SDK client at module top-level).
let _anthropic;
function anthropicClient() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

// ---- model pricing per 1M tokens (spec) -------------------------------------
// usd += (input + cache_creation*1.25 + cache_read*0.1)/1e6*IN + output/1e6*OUT
const PRICING = {
  // matched by substring on the model id reported in span.model_request_end
  opus: { in: 5, out: 25 },
  sonnet: { in: 3, out: 15 },
  haiku: { in: 1, out: 5 },
};
function priceFor(model) {
  const m = (model || "").toLowerCase();
  if (m.includes("opus")) return PRICING.opus;
  if (m.includes("haiku")) return PRICING.haiku;
  return PRICING.sonnet; // default (the coding agent is sonnet-4-6)
}

// ---- activity derivation -----------------------------------------------------
function basename(p) {
  if (!p || typeof p !== "string") return "";
  const cleaned = p.replace(/\/+$/, "");
  const i = cleaned.lastIndexOf("/");
  return i >= 0 ? cleaned.slice(i + 1) : cleaned;
}

// Compress a bash command to a glanceable target: first token (the program) plus
// a short tail, capped. e.g. "python3 test_calc.py" -> "python3 test_calc.py".
function shortCmd(cmd, max = 24) {
  if (!cmd || typeof cmd !== "string") return "";
  const oneLine = cmd.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

const TEST_RE = /test|pytest|bench|cargo|go test|npm test|jest|vitest|unittest/i;

// ---- the distiller -----------------------------------------------------------
// Stateful across one connection. Feed it managed-agent events via .feed(ev);
// it returns an ARRAY of frames to write ({hud}|{card}|{done}), each tagged with
// the source event id so the SSE layer can set `id:` for Last-Event-ID resume.
// Replay (reconnect) re-feeds the same events to rebuild hud BEFORE going live.
//
// Frame shape returned: { id, frame } where frame is {hud}|{card}|{done:true,hud}.
function makeDistiller() {
  const hud = {
    loop: "goal",
    iter: 1,
    tokens: 0,
    exit: { label: "task", have: 0, need: 1 },
    costUsd: 0,
    elapsedSec: 0,
    status: "running",
  };
  let usd = 0;
  let tokens = 0;
  const changed = new Set();
  let doneEmitted = false;
  let started = false;
  // ask_user tool uses we've surfaced as a question card but not yet acked — the
  // steer answers these. Keyed by tool_use_id so a replay doesn't double-emit.
  const pendingQuestions = new Set();
  // custom tool uses already turned into frames (idempotent across replay).
  const seenCustom = new Set();

  function hudFrame(id) {
    // shallow copy so each emitted frame is a stable snapshot
    return {
      id,
      frame: {
        hud: {
          loop: hud.loop,
          iter: hud.iter,
          tokens: hud.tokens,
          exit: { ...hud.exit },
          costUsd: round2(hud.costUsd),
          elapsedSec: hud.elapsedSec,
          status: hud.status,
          ...(hud.activity ? { activity: { ...hud.activity } } : {}),
        },
      },
    };
  }

  function setActivity(verb, target, note) {
    hud.activity = { verb, target, ...(note ? { note } : {}) };
  }

  // Emit the very first hud the moment we start consuming a fresh run.
  function start(id) {
    if (started) return [];
    started = true;
    return [hudFrame(id || "start")];
  }

  function feed(ev) {
    const out = [];
    if (!started) out.push(...start(ev && ev.id));
    const id = (ev && ev.id) || "ev";

    // Resume from a steered question: real forward progress (any agent activity)
    // means the human answered the ask_user — flip status back to running. We
    // don't gate on the (out-of-band) ack event, since a live re-opened stream
    // after a steer may never carry it; observed agent work is the real signal.
    if (
      hud.status === "awaiting_human" &&
      (ev.type === "agent.thinking" ||
        ev.type === "agent.tool_use" ||
        ev.type === "span.model_request_end" ||
        ev.type === "agent.message")
    ) {
      hud.status = "running";
      pendingQuestions.clear();
    }

    switch (ev.type) {
      case "agent.thinking": {
        setActivity("plan", "planning");
        out.push(hudFrame(id));
        break;
      }
      case "agent.tool_use": {
        const name = ev.name || "";
        const input = ev.input || {};
        if (/^(write|edit|str_replace)$/i.test(name)) {
          const t = basename(input.file_path);
          setActivity("edit", t || name);
          if (input.file_path) changed.add(input.file_path);
        } else if (/^(read|glob|grep)$/i.test(name)) {
          const t = basename(input.file_path || input.pattern || input.path);
          setActivity("read", t || name);
        } else if (/^bash$/i.test(name)) {
          const cmd = input.command || "";
          if (TEST_RE.test(cmd)) setActivity("test", shortCmd(cmd));
          else setActivity("edit", shortCmd(cmd));
        } else {
          // any other builtin tool — keep the rolling line moving
          setActivity("edit", name);
        }
        out.push(hudFrame(id));
        break;
      }
      case "span.model_request_end": {
        const u = ev.model_usage || ev.usage || {};
        const p = priceFor(ev.model || ev.model_id || (ev.request && ev.request.model));
        const cIn = u.input_tokens || 0;
        const cOut = u.output_tokens || 0;
        const cCreate = u.cache_creation_input_tokens || 0;
        const cRead = u.cache_read_input_tokens || 0;
        usd += (cIn + cCreate * 1.25 + cRead * 0.1) / 1e6 * p.in + (cOut / 1e6) * p.out;
        tokens += cIn + cOut;
        hud.costUsd = usd;
        hud.tokens = tokens;
        out.push(hudFrame(id));
        break;
      }
      case "agent.custom_tool_use": {
        if (seenCustom.has(ev.id)) break; // idempotent across replay
        seenCustom.add(ev.id);
        const input = ev.input || {};
        const name = ev.name;
        if (name === "report_diff") {
          out.push({
            id,
            frame: {
              card: {
                kind: "diff",
                files: numOr(input.files, changed.size || 1),
                added: numOr(input.added, 0),
                removed: numOr(input.removed, 0),
                summary: input.summary || "",
              },
            },
          });
          out.push({ ack: { toolUseId: ev.id, threadId: ev.session_thread_id, text: "ok" } });
        } else if (name === "report_tests") {
          const passed = numOr(input.passed, 0);
          const total = numOr(input.total, 0);
          out.push({
            id,
            frame: {
              card: {
                kind: "tests",
                passed,
                total,
                failing: Array.isArray(input.failing) ? input.failing : [],
              },
            },
          });
          hud.exit = { label: "tests green", have: passed, need: total || 1 };
          out.push(hudFrame(id));
          out.push({ ack: { toolUseId: ev.id, threadId: ev.session_thread_id, text: "ok" } });
        } else if (name === "checkpoint") {
          out.push({
            id,
            frame: {
              card: {
                kind: "checkpoint",
                progress: input.progress || "",
                iter: hud.iter,
                tokens: hud.tokens,
                usd: round2(hud.costUsd),
                ...(input.note ? { note: input.note } : {}),
              },
            },
          });
          out.push({ ack: { toolUseId: ev.id, threadId: ev.session_thread_id, text: "ok" } });
        } else if (name === "ask_user") {
          out.push({
            id,
            frame: {
              card: {
                kind: "question",
                prompt: input.question || "",
                options: Array.isArray(input.options) ? input.options : [],
              },
            },
          });
          hud.status = "awaiting_human";
          setActivity("wait", "needs you");
          out.push(hudFrame(id));
          pendingQuestions.add(ev.id);
          // NO ack — left pending for the steer to answer.
        } else if (name === "done") {
          const stats = Array.isArray(input.stats) && input.stats.length
            ? input.stats
            : derivedStats();
          out.push({
            id,
            frame: {
              card: {
                kind: "done",
                headline: input.headline || "Done",
                stats,
                final: true,
                ...(input.summary ? { subline: input.summary } : {}),
              },
            },
          });
          doneEmitted = true;
          if (input.status === "blocked") hud.status = "failed";
          else hud.status = "done";
          setActivity(input.status === "blocked" ? "fail" : "done", "done");
          out.push(hudFrame(id));
          out.push({ ack: { toolUseId: ev.id, threadId: ev.session_thread_id, text: "ok" } });
        } else {
          // unknown custom tool — ack as error so the agent doesn't hang.
          out.push({ ack: { toolUseId: ev.id, threadId: ev.session_thread_id, text: `unknown tool: ${name}`, isError: true } });
        }
        break;
      }
      case "user.custom_tool_result": {
        // The steer's answer to a pending ask_user (sent out-of-band) shows up
        // here on the resumed stream — clear the pending flag so status can reset.
        if (ev.custom_tool_use_id) pendingQuestions.delete(ev.custom_tool_use_id);
        break;
      }
      case "session.status_idle": {
        const sr = ev.stop_reason;
        const t = sr && sr.type;
        if (t === "end_turn" || t === "retries_exhausted") {
          out.push(...terminal(id));
        }
        // requires_action = waiting (e.g. on a pending ask_user) — do nothing.
        break;
      }
      case "session.status_terminated": {
        out.push(...terminal(id));
        break;
      }
      default:
        break;
    }
    return out;
  }

  // Terminal: synthesize a done card if none was emitted, mark hud done, emit the
  // final {done:true, hud} frame. Idempotent.
  function terminal(id) {
    if (terminal._done) return [];
    terminal._done = true;
    const out = [];
    if (!doneEmitted) {
      out.push({
        id,
        frame: {
          card: {
            kind: "done",
            headline: "Run complete",
            stats: derivedStats(),
            final: true,
          },
        },
      });
      doneEmitted = true;
    }
    if (hud.status !== "failed") hud.status = "done";
    setActivity("done", "done");
    out.push({ id, frame: { done: true, hud: hudFrame(id).frame.hud } });
    return out;
  }

  function derivedStats() {
    return [
      { label: "tokens", value: fmtTokens(hud.tokens) },
      { label: "cost", value: "$" + round2(hud.costUsd).toFixed(2) },
    ];
  }

  // Advance the wall clock (optional ~1/sec tick); returns a hud frame or null.
  function tick(elapsedSec) {
    if (!started || doneEmitted) return null;
    hud.elapsedSec = elapsedSec;
    return hudFrame("tick");
  }

  return {
    feed,
    tick,
    start,
    get hud() { return hud; },
    get doneEmitted() { return doneEmitted; },
    hasPendingQuestion() { return pendingQuestions.size > 0; },
  };
}

function numOr(v, d) { return typeof v === "number" && isFinite(v) ? v : d; }
function round2(n) { return Math.round((n || 0) * 100) / 100; }
function fmtTokens(n) {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
  return String(n);
}

// ============================================================================
// Managed-agent plumbing (create run, stream, list, ack, steer)
// ============================================================================

/**
 * Create a run: a fresh managed session against the coding agent/env, then send
 * the prompt. `repo` (optional) mounts a github_repository resource. Returns the
 * session id — the SSE endpoint streams it later. Does NOT stream here.
 *
 * repo may be a string url (token from GITHUB_TOKEN env) or
 * { url, token?, checkout? }.
 */
async function createRun({ prompt, repo } = {}) {
  if (!CODING_AGENT_ID || !CODING_ENV_ID) {
    throw new Error("CODING_AGENT_ID/CODING_ENV_ID not configured (run setup-coding-agent.js)");
  }
  if (!prompt || typeof prompt !== "string") throw new Error("createRun requires a prompt");

  const client = anthropicClient();
  const createParams = { agent: CODING_AGENT_ID, environment_id: CODING_ENV_ID };

  const resource = githubResource(repo);
  if (resource) createParams.resources = [resource];

  const session = await client.beta.sessions.create(createParams, MA_OPTS);

  await client.beta.sessions.events.send(session.id, {
    ...MA_OPTS,
    events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }],
  });

  return { id: session.id };
}

// Build a github_repository resource param from a `repo` arg, or null.
function githubResource(repo) {
  if (!repo) return null;
  const url = typeof repo === "string" ? repo : repo.url;
  if (!url) return null;
  const token = (typeof repo === "object" && repo.token) || process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("repo given but no GitHub token (set GITHUB_TOKEN or pass repo.token)");
  }
  const res = { type: "github_repository", url, authorization_token: token };
  const checkout = typeof repo === "object" ? repo.checkout : undefined;
  if (checkout) {
    res.checkout =
      typeof checkout === "string" ? { type: "branch", name: checkout } : checkout;
  }
  return res;
}

/** Open the live event stream for a session (SSE has no replay — open before any send). */
async function openEventStream(sessionId) {
  return anthropicClient().beta.sessions.events.stream(sessionId, MA_OPTS);
}

/**
 * List events after `afterId` (for Last-Event-ID reconnect replay). Returns an
 * array of events in chronological order. afterId omitted -> from the start.
 */
async function listEventsAfter(sessionId, afterId) {
  const params = { ...MA_OPTS, order: "asc", limit: 1000 };
  if (afterId) params.after_id = afterId;
  const page = await anthropicClient().beta.sessions.events.list(sessionId, params);
  const events = [];
  for await (const ev of page) events.push(ev);
  return events;
}

/** Reply a user.custom_tool_result for a custom tool use (the distiller's ack). */
async function ackCustomTool(sessionId, { toolUseId, threadId, text = "ok", isError = false }) {
  await anthropicClient().beta.sessions.events.send(sessionId, {
    ...MA_OPTS,
    events: [
      {
        type: "user.custom_tool_result",
        custom_tool_use_id: toolUseId,
        content: [{ type: "text", text }],
        ...(isError ? { is_error: true } : {}),
        ...(threadId ? { session_thread_id: threadId } : {}),
      },
    ],
  });
}

/**
 * STATELESS steer. List the session's events, find the latest `ask_user`
 * custom_tool_use with no following user.custom_tool_result (the pending
 * question), map the steer to an answer, and send the result. If there is no
 * pending question, send the voiceText (or a nudge) as a fresh user.message.
 *
 * steer = { gesture:"approve"|"reject" } | { voiceText:string }
 */
async function steer(sessionId, input = {}) {
  const client = anthropicClient();

  // Pull events chronologically and find the last unanswered ask_user.
  const events = await listEventsAfter(sessionId);
  const answered = new Set();
  for (const ev of events) {
    if (ev.type === "user.custom_tool_result" && ev.custom_tool_use_id) {
      answered.add(ev.custom_tool_use_id);
    }
  }
  let pending = null;
  for (const ev of events) {
    if (ev.type === "agent.custom_tool_use" && ev.name === "ask_user" && !answered.has(ev.id)) {
      pending = ev; // keep the LATEST
    }
  }

  if (pending) {
    const options = Array.isArray(pending.input && pending.input.options)
      ? pending.input.options
      : [];
    const answerText = mapSteerToAnswer(input, options);
    await ackCustomTool(sessionId, {
      toolUseId: pending.id,
      threadId: pending.session_thread_id,
      text: answerText,
    });
    return { answered: true, toolUseId: pending.id, answer: answerText };
  }

  // No pending question — send a nudge / the voiceText as a new user.message so
  // the held SSE picks up the resumed turn.
  const text = input.voiceText || nudgeFor(input.gesture);
  await client.beta.sessions.events.send(sessionId, {
    ...MA_OPTS,
    events: [{ type: "user.message", content: [{ type: "text", text }] }],
  });
  return { answered: false, message: text };
}

// gesture approve -> option 0, reject -> option 1; voiceText -> matched option
// (case-insensitive substring) or the raw text.
function mapSteerToAnswer(input, options) {
  if (input.voiceText) {
    const vt = input.voiceText.trim();
    const lc = vt.toLowerCase();
    const match = (options || []).find((o) => typeof o === "string" && o.toLowerCase().includes(lc));
    return match || vt;
  }
  if (input.gesture === "approve") return (options && options[0]) || "approve";
  if (input.gesture === "reject") return (options && options[1]) || "reject";
  return "ok";
}

function nudgeFor(gesture) {
  if (gesture === "approve") return "approve";
  if (gesture === "reject") return "reject";
  return "continue";
}

module.exports = {
  makeDistiller,
  createRun,
  openEventStream,
  listEventsAfter,
  ackCustomTool,
  steer,
  // exported for reuse/tests
  basename,
  shortCmd,
  priceFor,
  CODING_AGENT_ID,
  CODING_ENV_ID,
  MA_OPTS,
  anthropicClient,
};
