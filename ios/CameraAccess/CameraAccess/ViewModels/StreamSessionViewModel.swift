/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 */

import MWDATCamera
import MWDATCore
import MWDATDisplay
import Observation
import SwiftUI

enum StreamingStatus {
  case streaming
  case waiting
  case stopped
}

/// ViewModel for video streaming UI. Delegates device management to DeviceSessionManager.
@Observable
@MainActor
final class StreamSessionViewModel {
  // MARK: - State

  var currentVideoFrame: UIImage?
  var hasReceivedFirstFrame: Bool = false
  var streamingStatus: StreamingStatus = .stopped
  var showError: Bool = false
  var errorMessage: String = ""
  var requiresDATAppUpdate: Bool = false

  var capturedPhoto: UIImage?
  var showPhotoPreview: Bool = false
  var showPhotoCaptureError: Bool = false
  var isCapturingPhoto: Bool = false

  var hasActiveDevice: Bool { sessionManager.hasActiveDevice }
  var isDeviceSessionReady: Bool { sessionManager.isReady }

  var isStreaming: Bool { streamingStatus != .stopped }

  // MARK: - Private

  private let sessionManager: DeviceSessionManager
  private let wearables: WearablesInterface
  private var stream: MWDATCamera.Stream?

  private var stateListenerToken: AnyListenerToken?
  private var videoFrameListenerToken: AnyListenerToken?
  private var errorListenerToken: AnyListenerToken?
  private var photoDataListenerToken: AnyListenerToken?

  // Glasses lens display (attached to the same device session as the stream).
  private var display: Display?
  private var displayStateToken: AnyListenerToken?

  // MARK: - Init

  init(wearables: WearablesInterface) {
    self.wearables = wearables
    self.sessionManager = DeviceSessionManager(wearables: wearables)
  }

  // MARK: - Public API

  func handleStartStreaming() async {
    let permission = Permission.camera
    do {
      DATLog.log.notice("[Stream] handleStartStreaming — checking camera permission")
      var status = try await wearables.checkPermissionStatus(permission)
      if status != .granted {
        DATLog.log.notice("[Stream] camera permission=\(String(describing: status), privacy: .public) — requesting…")
        status = try await wearables.requestPermission(permission)
      }
      DATLog.log.notice("[Stream] camera permission status=\(String(describing: status), privacy: .public)")
      guard status == .granted else {
        showError("Permission denied")
        return
      }
      await startSession()
    } catch {
      DATLog.log.error("[Stream] permission error: \(String(describing: error), privacy: .public)")
      showError("Permission error: \(error.description)")
    }
  }

  func stopSession() async {
    await detachDisplay()
    guard let activeStream = stream else { return }
    stream = nil
    clearListeners()
    streamingStatus = .stopped
    currentVideoFrame = nil
    hasReceivedFirstFrame = false
    await activeStream.stop()
  }

  /// Stops both the stream and the underlying device session. Call in test tearDown.
  func endSession() {
    stream = nil
    clearListeners()
    displayStateToken = nil
    display = nil
    streamingStatus = .stopped
    currentVideoFrame = nil
    hasReceivedFirstFrame = false
    sessionManager.cleanup()
  }

  func capturePhoto() {
    guard !isCapturingPhoto, streamingStatus == .streaming else {
      showPhotoCaptureError = true
      return
    }
    isCapturingPhoto = true
    let success = stream?.capturePhoto(format: .jpeg) ?? false
    if !success {
      isCapturingPhoto = false
      showPhotoCaptureError = true
    }
  }

  func dismissError() {
    showError = false
    errorMessage = ""
  }

  func dismissPhotoCaptureError() {
    showPhotoCaptureError = false
  }

  func dismissPhotoPreview() {
    showPhotoPreview = false
    capturedPhoto = nil
  }

  // MARK: - Private

  private func startSession() async {
    let deviceSession: DeviceSession
    do {
      DATLog.log.notice("[Stream] startSession — requesting device session…")
      deviceSession = try await sessionManager.getSession()
      requiresDATAppUpdate = false
    } catch DeviceSessionError.datAppOnTheGlassesUpdateRequired {
      DATLog.log.error("[Stream] DAT app on the glasses requires an update")
      requiresDATAppUpdate = true
      showError(DeviceSessionError.datAppOnTheGlassesUpdateRequired.localizedDescription)
      return
    } catch {
      DATLog.log.error("[Stream] getSession failed: \(String(describing: error), privacy: .public)")
      showError("Failed to start session: \(error.localizedDescription)")
      return
    }

    guard deviceSession.state == .started else {
      DATLog.log.error("[Stream] device session not .started (state=\(String(describing: deviceSession.state), privacy: .public))")
      showError("Device session is not ready. Please try again.")
      return
    }

    let config = StreamConfiguration(
      videoCodec: VideoCodec.raw,
      resolution: StreamingResolution.low,
      frameRate: 24
    )

    guard let newStream = try? deviceSession.addStream(config: config) else {
      DATLog.log.error("[Stream] addStream returned nil")
      return
    }
    stream = newStream
    streamingStatus = .waiting
    setupListeners(for: newStream)
    DATLog.log.notice("[Stream] stream created — calling start()")
    await newStream.start()

    // Light up the glasses lens with a status card on the SAME device session.
    await attachDisplayCard(on: deviceSession)
  }

  private func setupListeners(for stream: MWDATCamera.Stream) {
    stateListenerToken = stream.statePublisher.listen { [weak self] state in
      Task { @MainActor in self?.handleStateChange(state) }
    }

    videoFrameListenerToken = stream.videoFramePublisher.listen { [weak self] frame in
      Task { @MainActor in self?.handleVideoFrame(frame) }
    }

    errorListenerToken = stream.errorPublisher.listen { [weak self] error in
      Task { @MainActor in self?.handleError(error) }
    }

    photoDataListenerToken = stream.photoDataPublisher.listen { [weak self] data in
      Task { @MainActor in self?.handlePhotoData(data) }
    }
  }

  private func clearListeners() {
    stateListenerToken = nil
    videoFrameListenerToken = nil
    errorListenerToken = nil
    photoDataListenerToken = nil
  }

  // MARK: - Glasses display card

  /// Attaches a Display capability to the active device session and renders a
  /// status card on the lens. Best-effort: a failure here is logged but never
  /// affects the camera stream (which is already running when this is called).
  private func attachDisplayCard(on session: DeviceSession) async {
    guard display == nil else { return }
    do {
      let capability = try session.addDisplay()
      displayStateToken = capability.statePublisher.listen { [weak self] state in
        Task { @MainActor in
          guard let self else { return }
          DATLog.log.notice("[Display] state=\(String(describing: state), privacy: .public)")
          if state == .started {
            await self.sendStatusCard()
          }
        }
      }
      await capability.start()
      display = capability
      DATLog.log.notice("[Display] capability started — waiting for .started")
    } catch {
      DATLog.log.error("[Display] addDisplay/start failed: \(String(describing: error), privacy: .public)")
    }
  }

  private func sendStatusCard() async {
    guard let display else { return }
    do {
      try await display.send(statusCard())
      DATLog.log.notice("[Display] status card sent ✅")
    } catch {
      let message = (error as? DisplayError)?.description ?? error.localizedDescription
      DATLog.log.error("[Display] send failed: \(message, privacy: .public)")
    }
  }

  /// Status card rendered on the glasses lens while streaming. `Text` is
  /// qualified to MWDATDisplay so it doesn't collide with SwiftUI.Text here.
  private func statusCard() -> FlexBox {
    FlexBox(direction: .column, spacing: 12) {
      MWDATDisplay.Text("CameraAccess", style: .heading)
      MWDATDisplay.Text("Streaming live from your glasses", style: .body, color: .secondary)
      MWDATDisplay.Text("Tap the shutter on your phone to capture a photo", style: .meta, color: .secondary)
    }
    .padding(24)
    .background(.card)
  }

  private func detachDisplay() async {
    displayStateToken = nil
    await display?.stop()
    display = nil
  }

  private func handleStateChange(_ state: StreamState) {
    DATLog.log.notice("[Stream] stream state=\(String(describing: state), privacy: .public)")
    switch state {
    case .stopped:
      currentVideoFrame = nil
      streamingStatus = .stopped
    case .waitingForDevice, .starting, .stopping, .paused:
      streamingStatus = .waiting
    case .streaming:
      streamingStatus = .streaming
    }
  }

  private func handleVideoFrame(_ frame: VideoFrame) {
    if let image = frame.makeUIImage() {
      currentVideoFrame = image
      if !hasReceivedFirstFrame {
        hasReceivedFirstFrame = true
        DATLog.log.notice("[Stream] received FIRST video frame ✅")
      }
    }
  }

  private func handleError(_ error: StreamError) {
    DATLog.log.error("[Stream] stream error: \(String(describing: error), privacy: .public)")
    let message = error.localizedDescription
    if message != errorMessage {
      showError(message)
    }
  }

  private func handlePhotoData(_ data: PhotoData) {
    isCapturingPhoto = false
    if let image = UIImage(data: data.data) {
      capturedPhoto = image
      showPhotoPreview = true
    }
  }

  private func showError(_ message: String) {
    errorMessage = message
    showError = true
  }

}
