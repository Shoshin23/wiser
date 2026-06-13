"use strict";
// HARD-STOP VERIFICATION for the streaming orchestrator (real coding agent).
// Proves a Managed Agent with agent_toolset + network-on cloud env can:
//   - run bash, edit files, run a REAL test
//   - emit a parseable event stream (tool uses, model_usage tokens)
//   - call a custom tool mid-run for structured reporting (the distiller seam)
// Logs the FULL event vocabulary + sample shapes so we design the distiller against reality.
// Run: cd firebase/functions && set -a && . ./.env && set +a && node test-coding-agent.js

const A = require("@anthropic-ai/sdk");
const Anthropic = A.default || A;
const BETA = "managed-agents-2026-04-01";
const opts = { betas: [BETA] };

const SYSTEM =
  "You are an autonomous coding agent in a Linux sandbox. Use bash and the file " +
  "tools to do the task. After you have actually run the tests, call the report_result " +
  "custom tool with a short summary and the counts. Then stop.";

const TOOLS = [
  { type: "agent_toolset_20260401" },
  {
    type: "custom",
    name: "report_result",
    description: "Report the final result after running the tests.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        files_changed: { type: "number" },
        tests_passed: { type: "number" },
        tests_total: { type: "number" },
      },
      required: ["summary"],
    },
  },
];

const TASK =
  "In the working directory: (1) create fib.py with an iterative fib(n) returning the " +
  "nth Fibonacci number (fib(0)=0, fib(1)=1). (2) create test_fib.py that asserts " +
  "fib(0)==0, fib(1)==1, fib(10)==55 and prints 'ALL PASS' at the end. (3) run it with " +
  "`python3 test_fib.py`. (4) Then call report_result with a one-line summary, " +
  "files_changed, tests_passed, tests_total.";

const samples = {}; // first occurrence of each event type (shape discovery)
const seen = {};

function note(ev) {
  seen[ev.type] = (seen[ev.type] || 0) + 1;
  if (!(ev.type in samples)) {
    try {
      const s = JSON.parse(JSON.stringify(ev));
      // truncate long text blocks for readability
      const str = JSON.stringify(s);
      samples[ev.type] = str.length > 1200 ? str.slice(0, 1200) + "…" : str;
    } catch (_) {
      samples[ev.type] = "<unserializable>";
    }
  }
}

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const hardTimeout = setTimeout(() => {
    console.error("\n\nTIMEOUT after 240s — printing what we have.");
    dump();
    process.exit(3);
  }, 240000);

  console.log("creating network-ON cloud env...");
  const env = await client.beta.environments.create(
    { name: "wiser-coding-test", config: { type: "cloud", networking: { type: "unrestricted" } } },
    opts
  );
  console.log("ENV_ID =", env.id);

  console.log("creating coding agent (agent_toolset + report_result)...");
  const agent = await client.beta.agents.create(
    { name: "wiser-coding-test", model: "claude-sonnet-4-6", system: SYSTEM, tools: TOOLS },
    opts
  );
  console.log("AGENT_ID =", agent.id);

  const session = await client.beta.sessions.create(
    { agent: agent.id, environment_id: env.id },
    opts
  );
  console.log("SESSION_ID =", session.id);

  console.log("\nstreaming + sending coding task...\n");
  const stream = await client.beta.sessions.events.stream(session.id, opts);
  await client.beta.sessions.events.send(session.id, {
    ...opts,
    events: [{ type: "user.message", content: [{ type: "text", text: TASK }] }],
  });

  let tokensIn = 0, tokensOut = 0, report = null;
  const toolUses = [];
  const t0 = Date.now();

  for await (const ev of stream) {
    note(ev);
    if (ev.type === "agent.message") {
      for (const b of ev.content || []) if (b.type === "text") process.stdout.write(b.text);
    } else if (ev.type === "agent.tool_use") {
      toolUses.push(ev.name || (ev.tool && ev.tool.name) || "?");
    } else if (ev.type === "span.model_request_end") {
      const u = ev.model_usage || ev.usage || {};
      tokensIn += u.input_tokens || 0;
      tokensOut += u.output_tokens || 0;
    } else if (ev.type === "agent.custom_tool_use") {
      console.log("\n[custom_tool_use]", ev.name, JSON.stringify(ev.input));
      if (ev.name === "report_result") report = ev.input;
      await client.beta.sessions.events.send(session.id, {
        ...opts,
        events: [{ type: "user.custom_tool_result", custom_tool_use_id: ev.id, content: [{ type: "text", text: "ok" }] }],
      });
    } else if (ev.type === "session.status_idle") {
      const sr = ev.stop_reason;
      console.log("\n[idle] stop_reason =", JSON.stringify(sr));
      if (sr && sr.type !== "requires_action") break;
    } else if (ev.type === "session.status_terminated") {
      console.log("\n[terminated]");
      break;
    } else if (ev.type === "session.error") {
      console.log("\n[session.error]", JSON.stringify(ev));
    }
  }

  clearTimeout(hardTimeout);
  const ms = Date.now() - t0;

  function dump() {
    console.log("\n\n=== EVENT TYPES SEEN ===");
    console.log(JSON.stringify(seen, null, 2));
    console.log("\n=== SAMPLE SHAPES (first of each) ===");
    for (const k of Object.keys(samples)) console.log("•", k, "→", samples[k]);
    console.log("\n=== DISTILLER SIGNALS ===");
    console.log("agent.tool_use names:", JSON.stringify(toolUses));
    console.log("tokens in/out:", tokensIn, "/", tokensOut);
    console.log("report_result input:", JSON.stringify(report));
    console.log("latency ms:", ms);
  }
  dump();

  const ranBash = !!seen["agent.tool_use"];
  const gotUsage = tokensOut > 0;
  const gotReport = !!report;
  console.log("\n=== VERDICT ===");
  console.log("bash/tool events visible in stream :", ranBash);
  console.log("token usage from model_request_end :", gotUsage);
  console.log("custom-tool report mid-run         :", gotReport);
  if (gotReport && gotUsage) console.log("\nPASS: real coding + parseable stream + structured report.");
  else console.log("\nPARTIAL — inspect event vocabulary above to design the distiller.");
  console.log("\nCLEANUP later: env", env.id, "agent", agent.id);
}

main().catch((e) => {
  console.error("\nERROR:", e?.status || "", e?.message || e);
  if (e?.error) console.error(JSON.stringify(e.error, null, 2));
  process.exit(1);
});
