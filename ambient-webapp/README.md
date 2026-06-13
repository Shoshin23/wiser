# wiser · ambient opportunity cards

A **prototype-first** webapp (deliberate exception to the repo's glasses-first rule —
ports to the lens later) that:

1. **Live-transcribes** the ongoing conversation (mic → rolling 5 s segments → Groq
   Whisper, server-side) and shows the running transcript.
2. **Scans in the background**: every ~8 s (debounced on transcript growth) it feeds the
   recent transcript to **Claude Haiku** (`claude-haiku-4-5`) and asks *"is there an
   opportunity to kick off an agent task?"* → an opportunity card, or nothing.
3. **Surfaces opportunities as dreamy cards** (matches `glasses-webapp/`'s theme +
   reuses its `styles.css` / `contract.js` / `cards.js`). Gestures:
   - **swipe right / →** — approve → dispatches the task to the agent fleet
     (`POST /api/ask-text`) and surfaces the result as a card.
   - **swipe left / ←** — dismiss.
   - **tap / click / ⏎** — open a prompt editor to tweak before sending.

All model/STT keys stay **server-side** — the browser talks only to this origin's backend.

## Run

```bash
cd ambient-webapp
npm install
node server.js          # http://localhost:8788
```

Open **http://localhost:8788** and click *Start listening*.

> **Mic needs a secure context.** `getUserMedia` works on `localhost`/`127.0.0.1` and over
> HTTPS, but **not** over a plain-HTTP LAN/Tailscale hostname. To test from another machine,
> tunnel it (e.g. `ngrok http 8788`) or serve over HTTPS.

## Keys

The backend loads, in order (first wins; the real environment always wins):
`ambient-webapp/.env` → `firebase/functions/.env` (both in-project). It needs:

- `GROQ_API_KEY` — Groq Whisper STT
- `ANTHROPIC_API_KEY` — Claude Haiku scanner

`GET /api/health` reports key presence (`{ ok, groq, anthropic }`) without leaking values.

Optional overrides: `PORT` (8788), `SCAN_MODEL` (`claude-haiku-4-5`), `STT_MODEL`
(`whisper-large-v3-turbo`), `WISER_FIREBASE_URL` (deployed agent fn),
`WISER_CHUNK_MS` (5000), `WISER_SCAN_INTERVAL_MS` (8000).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | key presence |
| POST | `/api/transcribe` | raw audio body → `{ text }` (Groq Whisper) |
| POST | `/api/scan` | `{ transcript }` → `{ opportunity \| null }` (Claude Haiku) |
| POST | `/api/ask-text` | `{ text, sessionId? }` → proxied to the deployed Firebase agent fn |

## Notes

- **Standalone backend** so it touches **no shared files** (`firebase/functions/index.js`,
  `glasses-webapp/`). The `/api/scan` + `/api/transcribe` logic can be folded into the
  Firebase function later if desired.
- Files `styles.css`, `contract.js`, `cards.js` are copied verbatim from `glasses-webapp/`
  so the look + card model port cleanly; `ambient-cards.js` adds the `opportunity` card.
