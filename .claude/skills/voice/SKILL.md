---
name: Voice loop (wiser)
description: How wiser does realtime voice on the glasses — talk to the orchestrator, glasses speak back, voice intent triggers agent actions. Use when building the iOS voice loop, choosing a realtime voice API, wiring AVAudioSession for the glasses' Bluetooth HFP audio, mapping voice intents to orchestrator tool calls, doing gesture push-to-talk, or debugging audio routing vs the DAT camera session. Recommends OpenAI Realtime (gpt-realtime) over WebRTC on iOS. Verified June 2026.
when_to_use: voice, realtime, speech to speech, gpt-realtime, openai realtime, gemini live, STT, TTS, AVAudioSession, bluetooth HFP, push to talk, barge-in, voice tool calling, microphone, deepgram
user-invocable: true
---

# Voice loop — wiser's spoken channel

Voice is the **detail-bandwidth channel** in the compression layer: the card shows the compressed signal,
voice fills in. Built on the **iOS DAT app** (web apps can't touch mic). Glasses audio = system **Bluetooth
HFP, 8 kHz mono** — no raw PCM, no "Hey Meta".

## Recommendation

**OpenAI Realtime API (`gpt-realtime`) over WebRTC, on the iOS phone, with the realtime model's
function-calling firing tools that hit the orchestrator. Index-pinch = push-to-talk. One short sentence per
reply.**

Why (1-day build): **one API = STT + LLM + TTS + VAD + barge-in + tool-calling** in a single connection —
a separate STT→LLM→TTS pipeline is 3 services / 3 failure modes you don't have time for. A maintained Swift
SDK (`m1guelpf/swift-realtime-openai`) already does mic capture, playback, ephemeral-key WebRTC connect, and
function-calling — the biggest day-of accelerator. Tool-calling *is* the point: voice intent → orchestrator
action, with the model talking while the call is pending.

**Fallback:** Gemini 3.1 Flash Live (same single-connection model, but tool-calling is blocking/sequential on
3.1). Keep a Deepgram-Nova-3 → LLM → Cartesia pipeline only as a last-resort escape hatch — don't build it first.

## API comparison (2026)

| | OpenAI Realtime `gpt-realtime` | Gemini 3.1 Flash Live | Pipeline (Deepgram→LLM→Cartesia) |
|---|---|---|---|
| Shape | native S2S, 1 conn | native S2S, 1 conn | 3 services you orchestrate |
| Barge-in | built-in (server/semantic VAD) | yes (VAD cancels gen) | you build it |
| Tool-call mid-convo | **yes, convo continues** | sequential/blocking on 3.1 | full control, full wiring |
| 8 kHz mono | resamples server-side (confirm WER) | resamples, any rate | **Deepgram Nova-3 phonecall = best on telephony audio** |
| Cost | audio in $32 / out $64 per M tok (~$0.05–0.18/min) | audio token-priced (confirm) | Deepgram $0.0077/min + Cartesia $0.006/min + LLM |

8 kHz is the key risk: S2S models *accept* upsampled HFP audio but WER degrades on narrowband. Fine for a
controlled demo room — **but test the real glasses→HFP→iOS route in hour one.**

## iOS audio session (HFP routing)

Glasses present as a **Bluetooth HFP headset** (8 kHz mic+speaker). Configure `AVAudioSession`, then the
Realtime SDK uses that route:

```swift
let s = AVAudioSession.sharedInstance()
try s.setCategory(.playAndRecord, mode: .voiceChat,           // .voiceChat engages HFP 2-way
                  options: [.allowBluetooth, .defaultToSpeaker]) // .allowBluetooth == .allowBluetoothHFP
try s.setActive(true)
```

Gotchas (verified):
- `.allowBluetooth` (= `.allowBluetoothHFP`) is required for HFP **input**. `.allowBluetoothA2DP` is
  output-only — won't give you the mic. You can't do A2DP-out + HFP-in at once, so TTS is also narrowband (fine).
- **iOS 17+ regression:** `mode: .default` + `.allowBluetooth` may stop selecting the BT *input*. Use
  `mode: .voiceChat` and/or explicit `setPreferredInput` to the HFP port. iOS 18.5 has VoIP audio-loss
  reports — keep `.videoChat` mode as a fallback. **Confirm on the demo device's iOS build.**
- **Camera/voice session war (critical):** if the DAT whiteboard-capture `AVCaptureSession` runs alongside
  voice, set `captureSession.automaticallyConfiguresApplicationAudioSession = false` — configure your audio
  category **first**, then add capture inputs, or the camera silently reconfigures the route and kills voice.

## Architecture — voice on phone, tools reach backend

```
Glasses (HFP 8kHz) ──BT──► iOS DAT app ──WebRTC──► OpenAI Realtime (gpt-realtime)
                                │  ▲                     │
                                │  └──── function call ──┘  (kick_off_agent / approve_diff / ask_clarification)
                                └── HTTPS ──► orchestrator (Agent SDK fleet) ──► result ──► back into convo
```

- **Don't proxy audio through your backend** — phone connects directly to OpenAI WebRTC; backend only
  **mints ephemeral keys** (30-min) + **executes tool calls**. Audio-in-the-backend doubles latency.
- Tool handlers on the phone make plain HTTPS calls to the orchestrator, then feed the result back.

```swift
try conversation.updateSession {
    session.tools = [
      .function(.init(name: "kick_off_agent", description: "Start an autonomous coding agent on a task",
        parameters: JSONSchema(type:.object, properties:["task":JSONSchema(type:.string)], required:["task"]))),
      .function(.init(name: "approve_diff", description: "Approve the shown diff",
        parameters: JSONSchema(type:.object, properties:["agentId":JSONSchema(type:.string)], required:["agentId"])))]
    session.toolChoice = .auto
    session.instructions = "You are wiser's voice. Be terse. One sentence max per reply."
}
for entry in conversation.entries {
    if case .functionCall(let call) = entry {
        let result = await orchestrator.run(name: call.name, args: call.arguments)
        try conversation.send(result: .init(id: UUID().uuidString, callId: call.callId, output: result))
    }
}
```
> Footgun: on a slow tool call the model can **hallucinate a result**. Instruct it to wait silently, or
> return an immediate ack and stream status as a follow-up.

## Push-to-talk (gesture-gated)

**Index-pinch = push-to-talk**, not always-listening — 8 kHz audio in a loud room makes server VAD
false-trigger constantly. Drive turns manually; keep barge-in on so a pinch cuts off TTS:

```swift
session.audio.input.turnDetection = .serverVad(createResponse: false, interruptResponse: true)
// pinch-down: open mic;  pinch-up: commit buffer → request response
```
Use a **swipe for approve/reject** so the user confirms diffs without speaking. Voice = intent, gesture = confirm.

## Short TTS

`session.instructions = "One sentence. No preamble. State the outcome or the single decision needed."`
+ `session.maxResponseOutputTokens = .limited(80)`. Audio bills ~1 token/50 ms, so short = cheap. Bump
`session.audio.output.speed` ~1.1. Favor a clear voice; always pair speech with the on-glasses card so
detail survives muddy narrowband output.

## First-hour gotchas

1. **Test real glasses→HFP→iOS audio in hour one** — don't validate on AirPods then hit 8 kHz surprises.
2. iOS 17/18 BT-input regressions → `mode:.voiceChat` + `setPreferredInput`; `.videoChat` fallback.
3. `captureSession.automaticallyConfiguresApplicationAudioSession = false` (order matters) or camera kills voice.
4. Build the **ephemeral-key minting endpoint first** or the phone can't connect.
5. Tool-result hallucination on slow calls → wait-or-ack.
6. Gesture-gated PTT, not always-listening, for the demo.
7. Info.plist `NSMicrophoneUsageDescription` + BT route active before `setActive`.

## Sources

[gpt-realtime](https://openai.com/index/introducing-gpt-realtime/) ·
[Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations) ·
[Realtime WebRTC](https://platform.openai.com/docs/guides/realtime-webrtc) ·
[swift-realtime-openai](https://github.com/m1guelpf/swift-realtime-openai) ·
[Gemini Live](https://ai.google.dev/gemini-api/docs/live-api/capabilities) ·
[STT benchmarks 2026](https://futureagi.com/blog/speech-to-text-apis-in-2026-benchmarks-pricing-developer-s-decision-guide/) ·
AVAudioSession/HFP: [4340](https://developer.apple.com/forums/thread/4340), [736814](https://developer.apple.com/forums/thread/736814), [681319](https://developer.apple.com/forums/thread/681319). Verified June 2026.
