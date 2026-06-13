import fs from "node:fs";
import path from "node:path";
import { PY_PRACTICE, PILOT_SLUGS } from "../config.js";
import { type Benchmark, type EvalInstance, runPytest } from "../bench.js";

// Aider polyglot — Python exercism exercises. Crisp, named test-failure output.
export const polyglot: Benchmark = {
  name: "polyglot",
  defaultIds: () => PILOT_SLUGS,
  load(slug: string): EvalInstance {
    const dir = path.join(PY_PRACTICE, slug);
    const files = fs.readdirSync(dir);
    const testFile = files.find((f) => f.endsWith("_test.py"))!;
    const solutionFile = testFile.replace(/_test\.py$/, ".py");
    const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");
    const stub = read(path.join(dir, solutionFile));
    const testSrc = read(path.join(dir, testFile));
    const instructions = (
      read(path.join(dir, ".docs", "instructions.md")) +
      "\n" +
      read(path.join(dir, ".docs", "instructions.append.md"))
    ).trim();

    return {
      id: slug,
      reference: read(path.join(dir, ".meta", "example.py")),
      solutionFile,
      solverPrompt: `You are solving a coding exercise. Implement your solution in the file \`${solutionFile}\`.

Requirements:
- Make the existing public API in the stub work as described — do not rename the module, class, or function names the tests will import.
- There is a hidden test suite; you cannot see it. Write a complete, correct implementation from the spec.
- Edit only \`${solutionFile}\`. Do not create extra files.

Exercise:
${instructions}`,
      setup(wd) {
        fs.writeFileSync(path.join(wd, solutionFile), stub);
      },
      grade(wd) {
        // Drop the pristine test in, run it, remove it again (keeps solves blind
        // and neutralizes any edit to the grader).
        const tp = path.join(wd, testFile);
        fs.writeFileSync(tp, testSrc);
        try {
          return runPytest(wd, testFile);
        } finally {
          fs.rmSync(tp, { force: true });
        }
      },
    };
  },
};
