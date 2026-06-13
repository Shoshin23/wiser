# Camera, audio + setup (iOS DAT path)

The capture/voice loop for `wiser` — "snap the whiteboard, ask the agent to build it" — needs the
**native iOS DAT SDK**. Web Apps can't reach the camera or mic.

> **v0.7.0 API rename (verified June 2026):** the camera types below were renamed for cross-platform parity:
> `StreamSession → Stream`, `StreamSessionConfig → StreamConfiguration`, `StreamSessionState → StreamState`,
> `StreamSessionError → StreamError`. Snippets here use the old names — translate to the new ones on ≥0.7.0.
> Also note: **mic gives no raw PCM stream** — audio is system **HFP, 8 kHz mono** only (plan STT around that),
> and v0.7.0 added thermal/battery session errors that can stop long sessions.

## Why iOS, not Web App

Per the FAQ, Web Apps get display + Neural Band/captouch + motion/GPS/local-storage — **but not camera or
microphone**. The Device Access Toolkit (native) is what "provides access to on-device sensors including
cameras, microphones, speakers, and … the display." So conversational + whiteboard-capture = iOS app.

## Camera streaming

You stream by adding a `StreamSession` to a `DeviceSession` and observing frames + state.

```swift
let config = StreamSessionConfig(
  videoCodec: VideoCodec.raw,
  resolution: StreamingResolution.low,   // .high | .medium | .low
  frameRate: 24)                         // valid: 2, 7, 15, 24, 30
guard let stream = try? session.addStream(config: config) else { return }

let frameToken = stream.videoFramePublisher.listen { frame in
  guard let image = frame.makeUIImage() else { return }
  Task { @MainActor in /* render preview */ }
}
let stateToken = stream.statePublisher.listen { state in /* update UI */ }

Task { await stream.start() }
```

Resolutions: `high` 720×1280, `medium` 504×896, `low` 360×640.
`StreamSessionState`: `stopping → stopped → waitingForDevice → starting → streaming → paused`.

### Bandwidth reality

The phone↔glasses link is **Bluetooth Classic**. An automatic ladder degrades quality under pressure:
first drops resolution one step, then frame rate (never below 15 fps). Frames are also **per-frame
compressed**, so even `high` can look soft. **Counter-intuitive but true: request *lower* res/fps to get
*cleaner* frames** with less compression loss. For a whiteboard still you care about sharpness, not
motion — prefer low fps and grab a photo (below) rather than reading from the video stream.

## Photo capture (the whiteboard grab)

Capture a still during an active stream. Video pauses for the shot and auto-resumes.

```swift
// iOS
let ok = stream.capturePhoto(format: .heic)   // delivered via photoDataPublisher
```

```kotlin
// Android equivalent (for reference)
session.capturePhoto().fold(
  onSuccess = { photo -> when (photo) {
    is PhotoData.HEIC   -> saveHeic(photo.encodedPhoto)
    is PhotoData.Bitmap -> displayBitmap(photo.rawBitmap)
  }},
  onFailure = { error -> when (error) {
    CaptureError.DeviceDisconnected -> showDeviceError()
    CaptureError.NotStreaming       -> showStreamingRequired()
    CaptureError.CaptureInProgress  -> showBusyMessage()
    CaptureError.CaptureFailed      -> showCaptureError()
  }}
)
```

`wiser` flow: glasses-handoff → user points at whiteboard → `capturePhoto(.heic)` → ship the image to the
orchestrator → orchestrator + vision model turn it into tasks for the agent fleet.

## Audio (conversational loop)

DAT exposes **microphone** + **speakers** (open-ear). Mic/speaker access is **shared with the system
Bluetooth (HFP) stack** — if you mix HFP calls with a streaming session, **fully configure HFP before**
starting any audio-using stream, or audio routing fights. For the realtime voice agent, the mic feeds your
STT / realtime model; agent replies play back through the open-ear speakers.

## Permissions

Granted by the user in the **Meta AI companion app**, not a normal iOS prompt:

- `Permission.CAMERA` — streaming + photo capture
- `Permission.MICROPHONE` — mic

Flow: check with `checkPermissionStatus` → if not granted, `requestPermission(_:)` opens the Meta AI app →
user responds → your app gets a callback URL → pass it to `handleUrl(_:)` to complete. Gate camera/photo
behind `CAMERA`, the voice loop behind `MICROPHONE`.

## Setup / requirements

- **Glasses:** Meta Ray-Ban Display, firmware **v21+** (other models v20+).
- **Meta AI app:** **v254+**, glasses paired, **developer mode enabled**.
- **DAT version:** track `version-dependencies` — e.g. DAT 0.4.0 pairs with Meta AI V254, Display glasses
  V21. Current reference here is ~**0.6**. Pin a version; preview APIs drift.
- **No hardware? Use the Mock Device Kit** — simulate a device end-to-end without glasses. Skill:
  `mwdat-ios:mockdevice-testing`. Build the capture/card loop against the mock, swap to real glasses last.

## Sources

- Camera / `StreamSession` / `StreamSessionConfig` — <https://wearables.developer.meta.com/docs/build-integration-ios>
- Mic & speakers (HFP sharing) — <https://wearables.developer.meta.com/docs/microphones-and-speakers>
- Setup & versions — <https://wearables.developer.meta.com/docs/getting-started-toolkit>, `.../version-dependencies`
- Permissions — DAT `WearablesInterface.requestPermission` / `Permission` enum reference
- iOS skills — `mwdat-ios:getting-started`, `camera-streaming`, `session-lifecycle`, `mockdevice-testing`
