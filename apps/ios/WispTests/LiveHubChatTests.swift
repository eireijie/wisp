import SwiftUI
import XCTest
@testable import Wisp

/**
 * Chat against a real, seeded hub (skipped without WISP_HUB and WISP_TOKEN): the cards, files,
 * edits and deletes from here and from elsewhere, an upload, and the open thread refreshing after the
 * hub restarts. With WISP_SHOTS set, it saves what the screens looked like there.
 */
@MainActor
final class LiveHubChatTests: XCTestCase {
  private var hub: URL!
  private var token = ""
  private var window: UIWindow?

  func testChatAgainstLocalHub() async throws {
    let environment = ProcessInfo.processInfo.environment
    guard let address = envVar("HUB", in: environment), let hub = URL(string: address), address.hasPrefix("http"),
          let token = envVar("TOKEN", in: environment), !token.isEmpty, !token.hasPrefix("$(") else {
      throw XCTSkip("Set WISP_HUB and WISP_TOKEN, pointing at a seeded hub.")
    }
    self.hub = hub; self.token = token
    let store = Store(loadSession: false)
    store.api = API(base: hub, token: token)
    await store.load()
    XCTAssertEqual(store.phase, .ready)
    try await until("connected") { store.connected }
    let channel = try XCTUnwrap(store.channels.first { $0.name == "general" })

    // the cards and files, rendered
    show(ChannelView(channel: channel), store)
    try await until("messages") { store.messages[channel.id] != nil }
    try await until("task, routine and discussion cards") {
      store.tasks.contains { $0.id == "tk_1" } && store.routines.contains { $0.id == "rt_1" } && store.discussions["dsc_1"] != nil
    }
    let list = try XCTUnwrap(store.messages[channel.id])
    XCTAssertTrue(list.contains { $0.parts.contains(.context(ContextUsage(model: "claude-sonnet-5-5", contextUsed: 128_400, contextWindow: 200_000))) })
    let filesMessage = try XCTUnwrap(list.first { $0.body == "Here are two files" })
    let notes = try XCTUnwrap(filesMessage.files.first { $0.name == "notes.txt" })
    let saved = try await store.localFile(notes.id, name: notes.name)
    XCTAssertEqual(try String(contentsOf: saved, encoding: .utf8), "Notes from the chat test.\nLine two.\n")
    try await Task.sleep(for: .seconds(2))
    shot("1-channel")
    scroll(toTop: true)
    try await Task.sleep(for: .seconds(1))
    shot("2-channel-top")

    // edit and delete from here
    let hello = try XCTUnwrap(list.first { $0.body == "Hello from the chat test" })
    try await store.editMessage(hello, body: "Hello, edited on the phone")
    let root = try XCTUnwrap(list.first { $0.body == "A thread to reply in" })
    try await store.deleteMessage(root)
    XCTAssertNotNil(store.messages[channel.id]?.first { $0.id == root.id }?.deletedAt, "a thread root with a reply stays, blank")

    // and from elsewhere, arriving over the live connection
    _ = try await call("PATCH", "messages/\(hello.id)", ["body": "Changed on another device"])
    try await until("an edit from elsewhere") { store.messages[channel.id]?.first { $0.id == hello.id }?.body == "Changed on another device" }
    _ = try await call("DELETE", "messages/\(filesMessage.id)")
    try await until("a delete from elsewhere") { store.messages[channel.id]?.contains { $0.id == filesMessage.id } == false }

    // an upload, sent with a message
    let png = UIGraphicsImageRenderer(size: CGSize(width: 60, height: 40)).pngData { ctx in UIColor.systemTeal.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 60, height: 40)) }
    let file = try await store.uploadFile(png, name: "upload.png", mime: "image/png", channelId: channel.id)
    try await store.send("Sent with a picture", in: channel.id, files: [file.id])
    try await until("the upload in the channel") { store.messages[channel.id]?.last?.files.first?.name == "upload.png" }
    try await Task.sleep(for: .seconds(2))
    scroll(toTop: false)
    try await Task.sleep(for: .seconds(1))
    shot("3-after-edits")

    // the open thread, refreshed after the hub restarts (the reply is added while it's down, so no event carries it)
    show(ThreadView(ref: ThreadRef(channelId: channel.id, rootId: root.id)), store)
    try await until("the thread") { store.threads[root.id]?.isEmpty == false && store.openThreads[root.id] != nil }
    shot("4-thread")
    if envVar("RECONNECT", in: environment) == "1" {
      try await store.send("reconnect-now", in: channel.id)
      try await until("the connection to drop") { !store.connected }
      try await until("the reply written while it was down", timeout: 150) { store.threads[root.id]?.contains { $0.body == "Written while you were away" } == true }
      try await Task.sleep(for: .seconds(1))
      shot("5-thread-after-reconnect")
    }
  }

  private func show(_ view: some View, _ store: Store) {
    let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first!
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
    window.rootViewController = UIHostingController(rootView: NavigationStack { view }.environment(store))
    window.windowLevel = .alert + 1
    window.makeKeyAndVisible()
    self.window = window
  }

  private func scroll(toTop: Bool) {
    guard let scrolls = window?.rootViewController?.view.find(UIScrollView.self) else { return }
    for s in scrolls where s.contentSize.height > s.bounds.height {
      s.setContentOffset(CGPoint(x: 0, y: toTop ? -s.adjustedContentInset.top : s.contentSize.height - s.bounds.height + s.adjustedContentInset.bottom), animated: false)
    }
  }

  private func shot(_ name: String) {
    guard let dir = envVar("SHOTS"), let view = window?.rootViewController?.view else { return }
    let image = UIGraphicsImageRenderer(bounds: view.bounds).image { _ in view.drawHierarchy(in: view.bounds, afterScreenUpdates: true) }
    try? image.pngData()?.write(to: URL(fileURLWithPath: dir).appending(path: "\(name).png"))
  }

  private func until(_ what: String, timeout: Double = 15, _ check: () -> Bool) async throws {
    let end = Date().addingTimeInterval(timeout)
    while !check() {
      if Date() > end { XCTFail("Timed out waiting for \(what)"); throw CancellationError() }
      try await Task.sleep(for: .milliseconds(200))
    }
  }

  private func call(_ method: String, _ path: String, _ body: [String: String]? = nil) async throws -> Data {
    var request = URLRequest(url: hub.appending(path: "/api/\(path)"))
    request.httpMethod = method
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, String(decoding: data, as: UTF8.self))
    return data
  }
}

private extension UIView {
  func find<T: UIView>(_ type: T.Type) -> [T] { ((self as? T).map { [$0] } ?? []) + subviews.flatMap { $0.find(type) } }
}
