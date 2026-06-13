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

| | **Web App** | **Native iOS (DAT SDK)** |
|---|---|---|
| Runtime | HTML/CSS/JS **on the glasses**, no companion app | Swift app on the **phone**, drives the glasses |
| Display UI | Yes | Yes |
| Camera stream + photo capture | **No** | **Yes** (`StreamSession`) |
| Microphone / conversational audio | **No** | **Yes** |
| Input | Neural Band, captouch, motion/orientation, phone GPS, local storage | Same via DAT |
| Speed to demo | Fastest | More setup |
| Skills | `meta-wearables-webapp:*` | `mwdat-ios:*` |

**Decision for `wiser`** (from on-device testing): the web SDK alone is **not enough**. Anything
**conversational** (talk to the orchestrator) or **camera-based** (snap the whiteboard, "build this")
needs the **native iOS DAT app** — the path our glasses lead knows well. A **Web App** is still the fastest way to
prototype the **card display/deep-dive UI** in isolation; build the card renderer as a webapp, port to the
iOS display surface once the data contract is stable.

Keep the three `wiser` pieces (display app · orchestrator backend · agent fleet) loosely coupled. The seam
is the **card schema** — `{ id, title, summary, payload }` — define it first.

## Known constraints (will bite the demo)

- **No on-device spatial anchors.** DAT ships none. Meta's own glasses-for-blind work fell back to
  **ARKit anchors on the phone**. Don't design the demo assuming the glasses anchor content in world space.
- **Bluetooth Classic bandwidth ceiling.** Camera res/fps auto-degrade under pressure; frames are
  per-frame compressed. Counter-intuitively, request *lower* res/fps for *cleaner* frames.
- **Developer Preview = no publishing.** Dev devices / Mock Device Kit only.
- **Everything routes through the Meta AI companion app** — pairing, permissions, native app launch.

## Detailed reference

- **[display-and-input.md](display-and-input.md)** — display surface, card list/deep-dive model, the full
  Neural Band gesture vocabulary (4 swipes + 2 pinches), captouch.
- **[camera-audio-setup.md](camera-audio-setup.md)** — `StreamSession` camera streaming, `capturePhoto`
  (the whiteboard grab), microphone/HFP audio, permissions, firmware/version requirements, Mock Device Kit.

## Sources

- Wearables Developer docs — <https://wearables.developer.meta.com/docs/getting-started-toolkit>
- Developer FAQ — <https://developers.meta.com/wearables/faq/>
- Introducing the DAT — <https://developers.meta.com/blog/introducing-meta-wearables-device-access-toolkit/>
