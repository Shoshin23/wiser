import { query } from "@anthropic-ai/claude-agent-sdk";
import { ORACLE_MODEL } from "./config.js";

/**
 * The crafted human-in-the-loop steer. The oracle is privileged: it sees the
 * reference solution AND the agent's failing attempt + test output. It writes a
 * detailed, prescriptive code-review note — the kind a senior engineer who knows
 * the answer would leave to unblock a teammate in ONE pass.
 *
 * This is intentionally high-context (the experiment is "does a great steer beat
 * raw test feedback"): it states the root cause, the correct approach concretely,
 * the exact edge cases/invariants being missed, and may include short snippets or
 * the key formula for the single trickiest part. It does NOT paste the whole
 * solution — the teammate still writes the implementation.
 */
const ORACLE_SYSTEM = `You are a senior engineer pair-reviewing a teammate's FAILING attempt at a coding task. You can see the reference solution; they cannot. Write the single most useful steering note that will let them fix it in one more pass.

Make it concrete and high-context:
- State the ROOT CAUSE of the failure (the real reason, not just "tests fail").
- Lay out the CORRECT APPROACH step by step: the algorithm, data structure, control flow, or formula they should use. Name specific functions/methods/lines in their code.
- Call out the SPECIFIC edge cases, invariants, ordering, or off-by-one details their attempt is mishandling.
- For the single trickiest sub-step, a short snippet or the exact formula/expression is allowed if it's the clearest way to convey it.

Hard rule: do NOT hand over a complete copy-paste solution. Convey the approach and the tricky bits; leave the bulk of the implementation for them to write. Output only the steering note, no preamble.`;

export async function craftSteer(args: {
  instructions: string;
  attempt: string;
  testOutput: string;
  reference: string;
}): Promise<string> {
  const prompt = `TASK / SPEC:
${args.instructions}

REFERENCE SOLUTION (for your eyes only — do not paste it wholesale):
${args.reference}

TEAMMATE'S FAILING ATTEMPT:
${args.attempt}

TEST FAILURE OUTPUT (they can already see this):
${args.testOutput}

Write the steering note now. Focus on what the test output alone does NOT tell them: the root cause and the correct approach.`;

  let text = "";
  for await (const m of query({
    prompt,
    options: {
      model: ORACLE_MODEL,
      systemPrompt: ORACLE_SYSTEM,
      maxTurns: 1,
      allowedTools: [],
      settingSources: [],
    } as any,
  })) {
    const msg = m as any;
    if (msg.type === "result" && msg.subtype === "success") {
      text = String(msg.result ?? "").trim();
    }
  }
  return text;
}
