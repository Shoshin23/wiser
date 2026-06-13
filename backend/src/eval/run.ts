import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { RESULTS_DIR, ORACLE_MODEL } from "./config.js";
import {
  type Benchmark,
  type EvalInstance,
  buildFeedback,
  buildSteered,
  freshWorkdir,
  readSolution,
} from "./bench.js";
import { SOLVER_MODEL, solve } from "./solver.js";
import { craftSteer } from "./oracle.js";
import { polyglot } from "./benches/polyglot.js";
import { humaneval } from "./benches/humaneval.js";
import { codecontests } from "./benches/codecontests.js";

const BENCHES: Record<string, Benchmark> = {
  polyglot,
  humaneval,
  codecontests,
};

// ── shared attempt-1 design ───────────────────────────────────────────────
// Attempt 1 runs ONCE per instance (the blind solve = baseline). Both injection
// arms fork that same session and resume in the same workdir, snapshotting the
// attempt-1 files between them so each arm starts from identical state.
//   A = blind · B = + raw test output · C = + raw test output + ONE human steer.
// B vs C isolates the marginal value of the steer; A→C is the total uplift.

interface Row {
  bench: string;
  id: string;
  baseline: boolean;
  retry: boolean;
  steer: boolean;
  steerText: string | null;
  attempt1Tail: string;
  cost: { attempt1: number; retry: number; steer: number };
  solverModel: string;
  oracleModel: string;
}

function snapshot(wd: string): string {
  const snap = wd + ".snap";
  fs.rmSync(snap, { recursive: true, force: true });
  fs.cpSync(wd, snap, { recursive: true });
  return snap;
}
function restore(wd: string, snap: string) {
  fs.rmSync(wd, { recursive: true, force: true });
  fs.cpSync(snap, wd, { recursive: true });
}

async function runInstance(bench: Benchmark, inst: EvalInstance): Promise<Row> {
  const wd = freshWorkdir(bench.name, "run", inst.id);
  inst.setup(wd);

  // Attempt 1 — the blind baseline solve.
  const a1 = await solve(inst.solverPrompt, wd, { solutionFile: inst.solutionFile });
  const g1 = inst.grade(wd);
  const row: Row = {
    bench: bench.name,
    id: inst.id,
    baseline: g1.passed,
    retry: g1.passed,
    steer: g1.passed,
    steerText: null,
    attempt1Tail: g1.output.split("\n").slice(-8).join("\n"),
    cost: { attempt1: a1.costUsd, retry: 0, steer: 0 },
    solverModel: SOLVER_MODEL,
    oracleModel: ORACLE_MODEL,
  };

  if (g1.passed || !a1.sessionId) {
    console.log(`  ${inst.id}: baseline=${g1.passed ? "PASS" : "fail"} (no injection)`);
    return row;
  }

  const snap = snapshot(wd); // attempt-1 end state, shared by both arms

  // Arm B (control): inject the raw test failures, fork + resume.
  const feedback = buildFeedback(g1.output, inst.solutionFile);
  const b = await solve(feedback, wd, {
    resume: a1.sessionId,
    fork: true,
    solutionFile: inst.solutionFile,
  });
  row.retry = inst.grade(wd).passed;
  row.cost.retry = b.costUsd;

  restore(wd, snap); // reset to attempt-1 state for an identical start

  // Arm C (treatment): B's feedback PLUS one crafted human steer.
  const attempt = readSolution(wd, inst.solutionFile);
  const steerText = await craftSteer({
    instructions: inst.solverPrompt,
    attempt,
    testOutput: g1.output,
    reference: inst.reference,
  });
  row.steerText = steerText;
  const steered = buildSteered(feedback, steerText);
  const c = await solve(steered, wd, {
    resume: a1.sessionId,
    fork: true,
    solutionFile: inst.solutionFile,
  });
  row.steer = inst.grade(wd).passed;
  row.cost.steer = c.costUsd;

  fs.rmSync(snap, { recursive: true, force: true });
  console.log(
    `  ${inst.id}: baseline=fail  retry=${row.retry ? "PASS" : "fail"}  steer=${row.steer ? "PASS" : "fail"}`,
  );
  return row;
}

function summarize(bench: string, rows: Row[]) {
  const n = rows.length;
  const count = (k: "baseline" | "retry" | "steer") => rows.filter((r) => r[k]).length;
  const baseFails = rows.filter((r) => !r.baseline);
  const rescued = (k: "retry" | "steer") => baseFails.filter((r) => r[k]).length;
  const cost = rows.reduce((s, r) => s + r.cost.attempt1 + r.cost.retry + r.cost.steer, 0);
  const pct = (x: number) => `${((x / n) * 100).toFixed(0)}%`;
  console.log(`\n══════════ RESULTS — ${bench} ══════════`);
  console.log(`instances:            ${n}`);
  console.log(`baseline resolve:     ${count("baseline")}/${n}  (${pct(count("baseline"))})`);
  console.log(`+ free retry resolve: ${count("retry")}/${n}  (${pct(count("retry"))})`);
  console.log(`+ ONE steer resolve:  ${count("steer")}/${n}  (${pct(count("steer"))})`);
  console.log(`\namong ${baseFails.length} baseline failures:`);
  console.log(`  rescued by free retry: ${rescued("retry")}/${baseFails.length}`);
  console.log(`  rescued by one steer:  ${rescued("steer")}/${baseFails.length}`);
  console.log(`\ntotal cost: $${cost.toFixed(3)}  ·  solver=${SOLVER_MODEL}  oracle=${ORACLE_MODEL}`);
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set (expected in backend/.env)");
  }
  const benchName = process.argv[2];
  const bench = BENCHES[benchName];
  if (!bench) {
    throw new Error(`usage: run.ts <${Object.keys(BENCHES).join("|")}> [ids...]`);
  }
  const ids = process.argv.slice(3);
  const targets = ids.length ? ids : bench.defaultIds();

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(RESULTS_DIR, `${bench.name}-${stamp}.jsonl`);
  console.log(`Running ${targets.length} ${bench.name} instances → ${outPath}\n`);

  const rows: Row[] = [];
  for (const id of targets) {
    const inst = bench.load(id);
    const row = await runInstance(bench, inst);
    rows.push(row);
    fs.appendFileSync(outPath, JSON.stringify(row) + "\n");
  }
  summarize(bench.name, rows);
  console.log(`\nraw results + steer texts: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
