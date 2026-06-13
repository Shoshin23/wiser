import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// backend/  (two levels up from src/eval)
export const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
export const DATA_DIR = path.join(BACKEND_ROOT, "eval-data");
export const BENCH_DIR = path.join(DATA_DIR, "polyglot-benchmark");
export const PY_PRACTICE = path.join(BENCH_DIR, "python", "exercises", "practice");
export const WORK_DIR = path.join(DATA_DIR, "work");
export const RESULTS_DIR = path.join(DATA_DIR, "results");
// Persistent frozen baseline-failures for fast steer iteration (NOT wiped).
export const FAILURES_DIR = path.join(DATA_DIR, "failures");

// Models — solver is the "Claude Code" agent under test; oracle crafts the steer.
export const SOLVER_MODEL = process.env.EVAL_SOLVER_MODEL ?? "claude-sonnet-4-6";
export const ORACLE_MODEL = process.env.EVAL_ORACLE_MODEL ?? "claude-opus-4-8";

// Tools the solver agent may use while writing the solution (no test file is on
// disk during the solve, so it cannot peek at the hidden grader).
export const SOLVER_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"];
export const SOLVER_MAX_TURNS = 20;

// Python toolchain for hermetic grading via uv (pins a stable interpreter).
export const UV_PYTHON = process.env.EVAL_UV_PYTHON ?? "3.12";

// Pilot instance set (10 of the 34 Python polyglot exercises). Curated for a
// spread of difficulty so baseline leaves room for a steer to rescue.
export const PILOT_SLUGS = [
  "bowling",
  "book-store",
  "affine-cipher",
  "dominoes",
  "food-chain",
  "grep",
  "sgf-parsing",
  "pov",
  "react",
  "zebra-puzzle",
];

export const ARMS = ["baseline", "retry", "steer"] as const;
export type Arm = (typeof ARMS)[number];
