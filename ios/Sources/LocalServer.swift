// A tiny HTTP server inside the app (127.0.0.1 only). It does two things:
//  - serves the Dial TV web app (the bundled dist/ folder), so the page has a normal http origin;
//  - relays downloads at /p/<scheme>/<host>/<path>?<query> (playlists, guides) with a VLC User-Agent
//    and an Access-Control-Allow-Origin header, streaming the response as it arrives.
import Foundation
import Network

final class LocalServer {
  static let port: UInt16 = 47810
  private var listener: NWListener?
  private let queue = DispatchQueue(label: "dialtv.server")
  private let root: URL

  init() {
    root = Bundle.main.resourceURL!.appendingPathComponent("dist", isDirectory: true)
  }

  var isRunning: Bool {
    if let l = listener, case .ready = l.state { return true }
    return false
  }

  func start(onReady: @escaping () -> Void) {
    listener?.cancel()
    let params = NWParameters.tcp
    params.allowLocalEndpointReuse = true
    params.requiredInterfaceType = .loopback
    guard let l = try? NWListener(using: params, on: NWEndpoint.Port(rawValue: LocalServer.port)!) else {
      // Port busy for a moment (app relaunch): try again shortly.
      queue.asyncAfter(deadline: .now() + 1) { [weak self] in self?.start(onReady: onReady) }
      return
    }
    listener = l
    l.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
    l.stateUpdateHandler = { [weak self] state in
      switch state {
      case .ready: DispatchQueue.main.async(execute: onReady)
      case .failed:
        self?.queue.asyncAfter(deadline: .now() + 1) { self?.start(onReady: onReady) }
      default: break
      }
    }
    l.start(queue: queue)
  }

  // MARK: - Requests

  private func accept(_ conn: NWConnection) {
    conn.start(queue: queue)
    readHead(conn, Data())
  }

  private func readHead(_ conn: NWConnection, _ soFar: Data) {
    conn.receive(minimumIncompleteLength: 1, maximumLength: 16384) { [weak self] data, _, done, error in
      guard let self = self else { return }
      var buf = soFar
      if let d = data { buf.append(d) }
      if let end = buf.range(of: Data("\r\n\r\n".utf8)) {
        self.handle(conn, head: String(decoding: buf[..<end.lowerBound], as: UTF8.self))
      } else if done || error != nil || buf.count > 65536 {
        conn.cancel()
      } else {
        self.readHead(conn, buf)
      }
    }
  }

  private func handle(_ conn: NWConnection, head: String) {
    let lines = head.components(separatedBy: "\r\n")
    let parts = (lines.first ?? "").split(separator: " ")
    guard parts.count >= 2 else { return respond(conn, 400, "Bad Request") }
    let method = String(parts[0])
    let target = String(parts[1])
    var headers: [String: String] = [:]
    for line in lines.dropFirst() {
      if let i = line.firstIndex(of: ":") {
        headers[line[..<i].lowercased()] = line[line.index(after: i)...].trimmingCharacters(in: .whitespaces)
      }
    }
    if method == "OPTIONS" {
      return send(conn, status: "204 No Content", headers: ["Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS"], body: Data())
    }
    guard method == "GET" || method == "HEAD" else { return respond(conn, 405, "Method Not Allowed") }
    if target.hasPrefix("/p/") {
      relay(conn, target: target, range: headers["range"], headOnly: method == "HEAD")
    } else {
      serveFile(conn, target: target, headOnly: method == "HEAD")
    }
  }

  // MARK: - Static files

  private static let types: [String: String] = [
    "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "mjs": "text/javascript; charset=utf-8",
    "css": "text/css; charset=utf-8", "json": "application/json", "svg": "image/svg+xml", "png": "image/png",
    "jpg": "image/jpeg", "ico": "image/x-icon", "woff2": "font/woff2", "woff": "font/woff", "wasm": "application/wasm",
    "map": "application/json", "txt": "text/plain; charset=utf-8",
  ]

  private func serveFile(_ conn: NWConnection, target: String, headOnly: Bool) {
    var path = target
    if let q = path.firstIndex(where: { $0 == "?" || $0 == "#" }) { path = String(path[..<q]) }
    path = path.removingPercentEncoding ?? path
    if path == "/" || path.isEmpty { path = "/index.html" }
    let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
    guard file.path.hasPrefix(root.standardizedFileURL.path), let data = try? Data(contentsOf: file) else {
      return respond(conn, 404, "Not Found")
    }
    let type = LocalServer.types[file.pathExtension.lowercased()] ?? "application/octet-stream"
    send(conn, status: "200 OK", headers: ["Content-Type": type, "Cache-Control": "no-cache"], body: headOnly ? Data() : data, length: data.count)
  }

  // MARK: - Relay

  private func relay(_ conn: NWConnection, target: String, range: String?, headOnly: Bool) {
    // /p/<scheme>/<host>/<rest>
    let rest = target.dropFirst(3)
    guard let s1 = rest.firstIndex(of: "/") else { return respond(conn, 400, "Bad Request") }
    let scheme = String(rest[..<s1])
    let afterScheme = rest[rest.index(after: s1)...]
    let hostEnd = afterScheme.firstIndex(where: { $0 == "/" || $0 == "?" }) ?? afterScheme.endIndex
    let host = String(afterScheme[..<hostEnd])
    let tail = String(afterScheme[hostEnd...])
    guard scheme == "http" || scheme == "https", !host.isEmpty, let url = URL(string: "\(scheme)://\(host)\(tail)") else {
      return respond(conn, 400, "Bad Request")
    }
    var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
    req.httpMethod = headOnly ? "HEAD" : "GET"
    req.setValue("VLC/3.0.21 LibVLC/3.0.21", forHTTPHeaderField: "User-Agent")
    if let r = range { req.setValue(r, forHTTPHeaderField: "Range") }
    let pump = RelayPump(conn: conn, queue: queue)
    let session = URLSession(configuration: .ephemeral, delegate: pump, delegateQueue: nil)
    let task = session.dataTask(with: req)
    pump.onClose = { task.cancel(); session.invalidateAndCancel() }
    pump.watchClient()
    task.resume()
  }

  // MARK: - Helpers

  private func respond(_ conn: NWConnection, _ code: Int, _ text: String) {
    send(conn, status: "\(code) \(text)", headers: ["Content-Type": "text/plain; charset=utf-8"], body: Data(text.utf8))
  }

  private func send(_ conn: NWConnection, status: String, headers: [String: String], body: Data, length: Int? = nil) {
    var head = "HTTP/1.1 \(status)\r\n"
    for (k, v) in headers { head += "\(k): \(v)\r\n" }
    head += "Content-Length: \(length ?? body.count)\r\nConnection: close\r\n\r\n"
    var out = Data(head.utf8)
    out.append(body)
    conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
  }
}

/// Streams one upstream response to one client connection (close-delimited body).
final class RelayPump: NSObject, URLSessionDataDelegate {
  private let conn: NWConnection
  private let queue: DispatchQueue
  private var closed = false
  private var sentHead = false
  var onClose: (() -> Void)?

  init(conn: NWConnection, queue: DispatchQueue) {
    self.conn = conn
    self.queue = queue
  }

  /// The client going away (channel change, page closed) stops the download.
  func watchClient() {
    conn.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] _, _, done, error in
      guard let self = self else { return }
      if done || error != nil { self.finish() } else { self.watchClient() }
    }
  }

  private func finish() {
    queue.async {
      if self.closed { return }
      self.closed = true
      self.conn.cancel()
      self.onClose?()
      self.onClose = nil
    }
  }

  private func write(_ data: Data) {
    queue.async {
      if self.closed { return }
      self.conn.send(content: data, completion: .contentProcessed { [weak self] error in
        if error != nil { self?.finish() }
      })
    }
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    let http = response as? HTTPURLResponse
    let code = http?.statusCode ?? 200
    var head = "HTTP/1.1 \(code) \(code == 200 ? "OK" : code == 206 ? "Partial Content" : "Status")\r\n"
    head += "Content-Type: \(http?.value(forHTTPHeaderField: "Content-Type") ?? "application/octet-stream")\r\n"
    if let cr = http?.value(forHTTPHeaderField: "Content-Range") { head += "Content-Range: \(cr)\r\n" }
    head += "Access-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: *\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
    sentHead = true
    write(Data(head.utf8))
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    write(data)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if !sentHead {
      write(Data("HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\nDownload failed".utf8))
    }
    // Let queued writes go out, then close.
    queue.async {
      if self.closed { return }
      self.conn.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { [weak self] _ in self?.finish() })
    }
  }
}
