//
// WiserMirror.swift
//
// "Fake mirror" of the glasses to a laptop. There is no API to read the lens
// display pixels, so instead we TEE data the app already holds:
//   • the camera POV frames (already decoded to UIImage in StreamSessionViewModel)
//   • the card text we render on the lens (plain strings in Wiser.swift)
// …into a tiny on-phone HTTP server. A laptop on the same Wi-Fi opens the URL
// the app prints and sees the camera POV with the card floated on top — a stand-in
// for "looking through the glasses."
//
// Self-contained: Network.framework only, no deps, no Xcode project edits
// (synchronized file group auto-includes this). Best-effort: any failure here
// never touches the camera/voice/display flow.
//
// Integration (already wired):
//   WiserMirror.shared.start()                       // idempotent
//   WiserMirror.shared.publish(frame: uiImage)       // in handleVideoFrame
//   WiserMirror.shared.publish(title:body:kind:)     // next to display.send
//
// Laptop: open http://<phone-lan-ip>:8088  (printed to the Xcode console on start).

import Foundation
import Network
import UIKit

final class WiserMirror: @unchecked Sendable {
  static let shared = WiserMirror()

  private let port: UInt16 = 8088
  private let queue = DispatchQueue(label: "wiser.mirror")

  private var listener: NWListener?
  private var started = false

  // Latest state (only touched on `queue`).
  private var latestJPEG: Data?
  private var latestCardJSON = "{}"
  private var lastEncode = Date.distantPast

  // Open /stream connections we push MJPEG frames to.
  private final class Subscriber {
    let conn: NWConnection
    var busy = false
    init(_ conn: NWConnection) { self.conn = conn }
  }
  private var subscribers: [ObjectIdentifier: Subscriber] = [:]

  private init() {}

  // MARK: - Lifecycle

  /// Idempotent. Starts the HTTP server and logs the laptop URL.
  func start() {
    queue.async { [weak self] in self?._start() }
  }

  private func _start() {
    guard !started else { return }
    do {
      let params = NWParameters.tcp
      params.allowLocalEndpointReuse = true
      let listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
      // Advertising over Bonjour also triggers/satisfies the iOS local-network
      // permission cleanly (keys already in Info.plist).
      listener.service = NWListener.Service(name: "wiser-mirror", type: "_http._tcp")
      listener.newConnectionHandler = { [weak self] conn in self?.handle(conn) }
      listener.stateUpdateHandler = { [weak self] state in
        if case .ready = state { self?.logURLs() }
        if case .failed(let err) = state {
          NSLog("[WiserMirror] listener failed: \(err)")
        }
      }
      listener.start(queue: queue)
      self.listener = listener
      self.started = true
    } catch {
      NSLog("[WiserMirror] start failed: \(error)")
    }
  }

  func stop() {
    queue.async { [weak self] in
      guard let self else { return }
      self.subscribers.values.forEach { $0.conn.cancel() }
      self.subscribers.removeAll()
      self.listener?.cancel()
      self.listener = nil
      self.started = false
    }
  }

  // MARK: - Publish (called from the camera + card code)

  /// Tee a camera POV frame. Encoded to JPEG on the caller side (so we hand the
  /// queue a Sendable `Data`, not a non-Sendable `UIImage`); pushes are throttled.
  func publish(frame image: UIImage) {
    guard let jpeg = image.jpegData(compressionQuality: 0.45) else { return }
    queue.async { [weak self] in
      guard let self else { return }
      // ~12 fps is plenty for a mirror and keeps the BT→phone→Wi-Fi path light.
      let now = Date()
      guard now.timeIntervalSince(self.lastEncode) > 0.08 else { return }
      self.lastEncode = now
      self.latestJPEG = jpeg
      self.pushFrameToSubscribers(jpeg)
    }
  }

  /// Tee the card currently shown on the lens. `kind` tints the overlay
  /// (info/running/done/cost/attn) — purely cosmetic on the laptop.
  func publish(title: String, body: String, kind: String = "info") {
    let json = Self.jsonObject(["title": title, "body": body, "kind": kind])
    queue.async { [weak self] in self?.latestCardJSON = json }
  }

  /// Clear the overlay card (e.g. when leaving a card view).
  func clearCard() {
    queue.async { [weak self] in self?.latestCardJSON = "{}" }
  }

  // MARK: - Connection handling

  private func handle(_ conn: NWConnection) {
    conn.start(queue: queue)
    receiveRequestLine(conn, buffer: Data())
  }

  private func receiveRequestLine(_ conn: NWConnection, buffer: Data) {
    conn.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, isComplete, error in
      guard let self else { return }
      var buf = buffer
      if let data { buf.append(data) }
      if let r = buf.range(of: Data("\r\n".utf8)) {
        let line = String(decoding: buf.subdata(in: buf.startIndex..<r.lowerBound), as: UTF8.self)
        self.route(conn, requestLine: line)
        return
      }
      if error != nil || isComplete { conn.cancel(); return }
      if buf.count < 65_536 {
        self.receiveRequestLine(conn, buffer: buf)
      } else {
        conn.cancel()
      }
    }
  }

  private func route(_ conn: NWConnection, requestLine: String) {
    // "GET /path?x=y HTTP/1.1"
    let parts = requestLine.split(separator: " ")
    let rawPath = parts.count > 1 ? String(parts[1]) : "/"
    let path = rawPath.split(separator: "?").first.map(String.init) ?? "/"

    switch path {
    case "/", "/index.html":
      sendText(conn, body: Self.viewerHTML, contentType: "text/html; charset=utf-8")
    case "/card":
      sendText(conn, body: latestCardJSON, contentType: "application/json")
    case "/health":
      sendText(conn, body: "ok", contentType: "text/plain")
    case "/stream":
      startMJPEG(conn)
    default:
      sendText(conn, body: "not found", contentType: "text/plain", status: "404 Not Found")
    }
  }

  // MARK: - Responses

  private func sendText(_ conn: NWConnection, body: String, contentType: String, status: String = "200 OK") {
    let bodyData = Data(body.utf8)
    let header = """
    HTTP/1.1 \(status)\r
    Content-Type: \(contentType)\r
    Content-Length: \(bodyData.count)\r
    Cache-Control: no-store\r
    Access-Control-Allow-Origin: *\r
    Connection: close\r
    \r\n
    """
    var out = Data(header.utf8)
    out.append(bodyData)
    conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
  }

  private func startMJPEG(_ conn: NWConnection) {
    let header = """
    HTTP/1.1 200 OK\r
    Content-Type: multipart/x-mixed-replace; boundary=frame\r
    Cache-Control: no-store\r
    Access-Control-Allow-Origin: *\r
    Connection: close\r
    \r\n
    """
    let sub = Subscriber(conn)
    subscribers[ObjectIdentifier(conn)] = sub
    conn.stateUpdateHandler = { [weak self] state in
      switch state {
      case .failed, .cancelled:
        self?.queue.async { self?.subscribers[ObjectIdentifier(conn)] = nil }
      default: break
      }
    }
    conn.send(content: Data(header.utf8), completion: .contentProcessed { [weak self] _ in
      // Prime with the most recent frame so the laptop isn't blank until the next tick.
      self?.queue.async {
        if let jpeg = self?.latestJPEG { self?.write(jpeg, to: sub) }
      }
    })
  }

  private func pushFrameToSubscribers(_ jpeg: Data) {
    for sub in subscribers.values where !sub.busy {
      write(jpeg, to: sub)
    }
  }

  private func write(_ jpeg: Data, to sub: Subscriber) {
    sub.busy = true
    let partHeader = "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: \(jpeg.count)\r\n\r\n"
    var chunk = Data(partHeader.utf8)
    chunk.append(jpeg)
    chunk.append(Data("\r\n".utf8))
    sub.conn.send(content: chunk, completion: .contentProcessed { [weak self] error in
      self?.queue.async {
        if error != nil {
          sub.conn.cancel()
          self?.subscribers[ObjectIdentifier(sub.conn)] = nil
        } else {
          sub.busy = false
        }
      }
    })
  }

  // MARK: - URLs / helpers

  private func logURLs() {
    let urls = Self.localIPv4Addresses().map { "http://\($0):\(port)" }
    let pretty = urls.isEmpty ? "http://<phone-ip>:\(port) (no Wi-Fi address found)" : urls.joined(separator: "  |  ")
    NSLog("[WiserMirror] 👓  laptop mirror ready — open on same Wi-Fi:  \(pretty)")
    print("\n========================================================")
    print("👓  WISER MIRROR — open this on your laptop (same Wi-Fi):")
    urls.forEach { print("   \($0)") }
    if urls.isEmpty { print("   (couldn't read Wi-Fi IP — check Settings ▸ Wi-Fi)") }
    print("========================================================\n")
  }

  /// Wi-Fi (en0) IPv4 addresses via getifaddrs.
  private static func localIPv4Addresses() -> [String] {
    var results: [String] = []
    var ifaddr: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return results }
    defer { freeifaddrs(ifaddr) }
    var ptr: UnsafeMutablePointer<ifaddrs>? = first
    while let p = ptr {
      let iface = p.pointee
      let family = iface.ifa_addr.pointee.sa_family
      if family == UInt8(AF_INET) {
        let name = String(cString: iface.ifa_name)
        if name == "en0" || name == "en1" {
          var addr = iface.ifa_addr.pointee
          var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
          if getnameinfo(&addr, socklen_t(iface.ifa_addr.pointee.sa_len),
                         &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
            let ip = String(cString: host)
            if !ip.isEmpty { results.append(ip) }
          }
        }
      }
      ptr = iface.ifa_next
    }
    return results
  }

  /// Minimal, dependency-free JSON object encoder for flat [String: String].
  private static func jsonObject(_ dict: [String: String]) -> String {
    let body = dict.map { "\(escape($0.key)):\(escape($0.value))" }.joined(separator: ",")
    return "{\(body)}"
  }

  private static func escape(_ s: String) -> String {
    var out = "\""
    for ch in s.unicodeScalars {
      switch ch {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      default:
        if ch.value < 0x20 { out += String(format: "\\u%04x", ch.value) }
        else { out.unicodeScalars.append(ch) }
      }
    }
    out += "\""
    return out
  }

  // MARK: - Embedded laptop viewer

  private static let viewerHTML = """
  <!doctype html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>wiser · glasses mirror</title>
  <style>
    :root{
      --text:#eef2f8; --muted:#8b94a8; --card:#0e1118cc; --line:#2a3242;
      --info:#86e3d6; --running:#86e3d6; --done:#9fe7bd; --cost:#f3d79a; --attn:#f4a6c6;
      --font:"SF Pro Rounded",system-ui,-apple-system,sans-serif;
    }
    *{box-sizing:border-box;margin:0;padding:0}
    html,body{height:100%;background:#000;font-family:var(--font);color:var(--text);overflow:hidden}
    #wrap{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}
    #cam{width:100%;height:100%;object-fit:cover;display:block}
    /* subtle "through the lens" vignette */
    #vignette{position:fixed;inset:0;pointer-events:none;
      box-shadow:inset 0 0 220px 60px rgba(0,0,0,.65)}
    /* the floated HUD card — roughly where the lens panel sits (upper-right-ish) */
    #card{position:fixed;top:8%;right:6%;max-width:340px;min-width:240px;
      background:var(--card);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
      border:1px solid var(--line);border-left:4px solid var(--info);
      border-radius:18px;padding:18px 20px;
      box-shadow:0 18px 50px rgba(0,0,0,.55);
      opacity:0;transform:translateY(-8px);transition:opacity .25s,transform .25s,border-color .25s}
    #card.show{opacity:1;transform:none}
    #card .kind{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
    #card .title{font-size:21px;font-weight:700;line-height:1.2}
    #card .body{font-size:15px;color:var(--muted);margin-top:8px;line-height:1.35}
    #tag{position:fixed;left:16px;bottom:14px;font-size:12px;color:var(--muted);
      letter-spacing:.12em;text-transform:uppercase;opacity:.75}
    #tag b{color:var(--info)}
    #off{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
      flex-direction:column;gap:10px;color:var(--muted);font-size:15px}
  </style></head>
  <body>
    <div id="wrap"><img id="cam" alt="" onload="hideOff()" onerror="showOff()"></div>
    <div id="off">waiting for the glasses feed…<small>start streaming in the app</small></div>
    <div id="vignette"></div>
    <div id="card"><div class="kind"></div><div class="title"></div><div class="body"></div></div>
    <div id="tag"><b>wiser</b> · glasses mirror</div>
  <script>
    const KIND={info:'#86e3d6',running:'#86e3d6',done:'#9fe7bd',cost:'#f3d79a',attn:'#f4a6c6'};
    const cam=document.getElementById('cam'),off=document.getElementById('off'),card=document.getElementById('card');
    function showOff(){off.style.display='flex'}
    function hideOff(){off.style.display='none'}
    // MJPEG never "finishes loading", so reveal as soon as bytes flow.
    cam.addEventListener('load',hideOff);
    function startCam(){ cam.src='/stream?t='+Date.now(); }
    cam.addEventListener('error',()=>{ showOff(); setTimeout(startCam,1500); });
    startCam();
    setInterval(()=>{ if(cam.naturalWidth>0) hideOff(); },1000);

    async function poll(){
      try{
        const c=await (await fetch('/card?t='+Date.now())).json();
        if(c&&c.title){
          card.querySelector('.kind').textContent=c.kind||'';
          card.querySelector('.title').textContent=c.title;
          card.querySelector('.body').textContent=c.body||'';
          card.style.borderLeftColor=KIND[c.kind]||KIND.info;
          card.classList.add('show');
        } else { card.classList.remove('show'); }
      }catch(e){}
    }
    poll(); setInterval(poll,600);
  </script></body></html>
  """
}
