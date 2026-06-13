---
name: Sample projects & test tasks (wiser)
description: A stable of concrete, pre-baked software tasks to hand the running wiser app — for rehearsing the full loop (voice/whiteboard → fleet → card → glasses) and demoing it in ~2 minutes. Use when you need something for the fleet to actually DO during testing or a live demo, picking a task that fits the time/flake budget, setting up the demo sandbox repo, or wiring the whiteboard-sketch→build path. Complements demo-target (which picks the headline-metric hero); this is the everyday test bench + the whiteboard wow. Verified June 2026.
when_to_use: sample project, test task, demo task, what to feed the fleet, rehearsal, 2-minute demo, whiteboard, sketch to code, wireframe to UI, seed repo, demo sandbox, scaffold a feature, add dark mode, red to green, fix failing test, small dev task, fallback demo
user-invocable: true
---

# Sample projects & test tasks — what to hand the running app

Once the loop (voice/whiteboard → orchestrator → Claude fleet → distiller → card → glasses) is wired, you
need **stable, rehearsed things for the fleet to actually work on.** This skill is that bench: a small set of
tasks chosen for a **~2-minute demo** — fast, visual, and each producing a real card *decision* (approve a
diff, pick a winner, clarify) so the glasses UX has something to do.

**Relationship to [[demo-target]]:** `demo-target` answers *"what produces the best headline metric"* (the
Rust `criterion` perf hero). **This skill** is the everyday test bench + the **whiteboard wow** — the things
you hand the app while building, rehearsing, and during the live segment that shows the *pipeline*, not a
benchmark number. Run the perf hero for the metric slide; run these for the live loop.

## Pre-stage a "demo sandbox" — do NOT clone repos live

Keep one tiny repo pre-cloned in the workspace so the fleet always has somewhere to work — no live `git
clone`, no `npm install` on conference WiFi. Two small apps cover every task below:

- **`webapp/`** — a one-page Vite + React (or plain HTML) site with a couple of components and `npm run dev`
  already warm. The target for "add a feature" and "build this sketch" tasks; the result is *visible*.
- **`lib/`** — a tiny Python (or TS) module with a `pytest`/`vitest` suite already passing. The target for
  red→green and "write tests" tasks; the result is a *deterministic green checkmark*.

Pre-warm everything the night before: deps installed, dev server boots, test suite green, models reachable.
The agent edits files *in this repo*; the card shows the diff/result; you approve via gesture.

## Tier A — Whiteboard sketch → build (the wow, medium risk)

The showstopper: it puts the **glasses camera** in the loop. Draw on a whiteboard → glasses capture the photo
→ Nemotron reads the sketch (see [[nemotron]] whiteboard-OCR) → orchestrator turns it into a task → fleet
builds it in `webapp/` → card shows *"Built your sketch — preview / approve?"* → you approve and it renders.

Keep the sketch **dead simple and high-contrast** (thick marker, few boxes, label the boxes in words). The
words matter more than the drawing — Nemotron reads "EMAIL", "PASSWORD", "LOG IN" far more reliably than it
infers intent from geometry. Pre-rehearse the exact drawing.

| Sketch | Fleet builds | Why it demos well |
|---|---|---|
| **Login form** — two labeled boxes + a button | A styled `<LoginForm>` component | Universally legible; instant visual payoff |
| **Pricing cards** — 3 columns, labels "Free / Pro / Team" | A 3-card pricing row | Structure is obvious from the sketch; looks impressive rendered |
| **Profile card** — avatar circle + name + 2 lines | A profile card component | Tiny, fast, hard to get wrong |
| **Nav bar** — logo box + 3 link labels | A top nav component | Single component, clear approve/reject |

> ⚠️ **Risk:** LLM-from-photo UI is the flakiest beat (lighting, handwriting, generation variance).
> **Mitigations:** (1) rehearse the *exact* sketch + lighting; (2) keep a **known-good pre-generated diff**
> ready to fall back to if the live read garbles; (3) constrain the prompt — "build ONLY a login form with
> the labeled fields, Tailwind, no router." Treat the live build as the wow but have the canned result armed.

## Tier B — Voice → small feature (visual, fast, low risk)

Speak a small change; fleet edits `webapp/`; card surfaces a one-line diff summary to approve. ~20–40s each.

| Voice prompt | Card decision | Notes |
|---|---|---|
| "Add a dark-mode toggle to the page" | *"Added theme toggle (+1 file) — approve?"* | Visual flip on approve; crowd-pleaser |
| "Add validation so the email field rejects bad input" | *"Added email validation + 2 tests — approve?"* | Pairs edit with a passing test |
| "Add a loading spinner while the data fetches" | *"Added spinner on fetch — approve?"* | Visible, self-contained |
| "Add a `/health` endpoint returning `{status:'ok'}`" | *"Added GET /health — tests green — approve?"* | If sandbox has a tiny server |

These are the **safest live tasks**: the scope is one component, the result is on screen, the card decision
is genuine. Default to these for the reliable middle of the demo.

## Tier C — Deterministic red→green (the bulletproof fallback)

When live-flake is unacceptable (judges watching, bad WiFi), run a task whose outcome is a **fixed green
checkmark**, not generated UI. Operate on `lib/`.

| Task | Card decision | Why bulletproof |
|---|---|---|
| "Fix the failing test in `parser`" | *"3/3 tests now green — approve diff?"* | Plant one broken function; red→green is deterministic |
| "Write tests for `slugify` and get them passing" | *"Added 5 tests, all green — approve?"* | Iterations-to-green metric ([[measurement]]) |
| "This function is O(n²) — make it O(n), keep tests green" | *"Refactored, 8/8 green — approve?"* | Tiny taste of the perf story without criterion setup |

Plant the bug / missing tests ahead of time so the loop is rehearsed. This tier is the **safety net**: if a
Tier A/B beat wobbles, pivot here and still show the full loop landing on a clean card.

## Best-of-N variant (most on-theme for a fleet)

Any Tier B/C task can be run **fanned out**: N agents attempt it in parallel, a verifier picks the one that
passes tests, card shows *"Agent 3 of 5 passed — approve winner?"*. This is the clearest visual of *why a
fleet beats one agent* and gives the gesture a real "pick the winner" job. See [[demo-target]] best-of-N and
[[agent-sdk]]/[[managed-agents]] for the parallel-session wiring.

## Picking a task — the 2-minute budget

A clean 2-minute live segment is roughly: **one Tier A whiteboard beat** (the wow) **+ one Tier B voice
beat** (reliable, shows steering), with **Tier C armed as fallback**. Don't try to show all three tiers —
pick two beats and rehearse them cold.

| If you want to show... | Run |
|---|---|
| The whole pipeline incl. camera | Tier A whiteboard sketch → build |
| Hands-free steering of agents | Tier B voice → feature → gesture approve |
| Rock-solid reliability | Tier C red→green |
| "Fleet > single agent" | Best-of-N variant of any B/C task |
| A real metric for the slide | **Not here — use [[demo-target]]** (criterion perf) |

## Rehearsal checklist

- [ ] Sandbox repo pre-cloned; `webapp/` dev server boots; `lib/` suite green.
- [ ] All deps installed offline; no live `clone`/`install` in the demo.
- [ ] Models reachable (Claude fleet + [[nemotron]] distiller); keys set.
- [ ] Whiteboard sketch drawn & photographed once to confirm Nemotron reads it; **canned diff armed**.
- [ ] Each chosen task run end-to-end at least twice; card copy reads cleanly on the 600×600 surface ([[card-ui]]).
- [ ] Tier C fallback rehearsed so you can pivot mid-demo without fumbling.
- [ ] Gestures (approve / pick winner / clarify) mapped and tested on-device ([[glasses]]).

**Bottom line:** keep a pre-warmed sandbox repo, lead the live loop with **one whiteboard sketch→build** beat
plus **one voice→feature** beat, and keep a **deterministic red→green** task armed as the safety net. Use
[[demo-target]] when you need the headline number, not the pipeline story.
