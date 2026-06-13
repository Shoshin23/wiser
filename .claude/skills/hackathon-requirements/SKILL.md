---
name: Hackathon requirements (wiser)
description: The brief, judging criteria, and deliverable spec for the hackathon wiser is built for. Use when scoping features, deciding what to build or cut, planning the demo, writing the submission README, or choosing models/architecture — to keep work aligned with what is actually judged. The theme is multi-agent & autonomous coding agents; the deliverable is a demo + a public repo one-pager, and judging rewards the workflow pattern and measurable evidence, not app polish.
when_to_use: hackathon, judging, criteria, deliverable, submission, demo, scope, what to build, what to cut, README one-pager, evidence, metrics, cost-quality, agentic leverage
user-invocable: true
---

# Hackathon requirements — what `wiser` is judged on

**Theme:** multi-agent & autonomous coding agents.

**The core point:** judges are **not** picking the most polished final app. They are judging an
**effective workflow pattern for using state-of-the-art coding agents**. A working app is *evidence*, not
the goal. Every decision should answer the three questions below.

## The three questions every submission must answer

1. **What workflow did you design?**
2. **Why does it work?**
3. **What data shows that it works?**

If a feature doesn't help answer one of these, it's probably a distraction. Spend effort on the **loop and
the evidence**, not on UI gold-plating (the `glasses` skill's "optimize for getting things done" applies).

## Deliverable

A **public GitHub repository** with a concise overview — think short README / one-pager judges can skim:

- **What you built**
- **The agent workflow you designed**
- **Key architectural decisions**
- **Evidence** — benchmarks, evals, metrics, or learnings

Plus a **live demo + Q&A**.

> ⚠️ **Timing discrepancy — confirm with organizers.** The written brief says **3-min demo + 2-min Q&A**;
> the *Deliverable* slide says **2-min demo + 1-min Q&A**. Plan/rehearse to the **shorter** (2+1) to be
> safe, with extra material ready if it's 3+2.

## Judging criteria (from the Criteria slide)

| Criterion | What they're asking |
|---|---|
| **Agentic leverage** | Did you go **beyond** a basic Claude Code / Cursor / Codex run? |
| **Measurable impact** | Benchmarks, evals, tests, performance gains, cost savings, time saved. |
| **Quality of the agent loop** | Feedback, verification, iteration, reviewers, benchmarks, parallel agents. |
| **Technical ambition** | Meaningful engineering challenges and real-world constraints. |
| **Cost–quality trade-offs** | Smart use of models, compute, orchestration, parallelism. |
| **Collaboration** | Effective team composition + division of responsibilities; combined skills. |
| **Demo clarity** | Can you clearly explain what you built, how it worked, and why it matters? |

## What the strongest submissions show

- **Agentic leverage beyond a basic single prompted run.**
- **Technical ambition.**
- **Measurable improvement** — via tests, benchmarks, evals, diffs, wall-clock time saved, $/token cost
  saved, or higher task quality. *Capture baseline vs after numbers.*
- **A structured agent loop** where models receive feedback and iterate.
- **Smart cost-quality tradeoffs** — model choice, parallelism, runtime.
- **A clear explanation** of the workflow pattern and why the result matters.

**Especially exciting to judges:** verifier agents, benchmark loops, parallel experiments, memory across
iterations, agents making substantial structural changes, and teams exploring the **cost-quality frontier**.
> Their framing example: *can many cheaper/faster Cursor 2.5 or Nemotron 3 Ultra agents reach the same
> quality as one slower, more expensive Fable-class agent?*

**Worked example they gave:** take an existing layout resolver, set up an **agent-driven benchmark loop**,
and improve perf from microseconds → nanoseconds via repeated profile → edit → benchmark → compare-vs-baseline.

## Codebase choice

Any: new prototype, existing side project, your startup's software, job software, or open-source.
**Brownfield is especially interesting** — agents dealing with real constraints beat a toy greenfield app.

## Team

Teams of **2–4 strongly encouraged**. Solo allowed but judged against the **same absolute bar**, so larger
teams have better odds. (`wiser` is a team — make the **Collaboration** criterion explicit in the demo:
who owned what, how perspectives combined.)

## Implications for `wiser` (turn the brief into a checklist)

`wiser` = voice-driven fleet of Claude coding agents, results distilled into cards on Ray-Ban Display.
To score against the criteria above, make sure the build produces:

- [ ] **The loop, made visible** — orchestrator → fleet → distiller → cards → approval is itself the
      "structured agent loop with feedback." Show it explicitly in the demo, not just the output.
- [ ] **Verification / reviewer agents** in the fleet, not just generators — directly hits *Quality of the
      agent loop*.
- [ ] **Measured evidence** — instrument the run: wall-clock saved, tokens/$ per task, parallel-vs-serial,
      task quality/diff acceptance. A simple before/after table beats a prettier card.
- [ ] **Explicit cost-quality story** — Nemotron Ultra for fast translate/distill, Claude agents for the
      hard coding; ideally a small experiment showing N cheap agents vs 1 expensive one on the same task.
- [ ] **Parallelism / experiments** — multiple agents or experiment variants, not one linear run.
- [ ] **Brownfield target** if feasible — run the fleet against a real repo with real constraints.
- [ ] **The one-pager README** — written alongside the build: what / workflow / architecture / evidence.
- [ ] **A tight 2-minute demo** that *shows the workflow pattern* and the data, ending on "why it matters."

## Sources

Hackathon brief + Deliverable/Criteria slides (provided by organizers, captured 2026-06-13).
