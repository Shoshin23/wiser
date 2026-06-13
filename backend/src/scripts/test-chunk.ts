// Pure-logic check for the TTS chunker (no API calls). Run: npm run test:chunk
import { chunkBySentence } from "../groq";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
}

// Sentence packing stays under the limit.
const a = chunkBySentence("Hello world. How are you today? I am fine.");
assert(a.length > 0, "produces chunks");
assert(a.every((c) => c.length <= 200), "all sentence chunks <= 200 chars");

// A long, punctuation-free run must hard-wrap at word boundaries with no data loss.
const long = Array(120).fill("word").join(" "); // ~600 chars
const lc = chunkBySentence(long);
assert(lc.every((c) => c.length <= 200), "hard-wrapped chunks <= 200 chars");
assert(lc.join(" ") === long, "hard-wrap loses no words");

// A single oversized token still gets split.
const huge = "x".repeat(450);
const hc = chunkBySentence(huge);
assert(hc.every((c) => c.length <= 200), "oversized token split <= 200 chars");
assert(hc.join("") === huge, "oversized token split loses nothing");

console.log("chunk test OK:", { sentences: a.length, longChunks: lc.length, hugeChunks: hc.length });
