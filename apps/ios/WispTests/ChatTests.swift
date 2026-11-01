import XCTest
import Security
import UIKit
import Synchronization
@testable import Wisp

@MainActor
final class ChatTests: XCTestCase {
  private func reply(_ method: String, _ path: String, _ json: String, status: Int = 200) {
    ManagementHTTPStub.responses.withLock { $0[method + " " + path] = (status, Data(json.utf8)) }
  }
  private func makeStore() -> Store {
    ManagementHTTPStub.responses.withLock { $0 = [:] }; ManagementHTTPStub.requests.withLock { $0 = [] }
    let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [ManagementHTTPStub.self]
    let store = Store(loadSession: false, persistToken: { _ in })
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

  func testFailedSendPreservesNewComposerText() {
    XCTAssertEqual(Composer.restoringFailedText("failed", current: "new draft"), "new draft")
    XCTAssertEqual(Composer.restoringFailedText("failed", current: ""), "failed")
    XCTAssertEqual(Composer.restoringFailedText("failed", current: " "), " ")
  }

  func testReplyCountsKeepServerTotalAndDeduplicateEvents() async throws {
    let store = makeStore()
    store.replyCounts["m1"] = 120
    reply("GET", "/api/channels/c1/messages", #"{"messages":[\#(message("r1", thread: "m1"))],"replyCounts":{}}"#)
    try await store.loadMessages("c1", thread: "m1")
    XCTAssertEqual(store.replyCounts["m1"], 120)
    func incoming(_ id: String, root: String) {
      store.handle(Data(#"{"type":"message","message":\#(message(id, thread: root))}"#.utf8))
    }
    incoming("r1", root: "m1")
    XCTAssertEqual(store.replyCounts["m1"], 120)
    incoming("r2", root: "m1")
    incoming("r2", root: "m1")
    XCTAssertEqual(store.replyCounts["m1"], 121)
    XCTAssertEqual(store.threads["m1"]?.map(\.id), ["r1", "r2"])
    store.replyCounts["uncached"] = 90
    incoming("r3", root: "uncached")
    incoming("r3", root: "uncached")
    XCTAssertNil(store.threads["uncached"])
    XCTAssertEqual(store.replyCounts["uncached"], 91)
    store.remove("r2", channel: "c1", thread: "m1")
    store.remove("r2", channel: "c1", thread: "m1")
    XCTAssertEqual(store.replyCounts["m1"], 120)
    incoming("r2", root: "m1")
    XCTAssertEqual(store.replyCounts["m1"], 120)
  }

  func testEarlierHistoryFailureCanRetryAndExhaustionIsSeparate() async throws {
    let store = makeStore()
    store.messages["c1"] = [msg("latest")]
    store.threads["m1"] = [msg("recent", thread: "m1")]
    reply("GET", "/api/channels/c1/messages", #"{"error":"Try later"}"#, status: 503)
    for thread: String? in [nil, "m1"] {
      do { _ = try await store.loadEarlier("c1", thread: thread); XCTFail("failure must throw") }
      catch let e as API.Failure { XCTAssertEqual(e.status, 503) }
    }
    XCTAssertFalse(store.noEarlierThreads.contains("m1"))
    XCTAssertEqual(store.messages["c1"]?.map(\.id), ["latest"])
    reply("GET", "/api/channels/c1/messages", #"{"messages":[\#(message("older"))],"replyCounts":{"older":4}}"#)
    let loaded = try await store.loadEarlier("c1")
    XCTAssertTrue(loaded)
    XCTAssertEqual(store.messages["c1"]?.map(\.id), ["older", "latest"])
    XCTAssertEqual(store.replyCounts["older"], 4)
    reply("GET", "/api/channels/c1/messages", #"{"messages":[],"replyCounts":{}}"#)
    let moreChannel = try await store.loadEarlier("c1")
    let moreThread = try await store.loadEarlier("c1", thread: "m1")
    XCTAssertFalse(moreChannel)
    XCTAssertFalse(moreThread)
    XCTAssertTrue(store.noEarlierThreads.contains("m1"))
  }

  func testThreadPaginationKeepsRootSeparateAndUsesReplyCursor() async throws {
    let store = makeStore()
    let root = message("sub", thread: "parent").replacingOccurrences(of: "10:00:00", with: "08:00:00")
    let latest = (0..<80).map { message("r\($0)", thread: "sub") }.joined(separator: ",")
    reply("GET", "/api/channels/c1/messages", #"{"messages":[\#(latest)],"replyCounts":{"r1":3}}"#)
    try await store.loadMessages("c1", thread: "sub")
    XCTAssertFalse(store.noEarlierThreads.contains("sub"))
    XCTAssertEqual(store.replyCounts["sub"], 80)
    XCTAssertEqual(store.replyCounts["r1"], 3)
    let older = message("early", thread: "sub").replacingOccurrences(of: "10:00:00", with: "09:00:00")
    reply("GET", "/api/channels/c1/messages", #"{"messages":[\#(root),\#(older)],"replyCounts":{}}"#)
    let loaded = try await store.loadEarlier("c1", thread: "sub")
    XCTAssertTrue(loaded)
    XCTAssertEqual(store.threads["sub"]?.first?.id, "early")
    XCTAssertFalse(store.threads["sub"]!.contains { $0.id == "sub" })
    XCTAssertEqual(store.roots["sub"]?.threadId, "parent")
    // A loaded sub-thread root is already a known reply in its parent, even if that parent isn't cached.
    store.replyCounts["parent"] = 40
    store.handle(Data(#"{"type":"message","message":\#(root)}"#.utf8))
    XCTAssertEqual(store.replyCounts["parent"], 40)
    XCTAssertEqual(store.message("sub", in: "c1")?.id, "sub")
    XCTAssertNil(store.messages["c1"])
    let request = try XCTUnwrap(ManagementHTTPStub.requests.withLock { $0.last })
    let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
    XCTAssertEqual(query.first { $0.name == "thread" }?.value, "sub")
    XCTAssertEqual(query.first { $0.name == "before" }?.value, "2026-10-22T10:00:00Z")
    // A root-only page finishes pagination without adding the root as a reply.
    reply("GET", "/api/channels/c1/messages", #"{"messages":[\#(root)],"replyCounts":{}}"#)
    let more = try await store.loadEarlier("c1", thread: "sub")
    XCTAssertFalse(more)
    XCTAssertTrue(store.noEarlierThreads.contains("sub"))
    XCTAssertEqual(store.threads["sub"]?.count, 81)
  }

  func testApprovalLoadDistinguishesDecidedMissingAndFailed() async throws {
    let store = makeStore()
    let approval = #"{"id":"a1","agentId":"agent","channelId":"c1","summary":"Run it","details":"","status":"approved","note":"","createdAt":"now"}"#
    reply("GET", "/api/approvals/a1", approval)
    let found = try await store.loadApproval("a1")
    XCTAssertTrue(found)
    XCTAssertEqual(store.approvals.first?.status, "approved")
    reply("GET", "/api/approvals/missing", #"{"error":"not found"}"#, status: 404)
    let missing = try await store.loadApproval("missing")
    XCTAssertFalse(missing)
    reply("GET", "/api/approvals/missing", #"{"error":"offline"}"#, status: 503)
    do { _ = try await store.loadApproval("missing"); XCTFail("failure must remain retryable") }
    catch let e as API.Failure { XCTAssertEqual(e.status, 503) }
    reply("GET", "/api/approvals/missing", approval.replacingOccurrences(of: "a1", with: "missing"))
    let retried = try await store.loadApproval("missing")
    XCTAssertTrue(retried)
  }

  func testExpiredForegroundAuthenticationSignsOutAndKeepsHub() async throws {
    let store = makeStore()
    let savedHub = Session.hub
    defer { Session.hub = savedHub }
    Session.hub = store.api?.base
    store.phase = .ready
    store.connected = true
    reply("GET", "/api/tasks", #"{"error":"unauthorized"}"#, status: 401)
    do { try await store.refreshTasks(); XCTFail("expected auth expiry") } catch {}
    XCTAssertEqual(store.phase, .signedOut)
    XCTAssertNil(store.api)
    XCTAssertNil(store.me)
    XCTAssertFalse(store.connected)
    XCTAssertEqual(store.sessionMessage, "Signed out: sign in again")
    XCTAssertEqual(Session.hub?.host(), "management.test")
    XCTAssertNil(store.syncError)
  }

  func testAPISendsTypedAuthenticationErrorAndUsefulDecodingDiagnostics() async throws {
    let store = makeStore()
    let api = try XCTUnwrap(store.api)
    reply("GET", "/expired", "{}", status: 401)
    do { let _: Empty = try await api.get("/expired"); XCTFail() }
    catch { XCTAssertTrue(error is API.AuthenticationExpired) }
    struct Payload: Decodable { struct Child: Decodable { var count: Int }; var child: Child }
    let body = #"{"child":{"count":"bad"},"padding":""# + String(repeating: "x", count: 250) + #""}"#
    reply("GET", "/bad-json", body)
    do { let _: Payload = try await api.get("/bad-json"); XCTFail() }
    catch let e as API.Failure {
      XCTAssertTrue(e.description.contains("child.count"))
      XCTAssertTrue(e.description.contains(String(body.prefix(200))))
      XCTAssertFalse(e.description.contains(String(repeating: "x", count: 201)))
      XCTAssertFalse(e.localizedDescription.contains("padding"))
    }
  }

  func testSocketAuthFailuresDifferFromNetworkDrops() {
    XCTAssertTrue(Store.isSocketAuthenticationFailure(code: 4401, reason: "unauthorized", status: nil))
    XCTAssertTrue(Store.isSocketAuthenticationFailure(code: 0, reason: nil, status: 401))
    XCTAssertFalse(Store.isSocketAuthenticationFailure(code: 4401, reason: "auth timeout", status: nil))
    XCTAssertFalse(Store.isSocketAuthenticationFailure(code: 1006, reason: nil, status: nil))
    let store = makeStore()
    let generation = store.session
    store.signOut()
    store.api = API(base: URL(string: "https://management.test")!, token: "new")
    store.phase = .ready
    store.authenticationExpired(generation: generation)
    XCTAssertEqual(store.api?.token, "new")
    XCTAssertEqual(store.phase, .ready)
  }

  func testGuestInboxBadgeIgnoresApprovalsTheInboxHides() {
    let store = makeStore()
    store.approvals = [Approval(id: "ap1", agentId: "a1", channelId: "c1", summary: "OK?", details: "", status: "pending", note: "", createdAt: "")]
    store.role = "owner"
    XCTAssertEqual(store.needsYouCount, 1)
    store.role = "guest"
    XCTAssertEqual(store.needsYouCount, 0)
  }

  func testGuestsDoNotLoadOrReceiveComputers() async throws {
    let store = makeStore()
    let computer = #"{"id":"desk","name":"Desk","kind":"vm","status":"ready","statusText":"","help":{"agentId":"a1","request":"Help","channelId":"c1"}}"#
    reply("GET", "/api/computers", "[\(computer)]")
    await store.refreshComputers()
    XCTAssertTrue(store.canViewComputers)
    XCTAssertEqual(store.computers.map(\.id), ["desk"])
    XCTAssertEqual(store.needsYouCount, 1)
    store.route = .computer(id: "desk")
    store.role = "guest"
    XCTAssertFalse(store.canViewComputers)
    XCTAssertTrue(store.computers.isEmpty)
    XCTAssertNil(store.route)
    XCTAssertEqual(store.needsYouCount, 0)
    ManagementHTTPStub.requests.withLock { $0 = [] }
    reply("GET", "/api/computers", #"{"error":"Forbidden"}"#, status: 403)
    await store.refreshComputers()
    store.handle(Data(#"{"type":"computer","computer":\#(computer)}"#.utf8))
    XCTAssertTrue(store.computers.isEmpty)
    XCTAssertNil(store.syncError)
    XCTAssertTrue(ManagementHTTPStub.requests.withLock { $0.isEmpty })
    store.role = "owner"
    XCTAssertTrue(store.canViewComputers)
  }

  func testMentionTriggerMatchesWebAtTheCaret() {
    for text in ["@", "hello @sc", "hello\n@sc", " @agent_1-two"] {
      XCTAssertNotNil(ComposerMentions.query(text, caret: text.count), text)
    }
    for text in ["sam@example", "(@sc", "@@sc", "@sc.", "@sc ", "@sc\n", "@é"] {
      XCTAssertNil(ComposerMentions.query(text, caret: text.count), text)
    }
    XCTAssertEqual(ComposerMentions.query("ask @sc later", caret: 7), "sc")
    XCTAssertEqual(ComposerMentions.query("@", caret: 1), "")
  }

  func testMentionFilteringAndInsertion() {
    let agents = [Agent(id: "a1", handle: "scout", name: "Researcher", harness: "codex", status: .online),
                  Agent(id: "a2", handle: "builder", name: "Sam agent", harness: "codex", status: .online)]
    let people = [Member(id: "u1", email: "sam@example.test", name: "Samuel", preferredName: "Sam", role: "member")]
    let matches = ComposerMentions.suggestions("@SA", caret: 3, agents: agents, people: people)
    XCTAssertEqual(matches.map(\.actor), [Actor(kind: .agent, id: "a2"), Actor(kind: .user, id: "u1")])
    XCTAssertEqual(ComposerMentions.suggestions("@res", caret: 4, agents: agents, people: people).map(\.handle), ["scout"])
    XCTAssertEqual(ComposerMentions.suggestions("@samu", caret: 5, agents: agents, people: people).map(\.handle), ["Sam"])
    XCTAssertTrue(ComposerMentions.suggestions("@ese", caret: 4, agents: agents, people: people).isEmpty)
    let spaced = [Member(id: "u2", email: "ann@example.test", name: "Ann Lee", preferredName: nil, role: "member")]
    XCTAssertEqual(ComposerMentions.suggestions("@an", caret: 3, agents: [], people: spaced).map(\.handle), ["Ann"])
    XCTAssertEqual(ComposerMentions.suggestions("@", caret: 1, agents: Array(repeating: agents[0], count: 8), people: people).count, 6)
    let completed = ComposerMentions.inserting("scout", into: "👋 @sc later", caret: 5)
    XCTAssertEqual(completed.text, "👋 @scout  later")
    XCTAssertEqual(completed.caret, "👋 @scout ".count)
    XCTAssertEqual(ComposerMentions.inserting("Sam", into: "@Sa", caret: 3).text, "@Sam ")
    XCTAssertEqual(ComposerMentions.inserting("scout", into: "email@sc", caret: 8).text, "email@sc")
  }

  func testImageAttachmentUsesAuthenticatedCacheAndBoundedThumbnail() async throws {
    let store = makeStore()
    let id = UUID().uuidString
    let format = UIGraphicsImageRendererFormat(); format.scale = 1
    let image = UIGraphicsImageRenderer(size: CGSize(width: 2000, height: 1000), format: format).image { context in
      UIColor.red.setFill(); context.fill(CGRect(x: 0, y: 0, width: 2000, height: 1000))
    }
    ManagementHTTPStub.responses.withLock { $0["GET /api/files/" + id] = (200, image.pngData()!) }
    let url = try await store.localFile(id, name: "Photo.PNG")
    defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    let cached = try await store.localFile(id, name: "Photo.PNG")
    XCTAssertEqual(cached, url)
    let requests = ManagementHTTPStub.requests.withLock { $0.filter { $0.url?.path == "/api/files/" + id } }
    XCTAssertEqual(requests.count, 1)
    XCTAssertEqual(requests.first?.value(forHTTPHeaderField: "Authorization"), "Bearer test")
    let thumbnail = try XCTUnwrap(AttachmentThumbnail.image(at: url))
    XCTAssertEqual(thumbnail.cgImage?.width, AttachmentThumbnail.maxPixelSize)
    XCTAssertEqual(thumbnail.cgImage?.height, AttachmentThumbnail.maxPixelSize / 2)
    XCTAssertTrue(AttachmentThumbnail.image(at: url) === thumbnail)
    XCTAssertNil(AttachmentThumbnail.image(at: url.deletingLastPathComponent().appending(path: "missing.png")))
    for name in ["image.png", "image.jpeg", "image.JPG", "image.gif", "image.webp"] { XCTAssertTrue(UploadedFile.isImage(name)) }
    XCTAssertFalse(UploadedFile.isImage("report.pdf"))
  }

  func testFailedPairingPersistenceRevokesReceivedTokenBeforeReportingFailure() async throws {
    let session = makeStore().api!.session
    for status in [200, 503] {
      ManagementHTTPStub.requests.withLock { $0 = [] }
      reply("POST", "/api/auth/logout", "{}", status: status)
      let store = Store(loadSession: false, persistToken: { _ in throw Session.PersistenceFailure(status: -34018) })
      do {
        try await store.adopt(hub: URL(string: "https://management.test")!, token: "just-paired", session: session)
        XCTFail("Keychain failure must prevent adoption")
      } catch let error as Session.PersistenceFailure {
        XCTAssertEqual(error.status, -34018)
        // other tests' stores may still be finishing requests, so look for the logout itself
        let logout = try XCTUnwrap(ManagementHTTPStub.requests.withLock { $0.first { $0.url?.path == "/api/auth/logout" } })
        XCTAssertEqual(logout.httpMethod, "POST")
        XCTAssertEqual(logout.value(forHTTPHeaderField: "Authorization"), "Bearer just-paired")
      }
      XCTAssertEqual(store.phase, .signedOut)
      XCTAssertNil(store.api)
    }
  }

  func testKeychainFailuresPreventSessionAdoption() throws {
    var added = false
    XCTAssertThrowsError(try Session.saveToken("new", delete: { _ in errSecAuthFailed }, add: { _ in added = true; return errSecSuccess }))
    XCTAssertFalse(added)
    XCTAssertThrowsError(try Session.saveToken("new", delete: { _ in errSecItemNotFound }, add: { _ in errSecNotAvailable }))
    XCTAssertNoThrow(try Session.saveToken("new", delete: { _ in errSecItemNotFound }, add: { _ in errSecSuccess }))
    let store = Store(loadSession: false, persistToken: { _ in throw Session.PersistenceFailure(status: errSecNotAvailable) })
    store.api = makeStore().api
    store.phase = .ready
    XCTAssertThrowsError(try store.switchSession(token: "new"))
    XCTAssertNil(store.api)
    XCTAssertEqual(store.phase, .signedOut)
  }

  func testManagementAndOtherLoadsRejectOldSessionResults() async throws {
    let loaders: [(String, String, (Store) async throws -> Void)] = [
      ("/api/agents", #"[{"id":"old","handle":"old","name":"Old","harness":"codex","status":"online"}]"#, { try await $0.refreshAgents() }),
      ("/api/nodes", #"[{"id":"old","name":"Old","online":true}]"#, { try await $0.refreshNodes() }),
      ("/api/tasks", #"[{"id":"old","title":"Old","brief":"","status":"open","from":{"kind":"user","id":"u1"},"channelId":"c1","createdAt":"now"}]"#, { try await $0.refreshTasks() }),
      ("/api/vault/notes", #"[{"path":"old.md"}]"#, { try await $0.refreshNotes() }),
      ("/api/routines", #"[{"id":"old","agentId":"a1","name":"Old","notePath":"old.md"}]"#, { try await $0.refreshRoutines() }),
      ("/api/skills", #"[{"id":"old","name":"Old"}]"#, { try await $0.refreshSkills() }),
      ("/api/connectors", #"[{"id":"old","name":"Old","kind":"mcp-http"}]"#, { try await $0.refreshConnectors() }),
      ("/api/me/sessions", #"[{"id":"old"}]"#, { try await $0.refreshSessions() }),
      ("/api/orgs", #"[{"id":"old","name":"Old","role":"member","members":1,"agents":0,"unread":false}]"#, { await $0.refreshOrgs() }),
      ("/api/channels/c1/messages", #"{"messages":[],"replyCounts":{}}"#, { try await $0.loadMessages("c1", thread: "root") })
    ]
    for (path, body, loader) in loaders {
      let store = makeStore()
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [ChatHTTPGate.self]
      let api = API(base: URL(string: "https://chat-session.test")!, token: "old", session: URLSession(configuration: configuration))
      store.api = api
      let load = Task { try await loader(store) }
      let pending = await ChatHTTPGate.next()
      XCTAssertEqual(pending.request.url?.path, path)
      store.signOut()
      var newer = api; newer.token = "new"
      store.api = newer
      store.phase = .ready
      pending.respond(body)
      do { try await load.value } catch { XCTAssertTrue(error is Store.Stale, "\(path): \(error)") }
      XCTAssertTrue(store.agents.isEmpty)
      XCTAssertTrue(store.nodes.isEmpty)
      XCTAssertTrue(store.tasks.isEmpty)
      XCTAssertTrue(store.notes.isEmpty)
      XCTAssertTrue(store.routines.isEmpty)
      XCTAssertTrue(store.skills.isEmpty)
      XCTAssertTrue(store.connectors.isEmpty)
      XCTAssertTrue(store.sessions.isEmpty)
      XCTAssertTrue(store.orgs.isEmpty)
      XCTAssertNil(store.threads["root"], path)
      XCTAssertFalse(store.noEarlierThreads.contains("root"), path)
    }
  }

  func testManagementBatchAndOldUnauthorizedReplyCannotChangeNewSession() async throws {
    let store = makeStore()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ChatHTTPGate.self]
    let api = API(base: URL(string: "https://chat-session.test")!, token: "old", session: URLSession(configuration: configuration))
    store.api = api
    let load = Task { try await store.refreshManagement() }
    var pending: [ChatHTTPGate] = []
    for _ in 0..<4 { pending.append(await ChatHTTPGate.next()) }
    store.signOut()
    var newer = api; newer.token = "new"
    store.api = newer
    store.phase = .ready
    for request in pending { request.respond("[]") }
    do { try await load.value; XCTFail("old management batch should throw") }
    catch { XCTAssertTrue(error is Store.Stale) }
    XCTAssertTrue(store.sections.isEmpty)
    XCTAssertTrue(store.members.isEmpty)
    let oldRequest = Task { try await store.refreshAgents() }
    let unauthorized = await ChatHTTPGate.next()
    store.signOut()
    store.api = api
    store.phase = .ready
    unauthorized.respond("{}", status: 401)
    do { try await oldRequest.value; XCTFail() } catch { XCTAssertTrue(error is Store.Stale) }
    XCTAssertEqual(store.api?.token, "old")
    XCTAssertEqual(store.phase, .ready)
    XCTAssertNil(store.sessionMessage)
  }

  func testReconnectRefreshesEveryEventDrivenCollection() async throws {
    let store = makeStore()
    for path in ["/api/agents", "/api/sections", "/api/nodes", "/api/teams", "/api/members", "/api/channels", "/api/computers", "/api/approvals", "/api/tasks", "/api/routines", "/api/vault/notes", "/api/changes", "/api/orgs"] {
      reply("GET", path, "[]")
    }
    reply("GET", "/api/me", #"{"kind":"user","user":{"id":"u1","email":"sam@example.test","name":"Sam"},"workspace":{"id":"w1","name":"Warren"}}"#)
    reply("GET", "/api/settings/lead", #"{"lead":null,"leadId":null}"#)
    store.openChannel = "c1"
    store.openThreads["root"] = "c1"
    store.backgrounds["a1"] = AgentBackground(notAllowed: "old")
    store.allowance = Allowance(todayTokens: 1, agents: [])
    store.profiles["me"] = MemoryProfile(person: .init(id: "u1", name: "Old"), level: "read", items: [])
    reply("GET", "/api/agents/a1/background", #"{"notAllowed":"new"}"#)
    reply("GET", "/api/background/allowance", #"{"todayTokens":2,"agents":[]}"#)
    reply("GET", "/api/memory/profile", #"{"person":{"id":"u1","name":"New"},"level":"read","items":[]}"#)
    reply("GET", "/api/channels/c1/messages", #"{"messages":[],"replyCounts":{}}"#)
    await store.refreshAfterReconnect()
    let paths = Set(ManagementHTTPStub.requests.withLock { $0.compactMap { $0.url?.path } })
    for path in ["/api/computers", "/api/approvals", "/api/tasks", "/api/settings/lead", "/api/routines", "/api/vault/notes", "/api/changes", "/api/channels/c1/messages", "/api/agents/a1/background", "/api/background/allowance", "/api/memory/profile"] {
      XCTAssertTrue(paths.contains(path), path)
    }
    XCTAssertNotNil(store.threads["root"])
    XCTAssertEqual(store.backgrounds["a1"]?.notAllowed, "new")
    XCTAssertEqual(store.allowance?.todayTokens, 2)
    XCTAssertEqual(store.profiles["me"]?.person.name, "New")
    XCTAssertNil(store.syncError)
    XCTAssertEqual(store.memoryVersion, 1)
    XCTAssertEqual(store.routinesVersion, 1)
    XCTAssertEqual(store.backgroundVersion, 1)
  }

}


/** A request gate: release responses only after the test has changed the session. */
private final class ChatHTTPGate: URLProtocol, @unchecked Sendable {
  private struct State {
    var queued: [ChatHTTPGate] = []
    var waiter: CheckedContinuation<Void, Never>?
  }
  private static let state = Mutex(State())
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "chat-session.test" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    if request.url?.path == "/api/auth/logout" { respond("{}"); return }
    let waiter = Self.state.withLock { state in
      let waiter = state.waiter
      state.queued.append(self)
      state.waiter = nil
      return waiter
    }
    waiter?.resume()
  }
  static func next() async -> ChatHTTPGate {
    await withCheckedContinuation { continuation in
      let ready = state.withLock { state in
        if !state.queued.isEmpty { return true }
        state.waiter = continuation
        return false
      }
      if ready { continuation.resume() }
    }
    return state.withLock { $0.queued.removeFirst() }
  }
  func respond(_ json: String, status: Int = 200) {
    let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(json.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
