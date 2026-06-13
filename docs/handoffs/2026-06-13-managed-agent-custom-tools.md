# Claude Managed Agent custom tools (`ask_user` + `handoff_to_glasses`) — Handoff

**Date:** 2026-06-13 · **Branch:** `main` · **Local HEAD:** `f9cf699` · **Remote `origin/main`:** `d179c6c` (⚠️ local is 1 behind — pull first)
**Purpose:** wiser's voice→Claude-Managed-Agent→glasses loop is live and working on-device. Next step is to give the managed agent two **custom tools** — a human-in-the-loop `ask_user` interview tool and a final `handoff_to_glasses` tool that emits a **distinct structured JSON** summarizing the result onto the lens. None of that is built yet (greenfield).

> ⚠️ **Inferred next task.** The `/handoff` arg ("is the command") was not a task. This next task is inferred from the live conversation immediately before the handoff: the user asked to "build the claude managed agent tools… one after the ask-user interview question tool… one to finally handoff to the glasses… in a scaffolding json that summarises the output… distinct." High confidence.

---

## 0. Next task — START HERE

Add **two Claude Managed Agents custom tools** to the backend agent and handle them in the session event loop. Custom tools are the documented mechanism (see `.claude/skills/managed-agents/SKILL.md` → "Tools — custom"): the agent emits `agent.custom_tool_use`, the session idles, the host runs the tool and replies `user.custom_tool_result`, the agent continues.

**Tool 1 — `ask_user` (interview / human-in-the-loop).** Agent calls it mid-task when it needs a decision/clarification. Glasses-first round-trip (per the ⭐ cardinal rule): backend pauses the session → pushes the question to the **lens** → user answers (voice→STT, or taps a choice) → backend replies `user.custom_tool_result` → agent resumes.
```
input_schema: { "question": string, "options"?: string[] }
```

**Tool 2 — `handoff_to_glasses` (final, DISTINCT structured handoff).** Agent calls it once the task/query is done, emitting a typed "scaffolding JSON" (NOT free-form text) the glasses render + speak. Proposed envelope (this is the "distinct" contract the user emphasized):
```json
{ "type":"handoff", "headline":"one-line result (card title)",
  "summary":"1–2 lines spoken + shown", "status":"done|needs_input|blocked",
  "detail":"optional deeper text for deep-dive",
  "actions":[{"label":"Approve","value":"approve"}] }
```
Backend captures this validated `event.input` as THE output → renders the card on the lens + TTS. (Matches the CLAUDE.md compression-layer MVP shape `{headline, one-liner, spoken_detail?, actions[]}` and the skill's `emit_card` pattern.)

**TWO OPEN DECISIONS — confirm with the user before/while building** (they invoked `/handoff` instead of answering):
1. Final field set for the `handoff_to_glasses` JSON (above is a proposal).
2. How `ask_user` answers come back: voice on the glasses (default), tappable lens choices, or both.

**Hard-stop guardrail (do this FIRST, like the managed-agents migration):** the custom-tool round-trip (`agent.custom_tool_use` events + `user.custom_tool_result`) is **UNVERIFIED in the real SDK** — we only verified basic sessions + `sessions.list`. Prove it live with a throwaway script before touching `index.js`; if it doesn't work as the skill claims, STOP and report, leaving the working backend intact.

**First steps / commands:**
1. `cd /Users/karthikkannan/.superset/projects/wiser && git pull` (you're 1 behind `d179c6c`).
2. Read `.claude/skills/managed-agents/SKILL.md` (custom tools, `always_ask`, Outcomes, `emit_card`).
3. Verify custom tools live (model on the script that already exists): copy the pattern in `firebase/functions/test-managed-agents.js`, declare one trivial `{type:"custom",name,input_schema}` tool on a *test* agent, run a session, confirm you receive `agent.custom_tool_use` and can reply `user.custom_tool_result`. Load the key: `cd firebase/functions && export ANTHROPIC_API_KEY=$(grep -E '^ANTHROPIC_API_KEY=' .env | cut -d= -f2-) && node test-managed-agents.js` (adapt).
4. Tools live on the AGENT, not the session — so update `firebase/functions/setup-managed-agent.js` to declare both custom tools, re-run it to mint a **new `AGENT_ID`**, update `.env` + the deployed function's runtime env, then handle the tool events in `runTurn()` (`firebase/functions/index.js:147`).
5. iOS: render the `ask_user` question on the lens + capture the answer; render `handoff_to_glasses` as a distinct card. iOS lens code is in `ios/CameraAccess/CameraAccess/Wiser.swift`.

---

## 1. Session summary
- Pivoted the glasses client from a **web app → native iOS DAT** (the Display web SDK can't access camera/mic/audio) and built the full loop: phone mic → backend → spoken answer + on-lens card via `MWDATDisplay`, Neural Band tap to start/stop. ✅ user-confirmed on device.
- Moved the backend from a local Express server (Claude **Agent SDK**, can't reach the phone at the venue) to a **Firebase Cloud Function** using **Claude Managed Agents** (the intended fleet path). ✅ live.
- Added **conversation memory** (client-owned `sessionId`) and **3 session endpoints** (list / detail / create), then built **session browsing on the lens** (paging model). ✅ user said "works!" on device.
- Moved the iOS app into THIS repo (`ios/CameraAccess/`) as the single source of truth and reverted the old `meta-display-experiments` copy to pristine.
- Codified the ⭐ **glasses-first cardinal rule** in `CLAUDE.md`.

## 2. Key decisions (and why)
- **Managed Agents (hosted) over the Messages API / self-hosted Agent SDK** — it's the intended fleet path; Agent SDK spawns a CLI subprocess that can't run serverless. Cost: ~5–6s/turn latency (model loop + Groq TTS), accepted for now.
- **Client-owned `sessionId` (not one global session)** — a global session breaks multi-user concurrency (one container, one ordered thread) and Cloud Functions instances don't share memory. Client holds the id, server mints it, recovers on expiry.
- **Native iOS DAT, not the Web App** — DAT 0.7.0 web path has NO camera/mic/audio; only native exposes them.
- **Firebase Cloud Function backend** — the phone couldn't reach the laptop over LAN at the venue (Wi-Fi client isolation); a public HTTPS endpoint removes that whole class of failure.
- **Lens lists use PAGING, not a scrollable focusable list** — MWDATDisplay 0.7.0 has **no focus/cursor API** for multi-item navigation (that exists only in the web-app path). So: one item per card with explicit buttons + whole-card tap fallback.
- **Background-agent governance (learned the hard way):** two background agents editing the same file caused a commit to sweep in half-built code, and a background agent pushed to `main` unauthorized. Rule now: sub-agents do **code+verify only**, non-overlapping files, and the orchestrator gates ALL git pushes/deploys. (Recorded in `CLAUDE.md` thinking + agent memory.)

## 3. Files changed (all committed unless noted; local is 1 behind `origin`)
**Backend (`firebase/functions/`)**
- `index.js` — Managed Agents integration + Option A memory + 3 session endpoints. Key symbols (verified at write time): `createSession()` (`:133`), `runTurn()` (`:147` — **the event loop where custom tools plug in**), `askAnthropic()` (`:198`), `sessions.list` (`:271`), `events.list` (`:242`,`:304`); routes `/api/health` (`:428`), `/api/ask` (`:434`), `/api/ask-text` (`:459`), `/api/sessions` (`:476`), `POST /api/sessions` (`:489`), `/api/sessions/:id` (`:506`). **No custom tools yet** (grep count 0).
- `setup-managed-agent.js` — creates the agent (currently **no tools**) + cloud env once → prints `AGENT_ID`/`ENV_ID`. `test-managed-agents.js` — standalone managed-agents smoke test. Both tracked.
- `.env` — `GROQ_API_KEY`, `ANTHROPIC_API_KEY`, `ANSWER_MODEL=claude-sonnet-4-6`, `STT_MODEL`, `TTS_MODEL`, `TTS_VOICE=hannah`, `AGENT_ID`, `ENV_ID`. **Gitignored** (not tracked) — regenerate via `setup-managed-agent.js` on a fresh clone.

**iOS (`ios/CameraAccess/CameraAccess/`)**
- `Wiser.swift` — the whole wiser flow. Key symbols: `AskResponse` (`:43`, has `sessionId`), `GlassesAudioRoute` (`:128`, routes TTS to glasses BT), `WiserViewModel.currentSessionId` (`:238`), `startGlasses()` (`:275`), `sendCard()` (`:366`), `sendReadyCard()` (`:444`), `sendSessionBrowseCard()` (`:569`), `pickSessionOnLens()` (`:642`), `newSessionOnLens()` (`:654`), `postAsk()` (`:769`), `postAskText()` (`:830`), `SessionsView` (phone fallback, `:1095`).
- `Views/MainAppView.swift` — `TabView` with **Ask** (default) + **Camera** tabs (registered branch).
- `Info.plist` — added `NSMicrophoneUsageDescription` + `NSAppTransportSecurity.NSAllowsArbitraryLoads`.
- `CameraAccess.xcodeproj/project.pbxproj` — `Wiser.swift` registered (UUIDs `DA7E…A001/A002`).

**Repo root**
- `CLAUDE.md` — ⭐ CARDINAL RULE glasses-first (`:5`). `README.md`, `.gitignore` — updated for the iOS-in-repo layout.

## 4. Architecture / how it works
```
iPhone (CameraAccess app)                         Firebase fn "wiser" (us-central1)        Anthropic / Groq
  mic → POST /api/ask (+sessionId) ───────────────▶ Groq STT
  ↑ plays TTS on glasses (BT A2DP)                  → Managed Agents session (per req) ───▶ claude-sonnet-4-6 (loop)
  ↑ MWDATDisplay card on lens  ◀── JSON ───────────── Groq TTS (Orpheus, 200-char chunks)
  Neural Band tap drives it                         {transcript, answer, audioChunks, card, sessionId}
```
- **Backend** = one Express app exported as the `wiser` gen2 function. `@anthropic-ai/sdk` **0.104.1**, `client.beta.agents/sessions/environments`, beta header `managed-agents-2026-04-01` (`MA_OPTS`, `index.js:130`). Agent + env created **once** (`setup-managed-agent.js`) → `AGENT_ID`/`ENV_ID`; a **session is created per request**, conversation continuity via client-passed `sessionId`. `runTurn()` is **stream-before-send** with the idle-break gate (break only on terminal `stop_reason`/terminated) — **this is exactly where the custom-tool handling goes**.
- **iOS** = native DAT app; the glasses are a paired peripheral. "Capture on phone, show on glasses": phone mic + networking, lens output via `MWDATDisplay.display.send(FlexBox{…})`, Neural Band via `Button.onClick`/`FlexBox.onTap`. **No focus API** → default cursor = first focusable child; lists are paged.
- **Contract** (backend↔iOS): `AskResponse {transcript, answer, audioChunks[b64 WAV], card{title,summary}, sessionId}`; sessions `{id,title,preview,status,createdAt,updatedAt}`; detail `{id,status,messages[{role,text}]}`.

## 5. Gotchas & watch-outs
- ⚠️ **Local is 1 commit behind `origin/main`** (`d179c6c` "glasses-only agent-coding UI — statusline, moment cards, voice, dreamy theme"). **Pull first**; it likely touches `Wiser.swift` — expect to reconcile with the lens/session code.
- ⚠️ **Two Xcode projects share bundle id `com.letsenvision.metaexp`** — the wiser app (`ios/CameraAccess/CameraAccess.xcodeproj`, USE THIS) and the now-pristine `meta-display-experiments` copy. Building the wrong one overwrites the app on the device with the camera-only sample. (This bit the user this session.)
- ⚠️ **Adding custom tools = new agent.** Tools live on the AGENT; `setup-managed-agent.js` currently creates it with NONE. You must re-create the agent with tool declarations → **new `AGENT_ID`** → update `.env` AND the deployed function's runtime env → redeploy.
- ⚠️ **Deploy is `gcloud`, not `firebase deploy`** — the service account lacks `firebaseextensions` perms. Always pass ALL runtime env vars on deploy or they reset.
- ⚠️ **Groq Orpheus voice must be lowercase** (`hannah`, not `Hannah`) or every TTS 400s → empty audio.
- ⚠️ **Managed-agents latency ~5–6s/turn** — noticeable in voice. Streaming TTS per sentence is the deferred fix.
- ⚠️ **SourceKit shows "No such module 'MWDATCore'"** spuriously in the editor — ignore; `xcodebuild` is the truth (it builds).
- ⚠️ **iOS 26/27 beta launch crash** (`_setContext:` selector) → Edit Scheme → Run → Options → uncheck **Enable Backtrace Recording**.
- ⚠️ `sessions.list()` is **API-key/org-scoped** (all sessions created with the key, not per end-user) — fine for the demo. `title` is null in practice → preview falls back to first user message (one tiny extra read per untitled session).

## 6. How to work here
- **iOS build (✅ ran this session):** `cd ios/CameraAccess && xcodebuild -project CameraAccess.xcodeproj -scheme CameraAccess -destination 'generic/platform=iOS' -configuration Debug CODE_SIGNING_ALLOWED=NO build` → `** BUILD SUCCEEDED **`. Run on a **real iPhone** (DAT needs hardware + paired glasses), not the simulator.
- **Backend deploy (sub-agent ran; ⚠️ not re-run by me):** `gcloud auth activate-service-account --key-file=/Users/karthikkannan/Downloads/wiser-1a319-firebase-adminsdk-fbsvc-d7031b62b8.json --project wiser-1a319` then `gcloud functions deploy wiser --gen2 --region us-central1 --timeout=300s …` with all runtime env vars (`ANTHROPIC_API_KEY,GROQ_API_KEY,ANSWER_MODEL,STT_MODEL,TTS_MODEL,TTS_VOICE,AGENT_ID,ENV_ID`).
- **Live (✅ observed this session):** `https://us-central1-wiser-1a319.cloudfunctions.net/wiser` — `GET /api/health` → 200, `GET /api/sessions` → 200. Quick agent test: `curl -X POST …/api/ask-text -H 'Content-Type: application/json' -d '{"text":"hi"}'`.
- **Debug markers:** backend `console.error("/api/… error", …)`; iOS `DATLog.log` (subsystem `CameraAccess`, category `DAT`).
- **House rules (`CLAUDE.md`):** ⭐ glasses-first (every feature must work on the lens, not just the phone); compression layer (one card, ~1 headline + 1–2 lines, voice carries detail, 6 gesture inputs); sub-agents code+verify only, orchestrator gates pushes/deploys.

## 7. Open / deferred
- **The next task itself** (custom tools) — not started; 2 design decisions unanswered (handoff JSON fields; interview answer channel).
- **Custom-tool round-trip unverified** in the real SDK — verify before wiring (hard-stop).
- **Image / POV-photo flow** — `postAsk` accepts an image param but iOS never captures a glasses photo; backend `askAnthropic` ignores image (`_imageB64`). Not wired.
- **Streaming TTS** (latency win) — deferred.
- **Lens session paging on real Neural Band** — only verified to *build* (⚠️); actual band navigation between buttons is unconfirmed on hardware (whole-card `.onTap` fallback exists).
- **`d179c6c` not yet integrated locally** — pull and reconcile (may overlap `Wiser.swift`).
