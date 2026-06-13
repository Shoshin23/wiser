# Display surface + input

What the user sees and how they navigate `wiser`'s cards on Meta Ray-Ban Display.

## Display access

- Only the **Meta Ray-Ban Display** model exposes a display. In DAT it's reachable on devices of type
  `DeviceType.META_RAYBAN_DISPLAY`.
- **Web App path:** you render with **standard HTML/CSS/JS** "with display and inputs optimized for these
  glasses." Treat it as a tiny, dark, glanceable web canvas — short lines, high contrast, one idea per
  view. (A ~square/small viewport; confirm exact px against `meta-wearables-webapp:create-webapp` — the
  scaffold sets the canvas size for you.)
- **iOS DAT path:** display access is provided through the toolkit — see `mwdat-ios:display-access`. Use
  this when the display must coexist with camera streaming / mic in the same session.

### Card model for `wiser`

The distiller normalizes every agent result into a **card**:

```
Card {
  id: string
  title: string          // one-liner, glanceable
  summary: string        // 1–2 short lines
  payload: object        // drill-down detail for the deep-dive view
}
```

Two views:
1. **Card list** — vertical list, one focused card at a time; up/down moves focus.
2. **Deep-dive** — enter a card to read `payload`; cancel to go back.

Keep text terse — this is a heads-up glance surface, not a phone screen. Render approvals as a card whose
deep-dive shows the diff summary and an enter=approve / cancel=reject affordance.

## Input

Primary input is the **Neural Band** (EMG wristband), plus **captouch** on the glasses arm. Web Apps also
get **motion/orientation** from the glasses and **GPS** from the connected phone, and **local storage**.

### Neural Band gestures (Web App)

| Gesture | Action | Map to `wiser` |
|---|---|---|
| Swipe **up / down** | move focus | navigate card list |
| Swipe **left / right** | move focus / paginate | switch sections, page long deep-dives |
| **Index-finger pinch** | **enter / confirm** | open card · approve diff |
| **Middle-finger pinch** | **cancel / back** | leave deep-dive · reject |

Design the whole card UI around these six events (4 swipes + 2 pinches). That's the full nav vocabulary —
don't assume a pointer or keyboard.

### Notes

- No on-device spatial anchors (see SKILL.md constraints). Cards live in the HUD, not anchored in world space.
- Keep state machine simple: `list ⇄ deepdive`, with `enter`/`cancel` as the only transitions. Easy to
  drive from both the webapp gesture events and (later) the iOS display surface.

## Sources

- Developer FAQ (input + Web App capabilities) — <https://developers.meta.com/wearables/faq/>
- Web app skills — `meta-wearables-webapp:create-webapp`, `add-ui`, `add-device-sensors`, `add-local-storage`
- iOS display — `mwdat-ios:display-access`
