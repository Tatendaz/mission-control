/* Mission Control.app — a real, resident Dock app for the board.
   A WKWebView on http://localhost:<port>/ in a plain window. Being a regular
   NSApplication is the whole point: the Dock shows the running-indicator dot,
   Cmd-Tab lists it, and clicking the Dock icon re-focuses the board — none of
   which a fire-and-exit script launcher can provide.

   The server is expected to be kept alive by launchd; if the first load fails,
   we kick the service once and retry while it boots. */

import AppKit
import WebKit

let PORT = ProcessInfo.processInfo.environment["MISSION_CONTROL_PORT"] ?? "8765"
let SERVICE = "com.tatendaz.mission-control"
let BOARD = URL(string: "http://localhost:\(PORT)/")!

final class Delegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var tries = 0

    func applicationDidFinishLaunching(_: Notification) {
        let cfg = WKWebViewConfiguration()
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1320, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Mission Control"
        window.contentView = web
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("MissionControlBoard")
        if window.frame.width < 400 { window.center() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        load()
    }

    func load() {
        web.load(URLRequest(url: BOARD, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5))
    }

    /* the server may still be booting (login, or launchd restarting it) */
    func retry() {
        if tries == 0 {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            p.arguments = ["kickstart", "gui/\(getuid())/\(SERVICE)"]
            try? p.run()
        }
        guard tries < 25 else {
            /* don't strand the user on a blank window: say what's wrong, and
               let the link restart the whole retry loop */
            tries = 0
            web.loadHTMLString("""
                <body style="font: 15px -apple-system, sans-serif; background: #0B0E14; color: #E6E9F0;
                             display: grid; place-items: center; height: 100vh; margin: 0">
                <div style="text-align: center">
                  <p>The Mission Control server isn't answering on port \(PORT).</p>
                  <p><a href="\(BOARD)" style="color: #7AA2F7">Try again</a> — or check:
                     <code>launchctl print gui/$UID/\(SERVICE)</code></p>
                </div></body>
                """, baseURL: nil)
            return
        }
        tries += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { self.load() }
    }

    func webView(_: WKWebView, didFinish _: WKNavigation!) { tries = 0 }
    func webView(_: WKWebView, didFail _: WKNavigation!, withError _: Error) { retry() }
    func webView(_: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError _: Error) { retry() }

    /* the board itself stays in-app; PR links, GitHub, everything else goes to
       the default browser */
    func webView(_: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, let scheme = url.scheme,
           ["http", "https"].contains(scheme),
           !["localhost", "127.0.0.1", "[::1]"].contains(url.host ?? "") {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    /* target=_blank */
    func webView(_: WKWebView, createWebViewWith _: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures _: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func applicationShouldHandleReopen(_: NSApplication, hasVisibleWindows visible: Bool) -> Bool {
        if !visible { window.makeKeyAndOrderFront(nil) }
        NSApp.activate(ignoringOtherApps: true)
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool { true }
}

/* a programmatic app has no menu bar unless it builds one; without an Edit
   menu, Cmd+C/V and Cmd+Q do nothing */
func buildMenu() {
    let main = NSMenu()

    let appItem = NSMenuItem()
    main.addItem(appItem)
    let appMenu = NSMenu()
    appItem.submenu = appMenu
    appMenu.addItem(withTitle: "Hide Mission Control", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    appMenu.addItem(NSMenuItem.separator())
    appMenu.addItem(withTitle: "Quit Mission Control", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

    let editItem = NSMenuItem()
    main.addItem(editItem)
    let edit = NSMenu(title: "Edit")
    editItem.submenu = edit
    edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    edit.addItem(NSMenuItem.separator())
    edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

    let viewItem = NSMenuItem()
    main.addItem(viewItem)
    let view = NSMenu(title: "View")
    viewItem.submenu = view
    let reload = NSMenuItem(title: "Reload Board", action: #selector(WKWebView.reload(_:)), keyEquivalent: "r")
    view.addItem(reload)

    NSApp.mainMenu = main
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.regular)   /* Dock icon + running dot, the reason this app exists */
buildMenu()
app.run()
