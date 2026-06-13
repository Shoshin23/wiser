import fs from "node:fs";
import path from "node:path";
import { freshWorkdir, type Benchmark } from "./bench.js";
import { polyglot } from "./benches/polyglot.js";
import { humaneval } from "./benches/humaneval.js";
import { codecontests } from "./benches/codecontests.js";

const BENCHES: Record<string, Benchmark> = { polyglot, humaneval, codecontests };

// Free (no API) sanity check: the hidden grader must PASS the reference solution
// for every default instance (and, where there's a meaningful stub, fail it).
const bench = BENCHES[process.argv[2]];
if (!bench) throw new Error(`usage: validate.ts <${Object.keys(BENCHES).join("|")}>`);

let ok = 0;
const ids = bench.defaultIds();
for (const id of ids) {
  const inst = bench.load(id);
  const wd = freshWorkdir(bench.name, "validate", id);
  inst.setup(wd);
  fs.writeFileSync(path.join(wd, inst.solutionFile), inst.reference);
  const ref = inst.grade(wd);
  if (ref.passed) ok++;
  console.log(
    `${ref.passed ? "OK  " : "FAIL"} ${id.padEnd(22)} reference=${ref.passed ? "pass" : "fail"}`,
  );
  if (!ref.passed) console.log("   " + ref.output.split("\n").slice(-6).join("\n   "));
}
console.log(`\n${ok}/${ids.length} reference solutions pass the grader`);
