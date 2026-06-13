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

  var isRecording: Bool { phase == .listening }
  var isBusy: Bool { phase == .thinking }

  @ObservationIgnored private let wearables: WearablesInterface
  @ObservationIgnored private let sessionManager: DeviceSessionManager
  @ObservationIgnored private var display: Display?
  @ObservationIgnored private var displayToken: AnyListenerToken?
  @ObservationIgnored private var recorder: AVAudioRecorder?
  @ObservationIgnored private var recordingURL: URL?
  @ObservationIgnored private let audio = AudioChunkPlayer()
  @ObservationIgnored private var lastChunks: [String] = []

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
            await self.sendCard(title: "wiser", body: "Tap Ask and speak.", control: .ask)
          }
        }
      }
      await capability.start()
      display = capability
    } catch {
      DATLog.log.error("[wiser] startGlasses failed: \(String(describing: error), privacy: .public)")
    }
  }

  /// Which tappable affordance (if any) the on-lens card should show.
  /// The button's onClick is delivered back to the app by MWDATDisplay so the
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

  private func sendCard(title: String, body: String, control: CardControl = .none) async {
    guard let display else { return }
    let button = controlButton(for: control)
    do {
      // Default-focus / cursor placement.
      //
      // MWDATDisplay 0.7.0 has NO explicit focus API — there is no `.focused()`,
      // `autoFocus`, `defaultFocus`, `tabIndex`, or initial-focus option on Button,
      // FlexBox, Text, or Display.send (verified against arm64-apple-ios.swiftinterface
      // and the mwdat-ios display-access skill). On the lens the Neural Band cursor
      // lands on the FIRST focusable child in document order. Text is not focusable;
      // the Button (it carries an onClick) is. The previous layout put the Button
      // LAST — after the heading and body Text — so the card started with focus above
      // the button and the user had to scroll down to reach it.
      //
      // Fix (implicit-focus pattern): emit the primary Button as the FIRST child so
      // it is the initial — and only — focusable element, immediately tappable via the
      // Neural Band with no scrolling. The title/body Text follow it for context.
      // The whole-card `.onTap` below still mirrors the same control as a fallback for
      // an off-center band tap.
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
    await sendCard(title: r.card.title, body: String(r.answer.prefix(240)), control: .again)

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

  init(wearables: WearablesInterface) {
    _viewModel = State(wrappedValue: WiserViewModel(wearables: wearables))
  }

  var body: some View {
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
