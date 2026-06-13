//
// GlassesDisplayHub.swift
//
// The lens has exactly ONE display capability (DAT 0.7.0: a device session can `addDisplay()`
// once). Both the Ask (voice Q&A) surface and the Build (agent-coding stream) surface render
// to the lens, so they must NOT each spin up their own DeviceSessionManager + Display — that
// would race for the single capability. This hub owns the one shared `DeviceSessionManager`
// and the one `Display`, and lets whichever surface is active `send(_:)` to it.
//
// Sharing model: a process-wide @MainActor singleton, created lazily from the app's
// `WearablesInterface`. The first surface to appear calls `start(wearables:)`; subsequent
// callers reuse the same capability. `send(_:)` is a no-op (best-effort) until the display
// reaches `.started`, exactly like the prior per-VM behavior — the surfaces stay usable on the
// phone even with no glasses connected.
//

import MWDATCore
import MWDATDisplay
import Observation

@Observable
@MainActor
final class GlassesDisplayHub {
  /// Process-wide single owner of the lens display capability.
  static let shared = GlassesDisplayHub()

  /// True once the display capability has reached `.started`. Observed by the surfaces to
  /// show a "glasses" indicator.
  private(set) var isReady: Bool = false

  @ObservationIgnored private var sessionManager: DeviceSessionManager?
  /// The single lens display capability. Exposed so a surface that prefers the existing
  /// `try await display.send(FlexBox{…})` call style (e.g. `WiserViewModel`) can send through
  /// the same shared capability instead of creating a second one.
  @ObservationIgnored private(set) var display: Display?
  @ObservationIgnored private var displayToken: AnyListenerToken?
  @ObservationIgnored private var starting = false
  /// Called once when the display first becomes `.started`, so the active surface can paint
  /// its initial card. Set by whichever surface most recently asked to start.
  @ObservationIgnored private var onReady: (@MainActor () async -> Void)?

  private init() {}

  /// Bring the shared display capability up (idempotent). `wearables` is needed only the first
  /// time, to create the underlying session manager. `onReady` runs when the display reaches
  /// `.started` (or immediately if it already has) so the caller can paint its first card.
  func start(wearables: WearablesInterface, onReady: @escaping @MainActor () async -> Void) async {
    self.onReady = onReady

    // Already up — fire the ready hook now so the newly-active surface repaints.
    if display != nil, isReady {
      await onReady()
      return
    }
    guard !starting else { return }
    starting = true
    defer { starting = false }

    let manager = sessionManager ?? DeviceSessionManager(wearables: wearables)
    sessionManager = manager
    do {
      let session = try await manager.getSession()
      // If a prior start already attached the display, don't add it twice.
      if display == nil {
        let capability = try session.addDisplay()
        displayToken = capability.statePublisher.listen { [weak self] state in
          Task { @MainActor in
            guard let self else { return }
            if state == .started {
              self.isReady = true
              await self.onReady?()
            } else if state == .stopped {
              self.isReady = false
            }
          }
        }
        await capability.start()
        display = capability
      }
    } catch {
      DATLog.log.error("[wiser] GlassesDisplayHub.start failed: \(String(describing: error), privacy: .public)")
    }
  }

  /// Send a root view to the lens. Best-effort: no-op when the display isn't up yet, mirroring
  /// the prior per-VM `guard let display else { return }` behavior.
  func send(_ view: FlexBox) async {
    guard let display else { return }
    do {
      try await display.send(view)
    } catch {
      let msg = (error as? DisplayError)?.description ?? error.localizedDescription
      DATLog.log.error("[wiser] GlassesDisplayHub.send failed: \(msg, privacy: .public)")
    }
  }

  /// True when a display capability exists and is started (cheap synchronous check for callers
  /// that want to early-out before building a card).
  var canSend: Bool { display != nil }
}
