"use strict";
// One-time setup: create the cloud environment + answer agent that the deployed
// `wiser` function reuses via AGENT_ID / ENV_ID env vars. Run ONCE, capture IDs.
//   set -a && . ./.env && set +a && node setup-managed-agent.js
// Idempotency note: agents/environments are PERMANENT until archived. Re-running
// creates new ones — only run when you intend to (re)provision.

const A = require("@anthropic-ai/sdk");
const Anthropic = A.default || A;

const BETA = "managed-agents-2026-04-01";
const SYSTEM =
  "You are wiser, a concise voice assistant heard through smart glasses. " +
  "Answer in 1-3 short spoken sentences. Plain text only — no markdown, lists, or emoji.";

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const opts = { betas: [BETA] };

  // Cloud env. Network OFF by default — fine: this Q&A agent has no tools/network.
  const env = await client.beta.environments.create(
    { name: "wiser-prod-cloud", config: { type: "cloud" } },
    opts
  );

  // Agent ONCE — model/system/tools live HERE. No tools (no container network needed).
  const agent = await client.beta.agents.create(
    { name: "wiser-answer", model: "claude-sonnet-4-6", system: SYSTEM, tools: [] },
    opts
  );

  console.log("ENV_ID=" + env.id);
  console.log("AGENT_ID=" + agent.id);
}

main().catch((e) => {
  console.error("ERROR:", e?.status || "", e?.message || e);
  process.exit(1);
});
