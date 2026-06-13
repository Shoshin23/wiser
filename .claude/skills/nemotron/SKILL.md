---
name: Nemotron on Nebius (wiser)
description: How wiser calls NVIDIA Nemotron models via Nebius (Token Factory) for the cheap/fast steps — intent→tasks, distilling agent results into glanceable cards, optional whiteboard-image reading, and the cost-quality experiment. Use when writing the orchestrator's translate/distill calls, picking a Nemotron model, wiring the OpenAI-compatible Nebius client, requesting JSON/structured output or tool calls, or computing the Nebius credit budget. OpenAI-SDK compatible. Verified June 2026.
when_to_use: nemotron, nebius, token factory, inference, distiller, intent to tasks, cheap model, json mode, structured output, tool calling, whiteboard OCR, cost-quality, NEBIUS_API_KEY, openai compatible
user-invocable: true
---

# Nemotron on Nebius — wiser's fast/cheap layer

Nemotron does the **high-volume, latency-sensitive, cheap** work; Claude agents do the heavy coding. All
Nemotron models are **OpenAI-SDK compatible** on Nebius **Token Factory**.

- **Base URL:** `https://api.tokenfactory.nebius.com/v1/` (NOT the old `api.studio.nebius.com` — Token
  Factory is the unified host; make sure your **$100 credit is on the Token Factory account**).
- **Auth:** Bearer `NEBIUS_API_KEY`.
- **Model IDs are namespaced & case-sensitive** (`nvidia/...`) — copy exact casing from the console list; a
  typo is a 404/400.

## Model picks & role mapping

| wiser role | Model | Nebius ID | Why |
|---|---|---|---|
| **intent → tasks** (high volume) | Nemotron 3 Nano 30B (reasoning **off/low**) | `nvidia/nemotron-3-nano-30b-a3b` | ~$0.06/$0.24 per M, fast, tool-calling + JSON, big context |
| **distill results → cards** | Nemotron 3 Nano 30B (JSON mode) | `nvidia/nemotron-3-nano-30b-a3b` | summarization is its sweet spot; reliable card structs |
| **cost-quality coding agent** | Nemotron 3 Super 120B (reasoning **on**) | `nvidia/nemotron-3-super-120b-a12b` | NVIDIA positions Super for agentic/coding; $0.30/$0.90 per M — the cheap foil to a Fable/Opus Claude agent |
| **whiteboard image → tasks** (optional) | Nemotron 3 Nano Omni 30B | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | the **only** Nemotron on Nebius that takes images; good OCR/diagram reading |

> The brief's "**Nemotron 3 Ultra / Nemotron Ultra**" = the ~500B tier — **not confirmed live on Nebius**
> as of June 2026. Build on **Nano + Super** (both live). Old `llama-3.1-nemotron-ultra-253b-v1` exists but
> is slower/pricier — don't use it.

**Capabilities (Nebius-served):** Nano & Super = text, tool-calling ✅, JSON ✅, reasoning-toggle ✅, no
images. Nano Omni = adds image/video/audio input. Nano/Super context 256K–1M; Omni 256K.

## Call it — distiller (card JSON)

```python
from openai import OpenAI
from pydantic import BaseModel
import os
client = OpenAI(base_url="https://api.tokenfactory.nebius.com/v1/", api_key=os.environ["NEBIUS_API_KEY"])

class Card(BaseModel):
    title: str; status: str; summary: str; next_action: str

resp = client.chat.completions.create(
    model="nvidia/nemotron-3-nano-30b-a3b",
    response_format={"type": "json_schema", "json_schema": Card.model_json_schema()},
    messages=[
        {"role": "system", "content": "Distill into ONE glanceable card. Respond ONLY in the given JSON schema."},
        {"role": "user", "content": agent_result_text},
    ],
    temperature=0.2,
)
card = Card.model_validate_json(resp.choices[0].message.content)  # validate + retry once on failure
```
Nebius supports `{"type":"json_schema",...}` and `{"type":"json_object"}`. **Tip: also put the schema in
the prompt text**, not just the param — small MoE models occasionally emit a stray prefix, so wrap in a
validate-and-retry-once loop.

## Call it — intent → tasks (tool calling)

```python
tools = [{"type":"function","function":{
  "name":"create_tasks","description":"Break a user intent into discrete coding tasks",
  "parameters":{"type":"object","required":["tasks"],"properties":{
    "tasks":{"type":"array","items":{"type":"object","required":["title","agent"],"properties":{
      "title":{"type":"string"},
      "agent":{"type":"string","enum":["coder","reviewer","researcher"]}}}}}}}}]
resp = client.chat.completions.create(model="nvidia/nemotron-3-nano-30b-a3b",
    messages=[{"role":"user","content":"Add OAuth login and write tests"}],
    tools=tools, tool_choice="auto")
calls = resp.choices[0].message.tool_calls   # .function.arguments is JSON
```

TypeScript: same with `new OpenAI({ baseURL, apiKey })`, `response_format`, `stream: true` (SSE works).

## Whiteboard image (Nano Omni)

```python
resp = client.chat.completions.create(model="nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
  messages=[{"role":"user","content":[
    {"type":"text","text":"Extract the tasks written on this whiteboard as a list."},
    {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,..."}}]}])
```
(Confirm Omni's image payload shape against the Token Factory cookbook.) Alternatively keep vision on Claude.

## Reasoning toggle

Nemotron 3 is reasoning-capable with a toggle, but the **exact Nebius param is undocumented** — likely
`reasoning_effort: "low|medium|high"` or a `/think`–`/no_think` system directive (possibly via `extra_body`).
**Grab the real param from the Token Factory Discord Nemotron cookbook.** Keep reasoning **off/low** for the
high-volume intent/distill steps (speed + cost); turn it **on** only for the Super coding experiment.
Reasoning mode bloats output tokens and TTFT — stream so the demo doesn't hang.

## Cost & budget (the cost-quality evidence)

| Model | $/M in | $/M out | speed |
|---|---|---|---|
| Nano 30B | 0.06 | 0.24 | fast |
| Super 120B | 0.30 | 0.90 | ~376 t/s, ~7s TTFT |
| *Claude Sonnet (compare)* | ~3 | ~15 | — |

Nano output is **~17× cheaper than Sonnet**; Super **~16× cheaper** yet does tool-calling + reasoning — that
is the quantifiable "**many cheap Nemotron agents vs one expensive Claude agent**" evidence the brief wants.
**$100 credit on Nano** (~$0.10/M blended) ≈ **~1B tokens ≈ ~500K calls** — you won't run out. On Super
(~$0.45/M) ≈ ~220M tokens. Capture per-call token/$ to put a number on the cost-quality story.

## First-hour gotchas

1. **Use the `tokenfactory` host**, and confirm the $100 credit is on that account (not legacy `studio`).
2. **Exact model-ID casing** from the console — typos 404.
3. **Reasoning-toggle param** is the one thing not in public docs — get it from the cookbook before building
   reasoning-dependent steps.
4. **JSON:** schema-in-param *and* in-prompt, plus a validate-and-retry-once wrapper.
5. Reasoning models have **long TTFT** — stream or keep reasoning off in the demo path.

## Sources

[NVIDIA Nemotron 3 launch](https://nvidianews.nvidia.com/news/nvidia-debuts-nemotron-3-family-of-open-models) ·
[Nebius: Super on Token Factory](https://nebius.com/blog/posts/nemotron3-super-now-available) ·
[Nebius quickstart](https://docs.tokenfactory.nebius.com/quickstart) ·
[Nebius JSON/structured output](https://docs.tokenfactory.nebius.com/ai-models-inference/json) ·
[AA: Super](https://artificialanalysis.ai/models/nvidia-nemotron-3-super-120b-a12b/providers) ·
[OpenRouter: Nano Omni](https://openrouter.ai/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning). Verified June 2026.
