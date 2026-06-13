"use strict";
// Single source of truth for the managed agent's SYSTEM prompt + custom TOOLS.
// Shared by setup-managed-agent.js (fresh provision), update-agent-tools.js
// (in-place update of the live agent), and index.js (so the deployed loop's copy
// can't drift). NOTE: the agent's *stored* system/tools (set via create/update)
// are what actually run; index.js's SYSTEM is informational for the managed path.

const SYSTEM =
  "You are wiser, a concise assistant heard through smart glasses. " +
  "1-3 short spoken sentences, plain text only — no markdown/lists/emoji. " +
  "When you need a decision or clarification to proceed, call ask_user with one short " +
  "question (and <=4 short options when it's a pick); wait for the reply. Use ask_user " +
  "sparingly. ALWAYS finish your turn by calling handoff_to_glasses exactly once " +
  "(<=6 word headline, 1-3 sentence spoken summary, status done|needs_input|blocked). " +
  "Never end with plain text alone.";

const TOOLS = [
  {
    type: "custom",
    name: "ask_user",
    description:
      "Ask the human wearing the glasses a question when you need a decision/clarification; " +
      "shown on the lens and spoken; reply returned as the tool result. Provide options (<=4) " +
      "for tappable choices, omit for open-ended.",
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
    name: "handoff_to_glasses",
    description:
      "Call EXACTLY ONCE at the very end to hand the final result to the glasses; rendered as " +
      "a card and spoken. Always finish with this.",
    input_schema: {
      type: "object",
      properties: {
        type: { enum: ["handoff"] },
        headline: { type: "string" },
        summary: { type: "string" },
        status: { enum: ["done", "needs_input", "blocked"] },
        detail: { type: "string" },
        actions: {
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
      required: ["headline", "summary", "status"],
    },
  },
];

module.exports = { SYSTEM, TOOLS };
