import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { FAILURES_DIR } from "./config.js";
import {
  type Benchmark,
  buildFeedback,
  buildSteered,
  readSolution,
  restoreDir,
} from "./bench.js";
import { solve } from "./solver.js";
import { craftSteer } from "./oracle.js";
import { polyglot } from "./benches/polyglot.js";
import { humaneval } from "./benches/humaneval.js";
import { codecontests } from "./benches/codecontests.js";

const BENCHES: Record<string, Benchmark> = { polyglot, humaneval, codecontests };

// Replay retry vs steer against frozen failures (from prep_failures). Cheap to
// re-run while iterating the oracle prompt — attempt-1 is never re-paid.
async function main() {
  const bench = BENCHES[process.argv[2]];
  if (!bench) throw new Error(`usage: try_steer.ts <${Object.keys(BENCHES).join("|")}> [ids...]`);
  const root = path.join(FAILURES_DIR, bench.name);
  const manifest: { id: string; safe: string; sessionId: string; testOutput: string }[] =
    JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const only = new Set(process.argv.slice(3));
  const entries = only.size ? manifest.filter((m) => only.has(m.id)) : manifest;

  let retryWins = 0;
  let steerWins = 0;
  const log: any[] = [];

  for (const m of entries) {
    const inst = bench.load(m.id);
    const wd = path.join(root, m.safe);
    const snap = wd + ".snap";
    const feedback = buildFeedback(m.testOutput, inst.solutionFile);

    // Arm B — raw feedback only.
    restoreDir(wd, snap);
    await solve(feedback, wd, { resume: m.sessionId, fork: true });
    const retryPass = inst.grade(wd).passed;

    // Arm C — feedback + crafted steer.
    restoreDir(wd, snap);
    const attempt = readSolution(wd, inst.solutionFile);
    const steerText = await craftSteer({
      instructions: inst.solverPrompt,
      attempt,
      testOutput: m.testOutput,
      reference: inst.reference,
    });
    restoreDir(wd, snap);
    await solve(buildSteered(feedback, steerText), wd, { resume: m.sessionId, fork: true });
    const steerPass = inst.grade(wd).passed;

    if (retryPass) retryWins++;
    if (steerPass) steerWins++;
    log.push({ id: m.id, retry: retryPass, steer: steerPass, steerText });
    console.log(
      `  ${m.id}: retry=${retryPass ? "PASS" : "fail"}  steer=${steerPass ? "PASS" : "fail"}${steerPass && !retryPass ? "  ← STEER WIN" : ""}`,
    );
  }

  const n = entries.length;
  console.log(`\n══════════ REPLAY — ${bench.name} (${n} frozen failures) ══════════`);
  console.log(`retry rescued: ${retryWins}/${n}`);
  console.log(`steer rescued: ${steerWins}/${n}`);
  console.log(`steer-only wins: ${log.filter((l) => l.steer && !l.retry).length}  ·  retry-only wins: ${log.filter((l) => l.retry && !l.steer).length}`);
  const out = path.join(root, `replay-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(out, JSON.stringify(log, null, 2));
  console.log(`detail + steer texts: ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
