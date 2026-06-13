# ios/

The **native iOS Meta Wearables DAT app — the real glasses client.** Everything the user interacts with
renders on the lens via `MWDATDisplay`; the Neural Band drives it (tap → `Button.onClick`). The phone holds
logic, networking, and state.

Xcode project: `ios/CameraAccess/CameraAccess.xcodeproj` (DAT SDK: `MWDATCore` / `MWDATDisplay` /
`MWDATCamera`). The generic Meta-sample notes are in [`CameraAccess/README.md`](./CameraAccess/README.md).

## Three surfaces

| Surface | File | What |
|---|---|---|
| **Ask** | `Wiser.swift` | Voice Q&A — mic → STT → managed agent (+ `ask_user` handoff) → TTS + card on lens. Session history. |
| **Build** | `OrchestratorRun.swift` | Live agent coding run — SSE HUD + cards streamed to the lens; steer (approve / reject / voice). |
| **Brainstorm** | `BrainstormSurface.swift` | Glasses-first contribution — voice idea + POV photo → the ambient scan; build-deck paging on the lens. |

Support: `GlassesDisplayHub.swift` (the one shared lens capability) · `WiserMirror.swift` (tees camera POV +
card JSON to a laptop browser over MJPEG, for demo/dev).

## Config

`WiserConfig` (in `Wiser.swift`) holds two backend URLs, both editable in-app:

- `backendURL` → the Firebase function ([`../firebase/`](../firebase/)) — Ask + Build.
- `ambientURL` → the ambient brainstorm server ([`../ambient-webapp/`](../ambient-webapp/)), via ngrok — Brainstorm.

Endpoints called: `/api/ask`, `/api/runs/:id/events` (SSE), `/api/runs/:id/steer`, `/api/sessions*`,
and `/api/brainstorms/active/contribute` (ambient). No API keys live on the device — they stay server-side.

## Build & run

1. Turn on **Developer Mode** in the Meta AI app and register the glasses.
2. Open the `.xcodeproj` in Xcode, set signing, build to your device.
3. Grant permissions (camera, microphone, Bluetooth, local network — declared in `Info.plist`).
4. Point `WiserConfig` at your backend / ambient URLs.
