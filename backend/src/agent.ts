import { query } from "@anthropic-ai/claude-agent-sdk";

// The "managed agent" seam. Right now it's a one-turn, no-tools answer.
// Later this widens into the coding-agent fleet: add tools/systemPrompt preset/
// cwd/maxTurns here and nothing else in the pipeline has to change.

const MODEL = process.env.ANSWER_MODEL ?? "claude-sonnet-4-6";
const SYSTEM =
  "You are wiser, a concise voice assistant heard through smart glasses. " +
  "Answer in 1-3 short spoken sentences. Plain text only — no markdown, lists, or emoji.";
const TIMEOUT_MS = 60_000;

/**
 * Run a single managed-agent turn. Pass an optional base64 image (no data: prefix)
 * to use the multimodal flow. Returns the final assistant text.
 */
export async function askAgent(
  text: string,
  imageB64?: string,
  mediaType = "image/jpeg",
): Promise<string> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

  // String prompt for text-only; async-iterable user message for image input.
  const prompt = imageB64
    ? (async function* () {
        yield {
          type: "user" as const,
          parent_tool_use_id: null,
          session_id: "",
          message: {
            role: "user" as const,
            content: [
              { type: "text", text },
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: imageB64 },
              },
            ],
          },
        };
      })()
    : text;

  try {
    for await (const m of query({
      // cast: the SDK's streaming-input message type drifts across versions;
      // structural shape above is correct at runtime (tsx/esbuild does no typecheck).
      prompt: prompt as any,
      options: {
        model: MODEL,
        systemPrompt: SYSTEM,
        maxTurns: 1,
        allowedTools: [],
        abortController: abort,
      },
    })) {
      const msg = m as any;
      if (msg.type === "result") {
        if (msg.subtype === "success") return String(msg.result ?? "").trim();
        throw new Error(`agent failed: ${msg.subtype}`);
      }
    }
    throw new Error("agent produced no result message");
  } finally {
    clearTimeout(timer);
  }
}
