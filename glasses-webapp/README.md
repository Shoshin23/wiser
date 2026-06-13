# glasses-webapp/

The **600×600 lens card UI** — vanilla JS, no build step. The card-list + deep-dive + steer interaction,
testable in a Chrome window and loadable on-device via a tunnel.

*If it works with arrows + Enter in a 600×600 window, it works on the glasses.*

## Run modes

```bash
npm run demo      # WISER_DEMO=true  → seeded mock timeline, no backend  → http://localhost:3000
npm run live      # WISER_DEMO=false → talks to the backend (WISER_BACKEND_URL, default :8787)
npm start         # default server
npm run backend   # dev-backend.js — a zero-dep reference WebSocket backend for local testing
```

Per-load override: `?demo=1` / `?demo=0` in the URL.

## Views & controls

Views (one at a time on the lens): **home** (mission control — fleet status, sessions, spend) ·
**loop** (ambient goal + statusline + decision cards) · **goals** · **team** · **analytics** (cost × quality).

Controls: **arrows** move focus · **Enter** activates · **Esc** back · **M** voice-steer mid-run.

## Backend contract (live mode)

```
POST /api/sessions            { prompt }            → { id }
GET  /api/sessions/:id/events (WebSocket)           → { hud } | { card }
POST /api/sessions/:id/steer  { gesture | voiceText }
```

## Env

`WISER_DEMO` (true/false) · `WISER_BACKEND_URL` (default `http://localhost:8787`) · `PORT` (default 3000).

## Recording the hero demo

`scripts/record-demo.mjs` drives the lens UI in headless Chromium and writes a webm to `recording/`
(gitignored); convert to the gif/mp4 in [`../media/`](../media/) with ffmpeg. Requires the `playwright`
devDependency and a server on `:3000`.

```bash
npm run demo &                 # serve in demo mode
node scripts/record-demo.mjs   # → recording/*.webm
```

## Key files

`app.js` (views + interaction) · `mock.js` (seeded demo timeline) · `session.js` (live transport + demo
fallback) · `cards.js` + `contract.js` (card shapes/renderers) · `server.js` · `dev-backend.js`.
