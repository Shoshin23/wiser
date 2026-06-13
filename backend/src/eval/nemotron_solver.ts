import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import type { SolveResult } from "./solver.js";

// Chat-completion solver for NVIDIA Nemotron on Nebius Token Factory. Nemotron is
// not an agent harness — it's a chat model — so the "session" is just a message
// array we persist in the workdir (_conv.json). Resume = reload + append one msg.
const BASE_URL = process.env.NEBIUS_BASE_URL ?? "https://api.tokenfactory.nebius.com/v1/";

// $/M (in,out) — from the nemotron skill, June 2026.
const PRICE: Record<string, { in: number; out: number }> = {
  "nvidia/nemotron-3-super-120b-a12b": { in: 0.3, out: 0.9 },
  "nvidia/nemotron-3-nano-30b-a3b": { in: 0.1, out: 0.3 },
};

let _c: OpenAI | null = null;
const client = () => (_c ??= new OpenAI({ baseURL: BASE_URL, apiKey: process.env.NEBIUS_API_KEY }));

export const isNemotron = (model: string) => model.startsWith("nvidia/");

// Take the last fenced code block (reasoning models emit prose/think first).
function extractCode(text: string): string {
  const blocks = [...text.matchAll(/```[a-zA-Z0-9+_-]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const code = blocks.length ? blocks[blocks.length - 1] : text;
  return code.trim() + "\n";
}

export async function nemotronSolve(
  prompt: string,
  wd: string,
  solutionFile: string,
  model: string,
  resume: boolean,
): Promise<SolveResult> {
  const convPath = path.join(wd, "_conv.json");
  const sys = {
    role: "system" as const,
    content: `You are an expert programmer. Reply with ONLY the complete, final contents of the file \`${solutionFile}\` inside a single fenced code block. No prose outside the code block.`,
  };
  let messages: any[];
  if (resume && fs.existsSync(convPath)) {
    messages = JSON.parse(fs.readFileSync(convPath, "utf8"));
  } else {
    messages = [sys];
  }
  messages.push({ role: "user", content: prompt });

  const out: SolveResult = {
    sessionId: "nemotron",
    costUsd: 0,
    inTok: 0,
    outTok: 0,
    numTurns: 1,
    subtype: "success",
  };
  try {
    const resp = await client().chat.completions.create({
      model,
      messages,
      temperature: 0.2,
      max_tokens: 8000,
    });
    const content = resp.choices[0]?.message?.content ?? "";
    fs.writeFileSync(path.join(wd, solutionFile), extractCode(content));
    messages.push({ role: "assistant", content });
    fs.writeFileSync(convPath, JSON.stringify(messages));

    const u = resp.usage;
    const p = PRICE[model] ?? { in: 0.2, out: 0.6 };
    out.inTok = u?.prompt_tokens ?? 0;
    out.outTok = u?.completion_tokens ?? 0;
    out.costUsd = (out.inTok / 1e6) * p.in + (out.outTok / 1e6) * p.out;
  } catch (e) {
    out.subtype = `error:${(e as Error).message.slice(0, 80)}`;
  }
  return out;
}
