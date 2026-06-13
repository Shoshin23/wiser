import OpenAI from "openai";

// NVIDIA Nemotron on Nebius Token Factory (OpenAI-SDK compatible).
// Used for the cheap/fast steps: intent->tasks and distilling agent results
// into glanceable cards. Heavy coding stays on the Claude agent fleet.
const BASE_URL = process.env.NEBIUS_BASE_URL ?? "https://api.tokenfactory.nebius.com/v1/";

// Model-IDs are namespaced + case-sensitive on Nebius — a typo 404s.
export const NEMOTRON_NANO = process.env.NEMOTRON_NANO_MODEL ?? "nvidia/nemotron-3-nano-30b-a3b";
export const NEMOTRON_SUPER = process.env.NEMOTRON_SUPER_MODEL ?? "nvidia/nemotron-3-super-120b-a12b";

/** True when a Nebius key is configured; callers fall back to local logic if not. */
export const nemotronEnabled = !!process.env.NEBIUS_API_KEY;

// Lazily constructed so the backend boots without a Nebius key (distiller falls
// back to the dumb-local path).
let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!_client) {
    _client = new OpenAI({ baseURL: BASE_URL, apiKey: process.env.NEBIUS_API_KEY });
  }
  return _client;
}

export interface DistilledCard {
  title: string;
  summary: string;
}

const CARD_SCHEMA = {
  name: "card",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "summary"],
    properties: {
      title: { type: "string", description: "<=6 words, the irreducible signal — a decision, blocker, or result" },
      summary: { type: "string", description: "1-2 short lines a human can read at a glance" },
    },
  },
} as const;

/**
 * Distill a raw agent answer into one glanceable card via Nemotron Nano.
 * Schema is in the param AND the prompt (small MoE models occasionally emit a
 * stray prefix); we validate-and-retry once before giving up to the caller.
 */
export async function distillCard(answer: string, transcript: string): Promise<DistilledCard> {
  const system =
    "You compress a coding agent's result into ONE glanceable card for AR glasses. " +
    "Keep only what a human must see: a decision, an approval, a blocker, or the result. " +
    "Drop the noise. Respond ONLY as JSON: { \"title\": string (<=6 words), \"summary\": string (1-2 lines) }.";
  const user = `User asked: ${transcript}\n\nAgent result:\n${answer}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await client().chat.completions.create({
      model: NEMOTRON_NANO,
      response_format: { type: "json_schema", json_schema: CARD_SCHEMA },
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const raw = resp.choices[0]?.message?.content ?? "";
    try {
      const parsed = JSON.parse(raw) as DistilledCard;
      if (parsed.title && parsed.summary) return parsed;
    } catch {
      // fall through to retry
    }
  }
  throw new Error("Nemotron distill returned no valid card after 2 attempts");
}

export interface IntentTask {
  title: string;
  agent: "coder" | "reviewer" | "researcher";
}

const CREATE_TASKS_TOOL = {
  type: "function" as const,
  function: {
    name: "create_tasks",
    description: "Break a user intent into discrete coding tasks",
    parameters: {
      type: "object",
      required: ["tasks"],
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            required: ["title", "agent"],
            properties: {
              title: { type: "string" },
              agent: { type: "string", enum: ["coder", "reviewer", "researcher"] },
            },
          },
        },
      },
    },
  },
};

/** Turn a spoken intent into a list of discrete tasks via Nemotron Nano tool-calling. */
export async function intentToTasks(intent: string): Promise<IntentTask[]> {
  const resp = await client().chat.completions.create({
    model: NEMOTRON_NANO,
    messages: [{ role: "user", content: intent }],
    tools: [CREATE_TASKS_TOOL],
    tool_choice: "auto",
  });
  const call = resp.choices[0]?.message?.tool_calls?.[0];
  if (call?.type !== "function") return [];
  try {
    const args = JSON.parse(call.function.arguments) as { tasks?: IntentTask[] };
    return args.tasks ?? [];
  } catch {
    return [];
  }
}
