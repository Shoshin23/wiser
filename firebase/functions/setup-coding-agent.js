"use strict";
// One-time setup for the STREAMING ORCHESTRATOR's coding fleet.
// Creates (1) a network-ON cloud environment and (2) a real coding agent
// (agent_toolset + the distiller's custom reporting tools). The deployed `wiser`
// function reuses both via CODING_ENV_ID / CODING_AGENT_ID env vars.
//
//   cd firebase/functions && set -a && . ./.env && set +a && node setup-coding-agent.js
//
// ADDITIVE: this provisions a NEW agent/env distinct from the Q&A agent
// (AGENT_ID/ENV_ID). It does NOT touch the live Q&A agent or the deployed
// function. Agents/environments are PERMANENT until archived — re-running creates
// new ones, so only run when you intend to (re)provision.

const A = require("@anthropic-ai/sdk");
const Anthropic = A.default || A;

const { CODING_SYSTEM, CODING_TOOLS } = require("./coding-agent-config");

const BETA = "managed-agents-2026-04-01";

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const opts = { betas: [BETA] };

  // Network-ON cloud env: the coding agent runs real bash/file tools and may need
  // network (pip installs, fetching deps, cloning repos). python3 is preinstalled.
  console.log("creating network-ON cloud env...");
  const env = await client.beta.environments.create(
    {
      name: "wiser-coding-cloud",
      config: { type: "cloud", networking: { type: "unrestricted" } },
    },
    opts
  );

  // Coding agent ONCE — model/system/tools live HERE. agent_toolset_20260401 gives
  // real bash/write/edit/read; the custom tools are the distiller seam (host-run).
  console.log("creating coding agent (agent_toolset + reporting tools)...");
  const agent = await client.beta.agents.create(
    {
      name: "wiser-coding",
      model: "claude-sonnet-4-6",
      system: CODING_SYSTEM,
      tools: CODING_TOOLS,
    },
    opts
  );

  console.log("CODING_ENV_ID=" + env.id);
  console.log("CODING_AGENT_ID=" + agent.id);
}

main().catch((e) => {
  console.error("ERROR:", e?.status || "", e?.message || e);
  if (e?.error) console.error(JSON.stringify(e.error, null, 2));
  process.exit(1);
});
