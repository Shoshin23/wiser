import type { Card } from "./types";

// Dumb-local distillation for now: title = first few words of the answer.
// Swap in a Haiku/Nemotron call here later without touching the pipeline.
export function distill(answer: string, transcript: string): Card {
  const words = answer.split(/\s+/).filter(Boolean);
  const title = words.slice(0, 6).join(" ") + (words.length > 6 ? "…" : "");
  return {
    title: title || transcript.slice(0, 40) || "Result",
    summary: answer,
  };
}
