//
// BrainstormSurface.swift
//
// The "Brainstorm" surface: a glasses-first "pitch into the active brainstorm" flow.
//
// Glasses-first (the CARDINAL RULE): the real interaction happens on the lens via MWDATDisplay,
// driven by a Neural Band tap. The user taps [Brainstorm], speaks a short idea, taps [Send], and
// we POST ONE contribution — the raw recorded audio plus the latest glasses POV frame, both
// base64 — to the AMBIENT brainstorm server (a separate ngrok host from the Firebase backend).
// The ambient server transcribes the audio and surfaces it as an opportunity card in a separate
// browser app. We never decode or play any audio response here (unlike the Ask flow).
//
// This is a STANDALONE re-creation of the brainstorm-contribute logic that used to live inside
// WiserViewModel in Wiser.swift. It owns its own @Observable @MainActor view model, its own
// recorder, and its own ambient networking. The lens display capability is shared with the Ask
// and Build surfaces via GlassesDisplayHub (DAT 0.7.0: one display capability per session).
//
// Type names are deliberately unique (Brainstorm*) so this file can be added while another agent
// removes the originals from Wiser.swift in parallel without symbol collisions.
//

import AVFoundation
import Foundation
import MWDATCore
import MWDATDisplay
import Observation
import SwiftUI

// MARK: - Ambient brainstorm contract (mirrors the ambient server's contribute endpoint)

/// `POST {ambientBaseURL}/api/brainstorms/active/contribute` body. Raw recorded audio (the server
/// transcribes it) plus the optional glasses POV frame, both base64. `imageB64` is nil when no POV
/// frame is cached yet. Uniquely named to avoid colliding with `ContributeBody` in Wiser.swift.
struct BrainstormContributeBody: Encodable {
  let audioB64: String
  let audioType: String
  let imageB64: String?
}

/// Loose contribute response: `200 {ok:true}` on success; `409 {error}` if nothing is active.
/// Uniquely named to avoid colliding with `ContributeResponse` in Wiser.swift.
struct BrainstormContributeResponse: Decodable {
  let ok: Bool?
}

// MARK: - View model

@Observable
@MainActor
final class BrainstormViewModel {
  // Phone-facing observable state. The lens is the deliverable; this drives a minimal phone view.
  var glassesReady: Bool = false
  /// Ambient brainstorm server (ngrok tunnel) — separate from the Firebase backend. Editable here.
  var ambientURL: String = WiserConfig.ambientURL
  /// Short, glanceable status for the phone view (mirrors the latest lens card).
  var statusLine: String = "Tap Brainstorm, speak your idea, then Send."
  /// True while a contribution recording is in progress.
  var isListening: Bool = false
  var showError: Bool = false
  var errorMessage: String = ""

  @ObservationIgnored private let wearables: WearablesInterface
  // The lens display is shared (one capability for the whole app — see GlassesDisplayHub).
  // `display` is a thin pointer at the hub's capability so the `display.send(...)` call sites
  // stay simple; it's populated in `startGlasses()` when the hub is ready.
  @ObservationIgnored private var display: Display?
  @ObservationIgnored private var recorder: AVAudioRecorder?
  @ObservationIgnored private var recordingURL: URL?

  init(wearables: WearablesInterface) {
    self.wearables = wearables
  }

  // MARK: Glasses display (best-effort, shared via GlassesDisplayHub)

  func startGlasses() async {
    // Bring up (or reuse) the one shared lens capability; when it's ready, grab the pointer so the
    // `display.send(...)` call sites work, and paint the ready card. This also makes the Brainstorm
    // surface re-take the lens (repaint its ready card) whenever it reappears.
    await GlassesDisplayHub.shared.start(wearables: wearables) { [weak self] in
      guard let self else { return }
      self.display = GlassesDisplayHub.shared.display
      self.glassesReady = true
      await self.sendBrainstormReadyCard()
    }
  }

  func stop() async {
    // Only tear down THIS surface's local resources. The lens display capability is shared
    // (GlassesDisplayHub) — leave it up so other tabs keep the glasses when Brainstorm disappears.
    // We just drop our local pointer; the next `startGlasses()` re-grabs it and repaints.
    recorder?.stop()
    recorder = nil
    isListening = false
    display = nil
    glassesReady = false
  }

  // MARK: Lens cards

  /// Generic single-headline lens card helper (mirrors Wiser's `sendCard`). Publishes to the
  /// on-phone mirror too so the laptop preview tracks the lens.
  private func sendCard(title: String, body: String, kind: String = "info") async {
    statusLine = body.isEmpty ? title : body
    WiserMirror.shared.publish(title: title, body: body, kind: kind)
    guard let display else { return }
    do {
      try await display.send(
        FlexBox(direction: .column, spacing: 12) {
          MWDATDisplay.Text(title, style: .heading)
          if !body.isEmpty {
            MWDATDisplay.Text(body, style: .body, color: .secondary)
          }
        }
        .padding(24)
        .background(.card)
      )
    } catch {
      let msg = (error as? DisplayError)?.description ?? error.localizedDescription
      DATLog.log.error("[brainstorm] sendCard failed: \(msg, privacy: .public)")
    }
  }

  /// The idle/ready lens card. A PRIMARY [Brainstorm] button (first focusable child → implicit
  /// Neural Band cursor) starts a contribution; the whole-card `.onTap` mirrors it as the
  /// off-center fallback.
  private func sendBrainstormReadyCard() async {
    statusLine = "Tap Brainstorm, speak your idea, then Send."
    WiserMirror.shared.publish(title: "Brainstorm", body: "Tap Brainstorm, speak your idea, then Send.", kind: "info")
    guard let display else { return }
    let brainstormButton = MWDATDisplay.Button(
      label: "Brainstorm",
      style: .primary,
      iconName: .lightBulb,
      onClick: { [weak self] in Task { @MainActor in await self?.startContribution() } }
    )
    do {
      try await display.send(
        FlexBox(direction: .column, spacing: 12) {
          brainstormButton
          MWDATDisplay.Text("Brainstorm", style: .heading)
          MWDATDisplay.Text("Tap Brainstorm, speak your idea, then Send.", style: .body, color: .secondary)
        }
        .padding(24)
        .background(.card)
        // Off-center tap mirrors the primary action.
        .onTap { [weak self] in Task { @MainActor in await self?.startContribution() } }
      )
    } catch {
      let msg = (error as? DisplayError)?.description ?? error.localizedDescription
      DATLog.log.error("[brainstorm] sendBrainstormReadyCard failed: \(msg, privacy: .public)")
    }
  }

  /// The "Listening… (brainstorm)" card: a PRIMARY [Send] button (first focusable child → implicit
  /// cursor) finalizes and contributes; whole-card `.onTap` mirrors Send as the off-center fallback.
  private func sendContributeListeningCard() async {
    statusLine = "Speak your idea, then tap Send."
    WiserMirror.shared.publish(title: "Listening… (brainstorm)", body: "Speak your idea, then tap Send.", kind: "running")
    guard let display else { return }
    let sendButton = MWDATDisplay.Button(
      label: "Send",
      style: .primary,
      iconName: .triangleRight,
      onClick: { [weak self] in Task { @MainActor in await self?.stopContributionAndSend() } }
    )
    do {
      try await display.send(
        FlexBox(direction: .column, spacing: 12) {
          sendButton
          MWDATDisplay.Text("Listening… (brainstorm)", style: .heading)
          MWDATDisplay.Text("Speak your idea, then tap Send.", style: .body, color: .secondary)
        }
        .padding(24)
        .background(.card)
        .onTap { [weak self] in Task { @MainActor in await self?.stopContributionAndSend() } }
      )
    } catch {
      let msg = (error as? DisplayError)?.description ?? error.localizedDescription
      DATLog.log.error("[brainstorm] sendContributeListeningCard failed: \(msg, privacy: .public)")
    }
  }

  // MARK: Brainstorm contribute (lens-primary, phone-testable)

  /// Start the brainstorm contribution: configure recording (mirrors the Ask loop's AVAudioSession
  /// setup, but to its own temp file) and render the "Listening… (brainstorm)" card with [Send].
  func startContribution() async {
    guard await requestMicPermission() else {
      showErr("Microphone permission denied — enable it in Settings.")
      return
    }
    do {
      let session = AVAudioSession.sharedInstance()
      // Capture from the GLASSES mic. The glasses present as a Bluetooth HFP headset (8kHz mono).
      // HFP INPUT requires `.allowBluetooth` AND `mode: .voiceChat` — on iOS 17+, `mode: .default`
      // + `.allowBluetooth` often fails to select the BT input and silently falls back to the
      // phone mic. `.voiceChat` engages the 2-way HFP link; then pin the preferred input to the
      // HFP port. Fall back to the phone's built-in mic only if no glasses mic is present.
      try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth])
      try session.setActive(true)
      let inputs = session.availableInputs ?? []
      let glassesMic = inputs.first { $0.portType == .bluetoothHFP }
      if let mic = glassesMic ?? inputs.first(where: { $0.portType == .builtInMic }) {
        try? session.setPreferredInput(mic)
      }
      DATLog.log.info("[brainstorm] mic = \(glassesMic != nil ? "glasses (HFP)" : "phone (built-in)", privacy: .public) | available inputs: \(inputs.map { $0.portType.rawValue }.joined(separator: ", "), privacy: .public)")

      let url = FileManager.default.temporaryDirectory.appendingPathComponent("wiser-contribution.m4a")
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
      isListening = true
      await sendContributeListeningCard()
    } catch {
      showErr("Couldn't start brainstorm: \(error.localizedDescription)")
    }
  }

  /// Stop+finalize the contribution recorder, attach the latest POV frame, and POST the
  /// contribution to the AMBIENT server. Shows a confirmation/error card on the lens, then returns
  /// to the ready card. No audio response is played.
  func stopContributionAndSend() async {
    recorder?.stop()
    recorder = nil
    isListening = false
    await sendCard(title: "Adding to brainstorm…", body: "", kind: "running")

    guard let url = recordingURL, let data = try? Data(contentsOf: url), !data.isEmpty else {
      await sendCard(title: "Nothing recorded", body: "Try Brainstorm again.")
      try? await Task.sleep(nanoseconds: 1_400_000_000)
      await sendBrainstormReadyCard()
      return
    }

    let audioB64 = data.base64EncodedString()
    let imageB64 = WiserMirror.shared.latestFrameJPEG()?.base64EncodedString()
    let body = BrainstormContributeBody(audioB64: audioB64, audioType: "audio/m4a", imageB64: imageB64)

    do {
      let req = try makeAmbientJSONRequest(path: "/api/brainstorms/active/contribute", body: body)
      let (respData, resp) = try await URLSession.shared.data(for: req)
      guard let http = resp as? HTTPURLResponse else {
        throw WiserError.server("No response from ambient server")
      }
      if http.statusCode == 409 {
        await sendCard(title: "No active brainstorm", body: "Start one in the browser first.")
      } else if (200..<300).contains(http.statusCode) {
        // Decode loosely; success is the 2xx itself (we don't need the body).
        _ = try? JSONDecoder().decode(BrainstormContributeResponse.self, from: respData)
        await sendCard(title: "Added to brainstorm ✓", body: "", kind: "done")
      } else {
        let detail = String(data: respData, encoding: .utf8) ?? "request failed"
        await sendCard(title: "Brainstorm failed", body: String(detail.prefix(120)))
      }
    } catch {
      await sendCard(title: "Brainstorm failed", body: String(error.localizedDescription.prefix(120)))
    }

    try? await Task.sleep(nanoseconds: 1_600_000_000)
    await sendBrainstormReadyCard()
  }

  // MARK: Networking (AMBIENT host only)

  /// Base URL for the AMBIENT brainstorm server (ngrok tunnel). Throws if the user hasn't set it.
  private func ambientBaseURL() throws -> URL {
    let trimmed = ambientURL.trimmingCharacters(in: .whitespacesAndNewlines)
    WiserConfig.ambientURL = trimmed
    guard !trimmed.isEmpty, let url = URL(string: trimmed), url.scheme != nil, url.host != nil else {
      throw WiserError.server("Set the Ambient URL (ngrok) in this tab first")
    }
    return url
  }

  /// JSON POST against the AMBIENT host. POST JSON, 60s timeout.
  private func makeAmbientJSONRequest<Body: Encodable>(path: String, body: Body) throws -> URLRequest {
    let url = try ambientBaseURL().appendingPathComponent(path.hasPrefix("/") ? String(path.dropFirst()) : path)
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.timeoutInterval = 60
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    req.httpBody = try JSONEncoder().encode(body)
    return req
  }

  // MARK: Helpers

  func saveAmbientURL() {
    ambientURL = ambientURL.trimmingCharacters(in: .whitespacesAndNewlines)
    WiserConfig.ambientURL = ambientURL
  }

  func dismissError() { showError = false }

  private func showErr(_ message: String) {
    errorMessage = message
    showError = true
    statusLine = message
    DATLog.log.error("[brainstorm] \(message, privacy: .public)")
  }

  private func requestMicPermission() async -> Bool {
    await withCheckedContinuation { cont in
      AVAudioApplication.requestRecordPermission { granted in
        cont.resume(returning: granted)
      }
    }
  }
}

// MARK: - Brainstorm tab (phone surface — minimal; the lens is the deliverable)

/// The "Brainstorm" tab. Glasses-first: the real UX is on the lens (ready → listening → confirm).
/// This phone view is a thin control surface — set the ambient URL and drive Contribute/Send by
/// tap so the flow is also testable without the band.
struct BrainstormView: View {
  @State private var viewModel: BrainstormViewModel

  init(wearables: WearablesInterface) {
    _viewModel = State(wrappedValue: BrainstormViewModel(wearables: wearables))
  }

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      VStack(spacing: 18) {
        header
        ambientField
        statusPanel
        Spacer()
        contributeButton
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

  private var header: some View {
    HStack {
      Text("brainstorm")
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
  }

  private var ambientField: some View {
    TextField("Ambient URL (ngrok)", text: $viewModel.ambientURL)
      .textInputAutocapitalization(.never)
      .autocorrectionDisabled()
      .keyboardType(.URL)
      .font(.system(size: 13, design: .monospaced))
      .foregroundStyle(.white)
      .padding(10)
      .background(Color.white.opacity(0.08))
      .cornerRadius(8)
      .onSubmit { viewModel.saveAmbientURL() }
  }

  private var statusPanel: some View {
    Text(viewModel.statusLine)
      .font(.system(size: 14))
      .foregroundStyle(.white.opacity(0.75))
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(14)
      .background(Color.white.opacity(0.05))
      .cornerRadius(12)
  }

  @ViewBuilder
  private var contributeButton: some View {
    if viewModel.isListening {
      Button {
        Task { await viewModel.stopContributionAndSend() }
      } label: {
        Text("Send")
          .font(.system(size: 20, weight: .bold))
          .frame(maxWidth: .infinity)
          .frame(height: 66)
          .background(Color.cyan)
          .foregroundStyle(.black)
          .cornerRadius(33)
      }
    } else {
      Button {
        Task { await viewModel.startContribution() }
      } label: {
        Label("Contribute", systemImage: "lightbulb.fill")
          .font(.system(size: 20, weight: .bold))
          .frame(maxWidth: .infinity)
          .frame(height: 66)
          .background(Color.white.opacity(0.12))
          .foregroundStyle(.cyan)
          .cornerRadius(33)
      }
    }
  }
}
