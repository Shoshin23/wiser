import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  SOLVER_MAX_TURNS,
  SOLVER_MODEL,
  SOLVER_TOOLS,
} from "./config.js";
import { isNemotron, nemotronSolve } from "./nemotron_solver.js";

export interface SolveResult {
  sessionId: string | null;
  costUsd: number;
  inTok: number;
  outTok: number;
  numTurns: number;
  subtype: string;
}

/**
 * One Claude Code session turn over `cwd`.
 *  - First attempt: pass `prompt` only.
 *  - Injection: pass the steer/feedback as `prompt` + `resume` = the prior
 *    session id. This continues the SAME conversation with exactly ONE more
 *    user message — the human-in-the-loop seam.
 */
export async function solve(
  prompt: string,
  cwd: string,
  opts: { resume?: string; fork?: boolean; solutionFile?: string } = {},
): Promise<SolveResult> {
  // Nemotron (or any nvidia/* model) is a chat model, not the Claude agent.
  if (isNemotron(SOLVER_MODEL)) {
    if (!opts.solutionFile) throw new Error("nemotron solver requires opts.solutionFile");
    return nemotronSolve(prompt, cwd, opts.solutionFile, SOLVER_MODEL, !!opts.resume);
  }

  const out: SolveResult = {
    sessionId: null,
    costUsd: 0,
    inTok: 0,
    outTok: 0,
    numTurns: 0,
    subtype: "no_result",
  };

  const options: Record<string, unknown> = {
    cwd,
    model: SOLVER_MODEL,
    allowedTools: SOLVER_TOOLS,
    maxTurns: SOLVER_MAX_TURNS,
    permissionMode: "bypassPermissions",
    // hermetic: do not load the project's CLAUDE.md / skills / settings
    settingSources: [],
  };
  if (opts.resume) options.resume = opts.resume;
  if (opts.fork) options.forkSession = true;

  try {
    for await (const m of query({ prompt, options: options as any })) {
      const msg = m as any;
      if (msg.type === "system" && msg.subtype === "init") {
        out.sessionId = msg.session_id ?? out.sessionId;
      } else if (msg.type === "result") {
        out.subtype = msg.subtype ?? "unknown";
        out.costUsd = Number(msg.total_cost_usd ?? 0);
        out.numTurns = Number(msg.num_turns ?? 0);
        out.inTok = Number(msg.usage?.input_tokens ?? 0);
        out.outTok = Number(msg.usage?.output_tokens ?? 0);
        out.sessionId = msg.session_id ?? out.sessionId;
      }
    }
  } catch (e) {
    // The SDK throws on e.g. max-turns instead of yielding a result. Treat as a
    // finished-but-unsolved attempt; the grader is the source of truth, and the
    // session id (captured from init) is still valid for resume.
    out.subtype = `error:${(e as Error).message.slice(0, 60)}`;
  }
  return out;
}

const SOLVE_PROMPT = (instructions: string, file: string) =>
  `You are solving a coding exercise. Implement your solution in the file \`${file}\`.

Requirements:
- Make the existing public API in the stub work as described — do not rename the module, class, or function names the tests will import.
- There is a hidden test suite; you cannot see it. Write a complete, correct implementation from the spec.
- Edit only \`${file}\`. Do not create extra files.

Exercise:
${instructions}`;

export { SOLVE_PROMPT };
export { SOLVER_MODEL };
