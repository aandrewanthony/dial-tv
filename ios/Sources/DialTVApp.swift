// Dial TV for iPad / iPhone: a native shell around the same web app as the desktop version.
// The app runs a small local server (LocalServer.swift) and shows it in a WKWebView.
import SwiftUI
import WebKit

@main
struct DialTVApp: App {
  @Environment(\.scenePhase) private var phase
  @StateObject private var model = ShellModel()

  var body: some Scene {
    WindowGroup {
      ZStack {
        Color.black.ignoresSafeArea()
        WebShell(model: model).ignoresSafeArea(.keyboard)
      }
      .preferredColorScheme(.dark)
      .onChange(of: phase) { p in
        if p == .active { model.ensureRunning() }
      }
    }
  }
}

final class ShellModel: ObservableObject {
  let server = LocalServer()
  let webView: WKWebView
  private var loaded = false
  private let navDelegate = ShellDelegate()

  init() {
    let cfg = WKWebViewConfiguration()
    cfg.allowsInlineMediaPlayback = true
    cfg.mediaTypesRequiringUserActionForPlayback = []
    cfg.allowsAirPlayForMediaPlayback = true
    cfg.allowsPictureInPictureMediaPlayback = true
    cfg.preferences.isElementFullscreenEnabled = true
    // Tells the web app it runs inside the mobile shell (src/lib/net.ts#shell).
    let js = "window.dialShell = { platform: 'ios' };"
    cfg.userContentController.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    webView = WKWebView(frame: .zero, configuration: cfg)
    webView.isOpaque = false
    webView.backgroundColor = .black
    webView.scrollView.backgroundColor = .black
    webView.scrollView.bounces = false
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    webView.allowsBackForwardNavigationGestures = false
    if #available(iOS 16.4, *) { webView.isInspectable = true }
    webView.navigationDelegate = navDelegate
    webView.uiDelegate = navDelegate
    ensureRunning()
  }

  /// Start (or restart after the app was suspended) the local server, then show the app.
  func ensureRunning() {
    if server.isRunning && loaded { return }
    server.start { [weak self] in
      guard let self = self else { return }
      if !self.loaded {
        self.loaded = true
        self.webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(LocalServer.port)/index.html")!))
      }
    }
  }
}

/// Keeps the app on its own page; other links open in Safari.
final class ShellDelegate: NSObject, WKNavigationDelegate, WKUIDelegate {
  private func isApp(_ url: URL?) -> Bool {
    guard let u = url else { return false }
    return u.host == "127.0.0.1" && u.port == Int(LocalServer.port)
  }

  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    let url = navigationAction.request.url
    if navigationAction.targetFrame?.isMainFrame == false || isApp(url) || url?.scheme == "about" || url?.scheme == "blob" {
      return decisionHandler(.allow)
    }
    if let u = url, u.scheme == "http" || u.scheme == "https" { UIApplication.shared.open(u) }
    decisionHandler(.cancel)
  }

  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let u = navigationAction.request.url, u.scheme == "http" || u.scheme == "https" { UIApplication.shared.open(u) }
    return nil
  }

  /// The web content process was killed (memory pressure): reload instead of showing a blank page.
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    webView.reload()
  }
}

struct WebShell: UIViewRepresentable {
  let model: ShellModel
  func makeUIView(context: Context) -> WKWebView { model.webView }
  func updateUIView(_ uiView: WKWebView, context: Context) {}
}
