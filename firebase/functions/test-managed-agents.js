"use strict";
// Standalone managed-agents smoke test (NOT the deployed function).
// Verifies the full hosted-agent flow per .claude/skills/managed-agents/SKILL.md:
//   environment.create (cloud) -> agent.create -> session.create
//   -> events.stream (OPEN BEFORE SEND) -> events.send(user.message)
//   -> collect agent.message text -> break only on TERMINAL idle / terminated.
// Run: `set -a && . ./.env && set +a && node test-managed-agents.js`

const A = require("@anthropic-ai/sdk");
const Anthropic = A.default || A;

const BETA = "managed-agents-2026-04-01";
const SYSTEM =
  "You are wiser, a concise voice assistant heard through smart glasses. " +
  "Answer in 1-3 short spoken sentences. Plain text only — no markdown, lists, or emoji.";

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  console.log("namespace check ->",
    "agents", !!client.beta?.agents,
    "sessions", !!client.beta?.sessions,
    "environments", !!client.beta?.environments);

  const opts = { betas: [BETA] };

  // 1) cloud environment (network OFF by default — fine, no tools/network needed)
  console.log("\ncreating environment...");
  const env = await client.beta.environments.create(
    { name: "wiser-cloud-test", config: { type: "cloud" } },
    opts
  );
  console.log("ENV_ID =", env.id);

  // 2) agent ONCE — model/system/tools live HERE. No tools (pure Q&A, no container network).
  console.log("\ncreating agent...");
  const agent = await client.beta.agents.create(
    { name: "wiser-answer-test", model: "claude-sonnet-4-6", system: SYSTEM, tools: [] },
    opts
  );
  console.log("AGENT_ID =", agent.id);

  // 3) session per run
  console.log("\ncreating session...");
  const session = await client.beta.sessions.create(
    { agent: agent.id, environment_id: env.id },
    opts
  );
  console.log("SESSION_ID =", session.id);

  // 4) stream BEFORE send. NB: SDK signature is stream(sessionID, params, options)
  //    — sessionID is positional; the beta header is auto-applied by the SDK.
  console.log("\nopening stream + sending user.message...");
  const t0 = Date.now();
  let answer = "";
  // stream() returns an APIPromise that resolves to an async-iterable Stream.
  const stream = await client.beta.sessions.events.stream(session.id, opts);

  await client.beta.sessions.events.send(session.id, {
    ...opts,
    events: [
      {
        type: "user.message",
        content: [{ type: "text", text: "In one sentence, what is the Eiffel Tower?" }],
      },
    ],
  });

  for await (const event of stream) {
    console.log("  [event]", event.type);
    if (event.type === "agent.message") {
      for (const b of event.content || []) {
        if (b.type === "text") answer += b.text;
      }
    } else if (event.type === "session.status_idle") {
      const sr = event.stop_reason;
      console.log("  [idle] stop_reason =", JSON.stringify(sr));
      // idle != done: break only on a TERMINAL stop_reason (not requires_action)
      if (sr && sr.type !== "requires_action") break;
    } else if (event.type === "session.status_terminated") {
      console.log("  [terminated]");
      break;
    }
  }

  const ms = Date.now() - t0;
  console.log("\n=== ANSWER ===");
  console.log(answer.trim());
  console.log(`\nlatency (send->terminal): ${ms} ms`);

  if (!answer.trim()) {
    console.error("\nFAIL: no answer text collected");
    process.exit(2);
  }
  console.log("\nPASS: managed-agents returned real text.");
  console.log("KEEP -> AGENT_ID=" + agent.id + " ENV_ID=" + env.id);
}

main().catch((e) => {
  console.error("\nERROR:", e?.status || "", e?.message || e);
  if (e?.error) console.error(JSON.stringify(e.error, null, 2));
  process.exit(1);
});
