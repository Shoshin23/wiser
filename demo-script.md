# wiser — demo script (2:00)

The real demo the team converged on: a **live brainstorm** where agents listen, pull ideas into
cards, and go build them — and you can join and steer **from the glasses**, hands-free.

Through-line: we're brainstorming features for a **toy repo — a tiny Linear (issue tracker)**.
The repo is hardcoded/connected up front. No intro slide — just show the stuff.

Setup on stage: laptop runs the scan loop (STT → Nemotron/Haiku → cards). One person wears the glasses.
A paper sketch is ready to photograph. Agents run on **Sonnet (fast)** so a change lands live.

Beat format: **[lens]** what's on the glasses · **[screen]** the brainstorm board · **[you do]** action · then the line.

---

## 0:00 — Cold open (no intro)

**[screen]** the toy issue-tracker repo, almost no features.

> "This is our project — a tiny issue tracker. We're about to brainstorm what to build next.
> The twist: the agents are in the room, listening."

**[you do]** click / say **"wiser on."** Listening waves start.

> "wiser is now listening to the meeting. Watch what it does with everything we say."

---

## 0:20 — The scan loop catches an idea

**[you do]** talk naturally, drop an idea: *"we need fast search across all our issues."*

**[screen]** a **card** pops up: *Feature — fast issue search.* Tagged with the cheap model that found it.

> "Nobody typed that. wiser is transcribing the brainstorm, and a cheap model — Nemotron — pulls the
> real idea out of the noise and drops it as one card. The firehose of a meeting, collapsed to the
> thing worth doing."

**[you do]** another voice, a bug: *"archived issues don't show up in search."*

**[screen]** second card: *Bug — search skips archived.*

> "Two ideas, two cards. A feature and a bug — already actionable."

---

## 0:55 — Contribute from the glasses (the wow)

**[lens]** the same brainstorm, live on the glasses — running sessions + the cards.
**[you do]** glasses-wearer: *"I can join this from here — no laptop."* Snap a photo of the paper sketch.

> "And I don't have to be at the screen. I'm in the room, in the moment — I sketched a layout on paper,
> so I just look at it and snap it. That photo feeds straight into the same scan."

**[screen]** the image becomes a third card: *Feature — move the label control, from a sketch.*

> "Vision-capable model, same loop. Real-world context, dropped in at exactly the right moment —
> without anyone breaking the conversation to write it down."

---

## 1:25 — Spawn the fleet

**[you do]** approve the cards → managed agents spin up, one per idea, in parallel.

**[screen]** sessions board: 3 agents running — tokens / files changing live.
**[lens]** a calm line: *3 sessions building.* That's all the glasses show.

> "Approve, and each card becomes a cloud agent — running in parallel, building against the real repo.
> On the glasses I don't get a feed to babysit. Just one calm line: building. They work; I stay present."

---

## 1:45 — Close the loop (payoff)

**[screen]** the first agent commits & pushes → the live page updates: the **search feature is there.**
**[lens]** one ping: *✓ committed — search shipped.*

> "And here's the payoff — the agent finished, pushed, and the app just changed in front of us. The idea
> someone said out loud, two minutes ago, is now live.
>
> Agents in the room with you. They catch the idea, they build it — and they only tap you when they
> need you. That's wiser."

---

### Notes
- ~300 words spoken ≈ 2:00 at a calm pace. If long, cut the bug card (0:50) first — keep feature + glasses sketch.
- Hardcoded: repo connection, brainstorm session (single, already running). "wiser on" can be a button.
- Glasses must do two things on-lens: **contribute** (photo → scan) and **glance** (sessions/cards line). That's the glasses-first bar.
- Cheap-model story = Nemotron/Haiku does the scan/compression; Sonnet-fast does the build so it lands live.
- Parallel agents (feature + bug + sketch) carry the multi-agent "wow"; only the feature needs to visibly finish.
- Honest Q&A: it's pinch/photo-to-capture, not always-on meeting surveillance — framed as steering, not recording.
