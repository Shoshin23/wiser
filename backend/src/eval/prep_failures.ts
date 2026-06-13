import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { FAILURES_DIR } from "./config.js";
import { type Benchmark, snapshotDir } from "./bench.js";
import { solve } from "./solver.js";
import { polyglot } from "./benches/polyglot.js";
import { humaneval } from "./benches/humaneval.js";
import { codecontests } from "./benches/codecontests.js";

const BENCHES: Record<string, Benchmark> = { polyglot, humaneval, codecontests };

// Freeze baseline-FAILURES once so steer variants can be replayed cheaply.
// For each id: run attempt-1; if it fails, snapshot the workdir + record the
// session id (resumable later) and the test output.
async function main() {
  const bench = BENCHES[process.argv[2]];
  if (!bench) throw new Error(`usage: prep_failures.ts <${Object.keys(BENCHES).join("|")}> [ids...]`);
  const ids = process.argv.slice(3);
  const targets = ids.length ? ids : bench.defaultIds();

  const root = path.join(FAILURES_DIR, bench.name);
  fs.mkdirSync(root, { recursive: true });
  const manifest: { id: string; safe: string; sessionId: string; testOutput: string }[] = [];

  for (const id of targets) {
    const inst = bench.load(id);
    const safe = id.replace(/[^A-Za-z0-9._-]/g, "_");
    const wd = path.join(root, safe);
    fs.rmSync(wd, { recursive: true, force: true });
    fs.mkdirSync(wd, { recursive: true });
    inst.setup(wd);

    const a1 = await solve(inst.solverPrompt, wd);
    const g1 = inst.grade(wd);
    if (g1.passed || !a1.sessionId) {
      console.log(`  ${id}: baseline ${g1.passed ? "PASS" : "no-session"} → skip`);
      continue;
    }
    snapshotDir(wd);
    manifest.push({ id, safe, sessionId: a1.sessionId, testOutput: g1.output });
    console.log(`  ${id}: baseline FAIL → frozen (session ${a1.sessionId.slice(0, 8)})`);
  }

  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`\nfroze ${manifest.length} failures → ${path.join(root, "manifest.json")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
