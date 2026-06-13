import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { WORK_DIR, UV_PYTHON } from "./config.js";

export interface GradeResult {
  passed: boolean;
  output: string; // captured stdout+stderr, tailed
}

/** One task, benchmark-agnostic. The runner only talks to this shape. */
export interface EvalInstance {
  id: string;
  solverPrompt: string; // attempt-1 prompt for the solver
  reference: string; // oracle-only reference solution
  solutionFile: string; // file the solver writes (read back for the oracle)
  setup(wd: string): void; // seed a fresh workdir (write starter files)
  grade(wd: string): GradeResult; // run the hidden tests
}

export interface Benchmark {
  name: string;
  defaultIds(): string[]; // pilot subset
  load(id: string): EvalInstance;
}

export function tail(s: string, n = 4000): string {
  return s.length <= n ? s : "…(truncated)…\n" + s.slice(-n);
}

// Arm B message: raw machine feedback (the test output).
export function buildFeedback(testOutput: string, solutionFile: string): string {
  return `Your solution is failing the hidden tests. Here is the test output:\n\n${testOutput}\n\nFix \`${solutionFile}\` so all tests pass.`;
}

// Arm C message: machine feedback + one human steer (so C ⊇ B; gap = the steer).
export function buildSteered(feedback: string, steerText: string): string {
  return `${feedback}\n\nA senior engineer reviewed your attempt and adds this guidance:\n${steerText}`;
}

/** Fresh per-(bench,arm,id) workdir. */
export function freshWorkdir(bench: string, arm: string, id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, "_");
  const wd = path.join(WORK_DIR, bench, arm, safe);
  fs.rmSync(wd, { recursive: true, force: true });
  fs.mkdirSync(wd, { recursive: true });
  return wd;
}

export function readSolution(wd: string, file: string): string {
  const p = path.join(wd, file);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

export function snapshotDir(wd: string): string {
  const snap = wd + ".snap";
  fs.rmSync(snap, { recursive: true, force: true });
  fs.cpSync(wd, snap, { recursive: true });
  return snap;
}
export function restoreDir(wd: string, snap: string) {
  fs.rmSync(wd, { recursive: true, force: true });
  fs.cpSync(snap, wd, { recursive: true });
}

/** Run a python file in a hermetic uv env; exit 0 = pass. */
export function runPython(
  wd: string,
  file: string,
  opts: { withPkgs?: string[]; stdin?: string; timeoutMs?: number } = {},
): { code: number; stdout: string; stderr: string; output: string } {
  const args = ["run", "--no-project", "--python", UV_PYTHON];
  for (const p of opts.withPkgs ?? []) args.push("--with", p);
  args.push("python", file);
  const res = spawnSync("uv", args, {
    cwd: wd,
    encoding: "utf8",
    input: opts.stdin,
    timeout: opts.timeoutMs ?? 60_000,
  });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  // spawnSync sets status=null on timeout/signal → treat as failure.
  return {
    code: res.status ?? 1,
    stdout,
    stderr,
    output: `${stdout}\n${stderr}`.trim(),
  };
}

/** Run pytest on a single test file in a hermetic uv env. */
export function runPytest(wd: string, testFile: string): GradeResult {
  const res = spawnSync(
    "uv",
    [
      "run",
      "--no-project",
      "--with",
      "pytest",
      "--python",
      UV_PYTHON,
      "python",
      "-m",
      "pytest",
      "-q",
      testFile,
    ],
    { cwd: wd, encoding: "utf8", timeout: 120_000 },
  );
  const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
  return { passed: res.status === 0, output: tail(out) };
}
