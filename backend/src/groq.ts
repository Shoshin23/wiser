import Groq, { toFile } from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const STT_MODEL = process.env.STT_MODEL ?? "whisper-large-v3-turbo";
const TTS_MODEL = process.env.TTS_MODEL ?? "canopylabs/orpheus-v1-english";
const TTS_VOICE = process.env.TTS_VOICE ?? "Hannah";
const TTS_MAX_CHARS = 200; // Groq Orpheus TTS hard limit per request

/** Speech -> text. Whisper needs a filename+content-type or it 400s. */
export async function transcribe(
  buffer: Buffer,
  filename = "recording.webm",
  contentType = "audio/webm",
): Promise<string> {
  const file = await toFile(buffer, filename, { type: contentType });
  const res = await groq.audio.transcriptions.create({
    file,
    model: STT_MODEL,
    language: "en",
  });
  return res.text.trim();
}

/** One <=200-char chunk -> base64 WAV. */
export async function synthesize(text: string): Promise<string> {
  const res = await groq.audio.speech.create({
    model: TTS_MODEL,
    voice: TTS_VOICE,
    input: text,
    response_format: "wav",
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString("base64");
}

/** Synthesize a full answer as ordered base64 WAV chunks (parallel calls, order preserved). */
export async function synthesizeChunks(text: string): Promise<string[]> {
  const chunks = chunkBySentence(text);
  return Promise.all(chunks.map(synthesize));
}

/** Split into <=maxChars pieces: pack sentences, then hard-wrap any oversized piece at word boundaries. */
export function chunkBySentence(text: string, maxChars = TTS_MAX_CHARS): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) ?? [text];
  const chunks: string[] = [];
  let cur = "";

  const flush = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = "";
  };

  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (sentence.length > maxChars) {
      flush();
      chunks.push(...hardWrap(sentence, maxChars));
      continue;
    }
    if ((cur + " " + sentence).trim().length > maxChars) {
      flush();
      cur = sentence;
    } else {
      cur = cur ? `${cur} ${sentence}` : sentence;
    }
  }
  flush();
  return chunks.filter(Boolean);
}

function hardWrap(s: string, maxChars: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of s.split(/\s+/)) {
    if (word.length > maxChars) {
      if (cur) { out.push(cur); cur = ""; }
      for (let i = 0; i < word.length; i += maxChars) out.push(word.slice(i, i + maxChars));
      continue;
    }
    if ((cur + " " + word).trim().length > maxChars) {
      out.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) out.push(cur);
  return out;
}
