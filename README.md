<div align="center">

<img src="media/wiser-demo.gif" width="460" alt="wiser demo — building a small issue tracker hands-free, on the glasses lens" />

# wiser

**A fleet of coding agents that lives in front of you — always there, never in the way.**

*Voice-driven Claude agents, surfaced as glanceable cards on Meta Ray-Ban Display glasses.*

<sub>↑ the actual 600×600 lens · <a href="media/wiser-demo.mp4">watch the MP4</a></sub>

</div>

---

## The idea

Picture coding agents you never *open* — you just *have* them. Always on, like a colleague who's around all
day, building while you get on with your life.

Boris Cherny, who built Claude Code, imagines a near future *"where anyone can just build software anytime."*
When that arrives, the agent stops being an app. It's just there, in the room with you.

Wonderful, and a little terrifying — an agent that's always there is one that can always interrupt you. So
here's the question wiser is built around:

> **Can you keep a fleet of coding agents in front of you all day — and barely notice them until they need you?**

You speak. A fleet of Claude agents goes off and writes the code, in silence.

Everything they're doing — the diffs, the logs, the second-guessing — collapses into one calm line you can
glance at and forget.

They interrupt you once, for the single call only you can make. You flick your fingers, and they finish.

Agents everywhere. Attention almost nowhere.

---

## What it does

- 🎙 **Start work by voice.** Just say what you want — no editor, no keyboard. A fleet of agents spins up.
- 👓 **Lives on your glasses.** Cards render on the Ray-Ban Display; you steer with the Neural Band (6 gestures) + voice.
- 🤫 **Glanceable, not streaming.** The agents' work collapses to one calm statusline. You glance — you don't read.
- ✋ **Interrupts you once.** It surfaces only the decisions you alone can make. Approve or steer with a flick.
- ⚡ **A fleet, not a bot.** Many cheap agents run in parallel, verifier-gated — the best *correct* result wins.
- 💸 **Cheap by design.** A small Nemotron model does the compression; a task can land at ~1/16 the cost of one top-tier run.

---

## The hard part: saying less

An agent at work throws off a flood — diffs, logs, reasoning, tool calls. The lens shows almost none of it:
**600×600, one view, no scrolling, a few words.**

So the whole game is throwing away the noise and keeping only what you need to see or decide. Three channels,
each tiny:

- **A card** — one line. A decision, an approval, a blocker. Nothing else.
- **Voice** — the glasses talk, you talk back. That's where the detail lives.
- **Gesture** — six moves on the Neural Band (four swipes, two pinches): approve, reject, drill in, next,
  ask. That's the whole vocabulary.

A small, fast model (NVIDIA **Nemotron**) does the squeezing — so compression is our cost story and our calm
story at once.

**Glasses-first rule:** if it's not on the lens, it's not done. The phone holds the logic, secrets, and
state; the interaction and the output happen on the glasses.

---

## The demo — a day in the life

1. **You just say it:** *"Hey wiser — build us a quick issue tracker, a small Linear."* A fleet spins up; you walk away.
2. **It works silently.** One line at the bottom rolls the present tense (`scaffolding · building IssueList · running tests`). No feed to babysit.
3. **Work catches itself.** In a meeting later, wiser offers: *"capture 'add SSO for the launch' as an issue?"* One pinch — filed into the tracker still being built.
4. **The one interruption that matters:** *"keep issues local, or sync a real backend?"* One gesture, and it continues. That's the morning's *only* interruption.
5. **The result:** a working tracker, with your captured issue as ticket #1 — built hands-free for ~4¢, roughly **1/16** the cost of one top-tier agent run.

---

## How it works

```
 voice intent ─▶ orchestrator ─▶ fleet of Claude agents ─▶ raw results ─▶ Nemotron distiller ─▶ cards ─▶ lens
       ▲                              │  (parallel, verifier-gated)                                      │
       └──────────────  you steer / approve / clarify (gesture + voice)  ◀──────────────────────────────┘
```

It's a real loop, not a one-shot prompt. Agents write code; a **verifier** re-runs the tests and benchmarks;
anything fast-but-wrong gets thrown out; it tries again until it's green.

Run many cheap **Nemotron**/Haiku agents in parallel and let the verifier keep the best *correct* one. That's
the bet: many cheap agents beating one expensive one.

**Evidence track:** an agent-driven perf loop on a real OSS target —
[`microsoft/llguidance`](https://github.com/microsoft/llguidance)'s `SimpleVob` token-mask bitset (the
constrained-decoding hot path behind structured outputs in vLLM / llama.cpp; pure scalar today, ~8× SIMD
headroom) — a clean `criterion` before/after, plus a *human-in-the-loop uplift* experiment (how much a public
benchmark improves when the human gives exactly one steer mid-loop).

---

## Architecture

Three loosely-coupled pieces, each buildable/demoable on its own:

| Path | What |
|------|------|
| `ios/CameraAccess/` | **Native iOS DAT app — the real glasses client.** Camera + mic + on-lens display + voice (Meta Wearables DAT). Flow in `CameraAccess/Wiser.swift`. |
| `backend/` | Node + TypeScript orchestrator (Claude Agent SDK): STT → agent → distill → TTS; serves cards/HUD over WebSocket. |
| `firebase/` | Serverless backend the iOS app calls (Anthropic Messages API + Groq STT/TTS). |
| `glasses-webapp/` | Vanilla-JS 600×600 lens app — the card-UI + interaction prototype (ambient + statusline + cards + voice), runnable in Chrome and on-device. |

**The seam** is the card contract: agents emit results → the distiller normalizes them into
`{kind, headline, one-liner, actions[]}` → the display renders the card + deep-dive. Define it early; it's
what keeps the three pieces independent.

---

## Run it

> Full setup, the cloud/STT/TTS pipeline, on-glasses deployment, and the contract live in
> [`ONBOARDING.md`](./ONBOARDING.md).

```bash
# Backend orchestrator
cd backend && npm install
cp .env.example .env          # fill in GROQ_API_KEY + ANTHROPIC_API_KEY
npm run dev                   # http://localhost:8787

# Glasses card-UI prototype (laptop demo path)
cd glasses-webapp
npm run demo                  # WISER_DEMO=true  → seeded run, no backend → http://localhost:3000
npm run live                  # WISER_DEMO=false → live backend
```

In Chrome at ~600×600: arrows move focus · **Enter** activates · **Esc** goes back. *If it works with
arrows + Enter in a 600×600 window, it works on the glasses.* On device, the iOS app is the real client; the
webapp can also load on-lens via the Meta Wearables deep-link/QR over HTTPS.

---

## Status

**Working:** voice → agent → voice pipeline (text + image); result card + deep-dive; the glasses-only card UI
(ambient + statusline + cards + voice) with a seeded demo timeline and a zero-dep WebSocket reference backend.

**In flight:** native iOS on-glass voice + display, the real Nemotron distiller (currently first-pass), live
orchestrator wiring, and the perf-evidence track.

Built at the **Whale** hackathon (Fiberplane / NP-Hard Ventures, Amsterdam) — judged on the *workflow*
(visible agent loop, verifier agents, cost-quality, measurable before/after), not app polish.
