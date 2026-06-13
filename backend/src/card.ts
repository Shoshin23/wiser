import type { Card } from "./types";
import { distillCard, nemotronEnabled } from "./nemotron";

/** Cheap local fallback: title = first few words of the answer. */
function localDistill(answer: string, transcript: string): Card {
  const words = answer.split(/\s+/).filter(Boolean);
  const title = words.slice(0, 6).join(" ") + (words.length > 6 ? "…" : "");
  return {
    title: title || transcript.slice(0, 40) || "Result",
    summary: answer,
  };
}

/**
 * Distill an agent answer into a glanceable card. Uses Nemotron Nano (Nebius)
 * when NEBIUS_API_KEY is set; falls back to local truncation otherwise or on error.
 */
export async function distill(answer: string, transcript: string): Promise<Card> {
  if (!nemotronEnabled) return localDistill(answer, transcript);
  try {
    return await distillCard(answer, transcript);
  } catch (err) {
    console.warn("Nemotron distill failed (falling back to local):", err instanceof Error ? err.message : err);
    return localDistill(answer, transcript);
  }
}
