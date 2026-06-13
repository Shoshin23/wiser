import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import {
  type Benchmark,
  type EvalInstance,
  runPython,
  tail,
} from "../bench.js";

interface HERecord {
  task_id: string;
  prompt: string;
  entry_point: string;
  canonical_solution: string;
  test: string;
}

const JSONL = path.join(DATA_DIR, "humaneval", "HumanEval.jsonl");
let cache: Map<string, HERecord> | null = null;
function db(): Map<string, HERecord> {
  if (cache) return cache;
  cache = new Map();
  for (const line of fs.readFileSync(JSONL, "utf8").trim().split("\n")) {
    const r = JSON.parse(line) as HERecord;
    cache.set(r.task_id, r);
  }
  return cache;
}

// A spread of 12 problems (mix of trivial and the harder later ones).
const PILOT = [0, 10, 32, 38, 50, 75, 91, 113, 127, 129, 140, 163].map(
  (n) => `HumanEval/${n}`,
);

export const humaneval: Benchmark = {
  name: "humaneval",
  defaultIds: () => PILOT,
  load(id: string): EvalInstance {
    const r = db().get(id);
    if (!r) throw new Error(`humaneval: unknown ${id}`);
    return {
      id,
      reference: r.prompt + r.canonical_solution,
      solutionFile: "solution.py",
      solverPrompt: `Implement the following Python function completely in a file named \`solution.py\`.

- Keep the exact signature and name \`${r.entry_point}\` — a hidden test imports it.
- Include any imports the function needs. Write only \`solution.py\`, no extra files.
- There is a hidden test suite; write a complete, correct implementation from the spec/docstring.

\`\`\`python
${r.prompt}\`\`\``,
      setup(wd) {
        // Seed with just the signature+docstring (the prompt), unimplemented.
        fs.writeFileSync(path.join(wd, "solution.py"), r.prompt);
      },
      grade(wd) {
        // import * so the test can reach helper functions the prompt defines
        // (some problems' check() calls a sibling fn, not just the entry point).
        const harness = `from solution import *\n${r.test}\ncheck(${r.entry_point})\nprint("OK")\n`;
        fs.writeFileSync(path.join(wd, "_grade.py"), harness);
        try {
          const { code, output } = runPython(wd, "_grade.py", { timeoutMs: 30_000 });
          return { passed: code === 0, output: tail(output) };
        } finally {
          fs.rmSync(path.join(wd, "_grade.py"), { force: true });
        }
      },
    };
  },
};
