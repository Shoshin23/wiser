import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { freshWorkdir } from "../bench.js";
import { codecontests } from "./codecontests.js";

// Keep only problems whose reference solution passes exact-match grading
// (drops special-judge / multiple-valid-output problems).
const JSONL = path.join(DATA_DIR, "codecontests", "pilot.jsonl");
const rows = fs.readFileSync(JSONL, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const keep: any[] = [];
for (const r of rows) {
  const inst = codecontests.load(r.id);
  const wd = freshWorkdir("codecontests", "filter", r.id);
  inst.setup(wd);
  fs.writeFileSync(path.join(wd, inst.solutionFile), inst.reference);
  if (inst.grade(wd).passed) keep.push(r);
  else console.log(`drop (special-judge): ${r.id}`);
}
fs.writeFileSync(JSONL, keep.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`kept ${keep.length}/${rows.length} exact-match-gradeable problems`);
