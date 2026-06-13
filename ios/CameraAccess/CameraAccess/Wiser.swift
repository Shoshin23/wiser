//
// Wiser.swift
//
// wiser flow on the Meta Ray-Ban Display glasses:
//   phone mic -> backend (Groq STT -> Claude managed agent -> Groq TTS) -> spoken answer + card on the lens.
//
// Added on top of Meta's CameraAccess sample. Reuses DeviceSessionManager for the
// glasses session and the MWDATDisplay card pattern from StreamSessionViewModel.
// The glasses display is best-effort: if no session, the voice loop still works on the phone.
//
// Image (POV photo) flow is a clean follow-up — `postAsk` already accepts an optional image.

import AudioToolbox
import AVFoundation
import Foundation
import MWDATCore
import MWDATDisplay
import Observation
import SwiftUI

// MARK: - Config

/// Backend base URL, persisted so it survives relaunch and is editable in-app
/// (the laptop's LAN IP changes; no rebuild needed).
enum WiserConfig {
  // Key bumped to ".v2" so any stale LAN URL saved by an earlier build is dropped
  // and the cloud default below takes effect on next launch.
  private static let key = "wiser.backendURL.v2"
  static let defaultURL = "https://us-central1-wiser-1a319.cloudfunctions.net/wiser"
  static var backendURL: String {
    get { UserDefaults.standard.string(forKey: key) ?? defaultURL }
    set { UserDefaults.standard.set(newValue, forKey: key) }
  }
}

// MARK: - Backend contract (mirrors backend/src/types.ts)

struct WiserCard: Codable {
  let title: String
  let summary: String
}

struct AskResponse: Codable {
  let transcript: String
  let answer: String
  let audioChunks: [String] // base64 WAV, in play order
  let card: WiserCard
  /// Conversation/session id. Present once the backend supports sessions.
  /// Send it back on the next ask to continue the same conversation; omit to start fresh.
  let sessionId: String?
}

// MARK: - Sessions contract (mirrors backend /api/sessions endpoints)

/// One row in `GET /api/sessions`.
struct SessionSummary: Codable, Identifiable, Hashable {
  let id: String
  let title: String?
  let preview: String?
  let status: String?
  let createdAt: String?
  let updatedAt: String?

  /// Title to show in the list — title, else preview, else a short id, else "Untitled".
  var displayTitle: String {
    if let t = title, !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return t }
    if let p = preview, !p.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return p }
    return "Conversation " + String(id.prefix(6))
  }
}

struct SessionsList: Codable {
  let sessions: [SessionSummary]
}

/// One message in a session detail.
struct SessionMessage: Codable, Identifiable, Hashable {
  /// Synthesized id (the backend rows have no id); index-based for stable SwiftUI identity.
  var id: Int { hashValue }
  let role: String   // "user" | "assistant"
  let text: String

  var isUser: Bool { role.lowercased() == "user" }
}

/// `GET /api/sessions/:id`.
struct SessionDetail: Codable {
  let id: String
  let status: String?
  let messages: [SessionMessage]
}

/// `POST /api/sessions` -> { sessionId }.
struct CreateSessionResponse: Codable {
  let sessionId: String
}

enum WiserError: LocalizedError {
  case server(String)
  case noAudio
  var errorDescription: String? {
    switch self {
    case .server(let m): return m
    case .noAudio: return "No audio was recorded."
    }
  }
}

// MARK: - Audio routing (glasses speakers)

/// Routes TTS output to the Meta Ray-Ban Display glasses' open-ear speakers.
///
/// WHY THIS AND NOT A DAT SDK CALL:
/// Meta Wearables DAT 0.7.0 ships exactly two device capabilities — `MWDATCamera.Stream`
/// and `MWDATDisplay.Display` (the only types conforming to `MWDATCore.Capability`; the
/// only `DeviceSession` convenience methods are `addStream(config:)` and `addDisplay()`).
/// There is NO `addAudio()` / `addSpeaker()` / `playAudio()` anywhere in MWDATCore /
/// MWDATCamera / MWDATDisplay (verified against the arm64-apple-ios.swiftinterface files).
/// The only `speaker*` tokens in the SDK are display ICON glyphs (`speakerOff`,
/// `speakerWithOneArc`, …) and the only `microphone` tokens are input-permission cases.
/// So the glasses are NOT addressable as an in-app DAT audio sink.
///
/// The glasses' open-ear speakers ARE a standard Bluetooth audio output, so we route to
/// them through `AVAudioSession`: a `.playAndRecord` category with Bluetooth output
/// allowed, no `.defaultToSpeaker` override, and an explicit preference for a connected
/// Bluetooth A2DP / HFP output port. If no Bluetooth output is connected we fall back to
/// the phone (receiver) rather than forcing the loudspeaker.
enum GlassesAudioRoute {
  /// Output port types that correspond to the glasses (or any Bluetooth audio device).
  private static let bluetoothOutputs: Set<AVAudioSession.Port> = [
    .bluetoothA2DP, // music/media route — the glasses' open-ear speakers land here
    .bluetoothHFP,  // hands-free (also used while .playAndRecord routes both ways)
    .bluetoothLE,
  ]

  /// Category options that make a Bluetooth output (the glasses) reachable while still
  /// allowing recording. No `.defaultToSpeaker` — that is what forced the phone speaker.
  static let categoryOptions: AVAudioSession.CategoryOptions = [.allowBluetooth, .allowBluetoothA2DP]

  /// True if the session's current output is a Bluetooth device (best-effort proxy for
  /// "the glasses are the active output").
  static var isRoutedToBluetooth: Bool {
    AVAudioSession.sharedInstance().currentRoute.outputs.contains { bluetoothOutputs.contains($0.portType) }
  }

  /// Steer playback toward the glasses' Bluetooth output if one is connected.
  ///
  /// Safe to call before every playback (and on a session that may already be configured
  /// for recording): it only adjusts category options / overrides, never tears down an
  /// active recording. Clears any lingering `.defaultToSpeaker` override so we stop
  /// forcing the loudspeaker. Returns true if a Bluetooth output appears to be active.
  @discardableResult
  static func routeToGlasses() -> Bool {
    let session = AVAudioSession.sharedInstance()
    do {
      // Ensure Bluetooth output is permitted. Re-asserting the category is cheap and keeps
      // the route correct even if something else changed the session underneath us.
      if session.category != .playAndRecord || !session.categoryOptions.contains(.allowBluetoothA2DP) {
        try session.setCategory(.playAndRecord, mode: .default, options: categoryOptions)
      }
      try session.setActive(true)
      // Undo any earlier `.defaultToSpeaker`; with A2DP allowed and no override, iOS routes
      // media playback to the connected Bluetooth device (the glasses) automatically.
      try session.overrideOutputAudioPort(.none)
    } catch {
      DATLog.log.error("[wiser] routeToGlasses failed: \(String(describing: error), privacy: .public)")
    }
    return isRoutedToBluetooth
  }
}

// MARK: - Sequential TTS playback

/// Plays an ordered list of base64 WAV chunks back-to-back, routed to the glasses'
/// open-ear speakers when connected (see `GlassesAudioRoute`), otherwise the phone.
/// Duration-based sequencing (no delegate) keeps it @MainActor and Sendable-clean.
@MainActor
final class AudioChunkPlayer {
  private var player: AVAudioPlayer?
  private var task: Task<Void, Never>?

  func play(base64Chunks: [String], onDone: @escaping () -> Void) {
    stop()
    let datas = base64Chunks.compactMap { Data(base64Encoded: $0) }
    guard !datas.isEmpty else { onDone(); return }
    // Route to the glasses' Bluetooth speakers before playing (also covers Replay, which
    // can run without a preceding recording having configured the session).
    GlassesAudioRoute.routeToGlasses()
    task = Task { @MainActor in
      for data in datas {
        if Task.isCancelled { break }
        do {
          let p = try AVAudioPlayer(data: data)
          self.player = p
          p.prepareToPlay()
          p.play()
          try? await Task.sleep(nanoseconds: UInt64((p.duration + 0.05) * 1_000_000_000))
        } catch {
          continue
        }
      }
      self.player = nil
      if !Task.isCancelled { onDone() }
    }
  }

  func stop() {
    task?.cancel()
    task = nil
    player?.stop()
    player = nil
  }
}

// MARK: - View model

@Observable
@MainActor
final class WiserViewModel {
  enum Phase: String {
    case idle = "Ready"
    case listening = "Listening…"
    case thinking = "Thinking…"
    case speaking = "Speaking…"
  }

  var phase: Phase = .idle
  var transcript: String = ""
  var answer: String = ""
  var glassesReady: Bool = false
  var backendURL: String = WiserConfig.backendURL
  var showError: Bool = false
  var errorMessage: String = ""

  /// The conversation this app is currently threading.
  /// nil => the next ask starts a fresh conversation; the backend assigns an id and we
  /// capture it from the response so following asks continue the same conversation.
  var currentSessionId: String?

  var isRecording: Bool { phase == .listening }
  var isBusy: Bool { phase == .thinking }

  /// Short, glanceable label for the current conversation shown on the Ask screen.
  var sessionLabel: String {
    if let id = currentSessionId, !id.isEmpty {
      return "session " + String(id.prefix(6))
    }
    return "new conversation"
  }

  @ObservationIgnored private let wearables: WearablesInterface
  @ObservationIgnored private let sessionManager: DeviceSessionManager
  @ObservationIgnored private var display: Display?
  @ObservationIgnored private var displayToken: AnyListenerToken?
  @ObservationIgnored private var recorder: AVAudioRecorder?
  @ObservationIgnored private var recordingURL: URL?
  @ObservationIgnored private let audio = AudioChunkPlayer()
  @ObservationIgnored private var lastChunks: [String] = []

  // MARK: Lens session-browse state
  //
  // Holds the fetched session list and which one is currently shown while the user is
  // BROWSING sessions ON THE LENS (paging model — see `sendSessionBrowseCard`). These are
  // @ObservationIgnored because they drive the lens card, not the phone SwiftUI view.
  @ObservationIgnored private var browseSessions: [SessionSummary] = []
  @ObservationIgnored private var browseIndex: Int = 0

  init(wearables: WearablesInterface) {
    self.wearables = wearables
    self.sessionManager = DeviceSessionManager(wearables: wearables)
  }

  // MARK: Glasses display (best-effort)

  func startGlasses() async {
    guard display == nil else { return }
    do {
      let session = try await sessionManager.getSession()
      let capability = try session.addDisplay()
      displayToken = capability.statePublisher.listen { [weak self] state in
        Task { @MainActor in
          guard let self else { return }
          if state == .started {
            self.glassesReady = true
            await self.sendReadyCard()
          }
        }
      }
      await capability.start()
      display = capability
    } catch {
      DATLog.log.error("[wiser] startGlasses failed: \(String(describing: error), privacy: .public)")
    }
  }

  /// Which tappable affordance(s) the on-lens card should show.
  /// Each case's onClick is delivered back to the app by MWDATDisplay so the
  /// Meta Neural Band tap can drive the whole loop hands-on-glasses.
  private enum CardControl {
    case ask    // idle/ready  -> tap starts listening
    case stop   // listening   -> tap stops & sends
    case again  // answer shown -> tap asks again
    case none   // thinking / no control
  }

  /// Hop the @Sendable onClick/onTap closure back onto the main actor and run
  /// the matching VM method. `toggleRecording()` is used for ask/stop so the
  /// single affordance flips correctly even if `phase` changed underneath us.
  private func runControl(_ control: CardControl) {
    switch control {
    case .ask, .stop:
      toggleRecording()
    case .again:
      Task { await startRecording() }
    case .none:
      break
    }
  }

  /// Builds the tappable Button for a card, or nil for `.none`.
  /// The onClick hops to the main actor and runs the matching VM method —
  /// this is how a Meta Neural Band tap drives the loop.
  private func controlButton(for control: CardControl) -> MWDATDisplay.Button? {
    switch control {
    case .ask:
      return MWDATDisplay.Button(
        label: "Ask",
        style: .primary,
        iconName: .metaAi,
        onClick: { [weak self] in Task { @MainActor in self?.runControl(.ask) } }
      )
    case .stop:
      return MWDATDisplay.Button(
        label: "Stop",
        style: .primary,
        iconName: .x,
        onClick: { [weak self] in Task { @MainActor in self?.runControl(.stop) } }
      )
    case .again:
      return MWDATDisplay.Button(
        label: "Ask again",
        style: .secondary,
        iconName: .twoArrowsClockwise,
        onClick: { [weak self] in Task { @MainActor in self?.runControl(.again) } }
      )
    case .none:
      return nil
    }
  }

  /// Send a single-control card (ready/listening/thinking/answer states).
  ///
  /// Default-focus / cursor placement.
  ///
  /// MWDATDisplay 0.7.0 has NO explicit focus API — there is no `.focused()`,
  /// `autoFocus`, `defaultFocus`, `tabIndex`, or initial-focus option on Button,
  /// FlexBox, Text, or Display.send (verified against arm64-apple-ios.swiftinterface
  /// and the mwdat-ios display-access skill). On the lens the Neural Band cursor
  /// lands on the FIRST focusable child in document order. Text is not focusable;
  /// the Button (it carries an onClick) is.
  ///
  /// Implicit-focus pattern: emit the primary Button as the FIRST child so it is the
  /// initial — and only — focusable element, immediately tappable via the Neural Band
  /// with no scrolling. The title/body Text follow it for context. The whole-card
  /// `.onTap` below still mirrors the same control as a fallback for an off-center tap.
  private func sendCard(title: String, body: String, control: CardControl = .none) async {
    guard let display else { return }
    let button = controlButton(for: control)
    do {
      try await display.send(
        FlexBox(direction: .column, spacing: 12) {
          if let button {
            button
          }
          MWDATDisplay.Text(title, style: .heading)
          if !body.isEmpty {
            MWDATDisplay.Text(body, style: .body, color: .secondary)
          }
        }
        .padding(24)
        .background(.card)
        // Whole-card tap mirrors the button so an off-center band tap still
        // drives the primary ask/stop affordance.
        .onTap { [weak self] in
          Task { @MainActor in self?.runControl(control) }
        }
      )
    } catch {
      let msg = (error as? DisplayError)?.description ?? error.localizedDescription
      DATLog.log.error("[wiser] display.send failed: \(msg, privacy: .public)")
    }
  }

  /// The answer card. Like `sendCard(control: .again)` but adds a **Sessions** button so
  /// the lens session-browse entry stays reachable after a conversation. "Ask again" is
  /// emitted FIRST (implicit cursor lands on it); whole-card `.onTap` mirrors Ask again.
  private func sendAnswerCard(title: String, body: String) async {
    guard let display else { return }
    let againButton = MWDATDisplay.Button(
      label: "Ask again",
      style: .primary,
      iconName: .twoArrowsClockwise,
      onClick: { [weak self] in Task { @MainActor in self?.runControl(.again) } }
    )
    let sessionsButton = MWDATDisplay.Button(
      label: "Sessions",
      style: .secondary,
      iconName: .speechBubble,
      onClick: { [weak self] in Task { @MainActor in await self?.openSessionsOnLens() } }
    )
    do {
      try await display.send(
        FlexBox(direction: .column, spacing: 12) {
          FlexBox(direction: .row, spacing: 8) {
            againButton
            sessionsButton
          }
          MWDATDisplay.Text(title, style: .heading)
          if !body.isEmpty {
            MWDATDisplay.Text(body, style: .body, color: .secondary)
          }
        }
        .padding(24)
        .background(.card)
        .onTap { [weak self] in Task { @MainActor in self?.runControl(.again) } }
      )
    } catch {
      let msg = (error as? DisplayError)?.description ?? error.localizedDescription
      DATLog.log.error("[wiser] sendAnswerCard failed: \(msg, privacy: .public)")
    }
  }

  // MARK: - Lens entry / ready card

  /// The idle/ready lens card. Entry point to the whole lens UX: two buttons —
  /// **Ask** (start the voice loop) and **Sessions** (browse past conversations
  /// ON THE LENS). Ask is emitted FIRST so the implicit cursor lands on the most
  /// common action; the whole-card `.onTap` mirrors Ask as a fallback.
  ///
  /// We render the two buttons in a `.row` FlexBox so they sit side-by-side as two
  /// distinct focusable affordances. (See `sendSessionBrowseCard` for why we keep
  /// the focusable-button count small and provide whole-card tap fallbacks: 0.7.0
  /// has no API to express or observe multi-item focus traversal.)
  private func sendReadyCard() async {
    guard let display else { return }
    let askButton = MWDATDisplay.Button(
      label: "Ask",
      style: .primary,
      iconName: .metaAi,
      onClick: { [weak self] in Task { @MainActor in self?.runControl(.ask) } }
    )
    let sessionsButton = MWDATDisplay.Button(
      label: "Sessions",
      style: .secondary,
      iconName: .speechBubble,
      onClick: { [weak self] in Task { @MainActor in await self?.openSessionsOnLens() } }
    )
    do {
      try await display.send(
        FlexBox(direction: .column, spacing: 12) {
          FlexBox(direction: .row, spacing: 8) {
            askButton
            sessionsButton
          }
          MWDATDisplay.Text("wiser", style: .heading)
          MWDATDisplay.Text(currentSessionId == nil
                              ? "Tap Ask to speak, or Sessions to resume."
                              : "Continuing \(sessionLabel). Ask or pick Sessions.",
                            style: .body, color: .secondary)
        }
        .padding(24)
        .background(.card)
        // Off-center tap defaults to the most common action (Ask).
        .onTap { [weak self] in Task { @MainActor in self?.runControl(.ask) } }
      )
    } catch {
      let msg = (error as? DisplayError)?.description ?? error.localizedDescription
      DATLog.log.error("[wiser] sendReadyCard failed: \(msg, privacy: .public)")
    }
  }

  // MARK: - Lens session browsing (paging model)
  //
  // NAVIGATION MODEL: PAGING (one session per card), chosen because MWDATDisplay 0.7.0
  // exposes NO focus API and NO way to express, observe, or control which of several
  // focusable items is selected (verified against arm64-apple-ios.swiftinterface — the
  // only interaction primitives are `Button.onClick` and `FlexBox.onTap` — and the
  // display-access skill, which documents no cursor/swipe traversal between items).
  // Rendering the whole list as a column of N Buttons would gamble that band swipes move
  // a cursor between them, which is undocumented. Instead we show ONE session per card
  // with a small, fixed set of explicit, individually-tappable buttons:
  //   [Select] [Next] [New] [Back]
  // plus the whole-card `.onTap` wired to Select as a fallback. The user swipes/taps to
  // the Next button to advance through sessions and taps Select to resume the shown one.

  /// Entry from the ready card's "Sessions" button: fetch the list and show the first
  /// session on the lens. Shows a brief loading card, then the first page (or an empty
  /// card offering New / Back if there are no sessions).
  private func openSessionsOnLens() async {
    await sendCard(title: "Sessions…", body: "Loading conversations.")
    do {
      let list = try await fetchSessions()
      browseSessions = list
      browseIndex = 0
      if list.isEmpty {
        await sendEmptySessionsCard()
      } else {
        await sendSessionBrowseCard()
      }
    } catch {
      // Surface on the lens AND fall back to the ready card so the user is never stuck.
      await sendCard(title: "Sessions failed",
                     body: String(error.localizedDescription.prefix(120)))
      try? await Task.sleep(nanoseconds: 1_500_000_000)
      await sendReadyCard()
    }
  }

  /// No sessions yet: offer New (start fresh) and Back (return to ready).
  private func sendEmptySessionsCard() async {
    guard let display else { return }
    let newButton = MWDATDisplay.Button(
      label: "New",
      style: .primary,
      iconName: .plus,
      onClick: { [weak self] in Task { @MainActor in await self?.newSessionOnLens() } }
    )
    let backButton = MWDATDisplay.Button(
      label: "Back",
      style: .secondary,
      iconName: .arrowLeft,
      onClick: { [weak self] in Task { @MainActor in await self?.sendReadyCard() } }
    )
    do {
      try await display.send(
        FlexBox(direction: .column, spacing: 12) {
          FlexBox(direction: .row, spacing: 8) {
            newButton
            backButton
          }
          MWDATDisplay.Text("No conversations", style: .heading)
          MWDATDisplay.Text("Start a New one, or go Back.", style: .body, color: .secondary)
        }
        .padding(24)
        .background(.card)
        .onTap { [weak self] in Task { @MainActor in await self?.newSessionOnLens() } }
      )
    } catch {
      let msg = (error as? DisplayError)?.description ?? error.localizedDescription
      DATLog.log.error("[wiser] sendEmptySessionsCard failed: \(msg, privacy: .public)")
    }
  }

  /// Short, glanceable label for one session on the lens: preview, else title, else id.
  private func browseLabel(_ s: SessionSummary) -> String {
    let primary = String(s.displayTitle.prefix(60))
    if let rel = WiserRelativeTime.string(from: s.updatedAt ?? s.createdAt) {
      return "\(primary)\n\(rel)"
    }
    return primary
  }

  /// Render the session at `browseIndex` as a single card with paging controls.
  ///
  /// Focusable buttons (kept deliberately few, primary action FIRST so the implicit
  /// cursor lands on it): [Select] then [Next] (only if more than one) then [New] then
  /// [Back]. The whole-card `.onTap` resumes the shown session as a fallback. The body
  /// shows "i of N" so the user knows where they are while paging.
  private func sendSessionBrowseCard() async {
    guard let display else { return }
    guard !browseSessions.isEmpty else {
      await sendEmptySessionsCard()
      return
    }
    let count = browseSessions.count
    let index = max(0, min(browseIndex, count - 1))
    browseIndex = index
    let session = browseSessions[index]
    let sessionId = session.id
    let position = "\(index + 1) of \(count)"

    let selectButton = MWDATDisplay.Button(
      label: "Select",
      style: .primary,
      iconName: .checkmark,
      onClick: { [weak self] in Task { @MainActor in await self?.pickSessionOnLens(id: sessionId) } }
    )
    let nextButton = MWDATDisplay.Button(
      label: "Next",
      style: .secondary,
      iconName: .triangleRight,
      onClick: { [weak self] in Task { @MainActor in await self?.advanceBrowse() } }
    )
    let newButton = MWDATDisplay.Button(
      label: "New",
      style: .secondary,
      iconName: .plus,
      onClick: { [weak self] in Task { @MainActor in await self?.newSessionOnLens() } }
    )
    let backButton = MWDATDisplay.Button(
      label: "Back",
      style: .outline,
      iconName: .arrowLeft,
      onClick: { [weak self] in Task { @MainActor in await self?.sendReadyCard() } }
    )

    do {
      try await display.send(
        FlexBox(direction: .column, spacing: 10) {
          // Primary + paging controls as a row of distinct focusable buttons.
          FlexBox(direction: .row, spacing: 8) {
            selectButton
            if count > 1 {
              nextButton
            }
            newButton
            backButton
          }
          MWDATDisplay.Text(position, style: .meta, color: .secondary)
          MWDATDisplay.Text(browseLabel(session), style: .body)
        }
        .padding(20)
        .background(.card)
        // Off-center tap resumes the currently shown session.
        .onTap { [weak self] in Task { @MainActor in await self?.pickSessionOnLens(id: sessionId) } }
      )
    } catch {
      let msg = (error as? DisplayError)?.description ?? error.localizedDescription
      DATLog.log.error("[wiser] sendSessionBrowseCard failed: \(msg, privacy: .public)")
    }
  }

  /// Advance to the next session (wraps around to the first), then re-render.
  private func advanceBrowse() async {
    guard !browseSessions.isEmpty else { return }
    browseIndex = (browseIndex + 1) % browseSessions.count
    await sendSessionBrowseCard()
  }

  /// Resume the picked session: point future asks at it, show a brief confirmation
  /// card on the lens, then return to the ready/ask card.
  private func pickSessionOnLens(id: String) async {
    // Keep transcript as-is — the next ask continues this conversation's memory.
    resumeSession(id: id, clearTranscript: false)
    let preview = browseSessions.first(where: { $0.id == id }).map { String($0.displayTitle.prefix(80)) } ?? ""
    await sendCard(title: "Resumed", body: preview.isEmpty ? sessionLabel : preview)
    try? await Task.sleep(nanoseconds: 1_200_000_000)
    await sendReadyCard()
  }

  /// Start a brand-new conversation from the lens, show a confirmation, return to ready.
  /// Tries the backend `POST /api/sessions`; if that fails, falls back to clearing the
  /// current session id so the next ask still starts fresh (the lens path never dead-ends).
  private func newSessionOnLens() async {
    do {
      try await startNewSession()
    } catch {
      // Backend create failed — clear locally so the next ask starts a fresh conversation.
      currentSessionId = nil
      transcript = ""
      answer = ""
      lastChunks = []
      DATLog.log.error("[wiser] newSessionOnLens create failed, cleared locally: \(String(describing: error), privacy: .public)")
    }
    await sendCard(title: "New conversation", body: "Tap Ask and speak.")
    try? await Task.sleep(nanoseconds: 1_200_000_000)
    await sendReadyCard()
  }

  // MARK: Voice loop

  func toggleRecording() {
    if isRecording {
      Task { await stopAndSend() }
    } else {
      Task { await startRecording() }
    }
  }

  func startRecording() async {
    audio.stop()
    guard await requestMicPermission() else {
      showErr("Microphone permission denied — enable it in Settings.")
      return
    }
    do {
      let session = AVAudioSession.sharedInstance()
      // Allow the glasses' Bluetooth output for TTS playback; do NOT use .defaultToSpeaker
      // (that forced the PHONE loudspeaker). We still prefer the phone's built-in mic for
      // INPUT below so recording quality stays high and we don't grab a low-bitrate
      // Bluetooth HFP mic.
      try session.setCategory(.playAndRecord, mode: .default, options: GlassesAudioRoute.categoryOptions)
      try session.setActive(true)
      // Pin input to the phone's built-in mic regardless of the Bluetooth output route.
      if let builtInMic = session.availableInputs?.first(where: { $0.portType == .builtInMic }) {
        try? session.setPreferredInput(builtInMic)
      }

      let url = FileManager.default.temporaryDirectory.appendingPathComponent("wiser-recording.m4a")
      try? FileManager.default.removeItem(at: url)
      let settings: [String: Any] = [
        AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
        AVSampleRateKey: 16_000.0,
        AVNumberOfChannelsKey: 1,
        AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
      ]
      let rec = try AVAudioRecorder(url: url, settings: settings)
      rec.record()
      recorder = rec
      recordingURL = url
      phase = .listening
      await sendCard(title: "Listening…", body: "Speak, then tap Stop.", control: .stop)
    } catch {
      showErr("Couldn't start recording: \(error.localizedDescription)")
    }
  }

  func stopAndSend() async {
    recorder?.stop()
    recorder = nil
    phase = .thinking
    await sendCard(title: "Thinking…", body: "")

    guard let url = recordingURL, let data = try? Data(contentsOf: url), !data.isEmpty else {
      showErr(WiserError.noAudio.localizedDescription)
      phase = .idle
      return
    }
    do {
      let result = try await postAsk(audio: data, audioName: "recording.m4a", audioType: "audio/m4a", image: nil)
      await handleResult(result)
    } catch {
      showErr("Request failed: \(error.localizedDescription)")
      phase = .idle
    }
  }

  private func handleResult(_ r: AskResponse) async {
    transcript = r.transcript
    answer = r.answer
    lastChunks = r.audioChunks
    // Capture/continue the conversation: the backend echoes the session it used (a new one
    // if we sent none). Persist it so the next ask threads the same conversation memory.
    if let sid = r.sessionId, !sid.isEmpty {
      currentSessionId = sid
    }
    await sendAnswerCard(title: r.card.title, body: String(r.answer.prefix(240)))

    if r.audioChunks.isEmpty {
      phase = .idle
    } else {
      phase = .speaking
      audio.play(base64Chunks: r.audioChunks) { [weak self] in
        Task { @MainActor in self?.phase = .idle }
      }
    }
  }

  func replay() {
    guard !lastChunks.isEmpty else { return }
    phase = .speaking
    audio.play(base64Chunks: lastChunks) { [weak self] in
      Task { @MainActor in self?.phase = .idle }
    }
  }

  // MARK: Networking

  private func postAsk(audio audioData: Data, audioName: String, audioType: String, image: Data?) async throws -> AskResponse {
    WiserConfig.backendURL = backendURL.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: WiserConfig.backendURL + "/api/ask") else {
      throw WiserError.server("Invalid backend URL")
    }
    let boundary = "wiser-\(UUID().uuidString)"
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.timeoutInterval = 60
    req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

    var body = Data()
    func append(_ s: String) { body.append(s.data(using: .utf8)!) }
    // Thread the conversation: include the current session id (if any) as a form field so
    // the backend continues that conversation; omitting it starts a fresh one.
    if let sid = currentSessionId, !sid.isEmpty {
      append("--\(boundary)\r\n")
      append("Content-Disposition: form-data; name=\"sessionId\"\r\n\r\n")
      append(sid)
      append("\r\n")
    }
    append("--\(boundary)\r\n")
    append("Content-Disposition: form-data; name=\"audio\"; filename=\"\(audioName)\"\r\n")
    append("Content-Type: \(audioType)\r\n\r\n")
    body.append(audioData)
    append("\r\n")
    if let image {
      append("--\(boundary)\r\n")
      append("Content-Disposition: form-data; name=\"image\"; filename=\"frame.jpg\"\r\n")
      append("Content-Type: image/jpeg\r\n\r\n")
      body.append(image)
      append("\r\n")
    }
    append("--\(boundary)--\r\n")

    let (data, resp) = try await URLSession.shared.upload(for: req, from: body)
    guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let detail = String(data: data, encoding: .utf8) ?? "request failed"
      throw WiserError.server(detail)
    }
    return try JSONDecoder().decode(AskResponse.self, from: data)
  }

  /// Send a typed prompt via `POST /api/ask-text {text, sessionId?}`.
  /// Not wired into the UI yet (the loop is voice-first), but kept so the JSON path of the
  /// contract is exercised the same way as the multipart one — handy for testing/text entry.
  func askText(_ text: String) async {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    transcript = trimmed
    phase = .thinking
    await sendCard(title: "Thinking…", body: "")
    do {
      let result = try await postAskText(trimmed)
      await handleResult(result)
    } catch {
      showErr("Request failed: \(error.localizedDescription)")
      phase = .idle
    }
  }

  private func postAskText(_ text: String) async throws -> AskResponse {
    let req = try makeJSONRequest(path: "/api/ask-text", body: AskTextBody(text: text, sessionId: currentSessionId))
    let (data, resp) = try await URLSession.shared.data(for: req)
    guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      throw WiserError.server(String(data: data, encoding: .utf8) ?? "request failed")
    }
    return try JSONDecoder().decode(AskResponse.self, from: data)
  }

  private struct AskTextBody: Encodable {
    let text: String
    let sessionId: String?
  }

  // MARK: Sessions

  /// List conversations: `GET /api/sessions`.
  func fetchSessions() async throws -> [SessionSummary] {
    let req = try makeGETRequest(path: "/api/sessions")
    let (data, resp) = try await URLSession.shared.data(for: req)
    try Self.ensureOK(resp, data)
    return try JSONDecoder().decode(SessionsList.self, from: data).sessions
  }

  /// Load one conversation's transcript: `GET /api/sessions/:id`.
  func fetchSessionDetail(id: String) async throws -> SessionDetail {
    let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
    let req = try makeGETRequest(path: "/api/sessions/\(encoded)")
    let (data, resp) = try await URLSession.shared.data(for: req)
    try Self.ensureOK(resp, data)
    return try JSONDecoder().decode(SessionDetail.self, from: data)
  }

  /// Start a brand-new conversation: `POST /api/sessions` -> { sessionId }.
  /// Sets `currentSessionId` and clears the on-screen transcript/answer for a fresh start.
  func startNewSession() async throws {
    let req = try makeJSONRequest(path: "/api/sessions", body: EmptyBody())
    let (data, resp) = try await URLSession.shared.data(for: req)
    try Self.ensureOK(resp, data)
    let created = try JSONDecoder().decode(CreateSessionResponse.self, from: data)
    resumeSession(id: created.sessionId, clearTranscript: true)
  }

  /// Point future asks at an existing conversation.
  /// `clearTranscript` is true for a fresh "New session" (no history yet); false when
  /// resuming an existing one (the detail screen already shows that conversation's history).
  func resumeSession(id: String, clearTranscript: Bool) {
    currentSessionId = id
    if clearTranscript {
      transcript = ""
      answer = ""
      lastChunks = []
    }
  }

  private struct EmptyBody: Encodable {}

  // MARK: Request builders

  private func baseURL() throws -> URL {
    WiserConfig.backendURL = backendURL.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: WiserConfig.backendURL) else {
      throw WiserError.server("Invalid backend URL")
    }
    return url
  }

  private func makeGETRequest(path: String) throws -> URLRequest {
    let url = try baseURL().appendingPathComponent(path.hasPrefix("/") ? String(path.dropFirst()) : path)
    var req = URLRequest(url: url)
    req.httpMethod = "GET"
    req.timeoutInterval = 30
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    return req
  }

  private func makeJSONRequest<Body: Encodable>(path: String, body: Body) throws -> URLRequest {
    let url = try baseURL().appendingPathComponent(path.hasPrefix("/") ? String(path.dropFirst()) : path)
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.timeoutInterval = 60
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    req.httpBody = try JSONEncoder().encode(body)
    return req
  }

  private static func ensureOK(_ resp: URLResponse, _ data: Data) throws {
    guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      throw WiserError.server(String(data: data, encoding: .utf8) ?? "request failed")
    }
  }

  // MARK: Lifecycle / helpers

  func stop() async {
    recorder?.stop()
    recorder = nil
    audio.stop()
    displayToken = nil
    await display?.stop()
    display = nil
    glassesReady = false
    sessionManager.cleanup()
  }

  func saveBackendURL() {
    backendURL = backendURL.trimmingCharacters(in: .whitespacesAndNewlines)
    WiserConfig.backendURL = backendURL
  }

  func dismissError() { showError = false }

  private func showErr(_ message: String) {
    errorMessage = message
    showError = true
    DATLog.log.error("[wiser] \(message, privacy: .public)")
  }

  private func requestMicPermission() async -> Bool {
    await withCheckedContinuation { cont in
      AVAudioApplication.requestRecordPermission { granted in
        cont.resume(returning: granted)
      }
    }
  }
}

// MARK: - View

struct WiserView: View {
  @State private var viewModel: WiserViewModel
  @State private var showSessions = false

  init(wearables: WearablesInterface) {
    _viewModel = State(wrappedValue: WiserViewModel(wearables: wearables))
  }

  var body: some View {
    NavigationStack {
      askContent
        .toolbar {
          ToolbarItem(placement: .topBarTrailing) {
            Button {
              showSessions = true
            } label: {
              Label("Sessions", systemImage: "bubble.left.and.bubble.right")
            }
            .tint(.cyan)
          }
        }
        .toolbarBackground(.black, for: .navigationBar)
        .sheet(isPresented: $showSessions) {
          SessionsView(viewModel: viewModel)
        }
    }
  }

  private var askContent: some View {
    ZStack {
      Color.black.ignoresSafeArea()

      VStack(spacing: 18) {
        HStack {
          Text("wiser")
            .font(.system(size: 32, weight: .bold))
            .foregroundStyle(.cyan)
          Spacer()
          Circle()
            .fill(viewModel.glassesReady ? Color.green : Color.gray)
            .frame(width: 10, height: 10)
          Text(viewModel.glassesReady ? "glasses" : "no glasses")
            .font(.caption)
            .foregroundStyle(.gray)
        }

        // Current conversation, surfaced subtly. Tap to browse/switch sessions.
        Button {
          showSessions = true
        } label: {
          HStack(spacing: 6) {
            Image(systemName: "bubble.left.and.bubble.right.fill")
              .font(.system(size: 11))
            Text(viewModel.sessionLabel)
              .font(.system(size: 12, weight: .medium, design: .monospaced))
          }
          .foregroundStyle(.cyan.opacity(0.85))
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)

        TextField("backend URL", text: $viewModel.backendURL)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .keyboardType(.URL)
          .font(.system(size: 13, design: .monospaced))
          .foregroundStyle(.white)
          .padding(10)
          .background(Color.white.opacity(0.08))
          .cornerRadius(8)
          .onSubmit { viewModel.saveBackendURL() }

        Text(viewModel.phase.rawValue)
          .font(.headline)
          .foregroundStyle(.white.opacity(0.8))
          .padding(.top, 4)

        if !viewModel.transcript.isEmpty || !viewModel.answer.isEmpty {
          ScrollView {
            VStack(alignment: .leading, spacing: 12) {
              if !viewModel.transcript.isEmpty {
                Text("You")
                  .font(.caption).foregroundStyle(.gray)
                Text(viewModel.transcript)
                  .foregroundStyle(.white.opacity(0.85))
              }
              if !viewModel.answer.isEmpty {
                Text("wiser")
                  .font(.caption).foregroundStyle(.cyan)
                Text(viewModel.answer)
                  .foregroundStyle(.white)
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }
          .frame(maxHeight: 240)
        }

        Spacer()

        Button {
          viewModel.toggleRecording()
        } label: {
          Text(viewModel.isRecording ? "Stop" : "Ask")
            .font(.system(size: 20, weight: .bold))
            .frame(maxWidth: .infinity)
            .frame(height: 66)
            .background(viewModel.isRecording ? Color.red : Color.cyan)
            .foregroundStyle(.black)
            .cornerRadius(33)
        }
        .disabled(viewModel.isBusy)
        .opacity(viewModel.isBusy ? 0.6 : 1.0)

        if !viewModel.answer.isEmpty {
          Button("Replay") { viewModel.replay() }
            .foregroundStyle(.cyan)
        }
      }
      .padding(24)
    }
    .task { await viewModel.startGlasses() }
    .onDisappear { Task { await viewModel.stop() } }
    .alert("Error", isPresented: $viewModel.showError) {
      Button("OK") { viewModel.dismissError() }
    } message: {
      Text(viewModel.errorMessage)
    }
  }
}

// MARK: - Sessions browse screen

/// Lists conversations from `GET /api/sessions`. Tap a row to open its transcript
/// (with a Resume action); "New session" starts a fresh conversation.
struct SessionsView: View {
  let viewModel: WiserViewModel
  @Environment(\.dismiss) private var dismiss

  @State private var sessions: [SessionSummary] = []
  @State private var isLoading = false
  @State private var loadError: String?

  var body: some View {
    NavigationStack {
      ZStack {
        Color.black.ignoresSafeArea()
        content
      }
      .navigationTitle("Sessions")
      .navigationBarTitleDisplayMode(.inline)
      .toolbarBackground(.black, for: .navigationBar)
      .toolbarColorScheme(.dark, for: .navigationBar)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Done") { dismiss() }.tint(.cyan)
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            Task { await newSession() }
          } label: {
            Label("New session", systemImage: "square.and.pencil")
          }
          .tint(.cyan)
          .disabled(isLoading)
        }
      }
      .task { await load() }
      .refreshable { await load() }
    }
    .preferredColorScheme(.dark)
  }

  @ViewBuilder
  private var content: some View {
    if isLoading && sessions.isEmpty {
      ProgressView().tint(.cyan)
    } else if let loadError, sessions.isEmpty {
      VStack(spacing: 12) {
        Text("Couldn't load sessions")
          .foregroundStyle(.white)
        Text(loadError)
          .font(.caption)
          .foregroundStyle(.gray)
          .multilineTextAlignment(.center)
        Button("Retry") { Task { await load() } }
          .tint(.cyan)
      }
      .padding(24)
    } else if sessions.isEmpty {
      VStack(spacing: 8) {
        Image(systemName: "bubble.left.and.bubble.right")
          .font(.system(size: 34))
          .foregroundStyle(.gray)
        Text("No conversations yet")
          .foregroundStyle(.white)
        Text("Tap New session, or just Ask.")
          .font(.caption)
          .foregroundStyle(.gray)
      }
    } else {
      List {
        ForEach(sessions) { session in
          NavigationLink {
            SessionDetailView(viewModel: viewModel, summary: session, onResume: { dismiss() })
          } label: {
            SessionRow(session: session, isCurrent: session.id == viewModel.currentSessionId)
          }
          .listRowBackground(Color.white.opacity(0.05))
        }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
    }
  }

  private func load() async {
    isLoading = true
    loadError = nil
    do {
      sessions = try await viewModel.fetchSessions()
    } catch {
      loadError = error.localizedDescription
    }
    isLoading = false
  }

  private func newSession() async {
    do {
      try await viewModel.startNewSession()
      dismiss()
    } catch {
      loadError = error.localizedDescription
    }
  }
}

private struct SessionRow: View {
  let session: SessionSummary
  let isCurrent: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        Text(session.displayTitle)
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(.white)
          .lineLimit(1)
        if isCurrent {
          Text("current")
            .font(.system(size: 10, weight: .bold))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Color.cyan.opacity(0.25))
            .foregroundStyle(.cyan)
            .clipShape(Capsule())
        }
      }
      if let preview = session.preview, !preview.isEmpty, preview != session.title {
        Text(preview)
          .font(.system(size: 13))
          .foregroundStyle(.white.opacity(0.7))
          .lineLimit(2)
      }
      HStack(spacing: 8) {
        if let rel = WiserRelativeTime.string(from: session.updatedAt ?? session.createdAt) {
          Text(rel)
        }
        if let status = session.status, !status.isEmpty {
          Text("• \(status)")
        }
      }
      .font(.system(size: 11))
      .foregroundStyle(.gray)
    }
    .padding(.vertical, 4)
  }
}

// MARK: - Session detail screen

/// Shows a conversation's messages from `GET /api/sessions/:id` with a Resume action that
/// points future asks at this conversation and returns to the Ask screen.
struct SessionDetailView: View {
  let viewModel: WiserViewModel
  let summary: SessionSummary
  /// Called after Resume so the parent sheet can dismiss back to the Ask screen.
  let onResume: () -> Void
  @Environment(\.dismiss) private var dismiss

  @State private var detail: SessionDetail?
  @State private var isLoading = false
  @State private var loadError: String?

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      content
    }
    .navigationTitle(summary.displayTitle)
    .navigationBarTitleDisplayMode(.inline)
    .toolbarBackground(.black, for: .navigationBar)
    .toolbarColorScheme(.dark, for: .navigationBar)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button("Resume") { resume() }
          .tint(.cyan)
          .fontWeight(.semibold)
      }
    }
    .task { await load() }
  }

  @ViewBuilder
  private var content: some View {
    if isLoading {
      ProgressView().tint(.cyan)
    } else if let loadError {
      VStack(spacing: 12) {
        Text("Couldn't load conversation")
          .foregroundStyle(.white)
        Text(loadError)
          .font(.caption).foregroundStyle(.gray).multilineTextAlignment(.center)
        Button("Retry") { Task { await load() } }.tint(.cyan)
      }
      .padding(24)
    } else if let detail {
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          ForEach(Array(detail.messages.enumerated()), id: \.offset) { _, msg in
            MessageBubble(message: msg)
          }
          if detail.messages.isEmpty {
            Text("No messages yet.")
              .font(.caption).foregroundStyle(.gray)
              .frame(maxWidth: .infinity, alignment: .center)
              .padding(.top, 40)
          }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    } else {
      Color.clear
    }
  }

  private func load() async {
    isLoading = true
    loadError = nil
    do {
      detail = try await viewModel.fetchSessionDetail(id: summary.id)
    } catch {
      loadError = error.localizedDescription
    }
    isLoading = false
  }

  private func resume() {
    // Point future asks at this conversation; keep the on-screen transcript as-is
    // (the next ask continues from here). Dismiss back to the Ask screen.
    viewModel.resumeSession(id: summary.id, clearTranscript: false)
    dismiss()
    onResume()
  }
}

private struct MessageBubble: View {
  let message: SessionMessage

  var body: some View {
    VStack(alignment: message.isUser ? .trailing : .leading, spacing: 3) {
      Text(message.isUser ? "You" : "wiser")
        .font(.caption2)
        .foregroundStyle(message.isUser ? .gray : .cyan)
      Text(message.text)
        .font(.system(size: 14))
        .foregroundStyle(.white)
        .padding(10)
        .background(message.isUser ? Color.white.opacity(0.08) : Color.cyan.opacity(0.14))
        .cornerRadius(12)
    }
    .frame(maxWidth: .infinity, alignment: message.isUser ? .trailing : .leading)
  }
}

// MARK: - Relative time

/// Formats backend ISO-8601 (or epoch) timestamps into a short relative string
/// ("2h ago"). Tolerant of the exact timestamp shape the backend sends.
enum WiserRelativeTime {
  private static let isoFractional: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()
  private static let iso: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
  }()
  private static let relative: RelativeDateTimeFormatter = {
    let f = RelativeDateTimeFormatter()
    f.unitsStyle = .short
    return f
  }()

  static func string(from raw: String?) -> String? {
    guard let raw, !raw.isEmpty else { return nil }
    guard let date = parse(raw) else { return nil }
    return relative.localizedString(for: date, relativeTo: Date())
  }

  private static func parse(_ raw: String) -> Date? {
    if let d = isoFractional.date(from: raw) { return d }
    if let d = iso.date(from: raw) { return d }
    // Epoch milliseconds or seconds.
    if let n = Double(raw) {
      return Date(timeIntervalSince1970: n > 1_000_000_000_000 ? n / 1000 : n)
    }
    return nil
  }
}
