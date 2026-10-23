import XCTest
@testable import Warren

@MainActor
final class ChatTests: XCTestCase {
  private func reply(_ method: String, _ path: String, _ json: String, status: Int = 200) {
    ManagementHTTPStub.responses.withLock { $0[method + " " + path] = (status, Data(json.utf8)) }
  }
  private func makeStore() -> Store {
    ManagementHTTPStub.responses.withLock { $0 = [:] }; ManagementHTTPStub.requests.withLock { $0 = [] }
    let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [ManagementHTTPStub.self]
    let store = Store(loadSession: false)
    store.api = API(base: URL(string: "https://management.test")!, token: "test", session: URLSession(configuration: configuration))
    store.role = "member"; store.me = User(id: "u1", email: "sam@example.test", name: "Sam")
    store.channels = [try! Wire.decoder.decode(Channel.self, from: Data(#"{"id":"c1","name":"general","kind":"channel","topic":"","createdAt":"2026-10-22T10:00:00Z"}"#.utf8))]
    return store
  }
  private func message(_ id: String, thread: String? = nil, author: String = "u1", body: String = "hi") -> String {
    #"{"id":"\#(id)","channelId":"c1","threadId":\#(thread.map { "\"\($0)\"" } ?? "null"),"author":{"kind":"user","id":"\#(author)"},"body":"\#(body)","parts":[],"createdAt":"2026-10-22T10:00:00Z"}"#
  }
  private func msg(_ id: String, thread: String? = nil, author: String = "u1") -> Message {
    try! Wire.decoder.decode(Message.self, from: Data(message(id, thread: thread, author: author).utf8))
  }

  func testEditedAndRemovedMessagesUpdateChannelAndThread() {
    let store = makeStore()
    store.messages["c1"] = [msg("m1"), msg("m2")]
    store.threads["m1"] = [msg("r1", thread: "m1"), msg("r2", thread: "m1")]
    store.replyCounts["m1"] = 2

    let edited = message("m2", body: "fixed").replacingOccurrences(of: #""createdAt""#, with: #""editedAt":"2026-10-22T10:01:00Z","createdAt""#)
    store.handle(Data(#"{"type":"message_updated","message":\#(edited)}"#.utf8))
    XCTAssertEqual(store.messages["c1"]?.last?.body, "fixed")
    XCTAssertNotNil(store.messages["c1"]?.last?.editedAt)

    store.handle(Data(#"{"type":"message_updated","message":\#(message("r1", thread: "m1", body: "reply fixed"))}"#.utf8))
    XCTAssertEqual(store.threads["m1"]?.first?.body, "reply fixed")

    store.handle(Data(#"{"type":"message_removed","messageId":"r2","channelId":"c1","threadId":"m1"}"#.utf8))
    XCTAssertEqual(store.threads["m1"]?.map(\.id), ["r1"])
    XCTAssertEqual(store.replyCounts["m1"], 1)

    store.handle(Data(#"{"type":"message_removed","messageId":"m2","channelId":"c1","threadId":null}"#.utf8))
    XCTAssertEqual(store.messages["c1"]?.map(\.id), ["m1"])

    // a reply in a thread that isn't loaded only lowers its count
    store.replyCounts["m9"] = 3
    store.handle(Data(#"{"type":"message_removed","messageId":"x","channelId":"c1","threadId":"m9"}"#.utf8))
    XCTAssertEqual(store.replyCounts["m9"], 2)
  }

  func testOnlyYourOwnMessagesCanBeEditedAndOwnersCanDeleteAny() {
    let store = makeStore()
    XCTAssertTrue(store.canEdit(msg("m1")))
    XCTAssertFalse(store.canEdit(msg("m1", author: "u2")))
    XCTAssertFalse(store.canDelete(msg("m1", author: "u2")))
    store.role = "owner"
    XCTAssertTrue(store.canDelete(msg("m1", author: "u2")))
    XCTAssertFalse(store.canEdit(msg("m1", author: "u2")))
    store.channels[0].archivedAt = "2026-10-22T10:00:00Z"
    XCTAssertFalse(store.canEdit(msg("m1")))
    XCTAssertFalse(store.canDelete(msg("m1")))
  }

  func testEditAndDeleteCallTheHub() async throws {
    let store = makeStore()
    store.messages["c1"] = [msg("m1"), msg("m2")]
    reply("PATCH", "/api/messages/m1", message("m1", body: "new words"))
    try await store.editMessage(msg("m1"), body: "new words")
    XCTAssertEqual(store.messages["c1"]?.first?.body, "new words")

    reply("DELETE", "/api/messages/m2", #"{"ok":true,"kept":false}"#)
    try await store.deleteMessage(msg("m2"))
    XCTAssertEqual(store.messages["c1"]?.map(\.id), ["m1"])

    // a thread root with replies stays, blank, so its replies can still be read
    reply("DELETE", "/api/messages/m1", #"{"ok":true,"kept":true}"#)
    try await store.deleteMessage(store.messages["c1"]![0])
    XCTAssertNotNil(store.messages["c1"]?.first?.deletedAt)
    XCTAssertEqual(store.messages["c1"]?.first?.body, "")
  }

  func testSendingWithFiles() async throws {
    let store = makeStore()
    store.messages["c1"] = []
    reply("POST", "/api/channels/c1/messages", message("m3", body: ""))
    try await store.send("", in: "c1", files: ["f1"])
    let request = try XCTUnwrap(ManagementHTTPStub.requests.withLock { $0.last { $0.url?.path == "/api/channels/c1/messages" } })
    let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
    XCTAssertEqual(sent["fileIds"] as? [String], ["f1"])
    XCTAssertEqual(store.messages["c1"]?.map(\.id), ["m3"])
  }

  func testNewPartsDecode() throws {
    let parts = try Wire.decoder.decode([MessagePart].self, from: Data(#"""
      [{"type":"task","taskId":"t1"},{"type":"routine","routineId":"r1"},{"type":"discussion","discussionId":"d1"},
       {"type":"context","usage":{"model":"sonnet","contextUsed":12000,"contextWindow":200000,"at":"x"}},{"type":"context","usage":null},
       {"type":"file","fileId":"f1","name":"a.png"},{"type":"something_new"}]
      """#.utf8))
    XCTAssertEqual(parts[0], .task(taskId: "t1"))
    XCTAssertEqual(parts[1], .routine(routineId: "r1"))
    XCTAssertEqual(parts[2], .discussion(discussionId: "d1"))
    XCTAssertEqual(parts[3], .context(ContextUsage(model: "sonnet", contextUsed: 12000, contextWindow: 200000)))
    XCTAssertEqual(parts[4], .context(nil))
    XCTAssertEqual(parts[6], .other("something_new"))
    XCTAssertEqual(ContextCard.tokens(12000), "12k")
    XCTAssertEqual(ContextCard.tokens(1234), "1.2k")
    XCTAssertEqual(ContextCard.tokens(200_000), "200k")
    XCTAssertEqual(ContextCard.tokens(1_000_000), "1M")
    XCTAssertTrue(UploadedFile.isImage("Photo.JPG"))
    XCTAssertFalse(UploadedFile.isImage("notes.pdf"))
  }

  func testDiscussionsLoadAndFollowEvents() async throws {
    let store = makeStore()
    let json = #"{"id":"d1","channelId":"c1","threadId":"m1","topic":"Launch plan","participants":["a1"],"moderatorId":"a1","rounds":2,"round":1,"status":"running","decisionPath":null,"progress":[{"agentId":"a1","status":"running"}]}"#
    reply("GET", "/api/discussions/d1", json)
    await store.loadDiscussion("d1")
    XCTAssertEqual(store.discussions["d1"]?.topic, "Launch plan")
    XCTAssertTrue(store.discussions["d1"]?.live == true)
    reply("POST", "/api/discussions/d1/cancel", "{}")
    reply("GET", "/api/discussions/d1", json.replacingOccurrences(of: #""status":"running""#, with: #""status":"cancelled""#))
    try await store.stopDiscussion("d1")
    XCTAssertEqual(store.discussions["d1"]?.status, "cancelled")
  }

  func testSignOutDropsLoadsStillInFlight() async throws {
    let store = makeStore()
    reply("GET", "/api/channels/c1/messages", #"{"messages":[\#(message("m1"))],"replyCounts":{}}"#)
    let gen = store.session
    let load = Task { try await store.loadMessages("c1") }
    await Task.yield()
    store.signOut()
    XCTAssertNotEqual(store.session, gen)
    do {
      try await load.value
      XCTFail("a load from before signing out should be dropped")
    } catch {}
    XCTAssertNil(store.messages["c1"])
    // and nothing crashes with no connection at all
    do { try await store.send("hi", in: "c1"); XCTFail() } catch {}
    do { _ = try await store.dm(with: Agent(id: "a1", handle: "a", name: "A", harness: "codex", status: .online)); XCTFail() } catch {}
  }
}
