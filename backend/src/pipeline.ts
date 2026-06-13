import { transcribe, synthesizeChunks } from "./groq";
import { askAgent } from "./agent";
import { distill } from "./card";
import type { AskResponse } from "./types";

interface AskOpts {
  filename?: string;
  contentType?: string;
  imageB64?: string;
  imageMediaType?: string;
}

/** Full voice pipeline: STT -> managed agent -> TTS -> card. */
export async function runAsk(audio: Buffer, opts: AskOpts = {}): Promise<AskResponse> {
  const transcript = await transcribe(audio, opts.filename, opts.contentType);
  return runAskText(transcript, opts.imageB64, opts.imageMediaType);
}

/** Same pipeline from a typed prompt (skips STT). Used by the text fallback. */
export async function runAskText(
  transcript: string,
  imageB64?: string,
  imageMediaType?: string,
): Promise<AskResponse> {
  const answer = await askAgent(transcript, imageB64, imageMediaType);
  // TTS is best-effort: a failure (e.g. Groq model terms not yet accepted) must not
  // sink the card. The webapp just shows the answer with no audio.
  let audioChunks: string[] = [];
  try {
    audioChunks = await synthesizeChunks(answer);
  } catch (err) {
    console.warn("TTS failed (continuing without audio):", err instanceof Error ? err.message : err);
  }
  const card = distill(answer, transcript);
  return { transcript, answer, audioChunks, card };
}
