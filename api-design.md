# wiser orchestrator API (design draft)

A small HTTP/JSON API for the glasses → orchestrator boundary. Scope, for now,
is three things:

1. Kick off a session with a prompt
2. List past sessions and their running status
3. Archive a session

JSON in, JSON out. No auth yet (added later — the orchestrator is public).

## Session object

```jsonc
{
  "id": "ses_…",                 // server-assigned
  "prompt": "…",                 // the kickoff prompt, verbatim
  "title": "… | null",           // optional label (defaults null)
  "status": "running",           // running | done | failed | archived
  "result": null,                // null until done — see note below
  "created_at": "2026-06-13T…Z",
  "updated_at": "2026-06-13T…Z"
}
```

**`status`** — a session's lifecycle:
| value | meaning |
|---|---|
| `running` | agent is working |
| `done` | finished; `result` is populated |
| `failed` | agent errored out |
| `archived` | hidden from the default list |

**`result`** — the payload the glasses render as a card. Shape is a
placeholder for now (`{ summary, detail }`); the real card schema is a separate
decision (the wiser CLAUDE.md flags it as the thing to nail down first).

## Endpoints

### `POST /sessions` — kick off a session with a prompt

Request:
```json
{ "prompt": "summarize the wiser repo", "title": "repo summary" }
```
Response `201`:
```json
{ "id": "ses_a1b2", "prompt": "summarize the wiser repo", "title": "repo summary",
  "status": "running", "result": null, "created_at": "…", "updated_at": "…" }
```
Returns immediately with `status: "running"` — the agent runs async.
`400` if `prompt` is missing/empty.

### `GET /sessions` — list past sessions + status

Response `200`:
```json
{ "data": [ { "id": "ses_a1b2", "status": "done", … }, … ] }
```
Newest-first. (Open question: include archived, or filter by default? Suggest
`?status=archived` / `?include_archived=true` when we need it — omit for now.)

### `GET /sessions/:id` — one session

Response `200` Session, or `404`. Used to poll a single session's status/result.

### `POST /sessions/:id/archive` — archive

Response `200`: the session with `status: "archived"`. `404` if unknown.
Soft — the record is kept, just flagged.

## Deferred (not in this cut)

- **How the glasses learn a status changed** — poll `GET /sessions`, or an SSE
  stream, or a realtime DB. Ties to the infra choice; poll is fine to start.
- **Auth** — token on every request once it's not loopback-only.
- **Card/result schema** — define properly before wiring the real agent.
- **Follow-up turns / deep-dive** — would add `POST /sessions/:id/messages`.
