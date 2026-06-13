# wiser — iOS DAT app (stub)

Deliberately minimal for now. The webapp (`../glasses-webapp`) is the primary surface
for the hackathon; this native app exists so we can later use the **Meta Wearables
Device Access Toolkit (DAT)** for things the webapp can't do — notably the on-glasses
**camera stream** and the native **on-glass display DSL**.

## What's here
- `Sources/wiserDAT/wiserDATApp.swift` — app entry; configures the SDK + handles the Meta AI URL callback.
- `Sources/wiserDAT/ContentView.swift` — one screen: a "Connect glasses" button and a status label.

This is **not** wired into an Xcode project yet (no `.xcodeproj`/`.pbxproj`). Treat the
Swift files as the seed for when we do the real iOS work.

## When we pick this up (planned path)
1. New Xcode app target; add the DAT SDK via SwiftPM:
   `https://github.com/facebook/meta-wearables-dat-ios` → `MWDATCore`, `MWDATCamera`, `MWDATDisplay`.
2. `Info.plist`: URL scheme (`wiserdat`), `UISupportedExternalAccessoryProtocols = com.meta.ar.wearable`,
   bluetooth/external-accessory background modes, `NSBluetoothAlwaysUsageDescription`, and the
   `MWDAT` dict (`AppLinkURLScheme`, `MetaAppID`).
3. `Wearables.configure()` at launch; `Wearables.shared.handleUrl(url)` in `.onOpenURL`.
4. Register (`startRegistration()`), create a session with `AutoDeviceSelector`, `session.start()`.
5. Camera: `session.addStream(StreamConfiguration(...))` → `videoFramePublisher` / `capturePhoto`.
   Send a captured frame to the wiser backend `POST /api/ask` (same contract the webapp uses).
6. Display: `session.addDisplay()` → `display.send(FlexBox { ... })` to render result cards on-glass.

See the `mwdat-ios:*` skills for exact snippets.
