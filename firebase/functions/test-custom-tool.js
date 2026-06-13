"use strict";
// STEP 0 — Hard-stop verification gate for the custom-tool round-trip.
// Proves the documented mechanism BEFORE touching index.js:
//   create env -> create TEST agent declaring ONE trivial `echo_back` custom tool
//   -> create session -> events.stream (OPEN BEFORE SEND) -> events.send(user.message)
//   -> on agent.custom_tool_use: assert name, capture event.id, send
//      user.custom_tool_result on the SAME stream, keep iterating
//   -> PASS iff we saw agent.custom_tool_use AND the session continued (further
//      agent.message OR terminal end_turn) after the result.
// Run: `cd firebase/functions && set -a && . ./.env && set +a && node test-custom-tool.js`

const A = require("@anthropic-ai/sdk");
const Anthropic = A.default || A;

const BETA = "managed-agents-2026-04-01";
const opts = { betas: [BETA] };

const ECHO_TOOL = {
  type: "custom",
  name: "echo_back",
  description: "Echo the user's text back. Always call this once with the user's text.",
  input_schema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
};

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  console.log("creating throwaway env...");
  const env = await client.beta.environments.create(
    { name: "wiser-custom-tool-test", config: { type: "cloud" } },
    opts
  );
  console.log("ENV_ID =", env.id);

  console.log("creating TEST agent with echo_back tool...");
  const agent = await client.beta.agents.create(
    {
      name: "wiser-custom-tool-test",
      model: "claude-sonnet-4-6",
      system: "always call echo_back once with the user's text",
      tools: [ECHO_TOOL],
    },
    opts
  );
  console.log("AGENT_ID =", agent.id);

  console.log("creating session...");
  const session = await client.beta.sessions.create(
    { agent: agent.id, environment_id: env.id },
    opts
  );
  console.log("SESSION_ID =", session.id);

  // STREAM before SEND.
  const stream = await client.beta.sessions.events.stream(session.id, opts);

  await client.beta.sessions.events.send(session.id, {
    ...opts,
    events: [
      {
        type: "user.message",
        content: [{ type: "text", text: "Please echo this: banana hammock 42" }],
      },
    ],
  });

  let sawCustomToolUse = false;
  let toolName = null;
  let toolInput = null;
  let continuedAfterResult = false;
  let repliedAt = false; // becomes true once we've sent the tool result
  let postResultText = "";
  let terminalStop = null;

  for await (const event of stream) {
    console.log("  [event]", event.type);

    if (event.type === "agent.message") {
      const text = (event.content || [])
        .filter((b) => b && b.type === "text")
        .map((b) => b.text)
        .join("");
      if (repliedAt && text.trim()) {
        continuedAfterResult = true;
        postResultText += text;
      }
    } else if (event.type === "agent.custom_tool_use") {
      sawCustomToolUse = true;
      toolName = event.name;
      toolInput = event.input;
      console.log("    -> custom_tool_use name =", event.name, "id =", event.id);
      console.log("    -> input =", JSON.stringify(event.input));

      // Reply on the SAME stream.
      await client.beta.sessions.events.send(session.id, {
        ...opts,
        events: [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: event.id,
            content: [{ type: "text", text: "echoed: " + (event.input && event.input.text) }],
            ...(event.session_thread_id ? { session_thread_id: event.session_thread_id } : {}),
          },
        ],
      });
      repliedAt = true;
      console.log("    -> sent user.custom_tool_result");
    } else if (event.type === "session.status_idle") {
      const sr = event.stop_reason;
      console.log("    [idle] stop_reason =", JSON.stringify(sr));
      if (sr && sr.type !== "requires_action") {
        // Terminal idle. If this happened AFTER we replied, the session continued
        // to completion past the tool result.
        terminalStop = sr.type;
        if (repliedAt) continuedAfterResult = true;
        break;
      }
    } else if (event.type === "session.status_terminated") {
      console.log("    [terminated]");
      if (repliedAt) continuedAfterResult = true;
      break;
    }
  }

  console.log("\n=== RESULT ===");
  console.log("sawCustomToolUse     =", sawCustomToolUse, toolName ? `(name=${toolName})` : "");
  console.log("toolInput            =", JSON.stringify(toolInput));
  console.log("continuedAfterResult =", continuedAfterResult);
  console.log("terminalStop         =", terminalStop);
  console.log("postResultText       =", JSON.stringify(postResultText.trim()));

  const PASS =
    sawCustomToolUse && toolName === "echo_back" && continuedAfterResult;

  if (PASS) {
    console.log("\nPASS: custom-tool round-trip works (saw agent.custom_tool_use; session resumed after the result).");
    process.exit(0);
  } else {
    console.error("\nFAIL: custom-tool round-trip did NOT behave as documented.");
    process.exit(2);
  }
}

main().catch((e) => {
  console.error("\nERROR:", e?.status || "", e?.message || e);
  if (e?.error) console.error(JSON.stringify(e.error, null, 2));
  process.exit(1);
});
