"use strict";
// Update the CODING agent's system/tools IN PLACE (keeps CODING_AGENT_ID, no .env
// edit, no redeploy — the system lives on the agent and applies to the next session).
//   agents.retrieve(CODING_AGENT_ID) -> version
//   agents.update(CODING_AGENT_ID, { version, system: CODING_SYSTEM, tools: CODING_TOOLS })
// Run: `cd firebase/functions && set -a && . ./.env && set +a && node update-coding-agent.js`

const A = require("@anthropic-ai/sdk");
const Anthropic = A.default || A;

const { CODING_SYSTEM, CODING_TOOLS } = require("./coding-agent-config");

const BETA = "managed-agents-2026-04-01";
const opts = { betas: [BETA] };
const CODING_AGENT_ID = process.env.CODING_AGENT_ID;

async function main() {
  if (!CODING_AGENT_ID) throw new Error("CODING_AGENT_ID not set (load .env)");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  console.log("retrieving coding agent", CODING_AGENT_ID, "...");
  let cur = await client.beta.agents.retrieve(CODING_AGENT_ID, opts);
  console.log("current version =", cur.version);

  const apply = (version) =>
    client.beta.agents.update(CODING_AGENT_ID, { ...opts, version, system: CODING_SYSTEM, tools: CODING_TOOLS });

  console.log("\nupdating agent (open-ended system + tools) ...");
  try {
    await apply(cur.version);
  } catch (err) {
    if (err && err.status === 409) {
      console.warn("version conflict, retrieving + retrying once...");
      cur = await client.beta.agents.retrieve(CODING_AGENT_ID, opts);
      await apply(cur.version);
    } else {
      throw err;
    }
  }

  const after = await client.beta.agents.retrieve(CODING_AGENT_ID, opts);
  console.log("\nCODING_AGENT_ID =", after.id, "(UNCHANGED)");
  console.log("new version     =", after.version);
  console.log("tools           =", JSON.stringify((after.tools || []).map((t) => t.name || t.type)));
  console.log("system          =", JSON.stringify(after.system));
  console.log("\nPASS: coding agent updated in place; CODING_AGENT_ID unchanged.");
}

main().catch((e) => {
  console.error("\nERROR:", e?.status || "", e?.message || e);
  if (e?.error) console.error(JSON.stringify(e.error, null, 2));
  process.exit(1);
});
