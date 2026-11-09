import XCTest
@testable import Wisp

@MainActor
final class ChatParityTests: XCTestCase {
  private func agent(_ id: String, _ handle: String) -> Agent {
    try! Wire.decoder.decode(Agent.self, from: Data(#"{"id":"\#(id)","handle":"\#(handle)","name":"\#(handle.capitalized)","harness":"claude-code","status":"online"}"#.utf8))
  }
  private func command(_ name: String, kind: String = "skill", via: String = "prompt") -> AgentCommand {
    try! Wire.decoder.decode(AgentCommand.self, from: Data(#"{"name":"\#(name)","kind":"\#(kind)","via":"\#(via)"}"#.utf8))
  }

  func testSlashQueryParsing() {
    XCTAssertEqual(SlashQuery.parse("/"), .init(handle: nil, query: ""))
    XCTAssertEqual(SlashQuery.parse("/Comp"), .init(handle: nil, query: "comp"))
    XCTAssertEqual(SlashQuery.parse("  @Poopy /que"), .init(handle: "poopy", query: "que"))
    XCTAssertNil(SlashQuery.parse("hello /que"))
    XCTAssertNil(SlashQuery.parse("/compact now"))
    XCTAssertNil(SlashQuery.parse("@poopy"))
  }

  func testGroupsFilterByQueryAndAgentAndSortPrefixFirst() {
    let a = agent("a1", "atlas"), b = agent("b1", "nova")
    let lists = ["a1": [command("review"), command("preview"), command("compact")], "b1": [command("review-pr")]]
    let all = SlashMenu.groups(here: [a, b], lists: lists, only: nil, query: "rev")
    XCTAssertEqual(all.map(\.agent.id), ["a1", "b1"])
    XCTAssertEqual(all[0].items.map(\.name), ["review", "preview"])
    XCTAssertEqual(SlashMenu.groups(here: [a, b], lists: lists, only: "b1", query: "").map(\.agent.id), ["b1"])
    XCTAssertTrue(SlashMenu.groups(here: [a], lists: lists, only: nil, query: "zzz").isEmpty)
  }

  func testSlashSectionsFollowMenuOrderAndFallBackOnKind() throws {
    let a = agent("a1", "ghosty")
    let json = ##"""
    {"commands":[
      {"name":"order-pizza","description":"Order the usual","kind":"wisp-skill","via":"prompt","group":"learned","isNew":true,"learnedBy":"Ghosty"},
      {"name":"weekly-report","kind":"wisp-skill","via":"prompt","group":"learned","learnedBy":"Nova"},
      {"name":"review","kind":"command","via":"raw","group":"harness"},
      {"name":"model","kind":"wisp","via":"wisp","group":"wisp"},
      {"name":"docx","kind":"wisp-skill","via":"prompt","group":"skill"},
      {"name":"imagegen","kind":"skill","via":"prompt","group":"harness"}
    ]}
    """##
    struct R: Decodable { var commands: [AgentCommand] }
    let list = try Wire.decoder.decode(R.self, from: Data(json.utf8)).commands
    XCTAssertEqual(list[0].isNew, true)
    XCTAssertEqual(list[0].learnedBy, "Ghosty")
    XCTAssertNil(list[1].isNew)
    // hub order is kept inside a section; sections come learned, harness, wisp, skill
    let shuffled = [list[3], list[4], list[2], list[0], list[5], list[1]].map { SlashRow(agent: a, command: $0) }
    let sections = SlashMenu.sections(shuffled)
    XCTAssertEqual(sections.map(\.title), ["Learned by Ghosty", "Learned by Nova", "Claude Code", "Wisp", "Skills"])
    XCTAssertEqual(sections[2].rows.map(\.command.name), ["review", "imagegen"])
    // an older hub sends no group: it comes from the kind
    XCTAssertEqual(command("compact", kind: "command", via: "raw").section, "harness")
    XCTAssertEqual(command("context", kind: "wisp", via: "wisp").section, "wisp")
    XCTAssertEqual(command("pdf", kind: "wisp-skill").section, "skill")
    XCTAssertEqual(command("x", kind: "skill").section, "harness")
    XCTAssertEqual(SlashMenu.sections([SlashRow(agent: a, command: command("compact", kind: "command", via: "raw")), SlashRow(agent: a, command: command("model", kind: "wisp", via: "wisp"))]).map(\.title), ["Claude Code", "Wisp"])
  }

  func testSkillPartDecodes() throws {
    let message = try Wire.decoder.decode(Message.self, from: Data(##"{"id":"m1","channelId":"c1","author":{"kind":"agent","id":"a1"},"body":"Done.","parts":[{"type":"skill","action":"learned","skillId":"s1","slug":"order-pizza"},{"type":"skill","action":"used","skillId":"s2","slug":"weekly-report"},{"type":"skill","action":"used","skillId":"s3"}],"createdAt":"2026-10-29T10:00:00.000Z"}"##.utf8))
    XCTAssertEqual(message.parts[0], .skill(action: "learned", skillId: "s1", slug: "order-pizza"))
    XCTAssertEqual(message.parts[1], .skill(action: "used", skillId: "s2", slug: "weekly-report"))
    XCTAssertEqual(message.parts[2], .other("skill"))
  }

  func testAgentsHereAndInsertedText() {
    let a = agent("a1", "atlas"), b = agent("b1", "nova")
    XCTAssertEqual(SlashMenu.agentsHere(isDm: true, dmAgent: a, agents: [a, b], members: nil, handle: nil).map(\.id), ["a1"])
    XCTAssertEqual(SlashMenu.agentsHere(isDm: false, dmAgent: nil, agents: [a, b], members: ["b1"], handle: nil).map(\.id), ["b1"])
    XCTAssertEqual(SlashMenu.agentsHere(isDm: false, dmAgent: nil, agents: [a, b], members: [], handle: nil).map(\.id), ["a1", "b1"])
    XCTAssertEqual(SlashMenu.agentsHere(isDm: false, dmAgent: nil, agents: [a, b], members: ["b1"], handle: "atlas").map(\.id), ["a1"])
    XCTAssertEqual(SlashMenu.text(for: command("compact"), agent: a, isDm: true), "/compact ")
    XCTAssertEqual(SlashMenu.text(for: command("compact"), agent: a, isDm: false), "@atlas /compact ")
    let done = SlashMenu.replacing("/co", caret: 3, with: "/compact ")
    XCTAssertEqual(done.text, "/compact ")
    XCTAssertEqual(done.caret, 9)
  }

  func testLiveRunKeepsOnlyTheAgentsWords() {
    var run = LiveRun(id: "r1", agentId: "a1", channelId: "c1", threadId: nil)
    run.apply(type: "text", text: "Hel")
    run.apply(type: "text", text: "lo")
    XCTAssertEqual(run.text, "Hello")
    run.apply(type: "status", text: "started")
    run.apply(type: "status", text: "Planning")
    run.apply(type: "error", text: "boom")
    run.apply(type: "notice", text: "Ran /compact.")
    run.apply(type: "tool_call", text: nil, tool: "wisp.memory_search")
    run.apply(type: "tool_result", text: #"{"content":[{"type":"text","text":"agents/x"}]}"#)
    XCTAssertEqual(run.text, "Hello")
    XCTAssertEqual(run.tool, "wisp.memory_search")
  }

  func testStoreShowsToolsAsPlainActivity() {
    let store = Store(loadSession: false, persistToken: { _ in })
    store.agents = [agent("a1", "atlas")]
    store.messages["c1"] = []
    for (name, file) in [("wisp.memory_search", "null"), ("browser.browser_navigate", "null"), ("shell", "null"), ("wisp.file_upload", "null")] {
      store.handle(Data(#"{"type":"run_event","runId":"r1","agentId":"a1","channelId":"c1","threadId":null,"threadPath":[],"event":{"type":"tool_call","name":"\#(name)","file":\#(file)}}"#.utf8))
    }
    XCTAssertEqual(store.activitySteps["a1"], ["Searching memory", "Browsing", "Running a command", "Sending a file"])
    XCTAssertEqual(store.activity["a1"], "Sending a file")
    XCTAssertEqual(WorkLabel.of(tool: "shell", file: nil, activity: "Running a command"), "Running a command…")
    XCTAssertEqual(ActivityText.phrase("Using its computer"), "is using its computer")
    XCTAssertEqual(store.liveRuns["r1"]?.text ?? "", "")
  }

  func testStoreStreamsRunEventsAndClearsWhenReplyArrives() {
    let store = Store(loadSession: false, persistToken: { _ in })
    store.agents = [agent("a1", "atlas")]
    store.messages["c1"] = []
    func run(_ text: String, thread: String? = nil) {
      store.handle(Data(#"{"type":"run_event","runId":"r1","agentId":"a1","channelId":"c1","threadId":\#(thread.map { "\"\($0)\"" } ?? "null"),"threadPath":[],"event":{"type":"text","text":"\#(text)"}}"#.utf8))
    }
    run("Hi "); run("there")
    XCTAssertEqual(store.streaming(in: "c1", thread: nil).first?.text, "Hi there")
    XCTAssertTrue(store.streaming(in: "c1", thread: "t1").isEmpty)
    let reply = #"{"type":"message","message":{"id":"m9","channelId":"c1","author":{"kind":"agent","id":"a1"},"body":"Hi there","parts":[],"createdAt":"2026-10-22T10:00:00Z"}}"#
    store.handle(Data(reply.utf8))
    XCTAssertTrue(store.streaming(in: "c1", thread: nil).isEmpty)
  }

  func testStoreClearsStreamWhenAgentStopsAndOnReconnect() {
    let store = Store(loadSession: false, persistToken: { _ in })
    store.agents = [agent("a1", "atlas")]
    store.applyLive(runId: "r1", agentId: "a1", channelId: "c1", threadId: nil, type: "text", text: "x")
    store.handle(Data(#"{"type":"agent_status","agentId":"a1","status":"online"}"#.utf8))
    XCTAssertTrue(store.liveRuns.isEmpty)
    store.applyLive(runId: "r2", agentId: "a1", channelId: "c1", threadId: nil, type: "text", text: "x")
    store.handle(Data(#"{"type":"ready"}"#.utf8))
    XCTAssertTrue(store.liveRuns.isEmpty)
  }

  func testDraftsSaveLoadAndClear() {
    let defaults = UserDefaults(suiteName: "drafts-test-\(UUID().uuidString)")!
    let key = ComposerDrafts.key(channel: "c1", thread: nil)
    XCTAssertEqual(ComposerDrafts.key(channel: "c1", thread: "t1"), "c1/t/t1")
    XCTAssertEqual(ComposerDrafts.load(key, defaults: defaults), "")
    ComposerDrafts.save("half a thought", key: key, defaults: defaults)
    XCTAssertEqual(ComposerDrafts.load(key, defaults: defaults), "half a thought")
    XCTAssertEqual(ComposerDrafts.load("c1/t/t1", defaults: defaults), "")
    ComposerDrafts.save("  \n", key: key, defaults: defaults)
    XCTAssertEqual(ComposerDrafts.load(key, defaults: defaults), "")
  }

  func testDraftsKeepOnlyTheNewest() {
    let defaults = UserDefaults(suiteName: "drafts-test-\(UUID().uuidString)")!
    let start = Date()
    for i in 0..<(ComposerDrafts.limit + 5) { ComposerDrafts.save("d\(i)", key: "c\(i)", defaults: defaults, now: start.addingTimeInterval(Double(i))) }
    XCTAssertEqual(ComposerDrafts.all(defaults).count, ComposerDrafts.limit)
    XCTAssertEqual(ComposerDrafts.load("c0", defaults: defaults), "")
    XCTAssertEqual(ComposerDrafts.load("c\(ComposerDrafts.limit + 4)", defaults: defaults), "d\(ComposerDrafts.limit + 4)")
  }

  func testAccessAndContext() {
    XCTAssertEqual(AccessLevel(nil), .edit)
    XCTAssertEqual(AccessLevel("read-only"), .readOnly)
    XCTAssertEqual(AccessLevel("full").label, "Full access")
    let info = try! Wire.decoder.decode(AgentContextInfo.self, from: Data(#"{"harness":"codex","model":"m","effort":null,"access":"full","contextUsed":50000,"contextWindow":200000}"#.utf8))
    XCTAssertEqual(info.level, .full)
    XCTAssertEqual(info.fraction, 0.25)
    XCTAssertEqual(info.summary, "25% of context used")
    let empty = try! Wire.decoder.decode(AgentContextInfo.self, from: Data(#"{"access":"edit","contextUsed":null,"contextWindow":null}"#.utf8))
    XCTAssertNil(empty.fraction)
  }

  func testReactionMineAndApprovalNote() {
    let r = Reaction(emoji: "👍", actors: [Actor(kind: .user, id: "u1"), Actor(kind: .agent, id: "a1")])
    XCTAssertTrue(r.isMine("u1"))
    XCTAssertFalse(r.isMine("a1"))
    XCTAssertFalse(r.isMine(nil))
    let a = try! Wire.decoder.decode(Approval.self, from: Data(#"{"id":"p","agentId":"a","channelId":"c","summary":"s","details":"","status":"denied","note":"too risky","createdAt":"2026-10-22T10:00:00Z"}"#.utf8))
    XCTAssertEqual(ApprovalText.decided(a, by: "Sam"), "Sam denied this: “too risky”")
    var b = a; b.status = "approved"; b.note = ""
    XCTAssertEqual(ApprovalText.decided(b, by: nil), "Someone approved this.")
  }
}

@MainActor
final class ChatParityRequestTests: XCTestCase {
  private func makeStore() -> Store {
    ManagementHTTPStub.responses.withLock { $0 = [:] }; ManagementHTTPStub.requests.withLock { $0 = [] }
    let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [ManagementHTTPStub.self]
    let store = Store(loadSession: false, persistToken: { _ in })
    store.api = API(base: URL(string: "https://management.test")!, token: "test", session: URLSession(configuration: configuration))
    store.role = "member"; store.me = User(id: "u1", email: "sam@example.test", name: "Sam")
    store.channels = [try! Wire.decoder.decode(Channel.self, from: Data(#"{"id":"c1","name":"general","kind":"channel","topic":"","createdAt":"2026-10-22T10:00:00Z","pinnedIds":["m2"]}"#.utf8))]
    return store
  }
  private func msg(_ id: String) -> Message {
    try! Wire.decoder.decode(Message.self, from: Data(#"{"id":"\#(id)","channelId":"c1","author":{"kind":"user","id":"u2"},"body":"hi","parts":[],"createdAt":"2026-10-22T10:00:00Z"}"#.utf8))
  }

  func testToggleReactionPostsAndUpdatesMessage() async throws {
    let store = makeStore()
    store.messages["c1"] = [msg("m1")]
    ManagementHTTPStub.responses.withLock { $0["POST /api/messages/m1/reactions"] = (200, Data(#"{"added":true,"reactions":[{"emoji":"🎉","actors":[{"kind":"user","id":"u1"}]}]}"#.utf8)) }
    try await store.toggleReaction(msg("m1"), emoji: "🎉")
    XCTAssertEqual(store.messages["c1"]?.first?.reactions?.first?.emoji, "🎉")
    XCTAssertTrue(ManagementHTTPStub.requests.withLock { $0 }.contains { $0.httpMethod == "POST" && $0.url?.path == "/api/messages/m1/reactions" })
  }

  func testPinRulesAndRequests() async throws {
    let store = makeStore()
    XCTAssertTrue(store.canPin(msg("m1")))
    XCTAssertFalse(store.isPinned(msg("m1")))
    XCTAssertTrue(store.isPinned(msg("m2")))
    store.role = "guest"
    XCTAssertFalse(store.canPin(msg("m1")))
    store.role = "member"
    ManagementHTTPStub.responses.withLock { $0["PUT /api/messages/m1/pin"] = (200, Data("{}".utf8)); $0["DELETE /api/messages/m2/pin"] = (200, Data("{}".utf8)); $0["GET /api/channels"] = (200, Data("[]".utf8)) }
    try await store.setPinned(msg("m1"), true)
    try await store.setPinned(msg("m2"), false)
    let seen = ManagementHTTPStub.requests.withLock { $0 }
    XCTAssertTrue(seen.contains { $0.httpMethod == "PUT" && $0.url?.path == "/api/messages/m1/pin" })
    XCTAssertTrue(seen.contains { $0.httpMethod == "DELETE" && $0.url?.path == "/api/messages/m2/pin" })
  }
}
