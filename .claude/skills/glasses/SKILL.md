---
name: Ray-Ban Display glasses (wiser)
description: Reference for building wiser's glasses display app on Meta Ray-Ban Display via the Meta Wearables Device Access Toolkit (DAT). Use when working on the on-glasses card/display UI, camera or photo capture (the whiteboard grab), the microphone/voice loop, Neural Band gesture input, web-app-vs-native-iOS path decisions, permissions, or device/firmware setup. Covers SDK limits (no on-device spatial anchors, Bluetooth Classic bandwidth ceiling) and which capabilities need the native iOS SDK vs a Web App.
when_to_use: glasses, Ray-Ban Display, Meta wearables, DAT, display UI, card UI, capture whiteboard, photo capture, camera stream, Neural Band, glasses voice, mwdat, meta-wearables-webapp
user-invocable: true
---

# Meta Ray-Ban Display — SDK reference (for `wiser`)

Standing reference for the **glasses display app** in `wiser`: a voice-driven fleet of Claude coding
agents that surfaces results as **cards** on Meta Ray-Ban **Display** glasses.

Source of truth: the [Meta Wearables Device Access Toolkit (DAT)](https://wearables.developer.meta.com/)
docs + developer FAQ. DAT is at **v0.x (developer preview)** — APIs move; verify a signature against the
`meta-wearables-webapp:*` / `mwdat-ios:*` skills before relying on it.

## The product

"The ones with the screen" = **Meta Ray-Ban Display** (`DeviceType.META_RAYBAN_DISPLAY`), an in-lens HUD.
The companion **Neural Band** (EMG wristband) is the primary input. DAT exposes the display **only** on
the Display model; other models (Ray-Ban Meta Gen 1/2, Optics, Oakley HSTN/Vanguard) are camera/audio/
sensors only.

## Two build paths — pick per piece

| | **Web App** | **Native iOS (DAT SDK ≥ v0.7.0)** |
|---|---|---|
| Runtime | HTML/CSS/JS **on the glasses**, no companion app | Swift app on the **phone**, drives the glasses |
| Display UI | Yes (HTML, but 600×600, **one screen, no scroll**) | **Yes** — `MWDATDisplay`, since v0.7.0 (2026-05-14) |
| Camera stream + photo capture | **No** | **Yes** (`Stream`, was `StreamSession`) |
| Microphone / conversational audio | **No** | **Yes** — but no raw stream (HFP 8 kHz mono via system BT) |
| Input | 6 gestures → arrow keys + Enter/cancel; **no text input** | Tap + directional swipe (Neural Band) |
| Speed to demo | Fastest | More setup |
| Skills | `meta-wearables-webapp:*` | `mwdat-ios:*` |

> **Correction (verified June 2026):** iOS reached **display parity with Android in DAT v0.7.0** via the
> `MWDATDisplay` module (same day as Android). The earlier "iOS = camera/audio only" assumption is
> **outdated**. Native display is **not arbitrary pixels** — it's a fixed component set
> (`FlexBox / Text / Button / Image / Icon / VideoPlayer`), **replace-whole-screen, one view,
> vertical-scroll-only, tap-only**. Requires the new **Device Access Toolkit App Model (DAM)** opt-in
> (Info.plist / manifest).

**Decision for `wiser`** (from on-device testing): the web SDK alone is **not enough**. Anything
**conversational** (talk to the orchestrator) or **camera-based** (snap the whiteboard, "build this")
needs the **native iOS DAT app** — the path our glasses lead knows well. A **Web App** is still the fastest way to
prototype the **card UI** in isolation (it's literally arrow-keys + Enter in a 600×600 browser window);
build the card renderer as a webapp, port to the iOS `MWDATDisplay` component set once the schema is stable.

Keep the three `wiser` pieces (display app · orchestrator backend · agent fleet) loosely coupled. The seam
is the **card schema** — `{ id, title, summary, payload }` — define it first.

## Known constraints (verified June 2026 — will bite the demo)

**The display is tiny by hard limit — this is the whole "compression layer" problem (see `CLAUDE.md`).**

- **600×600, one view, NO scrolling.** Web apps: fixed 600×600 viewport, "avoid scrolling," design to one
  screen. Native: each `Display.sendContent` **replaces the whole screen**, one view, vertical-scroll-only.
- **Additive display: black = transparent.** Dark backgrounds, light high-contrast UI only.
- **Input is ~6 gestures, period.** 4 swipes + index-pinch (= Enter/confirm), mapped to arrow keys + Enter.
  **No custom gestures, no raw touch coords, no keyboard / text input** (web apps). Native adds tap handlers
  (reset on every send). ⚠️ **Don't bind your "reject/back" to middle-finger pinch** — in Web Apps the
  middle pinch appears to be **OS-reserved** for a universal menu (Restart/Resume/Permissions); use the
  Escape/cancel event instead. (Sources conflict — the FAQ calls middle-pinch "cancel"; confirm on device.)
- **Web apps can't reach camera, mic, notifications, or offline/service-workers**; 5 MB storage; must be a
  public **HTTPS** URL; foreground-only; all networking **tethered through the phone over Bluetooth**.
- **No raw audio stream for STT.** Mic/speaker shared with the system BT (HFP) stack, 8 kHz mono; HFP must
  be configured before an audio-using session. Plan the voice loop around system audio, not a PCM publisher.
- **No on-device spatial anchors.** DAT ships none; content is HUD/screen-locked. Meta's own glasses-for-
  blind work fell back to **ARKit anchors on the phone**. Don't assume world-anchored content.
- **Bluetooth Classic bandwidth ceiling (camera).** Res/fps auto-degrade under pressure; frames are
  per-frame compressed. Counter-intuitively, request *lower* res/fps for *cleaner* frames.
- **Thermal / battery throttling.** v0.7.0 added `ThermalLevel` + thermal/battery/peak-power session
  errors — long sessions can get stopped. Demo with a cool, charged device.
- **One session per device at a time**, but multiple capabilities coexist in it (camera + display on the
  same `DeviceSession`). Interrupted by closing hinges, removing glasses, or another app's session.
- **Developer Preview = no publishing; ≤ 100 testers** via passcode URL (web) / release channel (DAT).
  Dev Mode required. Mock Device Kit lets you build without hardware.
- **Everything routes through the Meta AI companion app** — pairing, permissions, native app launch.
- **Unverified (confirm on device):** JS engine/version, per-app memory/CPU/watchdog limits, WebGL/Canvas/
  WebRTC/IndexedDB support, BT round-trip latency for rendering a card. No official source as of June 2026.

## Detailed reference

- **[display-and-input.md](display-and-input.md)** — display surface, card list/deep-dive model, the full
  Neural Band gesture vocabulary (4 swipes + 2 pinches), captouch.
- **[camera-audio-setup.md](camera-audio-setup.md)** — `StreamSession` camera streaming, `capturePhoto`
  (the whiteboard grab), microphone/HFP audio, permissions, firmware/version requirements, Mock Device Kit.

## Sources

- Wearables Developer docs — <https://wearables.developer.meta.com/docs/getting-started-toolkit>
- Developer FAQ — <https://developers.meta.com/wearables/faq/>
- Introducing the DAT — <https://developers.meta.com/blog/introducing-meta-wearables-device-access-toolkit/>
