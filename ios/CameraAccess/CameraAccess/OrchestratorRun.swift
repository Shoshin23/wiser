//
// OrchestratorRun.swift
//
// The "Build" surface: a live agent-coding run streamed from the backend orchestrator and
// rendered on the lens via MWDATDisplay, steered by Neural Band tap + voice.
//
// This is the native iOS half of docs/orchestrator-spec.md (THE CONTRACT). The backend distills
// a real Claude managed-agent event stream into Hud/Card/Steer frames over SSE; here we decode
// those frames and re-implement glasses-webapp's three attention layers in FlexBox:
//   - AMBIENT (calm): task title + GOAL + progress-to-exit, when no moment card is up.
//   - STATUSLINE (event-driven): status dot/word + activity (verb + target) + latest fact + $cost.
//   - MOMENT cards: diff/tests/cost/explain/checkpoint/done as distinct cards; `question` is
//     interactive (one Button per option + Speak), `done` is conclusive.
//
// Contract endpoints used:
//   POST /api/runs {prompt}              -> { id }
//   GET  /api/runs/:id/events            -> SSE: {hud} | {card} | {done,hud}
//   POST /api/runs/:id/steer {gesture|voiceText}
//
// The lens display capability is shared with the Ask surface via GlassesDisplayHub.
//

import AVFoundation
import Foundation
import MWDATCore
import MWDATDisplay
import Observation
import SwiftUI

// MARK: - Contract structs (mirror docs/orchestrator-spec.md exactly)

/// Always-on progress state. Emitted as `{hud}` SSE frames.
struct Hud: Codable, Equatable {
  let loop: String?            // "goal"
  let iter: Int?
  let tokens: Int?
  let exit: HudExit?           // progress-to-done
  let costUsd: Double?
  let elapsedSec: Double?
  let status: String?          // running|judging|retrying|awaiting_human|done|failed
  let activity: HudActivity?
}

struct HudExit: Codable, Equatable {
  let label: String?           // e.g. "tests green"
  let have: Int?
  let need: Int?
}

struct HudActivity: Codable, Equatable {
  let verb: String?            // plan|read|edit|test|judge|wait|done|fail
  let target: String?
  let note: String?
}

/// The card union, discriminated by `kind`. Fields exactly per cards.js / the contract.
/// Decoded leniently (every field optional) so a single struct covers all kinds and a missing
/// field never fails the whole frame.
struct Card: Codable, Equatable {
  let kind: String

  // diff
  let files: Int?
  let added: Int?
  let removed: Int?
  let summary: String?

  // tests
  let passed: Int?
  let total: Int?
  let failing: [String]?

  // cost
  let usd: Double?
  let tokens: Int?
  let model: String?

  // explain
  let headline: String?
  let oneLiner: String?

  // question
  let prompt: String?
  let options: [String]?

  // checkpoint
  let progress: String?
  let iter: Int?
  let note: String?

  // done
  let stats: [DoneStat]?
  let final: Bool?
  let subline: String?
}

struct DoneStat: Codable, Equatable, Hashable {
  let label: String
  let value: String
}

/// Steer (client -> backend). Exactly one of `gesture` / `voiceText` is set.
struct Steer: Encodable {
  var gesture: String?     // "approve" | "reject"
  var voiceText: String?

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encodeIfPresent(gesture, forKey: .gesture)
    try c.encodeIfPresent(voiceText, forKey: .voiceText)
  }
  enum CodingKeys: String, CodingKey { case gesture, voiceText }
}

/// One decoded SSE `data:` frame: `{hud}` | `{card}` | `{done:true, hud}`.
private struct RunFrame: Codable {
  let hud: Hud?
  let card: Card?
  let done: Bool?
}

/// `POST /api/runs` response.
private struct CreateRunResponse: Codable {
  let id: String
}

// MARK: - SSE client
//
// Plain iOS networking (NOT the Display web SDK): read `GET …/events` via a delegate-based
// `URLSessionDataTask`, append each `didReceive data:` chunk to a buffer, split on newlines,
// accumulate `id:` and `data:` lines, and emit one decoded frame per blank-line-terminated event.
// On drop we reconnect carrying `Last-Event-ID` = the last `id:` seen so the backend replays from
// there (the managed session is durable).

/// Events surfaced by the SSE stream to the RunViewModel.
enum RunEvent {
  case hud(Hud)
  case card(Card)
  case done(Hud?)
}

// Delegate-based reader (NOT @MainActor): `URLSession.bytes(for:).lines` buffers the whole HTTP/2
// streaming body on iOS instead of yielding line-by-line, so zero frames reach us on device even
// though curl streams fine. A `URLSessionDataTask` with a `URLSessionDataDelegate` delivers the
// body incrementally (`didReceive data:`) and is the reliable path for chunked/HTTP/2 SSE.
// `onEvent`/`onStatus` hop to @MainActor at the call sites (RunViewModel.openStream wraps them in
// `Task { @MainActor in … }`), so we can call them straight from the delegate queue.
final class RunSSEClient: NSObject, URLSessionDataDelegate {
  private let baseURL: String
  private let runId: String
  private let onEvent: (RunEvent) -> Void
  private let onStatus: (String) -> Void   // human-readable connection status for the phone UI

  // All mutable state below is touched only from the serial delegate queue (or guarded), so a
  // single serial OperationQueue keeps it race-free without extra locking.
  private let queue: OperationQueue
  private var session: URLSession?
  private var task: URLSessionDataTask?

  private var lastEventId: String?
  private var buffer = Data()           // rolling byte buffer; we pull complete `\n` lines off it
  private var dataLines: [String] = []  // accumulated `data:` lines for the in-progress event
  private var pendingId: String?        // `id:` for the in-progress event

  private var stopped = false           // set by stop(); suppresses reconnect
  private var sawDone = false           // terminal {done} frame seen; suppresses reconnect
  private var loggedFirstChunk = false  // one-time "first bytes arrived" diagnostic

  init(baseURL: String, runId: String,
       onEvent: @escaping (RunEvent) -> Void,
       onStatus: @escaping (String) -> Void) {
    self.baseURL = baseURL
    self.runId = runId
    self.onEvent = onEvent
    self.onStatus = onStatus
    let q = OperationQueue()
    q.maxConcurrentOperationCount = 1   // serial: serializes delegate callbacks
    q.name = "wiser.sse.delegate"
    self.queue = q
    super.init()
  }

  func start() {
    queue.addOperation { [weak self] in self?.open() }
  }

  func stop() {
    queue.addOperation { [weak self] in
      guard let self else { return }
      self.stopped = true
      self.task?.cancel()
      self.task = nil
      self.session?.invalidateAndCancel()
      self.session = nil
    }
  }

  /// Open one connection. On drop (didCompleteWithError) we reconnect carrying `Last-Event-ID`,
  /// unless stopped or a terminal `{done}` was seen.
  private func open() {
    guard !stopped else { return }
    guard let url = URL(string: baseURL + "/api/runs/\(runId)/events") else {
      onStatus("error invalid URL")
      return
    }
    // Reset per-connection parse state (carry lastEventId across reconnects).
    buffer.removeAll(keepingCapacity: true)
    dataLines.removeAll(keepingCapacity: true)
    pendingId = nil
    loggedFirstChunk = false

    var req = URLRequest(url: url)
    req.httpMethod = "GET"
    req.timeoutInterval = 300
    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    req.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
    req.setValue("identity", forHTTPHeaderField: "Accept-Encoding")   // defeat intermediary gzip buffering
    if let lastEventId { req.setValue(lastEventId, forHTTPHeaderField: "Last-Event-ID") }

    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 300
    config.timeoutIntervalForResource = 3600
    config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    config.waitsForConnectivity = true
    let session = URLSession(configuration: config, delegate: self, delegateQueue: queue)
    self.session = session
    let task = session.dataTask(with: req)
    self.task = task
    task.resume()
  }

  // MARK: URLSessionDataDelegate

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                  didReceive response: URLResponse,
                  completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    let code = (response as? HTTPURLResponse)?.statusCode ?? -1
    if (200..<300).contains(code) {
      onStatus("streaming")
      completionHandler(.allow)
    } else {
      onStatus("error \(code)")
      completionHandler(.cancel)
    }
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    if !loggedFirstChunk {
      loggedFirstChunk = true
      DATLog.log.info("[wiser] SSE first data chunk (\(data.count, privacy: .public) bytes)")
    }
    buffer.append(data)
    // Pull every complete `\n`-terminated line off the buffer; decode each as UTF-8.
    while let nl = buffer.firstIndex(of: 0x0A) {
      let lineData = buffer.subdata(in: buffer.startIndex..<nl)
      buffer.removeSubrange(buffer.startIndex...nl)
      guard var line = String(data: lineData, encoding: .utf8) else { continue }
      if line.hasSuffix("\r") { line.removeLast() }   // strip CR from CRLF
      consume(line: line)
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    session.finishTasksAndInvalidate()
    if self.session === session { self.session = nil; self.task = nil }
    guard !stopped && !sawDone else { return }
    if let error { DATLog.log.error("[wiser] SSE completed with error: \(String(describing: error), privacy: .public)") }
    onStatus("reconnecting…")
    DispatchQueue.global().asyncAfter(deadline: .now() + 1.5) { [weak self] in
      self?.queue.addOperation { self?.open() }
    }
  }

  // MARK: SSE line parsing

  /// One decoded line. Accumulate `id:`/`data:`; on a blank line dispatch the event.
  private func consume(line: String) {
    if line.isEmpty {
      if let id = pendingId { lastEventId = id }
      if !dataLines.isEmpty {
        let payload = dataLines.joined(separator: "\n")
        dataLines.removeAll(keepingCapacity: true)
        dispatch(payload)
      }
      pendingId = nil
      return
    }
    if line.hasPrefix(":") { return }                       // SSE comment / keep-alive
    if let v = field(line, "id:") { pendingId = v; return }
    if let v = field(line, "data:") { dataLines.append(v); return }
    // ignore `event:`/`retry:` and anything else
  }

  /// Decode + emit one `data:` payload.
  private func dispatch(_ payload: String) {
    let trimmed = payload.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty, trimmed != "[DONE]" else { return }
    guard let data = trimmed.data(using: .utf8) else { return }
    do {
      let frame = try JSONDecoder().decode(RunFrame.self, from: data)
      if frame.done == true {
        DATLog.log.info("[wiser] SSE frame: done")
        sawDone = true
        onEvent(.done(frame.hud))
        stop()
        return
      }
      // A frame is {hud} OR {card}; emit whichever is present (tolerate both).
      if let hud = frame.hud {
        DATLog.log.info("[wiser] SSE frame: hud")
        onEvent(.hud(hud))
      }
      if let card = frame.card {
        DATLog.log.info("[wiser] SSE frame: card(\(card.kind, privacy: .public))")
        onEvent(.card(card))
      }
    } catch {
      DATLog.log.error("[wiser] SSE decode failed: \(trimmed.prefix(200), privacy: .public)")
    }
  }

  private func field(_ line: String, _ prefix: String) -> String? {
    guard line.hasPrefix(prefix) else { return nil }
    var v = String(line.dropFirst(prefix.count))
    if v.hasPrefix(" ") { v.removeFirst() }   // SSE allows one optional leading space
    return v
  }
}

// MARK: - Run view model

@Observable
@MainActor
final class RunViewModel {
  enum Phase: String {
    case idle = "Idle"
    case prompting = "Prompt…"
    case starting = "Starting…"
    case streaming = "Running"
    case awaiting = "Needs you"
    case finished = "Done"
    case failed = "Failed"
  }

  // Phone-facing observable state (the lens is the deliverable; this drives a minimal phone view).
  var phase: Phase = .idle
  var runId: String?
  var hud: Hud?
  var connectionStatus: String = ""
  var latestFact: String = ""      // mirrors glasses-webapp's keyfact (latest card one-liner)
  var promptText: String = ""
  var backendURL: String = WiserConfig.backendURL
  var showError: Bool = false
  var errorMessage: String = ""
  var glassesReady: Bool = false

  /// True while an interactive `question` card is on the lens awaiting a steer.
  var awaiting: Bool { currentQuestion != nil }

  @ObservationIgnored private let wearables: WearablesInterface
  @ObservationIgnored private var display: Display?
  @ObservationIgnored private var sse: RunSSEClient?
  @ObservationIgnored private var currentQuestion: Card?

  // MARK: Moment-card dwell (clobber fix)
  //
  // The backend emits a HUD frame ~every second. Without dwell, every HUD frame would call
  // repaintLens() → ambient, painting over a just-shown diff/tests/cost/explain/checkpoint card
  // within ~1s (mirrors glasses-webapp's `autoMs`). While a moment card is on the lens we hold it
  // for `momentDwellSec`; HUD repaints are suppressed during that window. A newly-arriving card,
  // a question, or done still take over immediately. After the window the next HUD repaints ambient.
  @ObservationIgnored private var momentUntil: Date?     // lens shows a moment card until this time
  /// Webapp `autoMs` = 2800ms. Hold a moment card this long before HUD ticks can repaint ambient.
  private static let momentDwellSec: TimeInterval = 2.8
  /// True while a moment card should still own the lens (within its dwell window).
  private var momentActive: Bool {
    guard let until = momentUntil else { return false }
    return Date() < until
  }

  /// The last Hud we painted the lens from, used to ignore no-op HUD ticks (only elapsedSec moved).
  @ObservationIgnored private var lastPaintedHud: Hud?

  // Voice answer (steer) capture — reuses the same mic→STT backend the Ask flow uses, but routes
  // the transcript to `/api/runs/:id/steer` instead of `/api/ask`.
  @ObservationIgnored private var recorder: AVAudioRecorder?
  @ObservationIgnored private var recordingURL: URL?

  init(wearables: WearablesInterface) {
    self.wearables = wearables
  }

  // MARK: Lens display (shared)

  func startGlasses() async {
    await GlassesDisplayHub.shared.start(wearables: wearables) { [weak self] in
      guard let self else { return }
      self.display = GlassesDisplayHub.shared.display
      self.glassesReady = true
      // Repaint whatever this surface is currently showing so the Build tab re-takes the lens.
      await self.repaintLens()
    }
  }

  /// Drop the local pointer when this surface disappears; the shared capability stays up so the
  /// Ask tab keeps the lens. Does NOT cancel an in-flight run (the SSE keeps streaming so a
  /// returning user sees current state) — call `endRun()` to stop a run explicitly.
  func detachGlasses() {
    display = nil
    glassesReady = false
  }

  // MARK: Start / end a run

  /// Start a run from a prompt: `POST /api/runs {prompt}` → open SSE.
  func startRun(prompt: String) async {
    let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    // New run replaces any prior one on this surface.
    endRun()
    phase = .starting
    hud = nil
    latestFact = ""
    currentQuestion = nil
    momentUntil = nil
    lastPaintedHud = nil
    await sendStartingCard(prompt: trimmed)
    do {
      let id = try await createRun(prompt: trimmed)
      runId = id
      phase = .streaming
      openStream(id: id)
    } catch {
      showErr("Couldn't start run: \(error.localizedDescription)")
      phase = .failed
    }
  }

  /// Stop streaming the current run (does not affect the durable backend session).
  func endRun() {
    sse?.stop()
    sse = nil
  }

  private func openStream(id: String) {
    let base = currentBaseURLString()
    let client = RunSSEClient(
      baseURL: base, runId: id,
      onEvent: { [weak self] ev in Task { @MainActor in await self?.handle(ev) } },
      onStatus: { [weak self] s in Task { @MainActor in self?.connectionStatus = s } }
    )
    sse = client
    client.start()
  }

  private func handle(_ ev: RunEvent) async {
    switch ev {
    case .hud(let h):
      let prev = hud
      hud = h
      if let note = h.activity?.note, !note.isEmpty { latestFact = note }
      syncPhaseFromHud(h)
      // CLOBBER FIX (1/2): ignore no-op HUD ticks. The backend ticks elapsedSec ~every second;
      // if nothing else changed (status/activity/exit/costUsd/tokens/iter), update phone state
      // (already done above) but do NOT repaint the lens — a repaint would clobber a moment card.
      if let prev, Self.hudEqualIgnoringElapsed(prev, h) { return }
      // CLOBBER FIX (2/2): while a moment card is dwelling, don't let a HUD frame repaint ambient
      // over it. Ambient resumes on the next HUD frame after the dwell window expires.
      if momentActive { return }
      await repaintLens()

    case .card(let c):
      latestFact = Self.cardOneLiner(c)
      switch c.kind {
      case "question":
        // A question takes over immediately (ends any moment dwell).
        momentUntil = nil
        currentQuestion = c
        phase = .awaiting
        await sendQuestionCard(c)
      case "done":
        // Done takes over immediately (ends any moment dwell).
        momentUntil = nil
        currentQuestion = nil
        phase = .finished
        await sendDoneCard(c)
      default:
        // diff / tests / cost / explain / checkpoint → a moment card that dwells for ~2.8s
        // before HUD frames may repaint ambient over it.
        await sendMomentCard(c)
      }

    case .done(let h):
      if let h { hud = h }
      // If a `done` card already took the lens, keep it; otherwise show a conclusive screen.
      if phase != .finished {
        phase = .finished
        await sendDoneCard(synthesizedDone())
      }
      endRun()
    }
  }

  private func syncPhaseFromHud(_ h: Hud) {
    switch h.status {
    case "awaiting_human": if currentQuestion != nil { phase = .awaiting }
    case "done": phase = .finished
    case "failed": phase = .failed
    default: if phase == .starting { phase = .streaming }
    }
  }

  // MARK: Steer (tap + voice)

  /// Steer the run. Exactly one of `gesture` / `voiceText`. Stateless server-side: the backend
  /// matches it to the pending `ask_user`. Optimistically clears the on-lens question and returns
  /// to ambient/statusline so the calm state resumes immediately.
  func steer(gesture: String? = nil, voiceText: String? = nil) async {
    guard let id = runId else { return }
    currentQuestion = nil
    phase = .streaming
    await repaintLens()
    do {
      let req = try makeSteerRequest(id: id, steer: Steer(gesture: gesture, voiceText: voiceText))
      let (data, resp) = try await URLSession.shared.data(for: req)
      if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
        DATLog.log.error("[wiser] steer HTTP \(http.statusCode): \(String(data: data, encoding: .utf8) ?? "", privacy: .public)")
      }
    } catch {
      DATLog.log.error("[wiser] steer failed: \(String(describing: error), privacy: .public)")
    }
  }

  /// Tap an option button. Option 0 (the implicit cursor / first choice) maps to "approve";
  /// any other option maps to "reject" — matching the backend's gesture→answer mapping and
  /// glasses-webapp's `pickOption`. We also send the option text as a fallback so a >2-option
  /// question still answers with the exact picked text.
  private func answerOption(_ index: Int, text: String) async {
    if index == 0 {
      await steer(gesture: "approve")
    } else if index == 1 {
      await steer(gesture: "reject")
    } else {
      await steer(voiceText: text)
    }
  }

  // MARK: Voice steer (mic → STT → steer.voiceText)

  /// Start recording a spoken answer to the pending question. Stop via `stopAndSteerVoice()`.
  func startVoiceSteer() async {
    guard await requestMicPermission() else {
      showErr("Microphone permission denied — enable it in Settings.")
      return
    }
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playAndRecord, mode: .default, options: GlassesAudioRoute.categoryOptions)
      try session.setActive(true)
      if let mic = session.availableInputs?.first(where: { $0.portType == .builtInMic }) {
        try? session.setPreferredInput(mic)
      }
      let url = FileManager.default.temporaryDirectory.appendingPathComponent("wiser-steer.m4a")
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
      await sendListeningCard()
    } catch {
      showErr("Couldn't start recording: \(error.localizedDescription)")
    }
  }

  /// Stop recording, transcribe via the backend STT endpoint, and steer with the transcript.
  func stopAndSteerVoice() async {
    recorder?.stop()
    recorder = nil
    guard let url = recordingURL, let data = try? Data(contentsOf: url), !data.isEmpty else {
      // Nothing captured — just return to the question.
      if let q = currentQuestion { await sendQuestionCard(q) }
      return
    }
    do {
      let transcript = try await transcribe(audio: data)
      let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
      if text.isEmpty {
        if let q = currentQuestion { await sendQuestionCard(q) }
      } else {
        await steer(voiceText: text)
      }
    } catch {
      DATLog.log.error("[wiser] steer transcribe failed: \(String(describing: error), privacy: .public)")
      if let q = currentQuestion { await sendQuestionCard(q) }
    }
  }

  // MARK: Networking

  private func createRun(prompt: String) async throws -> String {
    let req = try makeJSONRequest(path: "/api/runs", body: ["prompt": prompt])
    let (data, resp) = try await URLSession.shared.data(for: req)
    try Self.ensureOK(resp, data)
    return try JSONDecoder().decode(CreateRunResponse.self, from: data).id
  }

  private func makeSteerRequest(id: String, steer: Steer) throws -> URLRequest {
    var req = try emptyRequest(path: "/api/runs/\(id)/steer", method: "POST")
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try JSONEncoder().encode(steer)
    return req
  }

  /// Reuse the existing multipart `/api/ask` path purely to turn captured audio into a transcript
  /// (we ignore the answer/cards — we only want `.transcript`), then route it as a steer. Keeps a
  /// single STT path across both surfaces with no backend changes for voice steering.
  private func transcribe(audio audioData: Data) async throws -> String {
    let base = currentBaseURLString()
    guard let url = URL(string: base + "/api/transcribe") else {
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
    append("Content-Disposition: form-data; name=\"audio\"; filename=\"steer.m4a\"\r\n")
    append("Content-Type: audio/m4a\r\n\r\n")
    body.append(audioData)
    append("\r\n--\(boundary)--\r\n")
    let (data, resp) = try await URLSession.shared.upload(for: req, from: body)
    try Self.ensureOK(resp, data)
    // Tolerate either { transcript } (dedicated endpoint) or the full AskResponse shape.
    if let t = try? JSONDecoder().decode(TranscribeResponse.self, from: data), let txt = t.transcript {
      return txt
    }
    return (try? JSONDecoder().decode(AskResponse.self, from: data))?.transcript ?? ""
  }

  private struct TranscribeResponse: Codable { let transcript: String? }

  // MARK: Request builders

  private func currentBaseURLString() -> String {
    let trimmed = backendURL.trimmingCharacters(in: .whitespacesAndNewlines)
    WiserConfig.backendURL = trimmed
    return trimmed
  }

  private func baseURL() throws -> URL {
    guard let url = URL(string: currentBaseURLString()) else {
      throw WiserError.server("Invalid backend URL")
    }
    return url
  }

  private func emptyRequest(path: String, method: String) throws -> URLRequest {
    let url = try baseURL().appendingPathComponent(path.hasPrefix("/") ? String(path.dropFirst()) : path)
    var req = URLRequest(url: url)
    req.httpMethod = method
    req.timeoutInterval = 60
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    return req
  }

  private func makeJSONRequest(path: String, body: [String: String]) throws -> URLRequest {
    var req = try emptyRequest(path: path, method: "POST")
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try JSONSerialization.data(withJSONObject: body)
    return req
  }

  private static func ensureOK(_ resp: URLResponse, _ data: Data) throws {
    guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      throw WiserError.server(String(data: data, encoding: .utf8) ?? "request failed")
    }
  }

  // MARK: Helpers

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
      AVAudioApplication.requestRecordPermission { granted in cont.resume(returning: granted) }
    }
  }

  /// Two Huds equal ignoring `elapsedSec` (the per-second clock tick). Used to drop no-op HUD
  /// frames so a moment card on the lens isn't clobbered by a clock-only update. Hud is Equatable;
  /// we compare a copy of `a` with `b`'s elapsedSec so only that field is excluded.
  private static func hudEqualIgnoringElapsed(_ a: Hud, _ b: Hud) -> Bool {
    let aNoElapsed = Hud(loop: a.loop, iter: a.iter, tokens: a.tokens, exit: a.exit,
                         costUsd: a.costUsd, elapsedSec: b.elapsedSec, status: a.status,
                         activity: a.activity)
    return aNoElapsed == b
  }

  private func synthesizedDone() -> Card {
    let tokens = hud?.tokens ?? 0
    let usd = hud?.costUsd ?? 0
    return Card(
      kind: "done", files: nil, added: nil, removed: nil, summary: nil,
      passed: nil, total: nil, failing: nil, usd: usd, tokens: tokens, model: nil,
      headline: "Run complete", oneLiner: nil, prompt: nil, options: nil,
      progress: nil, iter: hud?.iter, note: nil,
      stats: [DoneStat(label: "tokens", value: Self.fmtTokens(tokens)),
              DoneStat(label: "cost", value: "$" + String(format: "%.2f", usd))],
      final: true, subline: nil)
  }
}

// MARK: - Lens rendering (re-implements cards.js / app.js in FlexBox)
//
// MWDATDisplay 0.7.0 has NO cursor/arrow API and NO focus API (verified: only `Button.onClick`
// and `FlexBox.onTap`). So: the FIRST focusable child (first Button) is the implicit cursor, and
// every card adds a whole-card `.onTap` fallback. No per-second clock spam — the lens repaints
// only on hud/card events. Colors are approximated with `.primary`/`.secondary` text (the lens
// renders against a dark surface like the webapp); bars are drawn as text proportions, not CSS.

extension RunViewModel {

  /// Repaint the lens for the current (non-moment) state:
  ///   - an interactive question, if one is up;
  ///   - the conclusive done card stays put (don't overwrite it);
  ///   - the START card when idle and no run is in progress (the webapp START screen look);
  ///   - else the ambient + statusline composite (the calm center).
  /// Called on hud changes and on (re)attach.
  fileprivate func repaintLens() async {
    if let q = currentQuestion {
      await sendQuestionCard(q)
    } else if phase == .finished {
      // keep the done card up
    } else if phase == .idle, runId == nil {
      // No run in progress → the entry/START card (start a run BY SPEECH from the lens).
      await sendStartPromptCard()
    } else {
      await sendAmbientCard()
    }
  }

  // ---- AMBIENT + STATUSLINE (calm center) ----

  /// The calm center (webapp `paintAmbient` + `paintStatusline`): the task title up top, a centered
  /// GOAL block (label + big have/need + text progress bar), and the always-on STATUSLINE beneath
  /// (status glyph+word · activity verb-icon+target · latest fact · $cost). One composite card,
  /// since the lens shows one view at a time. Painting ambient records the Hud so subsequent
  /// clock-only HUD ticks are ignored, and clears any moment-dwell.
  fileprivate func sendAmbientCard() async {
    guard GlassesDisplayHub.shared.canSend else { return }
    momentUntil = nil
    lastPaintedHud = hud
    let h = hud
    let exit = h?.exit
    let label = exit?.label ?? "working"
    let have = exit?.have ?? 0
    let need = exit?.need ?? 0
    let count = need > 0 ? "\(have) / \(need)" : ""
    let title = taskTitle()

    await send(
      FlexBox(direction: .column, spacing: 16) {
        // Task title (the run's prompt).
        MWDATDisplay.Text(title, style: .heading)
        // GOAL block (the stable target): label, big have/need, text progress bar.
        MWDATDisplay.Text("GOAL · " + label.uppercased(), style: .meta, color: .secondary)
        if !count.isEmpty {
          MWDATDisplay.Text(count, style: .heading)
          MWDATDisplay.Text(Self.progressBar(have: have, need: need), style: .body, color: .secondary)
        }
        // STATUSLINE (rolling present-tense), beneath the goal.
        MWDATDisplay.Text(statusLineText(), style: .body, color: .secondary)
      }
      .padding(24)
      .background(.card)
    )
  }

  /// Status dot/word + activity (verb icon + target) + latest fact + $cost, compressed to one
  /// line (mirrors paintStatusline). Uses unicode glyphs for the verb/status icons since lens
  /// Text has no inline icon.
  private func statusLineText() -> String {
    guard let h = hud else { return "" }
    let st = Self.statusGlyph(h.status) + " " + Self.statusWord(h.status)
    var act = ""
    if let a = h.activity, let target = a.target, !target.isEmpty {
      act = Self.activityIcon(a.verb) + " " + target
    }
    let fact = latestFact
    let cost = "$" + String(format: "%.2f", h.costUsd ?? 0)
    return [st, act, fact, cost].filter { !$0.isEmpty }.joined(separator: "  ·  ")
  }

  private func taskTitle() -> String {
    if let target = hud?.activity?.target, hud?.activity?.verb == nil, !target.isEmpty { return target }
    let p = promptText.trimmingCharacters(in: .whitespacesAndNewlines)
    return p.isEmpty ? "Build" : String(p.prefix(40))
  }

  // ---- MOMENT cards (diff / tests / cost / explain / checkpoint) ----

  /// A milestone card (diff / tests / cost / explain / checkpoint) surfaced as a center takeover,
  /// matching cards.js renderers. It DWELLS for `momentDwellSec` (~2.8s, webapp `autoMs`): during
  /// that window HUD frames don't repaint ambient over it (see the `.hud` handler). After the
  /// window an explicit fallback repaints ambient even if HUD ticks have gone quiet. A "Back"
  /// button (first focusable → implicit cursor) + whole-card tap return to calm immediately.
  fileprivate func sendMomentCard(_ c: Card) async {
    guard GlassesDisplayHub.shared.canSend else { return }
    // Open the dwell window: HUD ticks won't repaint over this card until it elapses.
    let until = Date().addingTimeInterval(Self.momentDwellSec)
    momentUntil = until
    let back = MWDATDisplay.Button(
      label: "Back", style: .secondary, iconName: .arrowLeft,
      onClick: { [weak self] in Task { @MainActor in await self?.dismissMoment() } }
    )
    let (kindIcon, heading, line1, line2) = Self.momentContent(c)
    let kindLabel = kindIcon + " " + Self.cardKindLabel(c.kind).uppercased()
    await send(
      FlexBox(direction: .column, spacing: 10) {
        back
        MWDATDisplay.Text(kindLabel, style: .meta, color: .secondary)
        MWDATDisplay.Text(heading, style: .heading)
        if !line1.isEmpty { MWDATDisplay.Text(line1, style: .body) }
        if !line2.isEmpty { MWDATDisplay.Text(line2, style: .body, color: .secondary) }
      }
      .padding(20)
      .background(.card)
      .onTap { [weak self] in Task { @MainActor in await self?.dismissMoment() } }
    )
    // After the dwell window, fall back to ambient — but only if THIS moment is still the one
    // showing (a newer card/question/done may have taken over) and we're not awaiting/finished.
    Task { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(Self.momentDwellSec * 1_000_000_000))
      await MainActor.run {
        guard let self else { return }
        guard self.momentUntil == until else { return }   // superseded by a newer moment
        self.momentUntil = nil
        guard self.currentQuestion == nil, self.phase != .finished else { return }
        Task { await self.sendAmbientCard() }
      }
    }
  }

  /// Dismiss the current moment card on demand (Back / tap): end the dwell and return to calm.
  fileprivate func dismissMoment() async {
    momentUntil = nil
    await sendAmbientCard()
  }

  /// (kindIcon, heading, line1, line2) for a milestone card, per cards.js renderers.
  ///  - diff  → "+added  −removed" hero + "K files"  (renderDiff)
  ///  - tests → "passed / total" hero + text mini-bar + "all green"/"N failing"  (renderTests)
  ///  - cost  → "$X" hero + tokens (+ model)  (renderCost)
  ///  - explain → headline hero + "✦ Nemotron" by-line  (renderExplain)
  ///  - checkpoint → progress hero + "iter · tokens · $" + optional note  (renderCheckpoint)
  private static func momentContent(_ c: Card) -> (String, String, String, String) {
    switch c.kind {
    case "diff":
      let files = c.files ?? 0
      let heading = "+\(c.added ?? 0)  −\(c.removed ?? 0)"
      let line1 = "\(files) file" + (files == 1 ? "" : "s")
      return ("±", heading, line1, c.summary.map { String($0.prefix(80)) } ?? "")
    case "tests":
      let passed = c.passed ?? 0, total = c.total ?? 0
      let heading = "\(passed) / \(total)"
      let bar = progressBar(have: passed, need: total)
      let n = c.failing?.count ?? 0
      let line2 = n == 0 ? "all green" : (n == 1 ? (c.failing?.first ?? "1 failing") : "\(n) failing")
      return ("▶", heading, bar, line2)
    case "cost":
      let heading = "$" + String(format: "%.2f", c.usd ?? 0)
      let line1 = fmtTokens(c.tokens ?? 0) + (c.model.map { "  ·  " + $0 } ?? "")
      return ("$", heading, line1, "")
    case "explain":
      // renderExplain: a Nemotron-generated headline + the "✦ Nemotron" by-line.
      return ("✦", c.headline.map { String($0.prefix(90)) } ?? "Explain", "✦ Nemotron", "")
    case "checkpoint":
      let heading = c.progress.map { String($0.prefix(60)) } ?? "Checkpoint"
      let line1 = "iter \(c.iter ?? 0)  ·  " + fmtTokens(c.tokens ?? 0) + "  ·  $" + String(format: "%.2f", c.usd ?? 0)
      return ("◷", heading, line1, c.note.map { String($0.prefix(80)) } ?? "")
    default:
      return ("•", cardOneLiner(c), "", "")
    }
  }

  // ---- QUESTION card (interactive steer point) ----

  /// The decision moment. One Button per option (cap 3, first = implicit cursor) + a "Speak"
  /// button (.metaAi) for a voice answer + whole-card tap → option 0. Tapping option i steers
  /// approve(0)/reject(1)/voiceText(else); Speak records → STT → steer(voiceText).
  fileprivate func sendQuestionCard(_ c: Card) async {
    guard GlassesDisplayHub.shared.canSend else { return }
    let prompt = c.prompt ?? "Decision needed"
    let options = Array((c.options ?? []).prefix(3))
    let optionButtons: [MWDATDisplay.Button] = options.enumerated().map { (i, opt) in
      MWDATDisplay.Button(
        label: String(opt.prefix(40)),
        style: i == 0 ? .primary : .secondary,
        iconName: i == 0 ? .checkmark : .x,
        onClick: { [weak self] in Task { @MainActor in await self?.answerOption(i, text: opt) } }
      )
    }
    let speak = MWDATDisplay.Button(
      label: "Speak",
      style: options.isEmpty ? .primary : .outline,
      iconName: .metaAi,
      onClick: { [weak self] in Task { @MainActor in await self?.startVoiceSteer() } }
    )
    let buttons = optionButtons + [speak]
    await send(
      FlexBox(direction: .column, spacing: 12) {
        FlexBox(direction: .row, spacing: 8) {
          for b in buttons { b }
        }
        MWDATDisplay.Text("◆ DECISION", style: .meta, color: .secondary)
        MWDATDisplay.Text(String(prompt.prefix(160)), style: .heading)
      }
      .padding(24)
      .background(.card)
      .onTap { [weak self] in
        Task { @MainActor in
          if let first = options.first { await self?.answerOption(0, text: first) }
          else { await self?.startVoiceSteer() }
        }
      }
    )
  }

  // ---- DONE / FINAL card (conclusive) ----

  /// The webapp's conclusive ship screen (`showFinal`): a big ✓, the headline, an optional subline,
  /// and a stats grid. No return-to-ambient. A "New build" button (first focusable → implicit
  /// cursor) resets to the START card so the user can start another run from the lens.
  fileprivate func sendDoneCard(_ c: Card) async {
    guard GlassesDisplayHub.shared.canSend else { return }
    momentUntil = nil
    let headline = c.headline.map { String($0.prefix(80)) } ?? "Shipped"
    let stats = c.stats ?? []
    let again = MWDATDisplay.Button(
      label: "New build", style: .primary, iconName: .plus,
      onClick: { [weak self] in Task { @MainActor in await self?.resetToStart() } }
    )
    await send(
      FlexBox(direction: .column, spacing: 10) {
        again
        // Big ✓ hero, then the conclusive headline.
        MWDATDisplay.Text("✓", style: .heading)
        MWDATDisplay.Text(headline, style: .heading)
        if let sub = c.subline, !sub.isEmpty {
          MWDATDisplay.Text(String(sub.prefix(100)), style: .body, color: .secondary)
        }
        // Stats grid (value label · value label …), one glanceable line.
        if !stats.isEmpty {
          MWDATDisplay.Text(stats.map { "\($0.value) \($0.label)" }.joined(separator: "   ·   "),
                            style: .body)
        }
      }
      .padding(24)
      .background(.card)
    )
  }

  /// "New build" affordance: fully reset run state to idle and paint the START card on the lens.
  fileprivate func resetToStart() async {
    endRun()
    runId = nil
    hud = nil
    latestFact = ""
    currentQuestion = nil
    momentUntil = nil
    lastPaintedHud = nil
    phase = .idle
    await sendStartPromptCard()
  }

  // ---- transient state cards (starting / listening / start-prompt) ----

  fileprivate func sendStartingCard(prompt: String) async {
    guard GlassesDisplayHub.shared.canSend else { return }
    await send(
      FlexBox(direction: .column, spacing: 12) {
        MWDATDisplay.Text("Starting…", style: .heading)
        MWDATDisplay.Text(String(prompt.prefix(80)), style: .body, color: .secondary)
      }
      .padding(24)
      .background(.card)
    )
  }

  fileprivate func sendListeningCard() async {
    guard GlassesDisplayHub.shared.canSend else { return }
    let stop = MWDATDisplay.Button(
      label: "Send", style: .primary, iconName: .checkmark,
      onClick: { [weak self] in Task { @MainActor in await self?.stopAndSteerVoice() } }
    )
    await send(
      FlexBox(direction: .column, spacing: 12) {
        stop
        MWDATDisplay.Text("Listening…", style: .heading)
        MWDATDisplay.Text("Speak your answer, then Send.", style: .body, color: .secondary)
      }
      .padding(24)
      .background(.card)
      .onTap { [weak self] in Task { @MainActor in await self?.stopAndSteerVoice() } }
    )
  }

  /// The lens entry / START screen (webapp's start screen): heading "wiser", subtitle
  /// "steer the fleet, hands-free", and a primary "Speak task" button (first focusable → implicit
  /// cursor) that starts a run BY SPEECH. Whole-card `.onTap` mirrors it. Both → startPromptRecording().
  fileprivate func sendStartPromptCard() async {
    guard GlassesDisplayHub.shared.canSend else { return }
    phase = .idle
    currentQuestion = nil
    momentUntil = nil
    let speak = MWDATDisplay.Button(
      label: "Speak task", style: .primary, iconName: .metaAi,
      onClick: { [weak self] in Task { @MainActor in await self?.startPromptRecording() } }
    )
    await send(
      FlexBox(direction: .column, spacing: 14) {
        speak
        MWDATDisplay.Text("wiser", style: .heading)
        MWDATDisplay.Text("steer the fleet, hands-free", style: .body, color: .secondary)
      }
      .padding(24)
      .background(.card)
      .onTap { [weak self] in Task { @MainActor in await self?.startPromptRecording() } }
    )
  }

  // ---- voice PROMPT (start a run by speaking the task) ----

  /// Record a spoken task prompt, then start the run with the transcript. Distinct from
  /// `startVoiceSteer` (which answers a question); shares the same recorder + STT.
  func startPromptRecording() async {
    guard await requestMicPermission() else {
      showErr("Microphone permission denied — enable it in Settings.")
      return
    }
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playAndRecord, mode: .default, options: GlassesAudioRoute.categoryOptions)
      try session.setActive(true)
      if let mic = session.availableInputs?.first(where: { $0.portType == .builtInMic }) {
        try? session.setPreferredInput(mic)
      }
      let url = FileManager.default.temporaryDirectory.appendingPathComponent("wiser-prompt.m4a")
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
      phase = .prompting
      await sendPromptListeningCard()
    } catch {
      showErr("Couldn't start recording: \(error.localizedDescription)")
    }
  }
}

// MARK: - Static formatters (mirror contract.js)

extension RunViewModel {
  static func fmtTokens(_ n: Int) -> String {
    if n >= 1000 { return String(format: n >= 10000 ? "%.0fk tok" : "%.1fk tok", Double(n) / 1000) }
    return "\(n) tok"
  }

  static func cardKindLabel(_ kind: String) -> String {
    switch kind {
    case "diff": return "Diff"
    case "tests": return "Tests"
    case "cost": return "Cost"
    case "explain": return "Explain"
    case "question": return "Decision"
    case "checkpoint": return "Checkpoint"
    case "done": return "Done"
    default: return "Card"
    }
  }

  static func cardOneLiner(_ c: Card) -> String {
    switch c.kind {
    case "diff":
      let files = c.files ?? 0
      return "\(files) file" + (files == 1 ? "" : "s") + "  +\(c.added ?? 0) −\(c.removed ?? 0)"
    case "tests":
      let n = c.failing?.count ?? 0
      return "\(c.passed ?? 0)/\(c.total ?? 0) passing" + (n > 0 ? "  · \(n) red" : "")
    case "cost":
      return "$" + String(format: "%.2f", c.usd ?? 0) + "  ·  " + fmtTokens(c.tokens ?? 0) + (c.model.map { "  ·  " + $0 } ?? "")
    case "explain":
      return c.oneLiner ?? c.headline ?? ""
    case "question":
      return c.prompt ?? ""
    case "checkpoint":
      return (c.progress ?? "") + "  ·  " + fmtTokens(c.tokens ?? 0) + "  ·  $" + String(format: "%.2f", c.usd ?? 0)
    case "done":
      return c.headline ?? "done"
    default:
      return ""
    }
  }

  static func statusWord(_ s: String?) -> String {
    switch s {
    case "running": return "working"
    case "judging": return "judging"
    case "retrying": return "retrying"
    case "awaiting_human": return "needs you"
    case "done": return "done"
    case "failed": return "failed"
    default: return s ?? ""
    }
  }

  static func statusGlyph(_ s: String?) -> String {
    switch s {
    case "running": return "●"
    case "judging": return "◐"
    case "retrying": return "↻"
    case "awaiting_human": return "◆"
    case "done": return "✓"
    case "failed": return "✗"
    default: return "●"
    }
  }

  static func activityIcon(_ verb: String?) -> String {
    switch verb {
    case "plan": return "✦"
    case "read": return "▸"
    case "edit": return "✎"
    case "test": return "▶"
    case "judge": return "◐"
    case "wait": return "◆"
    case "done": return "✓"
    case "fail": return "✗"
    default: return "•"
    }
  }

  /// Text approximation of a progress bar (no CSS): 10 cells filled by proportion.
  static func progressBar(have: Int, need: Int) -> String {
    guard need > 0 else { return "" }
    let pct = max(0.0, min(1.0, Double(have) / Double(need)))
    let filled = Int((pct * 10).rounded())
    return String(repeating: "▰", count: filled) + String(repeating: "▱", count: 10 - filled) + "  \(Int(pct * 100))%"
  }
}

// MARK: - Prompt-recording lens cards + shared send

extension RunViewModel {
  /// Listening card for the START PROMPT flow — mirrors the webapp's "What should I build?"
  /// listening screen. "Build" is first (implicit cursor) → transcribe + start the run.
  fileprivate func sendPromptListeningCard() async {
    guard GlassesDisplayHub.shared.canSend else { return }
    let go = MWDATDisplay.Button(
      label: "Build", style: .primary, iconName: .checkmark,
      onClick: { [weak self] in Task { @MainActor in await self?.stopAndStartRun() } }
    )
    await send(
      FlexBox(direction: .column, spacing: 12) {
        go
        MWDATDisplay.Text("What should I build?", style: .heading)
        MWDATDisplay.Text("Say the task, then tap Build.", style: .body, color: .secondary)
      }
      .padding(24)
      .background(.card)
      .onTap { [weak self] in Task { @MainActor in await self?.stopAndStartRun() } }
    )
  }

  /// Stop the prompt recording, transcribe, and start the run with the spoken task.
  func stopAndStartRun() async {
    recorder?.stop()
    recorder = nil
    guard let url = recordingURL, let data = try? Data(contentsOf: url), !data.isEmpty else {
      await sendStartPromptCard()
      return
    }
    do {
      let transcript = try await transcribe(audio: data)
      let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
      if text.isEmpty { await sendStartPromptCard() }
      else { promptText = text; await startRun(prompt: text) }
    } catch {
      DATLog.log.error("[wiser] prompt transcribe failed: \(String(describing: error), privacy: .public)")
      await sendStartPromptCard()
    }
  }

  // Forward to the hub's shared send (the local helpers all go through here).
  fileprivate func send(_ view: FlexBox) async {
    await GlassesDisplayHub.shared.send(view)
  }
}

// MARK: - Build tab (phone surface — minimal; the lens is the deliverable)

/// The "Build" tab. Glasses-first: the real UI is on the lens (ambient/statusline/cards). This
/// phone view is a thin control surface — start a run by voice or text, mirror the HUD, and
/// expose tap controls so the flow is also drivable without the band for testing.
struct BuildView: View {
  @State private var viewModel: RunViewModel
  @FocusState private var promptFocused: Bool

  init(wearables: WearablesInterface) {
    _viewModel = State(wrappedValue: RunViewModel(wearables: wearables))
  }

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      VStack(spacing: 16) {
        header
        backendField
        hudPanel
        Spacer()
        controls
      }
      .padding(24)
    }
    .task { await viewModel.startGlasses() }
    .onDisappear { viewModel.detachGlasses() }
    .alert("Error", isPresented: $viewModel.showError) {
      Button("OK") { viewModel.dismissError() }
    } message: {
      Text(viewModel.errorMessage)
    }
  }

  private var header: some View {
    HStack {
      Text("build")
        .font(.system(size: 32, weight: .bold))
        .foregroundStyle(.cyan)
      Spacer()
      Circle()
        .fill(viewModel.glassesReady ? Color.green : Color.gray)
        .frame(width: 10, height: 10)
      Text(viewModel.glassesReady ? "glasses" : "no glasses")
        .font(.caption).foregroundStyle(.gray)
    }
  }

  private var backendField: some View {
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
  }

  @ViewBuilder
  private var hudPanel: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text(RunViewModel.statusGlyph(viewModel.hud?.status) + " " + RunViewModel.statusWord(viewModel.hud?.status))
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(.cyan)
        Spacer()
        Text(viewModel.phase.rawValue)
          .font(.caption).foregroundStyle(.gray)
      }
      if let exit = viewModel.hud?.exit, let need = exit.need, need > 0 {
        let have = exit.have ?? 0
        VStack(alignment: .leading, spacing: 4) {
          Text((exit.label ?? "goal") + "  \(have) / \(need)")
            .font(.system(size: 13)).foregroundStyle(.white.opacity(0.85))
          ProgressView(value: Double(have), total: Double(need))
            .tint(.cyan)
        }
      }
      if !viewModel.latestFact.isEmpty {
        Text(viewModel.latestFact)
          .font(.system(size: 13)).foregroundStyle(.white.opacity(0.7))
          .lineLimit(2)
      }
      HStack(spacing: 12) {
        if let h = viewModel.hud {
          Text("$" + String(format: "%.2f", h.costUsd ?? 0)).foregroundStyle(.yellow)
          Text(RunViewModel.fmtTokens(h.tokens ?? 0)).foregroundStyle(.gray)
          if let iter = h.iter { Text("iter \(iter)").foregroundStyle(.gray) }
        }
        if !viewModel.connectionStatus.isEmpty {
          Spacer()
          Text(viewModel.connectionStatus).foregroundStyle(.gray)
        }
      }
      .font(.system(size: 12, design: .monospaced))
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color.white.opacity(0.05))
    .cornerRadius(12)
  }

  @ViewBuilder
  private var controls: some View {
    VStack(spacing: 12) {
      // Start a run by text (voice prompt is available on the lens via "Speak task").
      HStack(spacing: 8) {
        TextField("describe the coding task…", text: $viewModel.promptText, axis: .vertical)
          .lineLimit(1...3)
          .focused($promptFocused)
          .font(.system(size: 14))
          .foregroundStyle(.white)
          .padding(10)
          .background(Color.white.opacity(0.08))
          .cornerRadius(10)
        Button {
          promptFocused = false
          Task { await viewModel.startRun(prompt: viewModel.promptText) }
        } label: {
          Image(systemName: "paperplane.fill")
            .foregroundStyle(.black)
            .frame(width: 44, height: 44)
            .background(Color.cyan)
            .clipShape(Circle())
        }
      }

      // Voice prompt (mic on phone, transcript → startRun).
      Button {
        Task { await viewModel.startPromptRecording() }
      } label: {
        Label("Speak task", systemImage: "mic.fill")
          .font(.system(size: 16, weight: .semibold))
          .frame(maxWidth: .infinity)
          .frame(height: 50)
          .background(Color.white.opacity(0.1))
          .foregroundStyle(.cyan)
          .cornerRadius(25)
      }

      // When a question is up, mirror the lens decision controls on the phone too.
      if viewModel.awaiting {
        HStack(spacing: 10) {
          Button {
            Task { await viewModel.steer(gesture: "approve") }
          } label: {
            Label("Approve", systemImage: "checkmark")
              .frame(maxWidth: .infinity).frame(height: 48)
              .background(Color.green.opacity(0.2)).foregroundStyle(.green).cornerRadius(24)
          }
          Button {
            Task { await viewModel.steer(gesture: "reject") }
          } label: {
            Label("Reject", systemImage: "xmark")
              .frame(maxWidth: .infinity).frame(height: 48)
              .background(Color.red.opacity(0.2)).foregroundStyle(.red).cornerRadius(24)
          }
        }
        .font(.system(size: 15, weight: .semibold))
      }
    }
  }
}
