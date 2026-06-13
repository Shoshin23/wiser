"use strict";
// Single source of truth for the CODING agent's SYSTEM prompt + custom TOOLS
// (the streaming orchestrator). Shared by setup-coding-agent.js (fresh provision)
// and any in-place updater. Mirrors agent-config.js but for the coding fleet.
//
// The agent's *stored* system/tools (set via create) are what actually run. The
// custom tools below are host-executed (the distiller acks them) — they are the
// structured seam the distiller turns into {card} frames. agent_toolset_20260401
// supplies the real bash/write/edit/read tools.

const CODING_SYSTEM =
  "Autonomous coding assistant in a Linux sandbox (python3 and common tools preinstalled; you have a " +
  "network). Do whatever the user asks using the bash and file tools — make real edits and actually run " +
  "your work to verify it. After substantive edits call report_diff. If the task has tests and you run them, " +
  "call report_tests. Call checkpoint at meaningful milestones. When you need a human decision to proceed, " +
  "call ask_user (<=3 short options) and wait. Finish by calling done exactly once with a <=6-word headline, " +
  "a 1-sentence summary, status done|blocked, and optional stats. Keep tasks self-contained in the sandbox; " +
  "do not narrate progress in prose — the tools are the output.";

const CODING_TOOLS = [
  { type: "agent_toolset_20260401" },
  {
    type: "custom",
    name: "report_diff",
    description:
      "Report a code change after substantive edits: how many files changed and the +/- line counts, " +
      "with a one-line summary of what changed.",
    input_schema: {
      type: "object",
      properties: {
        files: { type: "number" },
        added: { type: "number" },
        removed: { type: "number" },
        summary: { type: "string" },
      },
      required: ["summary"],
    },
  },
  {
    type: "custom",
    name: "report_tests",
    description:
      "Report a test run after actually running the tests: how many passed, the total, and the names " +
      "of any failing tests.",
    input_schema: {
      type: "object",
      properties: {
        passed: { type: "number" },
        total: { type: "number" },
        failing: { type: "array", items: { type: "string" } },
      },
      required: ["passed", "total"],
    },
  },
  {
    type: "custom",
    name: "checkpoint",
    description:
      "Report an intermediate 'where are we' milestone: a short progress phrase and an optional note.",
    input_schema: {
      type: "object",
      properties: {
        progress: { type: "string" },
        note: { type: "string" },
      },
      required: ["progress"],
    },
  },
  {
    type: "custom",
    name: "ask_user",
    description:
      "Ask the human wearing the glasses a question when you need a decision/clarification to proceed; " +
      "shown on the lens and spoken; reply returned as the tool result. Provide <=3 short options for " +
      "tappable choices, omit for open-ended. Then wait.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string" },
        options: { type: "array", items: { type: "string" } },
      },
      required: ["question"],
    },
  },
  {
    type: "custom",
    name: "done",
    description:
      "Call EXACTLY ONCE at the very end to hand the final result to the glasses; rendered as a card and " +
      "spoken. <=6-word headline, 1-sentence summary, status done|blocked, and optional stats.",
    input_schema: {
      type: "object",
      properties: {
        headline: { type: "string" },
        summary: { type: "string" },
        status: { enum: ["done", "blocked"] },
        stats: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              value: { type: "string" },
            },
            required: ["label", "value"],
          },
        },
      },
      required: ["headline", "summary"],
    },
  },
];

module.exports = { CODING_SYSTEM, CODING_TOOLS };
