# Brainstorm feature → interrupt a live agent session with a picture/prompt — Handoff

**Date:** 2026-06-13 · **Branch:** `main` (⚠️ local `d179c6c` is **4 commits BEHIND** `origin/main` = `6b95e2f`, and the working tree has **heavy uncommitted work from this session**) · **Last local commit:** `d179c6c feat(glasses): glasses-only agent-coding UI`
**Purpose:** Next session pulls the new `ambient-webapp` "brainstorm" feature from origin and builds on it: a way to **inject a picture or prompt into the SAME running agent session — i.e. interrupt it mid-run**. The SDK seam for this is confirmed to exist; nothing is built yet.

---

## 0. Next task — START HERE

> "pull changes and implement a brainstorm feature based on the brainstorming feature we already have. reuse everything from there and figure out a way to plug in to the same session and send a picture or a prompt to it. interrupt it basically"

**What "the brainstorming feature we already have" is** (verified): `ambient-webapp/` — landed on `origin/main` this session by a teammate (`439a38a feat(ambient): ambient opportunity cards — live STT + Haiku scanner → cards`). It's a standalone zero-dep Node webapp that live-transcribes conversation (Groq Whisper), scans it with `claude-haiku-4-5` for *opportunities to kick off a coding task*, and surfaces them as cards. It is NOT yet in your local tree — you must pull first.

**The new capability to add:** while an agent is *already running* a session (the orchestrator's `/api/runs` coding session, `sesn_…`), let the user **inject a picture and/or a prompt into that same session and interrupt the agent** so it incorporates the new input mid-task. Reuse the brainstorm scaffolding (STT → scan → card) for the "prompt" side; add image capture for the "picture" side.

**The seam is confirmed in the installed SDK** (`@anthropic-ai/sdk` under `firebase/functions/node_modules`):
- **Interrupt:** `BetaManagedAgentsUserInterruptEventParams` → `{ type:'user.interrupt', session_thread_id?:string }` (absent thread id = interrupt the primary/all threads). `events.d.ts:1275`.
- **Image input:** `BetaManagedAgentsImageBlock` = `{ type:'image', source: Base64ImageSource|URLImageSource|FileImageSource }`; `BetaManagedAgentsBase64ImageSource` = `{ data:<b64>, media_type:'image/jpeg'|… }`. `events.d.ts:477` / `:360`.
- So a `user.message` can carry mixed content: `[{type:'text',text},{type:'image',source:{type:'base64',media_type,data}}]`.

**Proposed implementation (smallest path, reuses existing orchestrator):**
1. Backend: add `orchestrator.inject(sessionId, {text?, imageB64?, mediaType?})` next to the existing `steer` (`firebase/functions/orchestrator.js:461`) that sends **`[{type:'user.interrupt'}]` then `[{type:'user.message', content:[…text + image block…]}]`** to the session; expose it as `POST /api/runs/:id/inject` next to `POST /api/runs/:id/steer` (`firebase/functions/index.js:886`). The held SSE (`GET /api/runs/:id/events`, `index.js:801`) will stream the agent's reaction.
2. iOS: capture a glasses-POV JPEG (the camera POV is already teed — see `WiserMirror.swift`/`StreamSessionViewModel.swift` from the incoming commits) → base64 → `POST /api/runs/:id/inject`. Add a lens affordance on the Build surface (`OrchestratorRun.swift`) to "send what I'm looking at" / speak a redirect.
3. Reuse the brainstorm side (`ambient-webapp/api/scan` Haiku scan) to turn ambient speech into the injected prompt, if you want the auto-brainstorm flavor.

**⚠️ HARD-STOP, do this FIRST (before wiring):** `user.interrupt` then `user.message`-with-image on a *running* session is UNVERIFIED in practice (we only verified the basic event loop + custom tools + a `user.message` nudge to an *idle* session). Prove it with a throwaway script modeled on `firebase/functions/test-coding-agent.js`: start a coding run, mid-run send `user.interrupt` + a `user.message` with a base64 image, and confirm the agent stops and reacts. If it doesn't behave, STOP and report — don't wire `index.js`.

**First commands (in order):**
```bash
cd /Users/karthikkannan/.superset/projects/wiser
git status                       # see this session's uncommitted work (a LOT)
git switch -c session-orchestrator-work   # PRESERVE this session's work on a branch
git add -A && git commit -m "wip: streaming orchestrator + custom tools + iOS Build surface"
git switch main && git merge --ff-only origin/main   # FF main to 6b95e2f (clean: main has no local commits)
git switch session-orchestrator-work && git merge main   # resolve the ONE conflict (Wiser.swift, below)
```
**Do NOT `git pull` into the dirty tree** — you'll get a messy half-merge. Commit to a branch first (above).

**The only merge conflict:** `ios/CameraAccess/CameraAccess/Wiser.swift`. Incoming `c2ffdc1` adds two `WiserMirror.shared.publish(title:body:kind:)` lines — one at the top of `sendCard(...)` (~`:368`) and one in `sendAnswerCard(...)` (~`:398`). This session also edited those methods (custom-tools cards + the `GlassesDisplayHub` refactor). Resolution is trivial: **keep both** — re-add the two `WiserMirror.shared.publish(...)` calls inside the session's versions of those methods. Everything else incoming is new files (no conflict).

---

## 1. Session summary
This session (all work **UNCOMMITTED** on local `main`):
- Built **two Claude Managed Agents custom tools** — `ask_user` + `handoff_to_glasses` — on the Q&A agent, plus an `/api/cancel`. Verified the custom-tool round-trip live. ✅
- Built the **streaming orchestrator** (`/api/runs`): a REAL coding agent (`agent_toolset_20260401`, network-on cloud env) whose event stream is **distilled into Card/Hud/Steer SSE frames** (`firebase/functions/orchestrator.js`). Verified live end-to-end (real `diff`/`tests`/`done` cards, working steer). ✅
- Built the **native iOS "Build" surface** (`OrchestratorRun.swift` + `GlassesDisplayHub.swift`): SSE client, lens renderers, start-a-run-by-speech, made Build the glasses entry. Builds clean. ⚠️ (not device-verified — see §7)
- Fixed a streaming bug: `URLSession.bytes(...).lines` buffers HTTP/2 → rewrote as a delegate-based `URLSessionDataTask` reader. ⚠️ (built, not device-confirmed)
- Fixed cards getting painted over by the per-second HUD tick (2.8s moment-card dwell + ignore elapsedSec-only frames). ⚠️
- Made the coding agent **open-ended** (no Rust/levenshtein hero; scratch sandbox; tests only if applicable) and updated it in place. ✅
- Deployed the Firebase function twice (`wiser-00006-yom`, then `wiser-00007-yom`) via `gcloud`. ✅

## 2. Key decisions (and why)
- **`client.beta.agents.update(id,{version,system,tools})` to add tools/change prompt in place** — keeps the same `AGENT_ID`/`CODING_AGENT_ID`, no new provisioning. (Earlier handoff wrongly assumed a new agent was required.)
- **Distiller = HYBRID**: HUD `activity` + `cost` derived automatically from the raw stream (`agent.tool_use` name+`input.file_path`/`command`; `span.model_request_end.model_usage`); cards come from the agent's emit-card custom tools (`report_diff`/`report_tests`/`checkpoint`/`ask_user`/`done`). Reliable + real.
- **Multi-turn HTTP, stateless steer** — the SSE is held by one request; `steer` finds the pending `ask_user` via `events.list` so it works across Cloud Run instances. The new `inject` should follow the same stateless pattern (operate on the durable `sesn_…`).
- **Native iOS is the surface (cardinal rule), `ambient-webapp` is a webapp** — the brainstorm feature reuses the `glasses-webapp` theme but is a standalone Node webapp. DECISION FOR NEXT SESSION: build the inject/interrupt on the **native Build surface** (glasses-first) vs. inside `ambient-webapp`. "Reuse everything from there" pulls toward ambient-webapp; the cardinal rule pulls toward native. Clarify before building.
- **Open-ended coding target** — user explicitly dropped the Rust/levenshtein hero; the sandbox has `python3` but not cargo.

## 3. Files changed
**Incoming on `origin/main` (NOT yet pulled — 4 commits `d179c6c..6b95e2f`):**
- NEW `ambient-webapp/` (the brainstorm feature): `server.js` (routes `/api/health`, `/api/transcribe` Groq Whisper, `/api/scan` Haiku structured-output, `/api/ask-text` proxy to the Firebase fn), `ambient.js`, `ambient-cards.js`, `cards.js`/`contract.js`/`styles.css` (copied from glasses-webapp), `index.html`, `package.json`.
- NEW `ios/.../WiserMirror.swift` (+ `6b95e2f` fix) — on-phone MJPEG server teeing glasses camera POV + card text ("laptop mirror"). MODIFIED `ViewModels/StreamSessionViewModel.swift`, `Info.plist`, `Wiser.swift` (the +2 `WiserMirror.publish` lines = the only conflict).

**This session — UNCOMMITTED, MODIFIED:**
- `firebase/functions/index.js` — custom-tool event loop, `/api/ask`+`/api/ask-text` `toolUseId` resume, `/api/cancel`, `/api/transcribe`, and the `/api/runs` orchestrator routes (`POST` `:782`, `GET …/events` `:801`, `POST …/steer` `:886`). `runAskText` still **ignores images** (`_imageB64` unused, `:504-506`).
- `firebase/functions/setup-managed-agent.js` — Q&A agent now declares the two custom tools.
- `ios/.../Wiser.swift` — `ask_user`/`handoff` cards, `Phase.awaitingAnswer`, refactored to use `GlassesDisplayHub`.
- `ios/.../Views/MainAppView.swift` — **Build is now the default/first tab**.
- `ios/CameraAccess.xcodeproj/project.pbxproj` — manually registered `OrchestratorRun.swift`/`GlassesDisplayHub.swift` (⚠️ see §5 — the project uses synchronized file groups).

**This session — UNCOMMITTED, NEW:**
- `firebase/functions/`: `orchestrator.js` (distiller + `createRun`:379 / `listEventsAfter`:428 / `ackCustomTool`:437 / `steer`:461), `coding-agent-config.js`, `agent-config.js`, `setup-coding-agent.js`, `update-agent-tools.js`, `update-coding-agent.js`, and test scripts `test-coding-agent.js`, `test-custom-tool.js`, `test-orchestrator.js`, `test-tools-e2e.js`.
- `ios/.../OrchestratorRun.swift` (Build surface + `RunSSEClient`), `ios/.../GlassesDisplayHub.swift` (single shared lens display).
- `docs/` (this handoff + `orchestrator-spec.md`, the Card/Hud/Steer contract).

## 4. Architecture / how it works
- **Run lifecycle:** `POST /api/runs {prompt}` → managed session against `CODING_AGENT_ID`/`CODING_ENV_ID` → `{id}`. iOS opens `GET /api/runs/:id/events` (SSE). Backend opens `events.stream`, feeds each event to `makeDistiller()`, writes `{hud}|{card}|{done}` frames (with `id:` for `Last-Event-ID` resume). `POST /api/runs/:id/steer` answers the pending `ask_user` (or nudges) — **stateless**, re-derived from `events.list`. The new **`inject`** should sit right here: `user.interrupt` + `user.message`(text+image) on the same `sesn_…`.
- **Why interrupt is its own event:** sending `user.message` to an *idle* session continues it; to redirect a *running* agent you send `user.interrupt` first (per the SDK type's doc). Verify the exact ordering (interrupt→message vs message-auto-interrupts) in the hard-stop script.
- **Image is unwired everywhere today:** `index.js` accepts `imageB64` but `runAskText` ignores it; `orchestrator.createRun`/`steer` are text-only. The new feature is the first real image path → use `BetaManagedAgentsImageBlock` in the `user.message` content.
- **Brainstorm feature is a separate process:** `ambient-webapp/server.js` is its own Node server (like `dev-backend.js`), proxying to the deployed Firebase fn for `/api/ask-text`. It does not import `firebase/functions`. Its `/api/scan` (Haiku, structured output, "knows it can change the wiser codebase") is the reusable "speech → task/opportunity" brain.
- **iOS lens ownership:** one `Display` capability, owned by `GlassesDisplayHub.shared`; both the Ask and Build surfaces send through it.

## 5. Gotchas & watch-outs
- ⚠️ **Don't pull into the dirty tree.** Commit this session's work to a branch first (§0). Local `main` (`d179c6c`) is an ancestor of `origin/main` (`6b95e2f`) so `main` fast-forwards cleanly *once the working tree is clean*.
- ⚠️ **Only conflict = `Wiser.swift`** (two `WiserMirror.shared.publish(...)` lines from `c2ffdc1`). Keep both sides.
- ⚠️ **Xcode project uses `PBXFileSystemSynchronizedRootGroup` (4 of them)** — new `.swift` files are auto-included; you do **NOT** need to edit `project.pbxproj` for the brainstorm feature's new files (the incoming commits added `WiserMirror.swift` with zero pbxproj changes). This session's *manual* pbxproj edits for `OrchestratorRun.swift`/`GlassesDisplayHub.swift` may be redundant — verify there's no duplicate-file build error after the merge.
- ⚠️ **Agent + deployed code must ship together.** Changing the agent's tools/prompt (`update-coding-agent.js`) takes effect immediately on the live agent; if the distiller in the deployed `index.js`/`orchestrator.js` can't handle a new tool, sessions hang to the 300s timeout. Update agent and redeploy in the same window.
- ⚠️ **Deploy is `gcloud`, not `firebase deploy`** (service account lacks perms); pass ALL runtime env vars each time or they reset. `TTS_VOICE` must be lowercase (`hannah`).
- ⚠️ **`.env` is gitignored** — `CODING_AGENT_ID=agent_01TBBgpoVLxTsHB4jEQx7wFN`, `CODING_ENV_ID=env_01LX4wxxVJHACiFehBoAxL86`, `AGENT_ID=agent_012YSXhdcBMtbGT8TVuLT5y8`, `ENV_ID=env_01FpjoKF1rKAGZaXqtwrm5Rw` are in the deployed function env and local `.env`. `ambient-webapp` has its own `.env`.
- ⚠️ **iOS Build surface is built but NOT device-verified** — the user was hitting "stuck/blank lens" bugs this session; the latest SSE + UI + clobber fixes compile but were not yet confirmed on hardware (§7).

## 6. How to work here
- **Backend deploy (✅ ran this session):**
  ```bash
  gcloud auth activate-service-account --key-file=/Users/karthikkannan/Downloads/wiser-1a319-firebase-adminsdk-fbsvc-d7031b62b8.json --project wiser-1a319
  gcloud functions deploy wiser --gen2 --region us-central1 --project wiser-1a319 --runtime nodejs22 \
    --source /Users/karthikkannan/.superset/projects/wiser/firebase/functions --entry-point wiser \
    --trigger-http --allow-unauthenticated --timeout=300s --memory=512Mi \
    --set-env-vars=^@^ANSWER_MODEL=…@ANTHROPIC_API_KEY=…@GROQ_API_KEY=…@LOG_EXECUTION_ID=true@STT_MODEL=whisper-large-v3-turbo@TTS_MODEL=canopylabs/orpheus-v1-english@TTS_VOICE=hannah@AGENT_ID=…@ENV_ID=…@CODING_AGENT_ID=…@ENV_ID/CODING_ENV_ID=…
  ```
  (Pull real values from `firebase/functions/.env`; use `@` as the `--set-env-vars` delimiter — `TTS_MODEL` has a `/`.)
- **Live URL (✅ observed):** `https://us-central1-wiser-1a319.cloudfunctions.net/wiser` — `GET /api/health`, `POST /api/runs`, `GET /api/runs/:id/events`, `POST /api/runs/:id/steer`, `POST /api/transcribe`.
- **Managed-agents script (✅ pattern):** `cd firebase/functions && set -a && . ./.env && set +a && node test-coding-agent.js` — copy this for the interrupt/image hard-stop script.
- **iOS build (✅ ran):** `cd ios/CameraAccess && xcodebuild -project CameraAccess.xcodeproj -scheme CameraAccess -destination 'generic/platform=iOS' -configuration Debug CODE_SIGNING_ALLOWED=NO build` → `** BUILD SUCCEEDED **`. Run on a real iPhone + paired glasses. (`No such module 'MWDATCore'` in SourceKit is spurious — xcodebuild is the truth.)
- **Brainstorm webapp (after pull):** `ambient-webapp/` — `npm start` / see its `README.md`; it needs its own `.env` (GROQ + ANTHROPIC keys + `FIREBASE_BASE_URL`).
- **Debug markers:** backend `console.error("/api/… error", …)`; iOS `DATLog.log` (subsystem `CameraAccess`) — the SSE reader logs first-chunk / each `hud`/`card(kind)`/`done` / decode failures.
- **House rules (`CLAUDE.md`):** ⭐ glasses-first (every feature on the lens via MWDATDisplay, not phone-only); compression layer (one card, voice carries detail, 6 gesture inputs); sub-agents code+verify only on non-overlapping files, orchestrator gates pushes/deploys.

## 7. Open / deferred
- **The new feature itself** — interrupt-a-running-session-with-picture/prompt: not started. Hard-stop verify `user.interrupt` + image `user.message` first (§0).
- **Where it lives** (native Build surface vs `ambient-webapp`) — unresolved decision; ask the user.
- **iOS Build surface on-device** — the SSE-delegate rewrite, the webapp-UI port, start-by-speech entry, and the 2.8s card-dwell are all ⚠️ built-not-device-verified. The user's last report was the lens showing only "GOAL working"; confirm the fixes actually render cards on hardware (Console subsystem `CameraAccess`).
- **All of this session's code is uncommitted** — preserve it (§0) before pulling.
- **Image input path is greenfield** — `runAskText` still ignores `imageB64`; no glasses photo is captured/sent yet (the laptop-mirror POV tee is the nearest existing frame source).
- **Throwaway test agents/envs** (`wiser-coding-test`, `wiser-tool-test`) are durable on the org — archive when convenient.
