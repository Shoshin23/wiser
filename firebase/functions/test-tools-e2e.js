"use strict";
// STEP 3 — Local end-to-end proof of the multi-turn resume + BOTH custom tools,
// talking DIRECTLY to Anthropic against the now-updated production AGENT_ID.
// No HTTP server, no deploy. Mirrors index.js's runTurnRaw loop exactly.
//
//   1) create a session against AGENT_ID/ENV_ID
//   2) send a prompt engineered to force a clarification -> expect kind:"question"
//   3) send a user.custom_tool_result answering it -> expect kind:"handoff"
//   4) print the question text and the handoff envelope JSON
//
// Run: `cd firebase/functions && set -a && . ./.env && set +a && node test-tools-e2e.js`

const A = require("@anthropic-ai/sdk");
const Anthropic = A.default || A;

const BETA = "managed-agents-2026-04-01";
const MA_OPTS = { betas: [BETA] };
const AGENT_ID = process.env.AGENT_ID;
const ENV_ID = process.env.ENV_ID;

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

// Faithful copy of index.js runTurnRaw (kept in sync by hand for this throwaway).
async function runTurnRaw(client, sessionId, sendEvents) {
  const stream = await client.beta.sessions.events.stream(sessionId, MA_OPTS);
  await client.beta.sessions.events.send(sessionId, { ...MA_OPTS, events: sendEvents });

  let answer = "";
  let handoff = null;

  for await (const event of stream) {
    if (event.type === "agent.message") {
      for (const b of event.content || []) if (b.type === "text") answer += b.text;
    } else if (event.type === "agent.custom_tool_use") {
      if (event.name === "ask_user") {
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
      } else {
        await client.beta.sessions.events.send(sessionId, {
          ...MA_OPTS,
          events: [
            {
              type: "user.custom_tool_result",
              custom_tool_use_id: event.id,
              content: [{ type: "text", text: `unknown tool: ${event.name}` }],
              is_error: true,
            },
          ],
        });
      }
    } else if (event.type === "session.status_idle") {
      const sr = event.stop_reason;
      if (sr && sr.type !== "requires_action") break;
    } else if (event.type === "session.status_terminated") {
      if (handoff) return { kind: "handoff", handoff, answer: answer.trim() };
      if (answer.trim()) return { kind: "answer", answer: answer.trim() };
      return { kind: "terminated" };
    }
  }
  if (handoff) return { kind: "handoff", handoff, answer: answer.trim() };
  return { kind: "answer", answer: answer.trim() };
}

async function main() {
  if (!AGENT_ID || !ENV_ID) throw new Error("AGENT_ID/ENV_ID not set (load .env)");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  console.log("creating session against", AGENT_ID, "...");
  const session = await client.beta.sessions.create(
    { agent: AGENT_ID, environment_id: ENV_ID },
    MA_OPTS
  );
  console.log("SESSION_ID =", session.id);

  // Turn 1 — force a clarification.
  const prompt =
    "Rename a function in my repo, but ask me which new name to use first before doing anything.";
  console.log("\n--- TURN 1 (expect kind:question) ---");
  console.log("prompt:", prompt);
  let res = await runTurnRaw(client, session.id, [
    { type: "user.message", content: [{ type: "text", text: prompt }] },
  ]);
  console.log("kind:", res.kind);

  if (res.kind !== "question") {
    console.error("\nFAIL: expected kind:question on turn 1, got:", JSON.stringify(res, null, 2));
    process.exit(2);
  }
  console.log("FIRST QUESTION:", JSON.stringify(res.question));
  console.log("OPTIONS       :", JSON.stringify(res.options));
  console.log("toolUseId     :", res.toolUseId, "| sessionThreadId:", res.sessionThreadId);

  const firstQuestion = res.question;

  // Resume rounds: answer each ask_user until we reach a handoff. The agent has no
  // real repo (network-off env, no github_repository resource), so it may clarify a
  // couple of times — which is exactly the N-round chaining we want to prove. Give
  // it a self-contained answer that lets it conclude.
  const answer =
    "Rename the function `calc` to `computeTotals`. That's the only function; just give me the " +
    "final summary now, you don't need any more details.";
  let rounds = 0;
  while (res.kind === "question" && rounds < 5) {
    rounds += 1;
    console.log(`\n--- RESUME ${rounds} (answering: "${answer.slice(0, 48)}...") ---`);
    res = await runTurnRaw(client, session.id, [
      {
        type: "user.custom_tool_result",
        custom_tool_use_id: res.toolUseId,
        content: [{ type: "text", text: answer }],
        ...(res.sessionThreadId ? { session_thread_id: res.sessionThreadId } : {}),
      },
    ]);
    console.log("kind:", res.kind, res.kind === "question" ? `(re-asked: ${JSON.stringify(res.question)})` : "");
  }

  if (res.kind !== "handoff") {
    console.error("\nFAIL: expected kind:handoff after resume rounds, got:", JSON.stringify(res, null, 2));
    process.exit(2);
  }
  console.log("\n=== FIRST QUESTION (turn 1) ===");
  console.log(firstQuestion);
  console.log("\n=== HANDOFF ENVELOPE ===");
  console.log(JSON.stringify(res.handoff, null, 2));

  // Validate the envelope shape.
  const h = res.handoff;
  const ok =
    typeof h.headline === "string" &&
    typeof h.summary === "string" &&
    ["done", "needs_input", "blocked"].includes(h.status);
  if (!ok) {
    console.error("\nFAIL: handoff envelope malformed.");
    process.exit(2);
  }
  console.log("\nPASS: multi-turn resume worked — question -> answer -> well-formed handoff.");
}

main().catch((e) => {
  console.error("\nERROR:", e?.status || "", e?.message || e);
  if (e?.error) console.error(JSON.stringify(e.error, null, 2));
  process.exit(1);
});
