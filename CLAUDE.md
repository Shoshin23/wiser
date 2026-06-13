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
