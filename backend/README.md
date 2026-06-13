# backend/

Node + TypeScript orchestrator and the **cost–quality eval harness**.

Two things live here:

1. **The voice pipeline** — STT → Claude agent → Nemotron distill → TTS, served over HTTP.
2. **The eval harness** (`src/eval/`) — the offline benchmark that produces the numbers in
   [`../EVIDENCE.md`](../EVIDENCE.md).

> The hosted **managed-agent** orchestrator (parallel coding runs, sessions, SSE) lives in
> [`../firebase/`](../firebase/), not here. This package is the local/self-hosted path.

## Run

```bash
cd backend && npm install
cp .env.example .env          # GROQ_API_KEY + ANTHROPIC_API_KEY (+ NEBIUS_API_KEY for Nemotron)
npm run dev                   # tsx watch → http://localhost:8787
```

Scripts: `dev` (watch) · `start` · `smoke` (pipeline smoke test) · `typecheck`.

## Endpoints (local, `:8787`)

| Method | Path | What |
|---|---|---|
| `GET`  | `/api/health` | liveness |
| `POST` | `/api/ask` | audio (+ optional image) → STT → agent → TTS → card |
| `POST` | `/api/ask-text` | text (+ optional image) → agent → card |

## Eval harness (`src/eval/`)

The cost–quality benchmark: each task is run **baseline · best-of-N · +1 human steer**, graded by a
**pytest verifier** on held-out tests.

```bash
tsx src/eval/run.ts <bench> [ids...]   # run a benchmark; writes to backend/eval-data/ (gitignored)
```

See [`../EVIDENCE.md`](../EVIDENCE.md) for methodology and results.

## Models / env

| Step | Default | Env override |
|---|---|---|
| STT | `whisper-large-v3-turbo` (Groq) | `STT_MODEL` |
| TTS | `canopylabs/orpheus-v1-english` (Groq) | `TTS_MODEL`, `TTS_VOICE` |
| Agent | `claude-sonnet-4-6` | `ANSWER_MODEL` |
| Distill | `nvidia/nemotron-…` (Nebius) | `NEMOTRON_*`, `NEBIUS_API_KEY`, `NEBIUS_BASE_URL` |

Required: `GROQ_API_KEY`, `ANTHROPIC_API_KEY`. Optional: `NEBIUS_API_KEY` (without it the distiller falls
back to local truncation). Eval overrides: `EVAL_SOLVER_MODEL`, `EVAL_ORACLE_MODEL`, `EVAL_UV_PYTHON`.

## Key files

`src/index.ts` (entry) · `src/pipeline.ts` (STT→agent→distill→TTS) · `src/groq.ts` · `src/agent.ts` ·
`src/nemotron.ts` (distiller) · `src/eval/` (harness).
