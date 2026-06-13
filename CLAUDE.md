# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Core thesis (north star)

**What does the world look like when you can have coding agents in front of you at any moment — without it
being constantly distracting?**

Always-available agents are easy; *non-distracting* always-available agents are the hard, interesting
problem. This tension is the design north star and the demo's punchline. It drives every UX decision:

- **Glanceable, not streaming.** Cards surface only what needs a human (a decision, an approval, a
  blocker) — agents work silently otherwise. The display pings you; it doesn't narrate.
- **Pull, not push.** Deep-dive is on demand. Default state is calm; detail is one gesture away.
- **Attention is the scarce resource.** Optimize for the fewest, highest-signal interruptions, not for
  showing everything the fleet is doing.

Judge any feature by: does it let agents be present without stealing attention?

## The compression layer (core design problem)

The hard technical idea of the hack: **agentic coding produces a firehose of information** (diffs, logs,
reasoning, multiple parallel agents) and **the glasses can show almost none of it.** The display is a
~600×600 surface, **one view at a time, no scrolling, a handful of words.** So the central problem is:

> **How do you compress a large, evolving agent state into a tiny visual + voice + gesture surface —
> losing the noise, keeping only what the human must see or decide?**

Three output/input channels, each tiny — design to their limits, not around them:

- **Visual (smallest):** a **card** = ~1 headline + 1–2 lines. The irreducible signal: a decision, an
  approval, a blocker. Everything else is dropped or deferred to voice.
- **Voice (the detail bandwidth):** the glasses *speak* the elaboration and the user talks back. This is
  where "more detail" lives, since text can't. Note: no raw mic stream — audio is HFP 8 kHz mono.
- **Gesture (steering):** the Neural Band gives exactly **6 inputs** (4 swipes + 2 pinches → arrows +
  enter/cancel). That's the whole control vocabulary: approve/reject, drill in, next/prev, **ask for
  clarification**. We "steer" the agents through these, not a keyboard.

**MVP scope (don't overcomplicate):** one cheap **Nemotron distill pass** turns an agent's raw result into
a fixed compact shape — `{ headline, one-liner, spoken_detail?, actions[] }` — rendered as a card with a
couple of gesture actions. No adaptive/hierarchical/learned compression yet; a single deterministic
summarize-to-card step is the MVP. The compression layer is also the **cost-quality story** (cheap model
does the squeezing) and the **non-distracting story** (compression *is* attention management).

## What this is

**wiser** is a hackathon project: a fleet of autonomous coding agents driven by voice and surfaced on Meta
Ray-Ban **Display** glasses — designed so they're *available everywhere but quiet by default*.

The end-to-end loop:

1. The user **talks** to an orchestrator agent (voice from the glasses).
2. The orchestrator **translates** that intent into concrete tasks for a fleet of **Claude-managed coding agents** (Claude Agent SDK).
3. The agent fleet runs autonomously and produces raw results.
4. A **distiller** condenses those results into compact **cards**.
5. Cards render on the **Ray-Ban Meta Display glasses**; the user can **deep-dive** into any card for detail.

**Nemotron Ultra** (NVIDIA) is in the stack as a model option — likely for the fast translate/distill steps where Claude agents are overkill.

## Operating principle

**Optimize for getting things done over code quality.** This is a hackathon. Prefer the shortest path to a working demo: hardcode where it unblocks you, skip abstractions until they pay for themselves, and don't gold-plate. Reach for the scaffolding skills below instead of hand-rolling boilerplate.

## Current state

The repo is **empty** — initialized git only, no commits, no scaffolding yet. The first job is to scaffold the pieces below. There are no build/lint/test commands to document until the stack is chosen and scaffolded; add them here once they exist.

## Architecture (intended)

Three cooperating pieces — keep them loosely coupled so they can be built and demoed independently:

- **Glasses display app** — what the user sees/controls. Renders cards, handles D-pad navigation and deep-dive. Two viable paths (pick for speed):
  - **Webapp** (recommended for hackathon speed): 600×600 dark-theme display, D-pad nav. Use the `meta-wearables-webapp:*` skills (`create-webapp`, `add-ui`, `connect-api`, `test-on-device`, `publish-to-vercel`).
  - **iOS** (DAT SDK): camera streaming + on-glass display via the Meta Wearables Device Access Toolkit. Use the `mwdat-ios:*` skills (`getting-started`, `display-access`, `camera-streaming`, `mockdevice-testing`).
- **Orchestrator backend** — receives voice/intent, translates to tasks, dispatches the Claude agent fleet, then distills results into cards and serves them to the display app (REST/WebSocket).
- **Agent fleet** — the autonomous coding agents. Built on the **Claude Agent SDK**; scaffold a new one with the `agent-sdk-dev:new-sdk-app` skill. Verify SDK apps with `agent-sdk-dev:agent-sdk-verifier-py` / `-ts`.

Data contract that ties it together: agents emit results → distiller normalizes them into a **card** shape (title + summary + drill-down payload) → display app renders the card list and the deep-dive view. Define this card schema early; it's the seam between the three pieces.

## Relevant skills (use these instead of building from scratch)

- **Claude Agent SDK**: `agent-sdk-dev:new-sdk-app`, `agent-sdk-dev:agent-sdk-verifier-{py,ts}`
- **Meta Display glasses webapp**: `meta-wearables-webapp:create-webapp`, `add-ui`, `connect-api`, `add-device-sensors`, `add-local-storage`, `test-on-device`, `publish-to-vercel`, `qr-code`, `passcode-for-testing`
- **Meta glasses iOS (DAT SDK)**: `mwdat-ios:getting-started`, `display-access`, `camera-streaming`, `session-lifecycle`, `mockdevice-testing`, `debugging`
- **Frontend polish** (for the card UI): `frontend-design:frontend-design` / `impeccable`

When the user references the Claude Agent SDK, the Claude API, or model IDs/pricing, consult the `claude-api` skill rather than answering from memory.
