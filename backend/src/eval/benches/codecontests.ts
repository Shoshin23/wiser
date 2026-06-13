import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import {
  type Benchmark,
  type EvalInstance,
  runPython,
  tail,
} from "../bench.js";

interface CCRecord {
  id: string;
  description: string;
  reference: string;
  tests: { input: string; output: string }[];
}

const JSONL = path.join(DATA_DIR, "codecontests", "pilot.jsonl");
let cache: CCRecord[] | null = null;
function db(): CCRecord[] {
  if (cache) return cache;
  if (!fs.existsSync(JSONL)) {
    throw new Error(
      `codecontests data missing. Run:\n  uv run --no-project --with datasets python src/eval/benches/prep_codecontests.py`,
    );
  }
  cache = fs.readFileSync(JSONL, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return cache;
}

const norm = (s: string) =>
  s.replace(/\r\n/g, "\n").trimEnd().split("\n").map((l) => l.trimEnd()).join("\n");

export const codecontests: Benchmark = {
  name: "codecontests",
  defaultIds: () => db().map((r) => r.id),
  load(id: string): EvalInstance {
    const r = db().find((x) => x.id === id);
    if (!r) throw new Error(`codecontests: unknown ${id}`);
    return {
      id,
      reference: r.reference,
      solutionFile: "solution.py",
      solverPrompt: `Solve this competitive programming problem in a file named \`solution.py\`.

- Read input from STDIN and write the answer to STDOUT, exactly as the problem specifies.
- Hidden test cases will pipe input on stdin and check stdout. Write only \`solution.py\`.

PROBLEM:
${r.description}`,
      setup(wd) {
        fs.writeFileSync(path.join(wd, "solution.py"), "# write your solution here\n");
      },
      grade(wd) {
        let passed = 0;
        let firstFail = "";
        for (let i = 0; i < r.tests.length; i++) {
          const t = r.tests[i];
          const { code, stdout, stderr } = runPython(wd, "solution.py", {
            stdin: t.input,
            timeoutMs: 10_000,
          });
          if (code === 0 && norm(stdout) === norm(t.output)) {
            passed++;
          } else if (!firstFail) {
            const got = code === 0 ? stdout : `(exit ${code})\n${stderr}`;
            firstFail = `test ${i + 1}/${r.tests.length} FAILED\n--- input ---\n${tail(t.input, 600)}\n--- expected ---\n${tail(t.output, 600)}\n--- got ---\n${tail(got, 600)}`;
          }
        }
        const ok = passed === r.tests.length;
        return {
          passed: ok,
          output: ok
            ? `all ${r.tests.length} tests passed`
            : `${passed}/${r.tests.length} passed\n${firstFail}`,
        };
      },
    };
  },
};
