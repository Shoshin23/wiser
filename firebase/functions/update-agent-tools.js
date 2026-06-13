"use strict";
// STEP 1 — Declare the two custom tools (ask_user + handoff_to_glasses) on the
// EXISTING agent, in place. Updating the live agent keeps the SAME AGENT_ID, so
// NO .env edit and NO redeploy are needed just for this tool/system change.
//   agents.retrieve(AGENT_ID) -> version
//   agents.update(AGENT_ID, { version, system: SYSTEM, tools: TOOLS })
//   agents.retrieve again -> verify both tools + new system are present.
// Run: `cd firebase/functions && set -a && . ./.env && set +a && node update-agent-tools.js`

const A = require("@anthropic-ai/sdk");
const Anthropic = A.default || A;

const { SYSTEM, TOOLS } = require("./agent-config");

const BETA = "managed-agents-2026-04-01";
const opts = { betas: [BETA] };
const AGENT_ID = process.env.AGENT_ID;

async function main() {
  if (!AGENT_ID) throw new Error("AGENT_ID not set (load .env)");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  console.log("retrieving agent", AGENT_ID, "...");
  let cur = await client.beta.agents.retrieve(AGENT_ID, opts);
  console.log("current version =", cur.version, "| current tools =", (cur.tools || []).map((t) => t.name || t.type));

  console.log("\nupdating agent (system + tools) ...");
  try {
    await client.beta.agents.update(AGENT_ID, {
      ...opts,
      version: cur.version,
      system: SYSTEM,
      tools: TOOLS,
    });
  } catch (err) {
    // Version mismatch (concurrent overwrite) -> retrieve again + retry once.
    if (err && err.status === 409) {
      console.warn("version conflict, retrieving + retrying once...");
      cur = await client.beta.agents.retrieve(AGENT_ID, opts);
      await client.beta.agents.update(AGENT_ID, {
        ...opts,
        version: cur.version,
        system: SYSTEM,
        tools: TOOLS,
      });
    } else {
      throw err;
    }
  }

  console.log("\nverifying ...");
  const after = await client.beta.agents.retrieve(AGENT_ID, opts);
  const toolNames = (after.tools || []).map((t) => t.name || t.type);
  console.log("AGENT_ID          =", after.id, "(UNCHANGED)");
  console.log("new version       =", after.version);
  console.log("model             =", after.model);
  console.log("tools             =", JSON.stringify(toolNames));
  console.log("system            =", JSON.stringify(after.system));

  const hasAskUser = toolNames.includes("ask_user");
  const hasHandoff = toolNames.includes("handoff_to_glasses");
  if (!hasAskUser || !hasHandoff) {
    console.error("\nFAIL: expected both ask_user + handoff_to_glasses on the agent.");
    process.exit(2);
  }
  console.log("\nPASS: agent now has both custom tools; AGENT_ID unchanged.");
}

main().catch((e) => {
  console.error("\nERROR:", e?.status || "", e?.message || e);
  if (e?.error) console.error(JSON.stringify(e.error, null, 2));
  process.exit(1);
});
