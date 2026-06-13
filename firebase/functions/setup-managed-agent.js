"use strict";
// One-time setup: create the cloud environment + answer agent that the deployed
// `wiser` function reuses via AGENT_ID / ENV_ID env vars. Run ONCE, capture IDs.
//   set -a && . ./.env && set +a && node setup-managed-agent.js
// Idempotency note: agents/environments are PERMANENT until archived. Re-running
// creates new ones — only run when you intend to (re)provision.

const A = require("@anthropic-ai/sdk");
const Anthropic = A.default || A;

const { SYSTEM, TOOLS } = require("./agent-config");

const BETA = "managed-agents-2026-04-01";

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const opts = { betas: [BETA] };

  // Cloud env. Network OFF by default — fine: the ask_user/handoff custom tools
  // run host-side, not in the container, so no container network is needed.
  const env = await client.beta.environments.create(
    { name: "wiser-prod-cloud", config: { type: "cloud" } },
    opts
  );

  // Agent ONCE — model/system/tools live HERE. Custom tools (ask_user +
  // handoff_to_glasses) are host-executed, so the container needs no network.
  const agent = await client.beta.agents.create(
    { name: "wiser-answer", model: "claude-sonnet-4-6", system: SYSTEM, tools: TOOLS },
    opts
  );

  console.log("ENV_ID=" + env.id);
  console.log("AGENT_ID=" + agent.id);
}

main().catch((e) => {
  console.error("ERROR:", e?.status || "", e?.message || e);
  process.exit(1);
});
