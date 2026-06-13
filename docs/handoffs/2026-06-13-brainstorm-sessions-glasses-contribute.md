# Brainstorm sessions + glasses contribute (inject/queue prompt + image) — Handoff

**Date:** 2026-06-13 · **Branch:** `main` · **HEAD:** `ec6a949` (pushed; local == `origin/main`, clean tree)
**Purpose:** Turn the existing ambient "brainstorm" into **sessioned** brainstorms that the **glasses can browse and contribute to** (inject/queue a prompt + image). The Haiku scan loop keeps running as usual. Greenfield — nothing for this task is built yet.

> **Supersedes** `docs/handoffs/2026-06-13-brainstorm-interrupt-same-session.md`. That doc's framing (interrupt the Claude Managed Agent coding session; a passive read-only side-scan) is **explicitly DISCARDED** by the user. Do not build that.

---

## 0. Next task — START HERE

Build this, exactly:
1. **Every brainstorm has a `sessionId`.** A brainstorm becomes a server-side session (id + rolling transcript + the opportunity cards it has produced + a contributions list), not just browser-local state.
2. **Glasses can SEE active brainstorm sessions** — list them on the lens (reuse the existing on-lens session-browse paging).
3. **Glasses can CONTRIBUTE to a chosen brainstorm session** — **inject or queue** a `prompt + image` into it. The image comes from the glasses POV; the prompt from voice→STT.
4. **The brainstorm goes on as usual** — the Haiku scanner keeps live-transcribing + scanning; contributed prompts/images become part of what it scans (image ⇒ Haiku vision).

**Explicitly OUT OF SCOPE (discarded):** interrupting/steering the Claude Managed Agents coding run (`user.interrupt`, `/api/runs/:id/steer`); the passive `/api/runs/:id/brainstorm` side-scan. This task is only about the **ambient brainstorm** (`ambient-webapp/` + the Haiku scan), made sessioned + glasses-contributable.

**The crux to settle first (architecture):** today the brainstorm is **browser-local + a stateless standalone server**. For the glasses (a phone, maybe off-LAN) to *see* and *contribute to* a brainstorm, the session state must live on a **shared, reachable** backend. The glasses already talk to the deployed Firebase fn (`https://us-central1-wiser-1a319.cloudfunctions.net/wiser`). So **recommended: add a brainstorm-session registry to the Firebase fn** (reachable by both the ambient webapp and the glasses); the ambient webapp becomes a client of it. Alternative: make `ambient-webapp/server.js` stateful AND reachable from the phone (deploy / tunnel / on-phone server like the laptop-mirror) — messier for the glasses. **Decide this before coding.**

**Proposed shape (inference — confirm with the user):**
- **Brainstorm session model:** `{ id, title, preview, status:"active"|"ended", transcript, proposed[] (cards so far), contributions[] ({text?, imageRef?, mode:"inject"|"queue", at}), createdAt, updatedAt }`.
- **Endpoints** (on the reachable backend):
  - `POST /api/brainstorms` → `{id}` (ambient webapp creates one when "Start listening" is pressed).
  - `GET /api/brainstorms` → `[{id,title,preview,status,updatedAt}]` (glasses browse this).
  - `POST /api/brainstorms/:id/transcript {text}` → append rolling transcript (ambient webapp feeds STT here) — OR keep transcript client-side and only register session + contributions (decision).
  - `POST /api/brainstorms/:id/contribute {text?, imageB64?, mode:"inject"|"queue"}` → add a contribution. **inject** = fold into the scan context now (next scan sees it). **queue** = hold as pending; surfaced on the next scan tick.
  - `GET /api/brainstorms/:id` → detail (transcript, cards, pending contributions) — ambient webapp polls to pick up glasses contributions.
  - Extend the **scan** to accept image(s): add an Anthropic image content block to the Haiku call so a contributed picture influences the opportunity (Haiku is vision-capable). Current `scanForOpportunity` is text-only (`ambient-webapp/server.js:137`).
- **Glasses (native iOS):** reuse the on-lens session-browse paging (below) pointed at `GET /api/brainstorms`; add a contribute affordance per session: speak a prompt (mic → `/api/transcribe`) and/or grab a glasses POV frame (the camera POV is already teed by `WiserMirror`/`StreamSessionViewModel`) → base64 → `POST /api/brainstorms/:id/contribute`.

**First steps / commands:**
1. `cd /Users/karthikkannan/.superset/projects/wiser && git status` (should be clean; HEAD `ec6a949`, in sync).
2. Read `ambient-webapp/` end to end: `server.js`, `ambient.js` (client loop), `ambient-cards.js`, `README.md`.
3. Run it to see today's behavior: `cd ambient-webapp && npm install && node server.js` → open `http://localhost:8788`, click *Start listening* (mic needs `localhost`/HTTPS — see README). Watch `/api/transcribe` + `/api/scan` fire.
4. Decide where brainstorm sessions live (Firebase fn vs ambient server) — ask the user. Then implement the model + endpoints, wire the ambient webapp as a client, and add the glasses browse+contribute surface.

---

## 1. Session summary (what THIS session actually did)
- Committed this session's prior work (streaming orchestrator + managed-agent custom tools + native Build surface) in 3 commits, **merged `origin/main`** (which brought the brainstorm `ambient-webapp/`, the laptop-mirror, a demo-mock retarget, README/ONBOARDING, demo media), and **pushed** → `origin/main` = `ec6a949`. ✅
- **Fixed a merge-surfaced build break:** `WiserMirror.swift` had been committed to origin with no pbxproj entry (the main `CameraAccess` target uses explicit file refs, NOT synchronized groups — only the *test* targets are synchronized), so it wasn't compiled. Registered it (UUIDs `…D001/D002`, mirroring `OrchestratorRun`) → iOS builds green. ✅ (commit `68f75d9`, folded into the merge that was pushed.)
- Investigated the new feature and (with the user) **discarded** the agent-interrupt + passive-scan approaches in favor of the sessioned-brainstorm + glasses-contribute design above. Wrote this handoff.

## 2. Key decisions (and why)
- **Brainstorm is its own thing, separate from the coding orchestrator.** It runs on cheap Haiku scans over live STT; it does NOT touch the Managed Agents coding loop. The earlier "interrupt the agent" idea is dead.
- **Sessions must live on a shared reachable backend** (recommended: the deployed Firebase fn) because the contributor (glasses/phone) and the scanner (browser) are different clients on possibly different networks. Browser-local state can't be browsed/contributed-to by the glasses.
- **Contributions carry image + prompt and have a mode (inject vs queue)** per the user's words. Image flows into the Haiku scan as a vision block.
- **Reuse, don't rebuild:** the glasses on-lens session browser already exists (paging model, no cursor API); the opportunity-card renderer + dreamy theme exist; the STT + scan endpoints exist. The work is *sessioning* + a *contribute* path + pointing the glasses browser at brainstorms.

## 3. Files changed / relevant
**Pulled this session (NEW on `origin/main`, now local) — the brainstorm feature to build on:**
- `ambient-webapp/server.js` — standalone Node server (port **8788**), **stateless**. Routes: `GET /api/health`, `GET /config.js`, `POST /api/transcribe` (Groq Whisper, raw audio body → `{text}`), `POST /api/scan` (`{transcript, proposed[]}` → `{opportunity|null}`, Haiku `claude-haiku-4-5`, `output_config.format` json_schema), `POST /api/ask-text` (proxy to the Firebase fn). Loads keys from `ambient-webapp/.env` then `firebase/functions/.env`. Scan brain = `scanForOpportunity()` (`:137`), `SCAN_SYSTEM`/`SCAN_SCHEMA` (`:85`/`:114`).
- `ambient-webapp/ambient.js` — the **client loop** (browser owns state): `state.transcript`, `state.proposed[]` (`:24`/`:30`); mic 5s segments → `/api/transcribe`; `maybeScan` every `SCAN_INTERVAL_MS` (8s) → `/api/scan`; approve → `/api/ask-text`.
- `ambient-webapp/ambient-cards.js` — `W.renderOpportunity(opp,{onApprove,onDismiss,onEdit})`; opportunity card = `{ title, summary, proposedPrompt }` (`:7`,`:21`). `contract.js`/`cards.js`/`styles.css` copied from `glasses-webapp/`.
- `ambient-webapp/README.md` — intent + run instructions (note: it's a deliberate prototype exception to glasses-first; "ports to the lens later" — this task is that port + sessioning).

**This session's committed work you'll build alongside (already on `origin/main`):**
- `firebase/functions/index.js` — Q&A + custom tools + the `/api/runs` orchestrator + `/api/sessions` (GET `:727` / POST `:740` / `:id` `:757`) — the latter is a **model** for brainstorm-session endpoints, and the Firebase fn is the recommended home for them.
- `firebase/functions/orchestrator.js`, `ambient`/`coding-agent-config.js`, setup/update + test scripts.
- `ios/.../Wiser.swift` — **on-lens session browser to reuse** (re-derived post-merge): `browseSessions`(`:314`)/`browseIndex`(`:315`), `openSessionsOnLens()`(`:693`), `sendSessionBrowseCard()`(`:763`), `advanceBrowse()`(`:828`), `pickSessionOnLens()`(`:836`), `newSessionOnLens()`(`:848`), `sendReadyCard()`(`:638`). Plus the voice capture + STT path and `GlassesDisplayHub`.
- `ios/.../OrchestratorRun.swift` (Build surface), `GlassesDisplayHub.swift` (shared lens), `WiserMirror.swift` (glasses POV MJPEG tee — **the image source for contributions**), `ViewModels/StreamSessionViewModel.swift` (camera).

## 4. Architecture / how it works (today vs. target)
- **Today:** one browser tab = one ephemeral brainstorm. `ambient.js` holds the transcript + proposed list in memory; `server.js` is a pure function server (no sessions, no cross-client state). The glasses have a separate on-lens browser for *Managed-Agent Q&A* sessions (`/api/sessions`), unrelated to brainstorms.
- **Target:** a brainstorm is a server-side session on a shared backend. The ambient webapp registers/feeds a session and keeps scanning; the glasses list active brainstorm sessions and POST contributions (prompt+image); the scanner folds contributions into its scan context (inject now / queue next tick). The opportunity cards continue to flow as usual.
- **Data flow to wire:** browser STT → session transcript (shared); glasses contribution (prompt+image) → session contributions (shared); scanner reads transcript + contributions → Haiku (vision when an image is present) → opportunity card. Who runs the scan loop (browser, as today, polling the session for contributions — vs. server-side timer) is an open implementation choice; the browser already has the mic, so browser-drives-scan + polls-contributions is the least-change path.
- **Image source:** `WiserMirror`/`StreamSessionViewModel` already tee the glasses camera POV (added by the laptop-mirror commits). Grab a frame → JPEG → base64 for the contribution.

## 5. Gotchas & watch-outs
- ⚠️ **`ambient-webapp` is a separate standalone server (port 8788), not the Firebase fn.** It is NOT deployed/reachable from the phone as-is. The glasses can't reach `localhost:8788`. This is the core reason the shared-backend decision matters.
- ⚠️ **Mic needs a secure context** — `getUserMedia` works on `localhost`/HTTPS only, not plain-HTTP LAN. Tunnel (`ngrok`) or HTTPS to test from another machine (README).
- ⚠️ **The main `CameraAccess` Xcode target uses EXPLICIT file refs, not synchronized groups** (only the test targets are synchronized). Any NEW `.swift` file you add for the glasses contribute UI **must be registered in `project.pbxproj`** (4 places: PBXBuildFile, PBXFileReference, the group children, the Sources phase) — mirror the `DA7E…` entries for `OrchestratorRun`/`GlassesDisplayHub`/`WiserMirror`. This bit us this session (WiserMirror was committed without it and didn't compile).
- ⚠️ **`/api/scan` is text-only today** — adding image input means an Anthropic vision content block in the Haiku `messages` call; keep the `output_config.format` json_schema.
- ⚠️ **No cursor/arrow API on MWDATDisplay 0.7.0** — the on-lens brainstorm browser must keep the paging model (one item + Next/Select buttons + whole-card tap), like `sendSessionBrowseCard`.
- ⚠️ **Keys** — `ambient-webapp` loads `ambient-webapp/.env` then `firebase/functions/.env`; both are gitignored. Needs `GROQ_API_KEY` + `ANTHROPIC_API_KEY`.

## 6. How to work here
- **Ambient webapp:** `cd ambient-webapp && npm install && node server.js` → `http://localhost:8788` → *Start listening*. (⚠️ not run by me this session — unverified locally; `npm start` per its `package.json`/README.)
- **Firebase fn (if hosting brainstorm sessions there) — deploy (✅ pattern ran this session):** `gcloud functions deploy wiser --gen2 --region us-central1 --project wiser-1a319 --runtime nodejs22 --source firebase/functions --entry-point wiser --trigger-http --allow-unauthenticated --timeout=300s --memory=512Mi --set-env-vars=^@^<ALL vars from firebase/functions/.env>` (use `@` delimiter; `TTS_VOICE` lowercase). Live URL: `https://us-central1-wiser-1a319.cloudfunctions.net/wiser`.
- **iOS build (✅ ran, green this session):** `cd ios/CameraAccess && xcodebuild -project CameraAccess.xcodeproj -scheme CameraAccess -destination 'generic/platform=iOS' -configuration Debug CODE_SIGNING_ALLOWED=NO build`. Run on a real iPhone + paired glasses. (`No such module 'MWDATCore'` in SourceKit is spurious.)
- **Debug markers:** ambient server `console.error(method, path, "->", …)`; Firebase `console.error("/api/… error", …)`; iOS `DATLog.log` (subsystem `CameraAccess`).
- **House rules (`CLAUDE.md`):** ⭐ glasses-first — the contribute + browse UX must work on the lens (MWDATDisplay), not just a phone/web screen. Compression layer (one card, paged). Sub-agents code+verify on non-overlapping files; orchestrator gates pushes/deploys.

## 7. Open / deferred
- **Where brainstorm sessions live** (Firebase fn vs ambient server) — unresolved; the gating decision. Ask the user.
- **Who runs the scan loop** once sessioned (browser-polls-contributions vs server-side timer).
- **inject vs queue** exact semantics + lens affordance for each.
- **Image → Haiku scan** wiring (vision block) — not started; `/api/scan` is text-only.
- **Glasses contribute UI** — capturing a POV frame (from `WiserMirror`/`StreamSessionViewModel`) + voice prompt → contribute POST — not started.
- The earlier interrupt/inject handoff is **superseded**; ignore its plan.
- Throwaway test agents/envs (`wiser-coding-test`, `wiser-tool-test`) remain on the org — archive when convenient.
