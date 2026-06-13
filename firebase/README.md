# firebase/

The **serverless backend the iOS app calls** — a Cloud Function wrapping Anthropic **Managed Agents**
(hosted Q&A + coding orchestrator) plus Groq STT/TTS. This is the production / on-device path.

Deployed at `https://us-central1-wiser-1a319.cloudfunctions.net/wiser`.

> The brainstorm/ambient scan server is **separate** — see [`../ambient-webapp/`](../ambient-webapp/). The
> iOS app talks to both (this fn for Ask/Build, the ambient server for Brainstorm contributions).

## Endpoints

| Method | Path | What |
|---|---|---|
| `GET`  | `/api/health` | liveness |
| `POST` | `/api/transcribe` | audio → Groq Whisper → `{text}` |
| `POST` | `/api/ask` | audio (+ image) → managed-agent Q&A → card + audio |
| `POST` | `/api/ask-text` | text Q&A |
| `POST` | `/api/cancel` | cancel a pending `ask_user` |
| `GET`/`POST` | `/api/sessions` | list / create Q&A sessions |
| `GET`  | `/api/sessions/:id` | session transcript |
| `POST` | `/api/runs` | start a coding run (orchestrator) |
| `GET`  | `/api/runs/:id/events` | **SSE** stream of HUD + card frames |
| `POST` | `/api/runs/:id/steer` | answer a question / nudge a run |

⚠️ `GET /api/sessions` is **API-key/org scoped** — it returns every session created with the key, not
per-user.

## Setup & deploy

The two managed agents are provisioned **once**, then their IDs go in the env:

```bash
node functions/setup-managed-agent.js   # → AGENT_ID, ENV_ID         (Q&A agent)
node functions/setup-coding-agent.js    # → CODING_AGENT_ID, CODING_ENV_ID  (orchestrator)
# put the printed IDs in your env, then deploy the function.
```

Change an agent's tools/system without redeploying with `update-agent-tools.js` / `update-coding-agent.js`.
`test-*.js` are local harnesses for the agents/tools.

## Env

Required: `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `AGENT_ID`, `ENV_ID`, `CODING_AGENT_ID`, `CODING_ENV_ID`.
Optional: `GITHUB_TOKEN` (mount a repo in `/api/runs`), `ANSWER_MODEL`, `STT_MODEL`, `TTS_MODEL`, `TTS_VOICE`.

Models: Groq for STT/TTS, Anthropic Managed Agents (Sonnet) for reasoning/coding. Uses the
`managed-agents` beta header.

## Key files

`functions/index.js` (routes) · `functions/orchestrator.js` (distiller: events → HUD/cards, cost/tokens) ·
`functions/agent-config.js` + `coding-agent-config.js` (agent system + custom tools) · `functions/setup-*.js`.

See also [`../docs/orchestrator-spec.md`](../docs/orchestrator-spec.md) for the HUD/Card/Steer frame contract.
