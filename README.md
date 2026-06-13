# wiser — glasses webapp + agent backend

Voice-driven Claude managed agents, surfaced as cards on Meta Ray-Ban **Display** glasses.

```
 Glasses webapp (600×600)            Backend orchestrator (Node/TS)         Cloud
 ┌───────────────────────┐  audio    ┌──────────────────────────────┐
 │ record mic on D-pad ──┼──(+image)─▶ /api/ask                      │
 │ capture camera frame  │           │   Groq STT  ──────────────────┼──▶ Groq Whisper
 │ render result CARD     │           │   Claude Agent SDK query() ───┼──▶ Anthropic
 │ play TTS audio chunks ◀┼──JSON─────┤   Groq TTS (chunked) ─────────┼──▶ Groq Orpheus
 └───────────────────────┘           └──────────────────────────────┘
        STT → prompt → managed agent → response → TTS   (text + image flows)
```

## Layout

| Path | What |
|------|------|
| `ios/CameraAccess/` | **Native iOS DAT app — the real glasses client. ALL iOS work goes here.** Open `CameraAccess.xcodeproj`; the wiser flow is in `CameraAccess/Wiser.swift`. (Moved out of the `meta-display-experiments` repo — that copy is no longer used.) |
| `firebase/` | Serverless backend the iOS app calls (Anthropic Messages API + Groq STT/TTS), deployed to `wiser-1a319` at `https://us-central1-wiser-1a319.cloudfunctions.net/wiser`. |
| `backend/` | Node + TypeScript orchestrator (Claude Agent SDK). The local/LAN version of the pipeline. |
| `glasses-webapp/` | Vanilla-JS Meta Display webapp — **deprecated**: the Display web SDK can't access camera/mic/audio, so the native iOS app is the glasses client. |

The frontend↔backend contract is `AskResponse` in `backend/src/types.ts` (`transcript`, `answer`, `audioChunks[]`, `card{title,summary}`). The `glasses-webapp` mirrors it.

## Run the backend

```bash
cd backend
npm install
cp .env.example .env        # then fill in GROQ_API_KEY and ANTHROPIC_API_KEY
npm run dev                  # http://localhost:8787  (warms up the agent on boot)
```

Quick checks:
```bash
npm run test:chunk          # TTS chunker logic (no keys needed)
npm run smoke -- "what's the capital of France?"   # proves the Agent SDK path (needs ANTHROPIC_API_KEY)
curl http://localhost:8787/api/health
```

**Env:** `ANSWER_MODEL` defaults to `claude-sonnet-4-6` (chosen for voice latency). Groq model/voice ids are env-overridable in case they drift.

## Run the webapp

**Laptop (primary dev/demo path):**
```bash
cd glasses-webapp && npm start    # http://localhost:3000
```
Open in Chrome, set the window to ~600×600. `config.js` points at `http://localhost:8787` by default. Press **Ask** (or Enter on it) to record; press again to stop and send. **Ask + Image** grabs a camera frame first. **Type** is the keyboard fallback (hits `/api/ask-text`).

**On the glasses:**
1. Expose the local backend over HTTPS: `cloudflared tunnel --url http://localhost:8787` → copy the `https://….trycloudflare.com` URL into `glasses-webapp/config.js`.
2. Deploy the static frontend (use the `meta-wearables-webapp:test-on-device` / `publish-to-vercel` skills — they also disable Vercel deployment protection so the glasses WebView isn't blocked).
3. Load on-device via the `fb-viewapp://web_app_deep_link?appName=…&appUrl=https://…` deep link / QR.

Both ends must be HTTPS (mixed content is blocked) — that's why the backend goes behind a tunnel.

## Controls (D-pad)

Arrow keys move focus · Enter activates · Escape goes back / cancels recording. The cyan ring shows focus.

## Status

Working: STT → managed agent → TTS pipeline (voice + image), result card + deep-dive, sequential audio playback, text fallback. Verified: chunker logic, typecheck, HTTP wiring, and the Agent SDK round-trip (subprocess spawns and responds).

Deferred: streaming partial answers, gapless WAV concatenation, the smarter `card.ts` distiller (currently first-few-words), and the iOS DAT app. On-glasses `getUserMedia` (mic/camera) is unconfirmed — the laptop demo + Type fallback cover that risk.
