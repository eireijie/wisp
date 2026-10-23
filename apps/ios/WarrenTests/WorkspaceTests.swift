import XCTest
@testable import Warren

@MainActor
final class WorkspaceTests: XCTestCase {
  private let task = ##"{"id":"t1","title":"Find venues","brief":"Three under $5k","status":"open","from":{"kind":"user","id":"u1"},"toAgentId":"a1","channelId":"c1","threadId":"m1","teamId":null,"reviewOf":null,"parentId":null,"result":null,"branch":null,"createdAt":"2026-10-18T12:00:00Z"}"##
  private let note = ##"{"path":"shared/hello.md","title":"Hello","tags":["work"],"links":["Plan"],"updatedAt":1792324800000,"content":"# Hello\n[[Plan]]","access":"edit","backlinks":[],"editedBy":"Sam","editedAt":"2026-10-18T12:00:00Z"}"##
  private let item = ##"{"path":"people/u1/preferences/short.md","kind":"preference","text":"Keep it short","by":"Nova","source":"Chat","messageId":"m1","channelId":"c1","created":"2026-10-18","updated":null,"pinned":true,"status":null,"due":null,"date":null}"##
  private let routine = ##"{"id":"r1","agentId":"a1","name":"Dinner ideas","notePath":"agents/a1/routines/dinner.md","schedule":"0 9 * * 1","timezone":"America/New_York","channelId":null,"enabled":true,"status":"ready","lastRunAt":null,"lastCompletedAt":null}"##
  private let background = ##"{"background":{"agentId":"a1","userId":"u1","enabled":true,"everyMinutes":60,"focus":"Inbox","quietStart":"22:00","quietEnd":"08:00","nextAt":null,"nextReason":"","lastAt":null,"lastNote":"","checking":false,"model":null,"effort":null,"dailyCap":24},"followups":[{"id":"f1","agentId":"a1","userId":"u1","dueAt":"2026-10-19T08:00:00Z","note":"Check replies","status":"pending"}],"notAllowed":null,"sources":[{"kind":"app","name":"Gmail","detail":"Connected"}],"usage":{"lastTokens":100,"todayTokens":200,"weekTokens":400,"checksToday":2,"capReached":false},"defaultDailyCap":24}"##
  private let skill = ##"{"id":"s1","name":"Meeting notes","description":"Use when meetings end","content":"# Notes","source":"custom","catalogId":null,"tags":["work"],"agentIds":["a1"]}"##
  private let connector = ##"{"id":"co1","name":"Notion","kind":"mcp-http","url":"https://mcp.notion.com/mcp","headers":{},"env":{"KEY":"••••1234"},"enabled":true,"agentIds":["a1"],"auth":{"required":true,"signedIn":false,"error":null},"warnings":[]}"##
  private let team = ##"{"id":"c1","name":"research","leads":["a1"],"leadId":"a1","reportsTo":null,"channelId":"c1","folder":"teams/research","repo":null,"baseBranch":"main","members":[{"agentId":"a1","role":"Lead","roleNotes":"Coordinate","lead":true,"managerId":null}]}"##
  private let storage = ##"{"path":"/data/vault","source":"setting","setting":"/data/vault","pendingRestart":false,"nextPath":"/data/vault","restartable":true,"previous":null,"moved":{"how":"copied","files":2},"sync":{"allowed":true,"reason":null,"urlPath":"/memory.git","branch":"main"},"tokens":[{"id":"vtk1","label":"Obsidian","createdAt":"2026-10-18","lastUsed":null}]}"##
  private let person = ##"{"id":"u1","name":"Sam","email":"sam@example.test","preferredName":null,"timezone":"UTC","role":"owner"}"##
  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T { try Wire.decoder.decode(type, from: Data(json.utf8)) }
  private func reply(_ method: String, _ path: String, _ json: String, status: Int = 200) {
    ManagementHTTPStub.responses.withLock { $0[method + " " + path] = (status, Data(json.utf8)) }
  }
  private func makeStore() -> Store {
    ManagementHTTPStub.responses.withLock { $0 = [:] }; ManagementHTTPStub.requests.withLock { $0 = [] }
    let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [ManagementHTTPStub.self]
    let store = Store(loadSession: false)
    store.api = API(base: URL(string: "https://management.test")!, token: "test", session: URLSession(configuration: configuration))
    store.role = "owner"; store.me = User(id: "u1", email: "sam@example.test", name: "Sam")
    reply("GET", "/api/channels", "[]"); reply("GET", "/api/vault/notes", "[\(note)]")
    return store
  }
  private func request(_ method: String, _ path: String) throws -> URLRequest {
    try XCTUnwrap(ManagementHTTPStub.requests.withLock { $0.last { $0.httpMethod == method && $0.url?.path == path } })
  }
  private func body(_ method: String, _ path: String) throws -> [String: Any] {
    let data = try XCTUnwrap(request(method, path).httpBody)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  func testTaskAndMemoryModels() throws {
    XCTAssertEqual(try decode(WorkTask.self, task).title, "Find venues")
    XCTAssertEqual(try decode(TaskMerge.self, "{\"output\":\"Merged\",\"task\":\(task)}").task?.id, "t1")
    XCTAssertEqual(try decode(WorkspaceLead.self, ##"{"lead":"a1","reason":"first"}"##).lead, "a1")
    XCTAssertEqual(try decode(UploadedFile.self, ##"{"id":"fi1","name":"brief.pdf","size":24,"mime":"application/pdf"}"##).size, 24)
    XCTAssertEqual(try decode(MemoryNote.self, note).links, ["Plan"])
    XCTAssertNil(try decode(MemoryNote.self, ##"{"path":"shared/search.md","title":"Search","snippet":"Found this"}"##).content)
    XCTAssertEqual(try decode(NoteRevision.self, ##"{"hash":"abc","author":"Sam","date":"2026-10-18","message":"Edit"}"##).id, "abc")
    XCTAssertNil(try decode(NoteResolution.self, ##"{"path":null}"##).path)
    XCTAssertEqual(try decode(NoteContent.self, ##"{"content":"old"}"##).content, "old")
    let profile = try decode(MemoryProfile.self, "{\"person\":{\"id\":\"u1\",\"name\":\"Sam\"},\"level\":\"manage\",\"items\":[\(item)]}")
    XCTAssertTrue(profile.editable); XCTAssertEqual(profile.items.first?.pinned, true)
    XCTAssertEqual(try decode(RememberResult.self, "{\"saved\":false,\"similar\":[\(item)]}").similar?.first?.text, "Keep it short")
    let access = try decode(MemoryAccess.self, ##"{"path":"shared","level":"manage","rules":[{"id":"ac1","path":"shared","subject":{"kind":"team","name":"research"},"level":"read","startup":true,"builtin":false}]}"##)
    XCTAssertEqual(access.rules?.first?.subject.name, "research")
    XCTAssertEqual(try decode(MemorySubject.self, ##"{"kind":"role","team":"research","role":"Lead"}"##).role, "Lead")
  }

  func testAutomationAndAppModels() throws {
    XCTAssertEqual(try decode(Routine.self, routine).schedule, "0 9 * * 1")
    XCTAssertEqual(try decode(RoutineRun.self, ##"{"ok":true,"channelId":"c1","messageId":"m1"}"##).messageId, "m1")
    let b = try decode(AgentBackground.self, background)
    XCTAssertEqual(b.background?.dailyCap, 24); XCTAssertEqual(b.followups?.first?.note, "Check replies")
    XCTAssertEqual(b.sources?.first?.kind, "app"); XCTAssertEqual(b.usage?.todayTokens, 200)
    XCTAssertNil(try decode(AgentBackground.self, ##"{"background":null,"followups":[],"notAllowed":"Private device","sources":[],"usage":{},"defaultDailyCap":24}"##).background)
    XCTAssertEqual(try decode(HelperSkill.self, skill).agentIds, ["a1"])
    let library: [HelperSkill] = try NativeCatalog.read("SkillCatalog", as: [HelperSkill].self)
    XCTAssertFalse(library.isEmpty); XCTAssertNotNil(library.first?.plain?.does)
    let catalog: [AppConnector] = try NativeCatalog.read("ConnectorCatalog", as: [AppConnector].self)
    XCTAssertFalse(catalog.isEmpty); XCTAssertTrue(catalog.contains { $0.fields?.isEmpty == false })
    XCTAssertEqual(try decode(AppConnector.self, connector).auth?.required, true)
    XCTAssertEqual(try decode(ConnectorSignIn.self, ##"{"url":"https://provider.test/oauth"}"##).url, "https://provider.test/oauth")
    let market = try decode(Marketplace.self, ##"{"featured":true,"entries":[{"id":"com.example/app","name":"App","description":"Read notes","publisher":"example.com","domain":"example.com","verified":true,"installs":[{"kind":"mcp-http","label":"Remote","url":"https://example.com/mcp","fields":[{"key":"KEY","label":"API key","secret":true,"optional":false,"hint":"Paste key"}]}]}]}"##)
    XCTAssertEqual(market.entries.first?.installs.first?.fields?.first?.key, "KEY")
  }

  func testWorkspaceModels() throws {
    XCTAssertEqual(try decode(WorkspaceTeam.self, team).members?.first?.roleNotes, "Coordinate")
    XCTAssertEqual(try decode(AccountSession.self, ##"{"id":"sess1","label":"Safari on iPhone","current":true,"createdAt":"2026-10-18","lastUsed":null}"##).current, true)
    XCTAssertEqual(try decode(WorkspaceInvite.self, ##"{"id":"i1","role":"guest","code":"one-time","expiresAt":"2026-10-25"}"##).code, "one-time")
    XCTAssertEqual(try decode(AgentPolicy.self, ##"{"askBefore":["send","spend"],"maxHops":6,"maxRunsPerMinute":20,"defaultAccess":"edit"}"##).maxHops, 6)
    let memory = try decode(MemoryStorage.self, storage)
    XCTAssertEqual(memory.tokens?.first?.label, "Obsidian"); XCTAssertEqual(memory.moved?.files, 2); XCTAssertEqual(memory.sync?.branch, "main")
    XCTAssertEqual(try decode(MemoryToken.self, ##"{"id":"vtk2","token":"secret-once"}"##).token, "secret-once")
    XCTAssertEqual(try decode(DeviceRegistration.self, ##"{"node":{"id":"n1"},"token":"node-token"}"##).token, "node-token")
    XCTAssertEqual(try decode(HarnessInstall.self, ##"{"ok":true,"output":"Installed"}"##).ok, true)
    XCTAssertEqual(try decode(AgentConnection.self, ##"{"id":"cn1","agentId":"a1","kind":"harness","device":"Mac","lastUsed":null}"##).device, "Mac")
    XCTAssertEqual(try decode(ComputerDefaults.self, ##"{"orgo":{"configured":true,"hint":"…1234"},"defaults":{"vmSize":"medium","controlIdleMinutes":10}}"##).defaults.vmSize, "medium")
    XCTAssertEqual(try decode(ExportInfo.self, ##"{"dataDir":"/data","notes":5,"messages":8,"files":2,"agents":1}"##).notes, 5)
    XCTAssertEqual(try decode(VoicePreferences.self, ##"{"listen":"device","speak":"openai","openaiKey":"••••","elevenlabsKey":""}"##).speak, "openai")
    XCTAssertEqual(try decode(AgentNode.self, ##"{"id":"n1","name":"Mac","online":true,"mine":true,"shared":false,"paused":false,"lastSeen":null,"agents":["nova"],"harnesses":[{"id":"codex","version":"1"}]}"##).agents, ["nova"])
  }

  func testGuidedTextAndUpdateModel() throws {
    XCTAssertEqual(GuideText.routineName("", goal: "Send dinner ideas. Include a list."), "Send dinner ideas")
    XCTAssertEqual(GuideText.routineSteps(goal: "Plan dinner", steps: "Check the fridge"), "Goal: Plan dinner\n\nCheck the fridge")
    let skill = GuideText.skill(name: "Meeting notes", what: "Summarize", when: "Meetings end", result: "Decisions")
    XCTAssertEqual(skill.description, "Use when meetings end")
    XCTAssertTrue(skill.content.contains("## What a good result looks like\nDecisions"))
    let update = try decode(HubUpdate.self, ##"{"version":{"commit":"abc","date":"2026-10-18"},"check":{"behind":1,"changes":["abc Fix"],"canUpdate":true,"reason":"One update"},"update":{"state":"idle","message":"","log":[]}}"##)
    XCTAssertEqual(update.version?.commit, "abc"); XCTAssertEqual(update.check?.canUpdate, true)
  }

  func testTaskRoundTrip() async throws {
    let store = makeStore()
    reply("POST", "/api/tasks", task)
    let created = try await store.createTask(["to": AnyEncodable("auto"), "title": AnyEncodable("Find venues"), "brief": AnyEncodable("Three under $5k"), "fileIds": AnyEncodable(["fi1"])])
    XCTAssertEqual(store.tasks.first?.id, created.id)
    XCTAssertEqual(try body("POST", "/api/tasks")["fileIds"] as? [String], ["fi1"])
    reply("PATCH", "/api/tasks/t1", task.replacingOccurrences(of: "\"open\"", with: "\"done\""))
    try await store.updateTask("t1", status: "done", result: "Three found")
    XCTAssertTrue(store.tasks[0].closed)
    XCTAssertEqual(try body("PATCH", "/api/tasks/t1")["result"] as? String, "Three found")
  }

  func testMemoryRoundTripAndQueryEncoding() async throws {
    let store = makeStore(); reply("PUT", "/api/vault/note", note)
    try await store.saveNote(path: "shared/hello.md", content: "# Hello", message: "Edit hello")
    XCTAssertEqual(store.notes.first?.path, "shared/hello.md")
    XCTAssertEqual(try body("PUT", "/api/vault/note")["message"] as? String, "Edit hello")
    reply("DELETE", "/api/vault/note", ##"{"ok":true}"##)
    try await store.deleteNote("shared/hello.md")
    XCTAssertTrue(store.notes.isEmpty)
    XCTAssertEqual(URLComponents(url: try XCTUnwrap(request("DELETE", "/api/vault/note").url), resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "shared/hello.md")
    reply("GET", "/api/vault/resolve", ##"{"path":"shared/hello.md"}"##)
    let resolved = try await store.resolveNote("Hello & world", from: "shared/start.md")
    XCTAssertEqual(resolved, "shared/hello.md")
    let query = URLComponents(url: try XCTUnwrap(request("GET", "/api/vault/resolve").url), resolvingAgainstBaseURL: false)?.queryItems
    XCTAssertEqual(query?.first { $0.name == "target" }?.value, "Hello & world")
  }

  func testAboutRoundTripAndDuplicateMessage() async throws {
    let store = makeStore()
    reply("GET", "/api/memory/profile", "{\"person\":{\"id\":\"u1\",\"name\":\"Sam\"},\"level\":\"manage\",\"items\":[\(item)]}")
    reply("POST", "/api/memory/remember", ##"{"saved":true}"##)
    try await store.remember(["kind": AnyEncodable("preference"), "text": AnyEncodable("Keep it short")])
    XCTAssertEqual(store.profiles["me"]?.items.first?.text, "Keep it short")
    XCTAssertEqual(try body("POST", "/api/memory/remember")["about"] as? String, "me")
    reply("POST", "/api/memory/remember", "{\"saved\":false,\"similar\":[\(item)]}")
    do { try await store.remember(["kind": AnyEncodable("preference")]); XCTFail("Expected duplicate") }
    catch { XCTAssertTrue(error.localizedDescription.contains("Edit that one instead")) }
  }

  func testRoutinesAndBackgroundRoundTrips() async throws {
    let store = makeStore(); reply("POST", "/api/routines", routine)
    try await store.saveRoutine(nil, fields: ["agentId": AnyEncodable("a1"), "name": AnyEncodable("Dinner ideas"), "schedule": .null, "timezone": AnyEncodable("UTC")], steps: "Suggest dinner")
    XCTAssertEqual(store.routines.first?.name, "Dinner ideas")
    XCTAssertEqual(try body("POST", "/api/routines")["steps"] as? String, "Suggest dinner")
    reply("PUT", "/api/agents/a1/background", ##"{"background":null}"##); reply("GET", "/api/agents/a1/background", background)
    try await store.saveBackground("a1", ["enabled": AnyEncodable(true), "dailyCap": .null])
    XCTAssertEqual(store.backgrounds["a1"]?.background?.enabled, true)
    XCTAssertTrue(try body("PUT", "/api/agents/a1/background")["dailyCap"] is NSNull)
  }

  func testSkillsAndConnectorsRoundTrips() async throws {
    let store = makeStore(); reply("POST", "/api/skills", skill)
    try await store.saveSkill(nil, ["name": AnyEncodable("Meeting notes"), "content": AnyEncodable("# Notes"), "agentIds": AnyEncodable(["a1"])])
    XCTAssertEqual(store.skills.first?.agentIds, ["a1"])
    XCTAssertEqual(try body("POST", "/api/skills")["content"] as? String, "# Notes")
    reply("PATCH", "/api/connectors/co1", connector)
    try await store.saveConnector("co1", ["env": AnyEncodable(["KEY": "••••1234"]), "agentIds": AnyEncodable(["a1"])])
    XCTAssertEqual(store.connectors.first?.name, "Notion")
    XCTAssertEqual(try body("PATCH", "/api/connectors/co1")["env"] as? [String: String], ["KEY": "••••1234"])
    reply("POST", "/api/connectors/co1/signin", ##"{"url":"https://provider.test/oauth"}"##)
    let url = try await store.connectorSignIn("co1")
    XCTAssertEqual(url?.host, "provider.test")
    XCTAssertEqual(try body("POST", "/api/connectors/co1/signin")["origin"] as? String, "https://management.test")
  }

  func testTeamsAndDevicesRoundTrips() async throws {
    let store = makeStore(); reply("GET", "/api/teams", "[\(team)]")
    try await store.refreshTeams()
    XCTAssertEqual(store.teams.first?.channelId, "c1")
    XCTAssertEqual(store.teams.first?.leads, ["a1"])
    reply("PATCH", "/api/nodes/n1", ##"{"ok":true}"##)
    reply("GET", "/api/nodes", ##"[{"id":"n1","name":"Mac","online":true,"mine":true,"shared":true}]"##)
    try await store.updateNode("n1", ["shared": AnyEncodable(true)])
    XCTAssertEqual(store.nodes.first?.shared, true)
    XCTAssertEqual(try body("PATCH", "/api/nodes/n1")["shared"] as? Bool, true)
  }

  func testAccountWorkspacePeopleStorageRoundTrips() async throws {
    let store = makeStore(); reply("PATCH", "/api/me", person)
    try await store.saveProfile(["name": AnyEncodable("Sam"), "preferredName": .null])
    XCTAssertEqual(store.me?.timezone, "UTC"); XCTAssertTrue(try body("PATCH", "/api/me")["preferredName"] is NSNull)
    reply("PUT", "/api/me/prefs", ##"{"experience":"simple","clock":"auto","sendWith":"enter","toolCalls":"collapsed"}"##)
    try await store.savePrefs(["experience": AnyEncodable("simple")]); XCTAssertTrue(store.simple)
    XCTAssertEqual(try body("PUT", "/api/me/prefs")["experience"] as? String, "simple")
    reply("PATCH", "/api/workspace", ##"{"id":"w1","name":"Studio"}"##)
    try await store.renameWorkspace("Studio"); XCTAssertEqual(store.workspace?.name, "Studio")
    XCTAssertEqual(try body("PATCH", "/api/workspace")["name"] as? String, "Studio")
    store.members = [try decode(Member.self, person)]
    reply("PATCH", "/api/members/u1", person.replacingOccurrences(of: "owner", with: "member"))
    try await store.updateMember("u1", role: "member"); XCTAssertEqual(store.members[0].role, "member"); XCTAssertEqual(store.role, "member")
    XCTAssertEqual(try body("PATCH", "/api/members/u1")["role"] as? String, "member")
    reply("PUT", "/api/memory/storage", storage)
    try await store.saveMemoryStorage("/data/vault"); XCTAssertEqual(store.memoryStorage?.path, "/data/vault")
    XCTAssertEqual(try body("PUT", "/api/memory/storage")["path"] as? String, "/data/vault")
    reply("PUT", "/api/settings/agents", ##"{"askBefore":["send"],"maxHops":4,"maxRunsPerMinute":10,"defaultAccess":"read-only"}"##)
    try await store.saveAgentPolicy(AgentPolicy(askBefore: ["send"], maxHops: 4, maxRunsPerMinute: 10, defaultAccess: "read-only"))
    XCTAssertEqual(store.agentPolicy?.maxHops, 4)
    XCTAssertEqual(try body("PUT", "/api/settings/agents")["defaultAccess"] as? String, "read-only")
  }

  func testForbiddenMutationKeepsStateAndLiveEventsRefresh() async throws {
    let store = makeStore(); store.notes = [try decode(MemoryNote.self, note)]
    reply("DELETE", "/api/vault/note", ##"{"error":"You don't have permission to edit this note."}"##, status: 403)
    do { try await store.deleteNote("shared/hello.md"); XCTFail("Expected denied") }
    catch { XCTAssertEqual(error.localizedDescription, "You don't have permission to edit this note.") }
    XCTAssertEqual(store.notes.count, 1)
    reply("GET", "/api/tasks", "[\(task)]"); reply("GET", "/api/routines", "[\(routine)]")
    reply("GET", "/api/agents/a1/background", background)
    reply("GET", "/api/settings/lead", ##"{"lead":"a1","leadId":null}"##)
    store.backgrounds["a1"] = try decode(AgentBackground.self, ##"{"background":null}"##)
    store.handle(Data(##"{"type":"tasks_changed"}"##.utf8))
    store.handle(Data(##"{"type":"routines_changed"}"##.utf8))
    store.handle(Data(##"{"type":"background_changed","agentId":"a1"}"##.utf8))
    store.handle(Data(##"{"type":"memory_changed"}"##.utf8))
    store.handle(Data(##"{"type":"lead_changed"}"##.utf8))
    for _ in 0..<50 {
      if !store.tasks.isEmpty && !store.routines.isEmpty && store.backgrounds["a1"]?.background != nil && store.taskLead == "a1" { break }
      try await Task.sleep(for: .milliseconds(20))
    }
    XCTAssertEqual(store.tasks.count, 1); XCTAssertEqual(store.routines.count, 1)
    XCTAssertEqual(store.backgrounds["a1"]?.background?.enabled, true); XCTAssertEqual(store.memoryVersion, 1)
    XCTAssertEqual(store.taskLead, "a1")
  }

  func testAddPersonAndInviteRoundTrip() async throws {
    let store = makeStore()
    reply("POST", "/api/members", person)
    reply("GET", "/api/members", "[\(person)]"); reply("GET", "/api/invites", "[]")
    try await store.addPerson(["name": AnyEncodable("Sam"), "email": AnyEncodable("sam@example.test"), "password": AnyEncodable("temporary-pass"), "role": AnyEncodable("member")])
    XCTAssertEqual(store.members.first?.name, "Sam")
    XCTAssertEqual(try body("POST", "/api/members")["role"] as? String, "member")
    reply("POST", "/api/invites", ##"{"id":"i1","role":"guest","code":"once","expiresAt":"2026-10-25"}"##)
    let invite = try await store.createInvite(role: "guest", days: 7)
    XCTAssertEqual(invite.code, "once"); XCTAssertEqual(store.invites.first?.id, "i1")
    XCTAssertEqual(try body("POST", "/api/invites")["days"] as? Int, 7)
  }
}
