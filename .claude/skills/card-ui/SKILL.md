---
name: Card UI & transport (wiser)
description: How wiser renders glanceable cards on the glasses and pushes live updates. Use when building the card-list/deep-dive UI, the 600x600 web app from Meta's starter kit, the .focusable D-pad model, the WebSocket/poll card-push transport, the Vercel deploy + QR install loop, desktop testing, or the native iOS MWDATDisplay component rendering. Recommends building the card UI as a Web App (desktop-testable) and going native only for the camera/mic session. Verified June 2026.
when_to_use: card UI, card list, deep dive, webapp, 600x600, focusable, d-pad, keydown, websocket, connectWebSocket, polling, card push, transport, vercel, QR, deeplink, MWDATDisplay, Display.send, FlexBox, render card, deploy glasses
user-invocable: true
---

# Card UI & transport — rendering wiser's cards

How the compressed cards reach the lens, and how the orchestrator pushes updates.

## Recommendation

**Build the card UI as a Web App, tested entirely on desktop. Add native iOS `MWDATDisplay` only when the
demo needs camera/mic in the same session.** The renderer is conceptually identical on both paths (same
`{id,title,summary,payload}` schema, same one-view + 6-event model) — the web path gets a demoable,
live-updating card UI **today on a laptop**, and wiser needs native *anyway* for capture/voice, so build them
in parallel and port the (stabilized) card schema into `MWDATDisplay` later. **Don't block the card UI on
native setup.**

> Two earlier assumptions corrected by research: **WebSocket IS supported** (Meta ships a `connectWebSocket()`
> helper) — not "unverified". And the native send method is **`Display.send(_:)`**, not `sendContent`.

## Web app card UI (the starter kit)

Repo: `facebookincubator/meta-wearables-webapp` — an **AI-coding skill toolkit** that scaffolds apps; the
runnable reference is `examples/snake/` (plain `index.html` + `app.js` + `styles.css`, **no build step**).
```bash
curl -sL https://raw.githubusercontent.com/facebookincubator/meta-wearables-webapp/main/install-skills.sh | bash
# skills: create-webapp, add-ui, connect-api, add-device-sensors, add-local-storage,
#         test-on-device, publish-to-vercel, passcode-for-testing, qr-code
```

**600×600 setup (verbatim):**
```html
<meta name="viewport" content="width=600, height=600, initial-scale=1.0, user-scalable=no">
<meta name="mrbd-web-app-capable" content="yes">   <!-- must be "yes" verbatim -->
```
```css
html, body { width:600px; height:600px; overflow:hidden; }
```
Safe area **584×584** (8dp margin); buttons ~88dp; body ≥16px, primary 20–24px.

**`.focusable` D-pad model** (hand-rolled, 1-D wrap-around — *not* 2-D spatial):
```javascript
function moveFocus(dir){
  const f=[...document.querySelectorAll('.focusable:not([disabled]):not(.hidden)')];
  if(!f.length) return;
  const i=f.indexOf(document.activeElement);
  if(i===-1){ f[0].focus(); return; }
  const n=(dir==='up'||dir==='left') ? (i>0?i-1:f.length-1) : (i<f.length-1?i+1:0);
  f[n].focus(); f[n].scrollIntoView({block:'nearest',behavior:'smooth'});
}
```
**Gestures arrive as ordinary `keydown`** (OS translates Neural Band/captouch → keys):
```javascript
document.addEventListener('keydown', e => {
  switch(e.key){
    case 'ArrowUp':moveFocus('up');break;   case 'ArrowDown':moveFocus('down');break;
    case 'ArrowLeft':moveFocus('left');break; case 'ArrowRight':moveFocus('right');break;
    case 'Enter': if(document.activeElement.classList.contains('focusable')) document.activeElement.click(); break;
    case 'Escape': popToList(); break;        // list ⇄ deepdive
    default: return;
  } e.preventDefault();
});
```
Gate the nav listener on a `list ⇄ deepdive` state (Snake uses two state-gated keydown listeners). For
approval cards: deep-dive shows the diff summary with **Enter = approve / Escape = reject**.
> Prefer the **`Escape` event** for back/reject — don't bind middle-finger pinch directly (may be OS-reserved).

**Additive styling — black = transparent**, so never pure-black your surfaces: `--bg:#0a0a0f` (near-black,
visible), `--card:#1a1a2e`, focus cue = cyan glow `box-shadow:0 0 20px rgba(0,212,255,.4)` on `:focus`.

## Transport — live card push

Supported on the device WebView: Display, Input, IMU, GPS, Local Storage, **`fetch`**, **`WebSocket`**.
Unsupported (verbatim): Camera, Microphone, Text Input, Offline, **Notifications**, Back Navigation.

1. **Primary: WebSocket (`wss://`)** — the blessed push channel; "agent finished" = one message. The starter's
   `connect-api` skill ships `connectWebSocket(url,{onOpen,onMessage,onClose,onError})` with auto-reconnect.
2. **Fallback: fetch-poll every 3–5 s** (foreground, exponential backoff, ETag) — most robust given
   foreground-only + BT flakiness + no service workers.
3. **Foreground discipline:** budget `<3 s load, <500 KB JS gz, <10 requests`; **tear down WS + polling on
   `visibilitychange`** (`clearInterval`). Avoid **SSE/EventSource** (no first-party support; long-lived HTTP
   stream likely killed by the BT-tethered proxy).

**Latency:** no published BT round-trip number; routes through the phone over Bluetooth. **Target 2–5 s
perceived**, not sub-second — don't promise real-time in the demo.

## Deploy + install loop

No web dashboard — a web app is just a static HTTPS host added on the phone.
```bash
vercel --yes --prod                                  # HTTPS URL
# disable Vercel SSO protection (it blocks the glasses browser):
echo '{"ssoProtection":null}' | vercel api "/v9/projects/$PROJECT_ID" -X PATCH --input - --silent
vercel alias set "$(vercel --prod)" wiser-cards.vercel.app   # STABLE alias
```
Install: Meta AI app (v254+, confirm floor) + Display fw v21+ + **Developer Mode** (tap version 5×). Deeplink
`fb-viewapp://web_app_deep_link?appName=wiser&appUrl=<url-encoded-https>` → QR via the `qr-code` skill's
python script → scan with phone camera → one-tap add. **Build the alias + QR once**; then every iterate =
`vercel --yes` (re-disable ssoProtection, re-alias) with **no reinstall** — glasses re-fetch on reopen.

## Desktop testing

**No simulator needed — a Chrome window IS the simulator** (gestures = keyboard). Open `index.html`, set
DevTools viewport 600×600, use **arrow keys + Enter + Esc**. Meta's guarantee: *"if it works with arrow keys
and Enter on your computer, it works on your glasses."* ~95% buildable glasses-free; hardware only for real
IMU/GPS + final additive-legibility check.

## Native `MWDATDisplay` (iOS — for the camera/mic session)

Repo: `facebook/meta-wearables-dat-ios` (note `facebook`, not `facebookincubator`). DAT v0.7.0+.
```swift
let display = try session.addDisplay()
display.statePublisher.listen { state in Task { @MainActor in
  guard state == .started else { return }            // gate on DisplayState.started
  try await display.send(                            // Display.send(_:) — replaces whole screen
    FlexBox(direction: .column, spacing: 12) {        // exactly ONE root DisplayableView
      Text(card.title, style: .heading)
      Text(card.summary, style: .body)
      Button(label: "Approve", style: .primary, iconName: .checkmark, onClick: { approve(card.id) })
      Button(label: "Reject",  style: .secondary, iconName: .close,   onClick: { reject(card.id) })
    }.padding(24).background(.card))
}}
Task { await display.start() }
```
Components: `FlexBox`, `Text(_:style:color:)` (`.heading/.body/.meta`), `Button(label:style:iconName:onClick:)`,
`Image(uri:sizePreset:cornerRadius:)` (URL only), `Icon(name:style:)`, `VideoPlayer(provider:codec:onError:)`.
**Each `send` replaces the whole screen AND resets all tap handlers**; exactly one root (root `FlexBox` for UI
or root `VideoPlayer` for video); vertical-scroll-only. Needs the **DAM** Info.plist opt-in (`MWDAT` dict +
`UISupportedExternalAccessoryProtocols → com.meta.ar.wearable` + BT background modes — confirm full set).
Card-schema maps directly: `title→Text(.heading)`, `summary→Text(.body)`, `payload→Text(.meta)`/nested FlexBox,
actions → two Buttons.

## Web vs native (1-day hack)

| | Web App | Native `MWDATDisplay` |
|---|---|---|
| Time to first card | **hours** (vanilla HTML, desktop) | day+ (Xcode, DAM, pairing) |
| Dev w/o glasses | **~95%** | Mock Device Kit only |
| Live push | WebSocket + poll | `display.send` per update |
| Camera/mic | **impossible** | **required — only path** |
| Iterate | redeploy-to-alias, no reinstall | rebuild/reinstall |

**Verdict:** web app for the card UI demo now; native iOS DAT in parallel for capture/voice; port the stable
card schema into `MWDATDisplay` if you want one native session.

## Sources

[webapps build docs](https://wearables.developer.meta.com/docs/develop/webapps/build/) ·
[meta-wearables-webapp](https://github.com/facebookincubator/meta-wearables-webapp) ·
[meta-wearables-dat-ios](https://github.com/facebook/meta-wearables-dat-ios) ·
[MWDATDisplay reference](https://wearables.developer.meta.com/docs/reference/ios_swift/dat/). Verified June 2026.
