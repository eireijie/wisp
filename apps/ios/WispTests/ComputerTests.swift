import XCTest
@testable import Wisp

@MainActor
final class ComputerTests: XCTestCase {
  private let vmJSON = ##"{"id":"c1","name":"Desk","kind":"vm","nodeId":"n1","status":"ready","statusText":"","online":true,"ownerId":null,"paused":false,"code":null,"transport":"vnc","agents":["a1"],"activity":{"agentId":"a1","text":"Opened Chrome","at":"2026-10-25T10:00:00.000Z"},"controller":null,"help":null}"##
  private let agentJSON = ##"{"id":"a1","name":"Darnold","handle":"darnold","harness":"codex","model":null,"nodeId":"n1","computerId":"c1","groups":[],"settings":{},"status":"online"}"##

  private func node(_ id: String, mine: Bool = true, shared: Bool = false, online: Bool = true, vm: String = #"{"ok":true,"detail":""}"#) throws -> AgentNode {
    let json = #"{"id":"\#(id)","name":"Mac \#(id)","mine":\#(mine),"shared":\#(shared),"online":\#(online),"capabilities":{"platform":"darwin","screen":{"ok":true},"vm":\#(vm)}}"#
    return try Wire.decoder.decode(AgentNode.self, from: Data(json.utf8))
  }

  private func makeStore() throws -> Store {
    ManagementHTTPStub.responses.withLock { $0 = [:] }
    ManagementHTTPStub.requests.withLock { $0 = [] }
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [ManagementHTTPStub.self]
    let store = Store(loadSession: false)
    store.api = API(base: URL(string: "https://management.test")!, token: "test", session: URLSession(configuration: config))
    store.role = "owner"
    store.me = User(id: "u1", email: "o@example.test", name: "You")
    store.computers = [try Wire.decoder.decode(Computer.self, from: Data(vmJSON.utf8))]
    store.agents = [try Wire.decoder.decode(Agent.self, from: Data(agentJSON.utf8))]
    return store
  }

  private func reply(_ method: String, _ path: String, _ json: String, status: Int = 200) {
    ManagementHTTPStub.responses.withLock { $0[method + " " + path] = (status, Data(json.utf8)) }
  }

  private func sentRequests(_ method: String, _ path: String) -> [URLRequest] {
    ManagementHTTPStub.requests.withLock { $0 }.filter { $0.httpMethod == method && $0.url?.path == path }
  }

  private func sentBody(_ method: String, _ path: String) -> [String: Any]? {
    sentRequests(method, path).last?.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
  }

  // MARK: decoding

  func testComputerDecodesWhatTheDetailsNeed() throws {
    let c = try Wire.decoder.decode(Computer.self, from: Data(vmJSON.utf8))
    XCTAssertEqual(c.agentIds, ["a1"])
    XCTAssertEqual(c.activity?.text, "Opened Chrome")
    XCTAssertTrue(c.canTransfer)
  }

  func testOlderHubWithoutTheNewFieldsStillDecodes() throws {
    let c = try Wire.decoder.decode(Computer.self, from: Data(#"{"id":"c","name":"X","kind":"orgo","status":"offline","statusText":""}"#.utf8))
    XCTAssertEqual(c.agentIds, [])
    XCTAssertFalse(c.isOnline)
    XCTAssertFalse(c.canTransfer)
  }

  func testPausedComputerCannotTransfer() throws {
    var c = try Wire.decoder.decode(Computer.self, from: Data(vmJSON.utf8))
    c.paused = true
    XCTAssertFalse(c.canTransfer)
  }

  func testLogEntryDecodes() throws {
    let list = try Wire.decoder.decode([ComputerLogEntry].self, from: Data(#"[{"actor":{"kind":"agent","id":"a1"},"text":"Clicked","at":"2026-10-25T10:00:00.000Z"},{"actor":{"kind":"user","id":"system"},"text":"Wrong PIN","at":"2026-10-25T10:01:00.000Z"}]"#.utf8))
    XCTAssertEqual(list.count, 2)
    XCTAssertEqual(list[1].actor.id, "system")
    XCTAssertEqual(ComputerDetailsView.lowered("Handed it back"), "handed it back")
  }

  // MARK: the add form

  func testNewVMUsesSizeAndDefaultName() throws {
    let body = NewComputer.make(kind: .vm, nodeId: "n1", deviceName: "Studio", name: "  ", size: .large, existingOrgo: "")
    XCTAssertEqual(body, NewComputer(kind: "vm", nodeId: "n1", name: "Studio desktop", cpus: 4, memoryGb: 8))
    let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any]
    XCTAssertEqual(json?["cpus"] as? Int, 4)
    XCTAssertNil(json?["ram"])
  }

  func testOwnScreenSendsOnlyTheDeviceAndName() throws {
    let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(NewComputer.make(kind: .device, nodeId: "n1", deviceName: "Mac", name: "", size: .small, existingOrgo: ""))) as? [String: Any]
    XCTAssertEqual(json?["kind"] as? String, "device")
    XCTAssertEqual(json?["nodeId"] as? String, "n1")
    XCTAssertNil(json?["name"])
    XCTAssertNil(json?["cpus"])
  }

  func testOrgoNewAndExisting() throws {
    XCTAssertEqual(NewComputer.make(kind: .orgo, nodeId: "", deviceName: nil, name: "", size: .medium, existingOrgo: ""), NewComputer(kind: "orgo", name: "Cloud computer", ram: 8, cpu: 2))
    let id = "3f1c2a3e-1111-4222-8333-444455556666"
    let existing = NewComputer.make(kind: .orgo, nodeId: "", deviceName: nil, name: "Mine", size: .medium, existingOrgo: " \(id) ")
    XCTAssertEqual(existing, NewComputer(kind: "orgo", name: "Mine", computerId: id))
  }

  func testSizeLabels() {
    XCTAssertEqual(ComputerSize.small.label(for: .vm), "Small: 1 CPU, 2 GB")
    XCTAssertEqual(ComputerSize.large.label(for: .orgo), "Large: 4 CPUs, 16 GB")
  }

  func testVMNoteExplainsWhyNot() throws {
    XCTAssertNil(ComputerAdd.vmNote([try node("1")]))
    XCTAssertEqual(ComputerAdd.vmNote([]), "Connect a device first.")
    XCTAssertTrue(ComputerAdd.vmNote([try node("1", online: false, vm: #"{"ok":false,"detail":""}"#)])!.contains("disconnected"))
    let refused = try node("1", vm: #"{"ok":false,"detail":"Docker isn't installed."}"#)
    XCTAssertEqual(ComputerAdd.vmNote([refused]), "Mac 1: Docker isn't installed.")
    XCTAssertEqual(ComputerAdd.list(["A", "B", "C"]), "A, B, and C")
  }

  func testOnlyYourDevicesAndSharedOnesAreUsable() throws {
    let nodes = [try node("1"), try node("2", mine: false), try node("3", mine: false, shared: true)]
    XCTAssertEqual(ComputerAdd.usable(nodes).map(\.id), ["1", "3"])
  }

  func testAddComputerPostsAndKeepsIt() async throws {
    let store = try makeStore()
    store.computers = []
    reply("POST", "/api/computers", vmJSON)
    let c = try await store.addComputer(NewComputer(kind: "vm", nodeId: "n1", name: "Desk", cpus: 2, memoryGb: 4))
    XCTAssertEqual(c.id, "c1")
    XCTAssertEqual(store.computers.map(\.id), ["c1"])
    XCTAssertEqual(sentBody("POST", "/api/computers")?["memoryGb"] as? Int, 4)
  }

  // MARK: roles

  func testWhoCanRemove() throws {
    let vm = try Wire.decoder.decode(Computer.self, from: Data(vmJSON.utf8))
    let mine = [try node("n1")], notMine = [try node("n1", mine: false, shared: true)]
    XCTAssertTrue(ComputerRights.canRemove(vm, userId: "u1", role: "owner", nodes: notMine))
    XCTAssertTrue(ComputerRights.canRemove(vm, userId: "u1", role: "member", nodes: mine))
    XCTAssertFalse(ComputerRights.canRemove(vm, userId: "u1", role: "member", nodes: notMine))
    var screen = vm; screen.kind = "device"; screen.ownerId = "u1"
    XCTAssertTrue(ComputerRights.canRemove(screen, userId: "u1", role: "member", nodes: []))
    XCTAssertFalse(ComputerRights.canRemove(screen, userId: "u2", role: "owner", nodes: []))
    var cloud = vm; cloud.kind = "orgo"
    XCTAssertTrue(ComputerRights.canRemove(cloud, userId: "u2", role: "member", nodes: []))
  }

  // MARK: rename, start, stop, remove, hand back

  func testRenameStartStopRemove() async throws {
    let store = try makeStore()
    let c = store.computers[0]
    reply("PATCH", "/api/computers/c1", vmJSON.replacingOccurrences(of: "\"Desk\"", with: "\"Studio\""))
    try await store.renameComputer(c, to: "Studio")
    XCTAssertEqual(store.computers[0].name, "Studio")
    XCTAssertEqual(sentBody("PATCH", "/api/computers/c1")?["name"] as? String, "Studio")

    reply("POST", "/api/computers/c1/stop", vmJSON.replacingOccurrences(of: "\"ready\"", with: "\"stopped\""))
    try await store.setComputerRunning(c, false)
    XCTAssertEqual(store.computers[0].status, "stopped")
    reply("POST", "/api/computers/c1/start", vmJSON.replacingOccurrences(of: "\"ready\"", with: "\"starting\""))
    try await store.setComputerRunning(c, true)
    XCTAssertEqual(store.computers[0].status, "starting")

    reply("DELETE", "/api/computers/c1", #"{"ok":true}"#)
    try await store.removeComputer(c)
    XCTAssertTrue(store.computers.isEmpty)
  }

  func testHandBackSendsTheNoteOnlyWhenThereIsOne() async throws {
    let store = try makeStore()
    reply("POST", "/api/computers/c1/control", vmJSON)
    try await store.handBack(store.computers[0], note: "  Signed in for you  ")
    XCTAssertEqual(sentBody("POST", "/api/computers/c1/control")?["note"] as? String, "Signed in for you")
    XCTAssertEqual(sentBody("POST", "/api/computers/c1/control")?["take"] as? Bool, false)
    try await store.handBack(store.computers[0], note: "   ")
    XCTAssertNil(sentBody("POST", "/api/computers/c1/control")?["note"])
  }

  func testOpenOnComputerSendsTheOpenAction() async throws {
    let store = try makeStore()
    reply("POST", "/api/computers/c1/act", "{}")
    try await store.openOnComputer(store.computers[0], target: "https://example.com")
    let action = sentBody("POST", "/api/computers/c1/act")?["action"] as? [String: Any]
    XCTAssertEqual(action?["action"] as? String, "open")
    XCTAssertEqual(action?["target"] as? String, "https://example.com")
  }

  func testWebLinks() {
    XCTAssertTrue(isWebLink("https://example.com/a?b=1"))
    XCTAssertTrue(isWebLink(" http://localhost:3000 "))
    XCTAssertFalse(isWebLink("example.com"))
    XCTAssertFalse(isWebLink("javascript:alert(1)"))
    XCTAssertFalse(isWebLink("https://a.com and more"))
    XCTAssertFalse(isWebLink("file:///etc/passwd"))
  }

  // MARK: files

  private let folderJSON = ##"{"path":"/home/me/Documents","parent":"/home/me","home":"/home/me","entries":[{"name":"b.txt","dir":false,"size":2048,"modified":null},{"name":".secret","dir":false,"size":1,"modified":null},{"name":"Reports","dir":true,"size":0,"modified":"2026-10-01T00:00:00.000Z"},{"name":"a.txt","dir":false,"size":10,"modified":null}]}"##

  func testFolderListing() throws {
    let f = try Wire.decoder.decode(RemoteFolder.self, from: Data(folderJSON.utf8))
    XCTAssertEqual(f.shown(hidden: false).map(\.name), ["Reports", "a.txt", "b.txt"])
    XCTAssertEqual(f.shown(hidden: true).map(\.name), ["Reports", ".secret", "a.txt", "b.txt"])
    XCTAssertEqual(f.hiddenCount, 1)
    XCTAssertEqual(f.join("a.txt"), "/home/me/Documents/a.txt")
    XCTAssertEqual(f.crumbs, "Home / Documents")
  }

  func testWindowsPathsJoinWithBackslashes() {
    let f = RemoteFolder(path: "C:\\Users\\me", parent: "C:\\Users", home: "C:\\Users\\me", entries: [])
    XCTAssertEqual(f.join("x.txt"), "C:\\Users\\me\\x.txt")
    XCTAssertEqual(f.crumbs, "Home")
  }

  func testListFilesAsksForThePath() async throws {
    let store = try makeStore()
    reply("GET", "/api/computers/c1/files", folderJSON)
    let f = try await store.listFiles(store.computers[0], path: "~/Documents")
    XCTAssertEqual(f.entries.count, 4)
    XCTAssertEqual(sentRequests("GET", "/api/computers/c1/files").last?.url?.query, "path=~/Documents")
  }

  func testUploadSendsTheFileWithItsNameAndFolder() async throws {
    let store = try makeStore()
    reply("POST", "/api/computers/c1/files", #"{"path":"/home/me/Desktop/my file.txt"}"#)
    let landed = try await store.uploadRemoteFile(store.computers[0], folder: "~/Desktop", name: "my file.txt", data: Data("hi".utf8))
    XCTAssertEqual(landed, "/home/me/Desktop/my file.txt")
    let req = try XCTUnwrap(sentRequests("POST", "/api/computers/c1/files").last)
    XCTAssertEqual(req.httpBody, Data("hi".utf8))
    XCTAssertEqual(req.value(forHTTPHeaderField: "content-type"), "application/octet-stream")
    XCTAssertEqual(req.value(forHTTPHeaderField: "x-filename"), "my%20file%2Etxt")
    XCTAssertTrue(req.url?.query?.contains("folder=~/Desktop") == true)
  }

  func testUploadRefusesAFileOverTheLimit() async throws {
    let store = try makeStore()
    do {
      _ = try await store.uploadRemoteFile(store.computers[0], folder: "~", name: "big.bin", data: Data(count: ComputerFileLimits.maxBytes + 1))
      XCTFail("should have refused")
    } catch let f as API.Failure {
      XCTAssertTrue(f.message.contains("50 MB"))
    }
    XCTAssertTrue(sentRequests("POST", "/api/computers/c1/files").isEmpty)
  }

  func testDownloadKeepsTheFileName() async throws {
    let store = try makeStore()
    reply("GET", "/api/computers/c1/files/download", "file contents")
    let url = try await store.downloadRemoteFile(store.computers[0], path: "/home/me/Documents/notes.txt")
    XCTAssertEqual(url.lastPathComponent, "notes.txt")
    XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "file contents")
  }

  func testNewFolder() async throws {
    let store = try makeStore()
    reply("POST", "/api/computers/c1/files/folder", #"{"path":"/x"}"#)
    try await store.makeRemoteFolder(store.computers[0], in: "~/Desktop", name: "Receipts")
    XCTAssertEqual(sentBody("POST", "/api/computers/c1/files/folder")?["folder"] as? String, "~/Desktop")
    XCTAssertEqual(sentBody("POST", "/api/computers/c1/files/folder")?["name"] as? String, "Receipts")
  }

  func testScreenshotFileIsNamedByComputerAndTime() async throws {
    let store = try makeStore()
    reply("GET", "/api/computers/c1/screen", "jpegbytes")
    let url = try await store.screenshotFile(store.computers[0])
    XCTAssertTrue(url.lastPathComponent.hasPrefix("Desk 20"))
    XCTAssertEqual(url.pathExtension, "jpg")
  }

  // MARK: teaching

  func testRecordingTakesPicturesOnlyForClicksAndEnter() {
    var r = TeachRecording()
    r.add(kind: "click", x: 10, y: 20, snapshot: Data([1]))
    r.add(kind: "type", text: "hello", snapshot: Data([2]))
    r.add(kind: "key", keys: "Enter", snapshot: Data([3]))
    r.add(kind: "key", keys: "Tab", snapshot: Data([4]))
    r.add(kind: "scroll", x: 1, y: 2, direction: "down", snapshot: Data([5]))
    XCTAssertEqual(r.items.map { $0.snapshot != nil }, [true, false, true, false, false])
    XCTAssertEqual(r.count, 5)
    XCTAssertEqual(r.steps[1].text, "hello")
  }

  func testRecordingStopsTakingPicturesAtTheLimit() {
    var r = TeachRecording()
    for _ in 0..<(TeachRecording.maxSnapshots + 5) { r.add(kind: "click", x: 1, y: 1, snapshot: Data([1])) }
    XCTAssertEqual(r.items.filter { $0.snapshot != nil }.count, TeachRecording.maxSnapshots)
    XCTAssertEqual(r.count, TeachRecording.maxSnapshots + 5)
  }

  func testRecordingStopsAtTheHubsStepLimit() {
    var r = TeachRecording()
    for _ in 0..<TeachRecording.maxSteps { r.add(kind: "key", keys: "Tab") }
    XCTAssertNil(r.add(kind: "key", keys: "Tab"))
    XCTAssertEqual(r.count, TeachRecording.maxSteps)
  }

  func testStepTimesAndElements() {
    let start = Date(timeIntervalSince1970: 1000)
    var r = TeachRecording(started: start)
    let i = r.add(kind: "click", x: 5, y: 6, now: start.addingTimeInterval(2.5))!
    XCTAssertEqual(r.steps[i].at, 2500)
    r.setElement(TaughtElement(url: "https://x.test", title: nil, role: "button", name: "Export", selector: "#go"), at: i)
    r.setElement(TaughtElement(url: "u", title: nil, role: "r", name: "n", selector: nil), at: 99) // out of range: ignored
    XCTAssertEqual(r.steps[i].element?.name, "Export")
    XCTAssertEqual(TeachRecording.clock(65), "1:05")
  }

  func testOnlyVMClicksAreInspected() {
    XCTAssertTrue(teachInspects(kind: "click", computerKind: "vm"))
    XCTAssertFalse(teachInspects(kind: "click", computerKind: "device"))
    XCTAssertFalse(teachInspects(kind: "scroll", computerKind: "vm"))
  }

  func testInspectAsksForTheElement() async throws {
    let store = try makeStore()
    reply("POST", "/api/computers/c1/act", #"{"element":{"url":"https://x.test","role":"button","name":"Export"}}"#)
    let e = try await store.inspect(store.computers[0], x: 10, y: 20, width: 1280, height: 800)
    XCTAssertEqual(e?.name, "Export")
    let action = sentBody("POST", "/api/computers/c1/act")?["action"] as? [String: Any]
    XCTAssertEqual(action?["action"] as? String, "inspect")
    XCTAssertEqual((action?["space"] as? [String: Int])?["width"], 1280)
    reply("POST", "/api/computers/c1/act", #"{"element":null}"#)
    let none = try await store.inspect(store.computers[0], x: 1, y: 1, width: 10, height: 10)
    XCTAssertNil(none)
  }

  func testSavingALessonUploadsPicturesThenTeaches() async throws {
    let store = try makeStore()
    var r = TeachRecording()
    r.add(kind: "click", x: 3, y: 4, snapshot: Data([9, 9]))
    r.add(kind: "type", text: "report")
    reply("POST", "/api/files", #"{"id":"f1","name":"step-1.jpg"}"#)
    reply("POST", "/api/routines/teach", #"{"id":"r1"}"#)
    reply("GET", "/api/routines", "[]")
    try await store.saveLesson(agent: store.agents[0], computer: store.computers[0], name: " Weekly report ", recording: r, narration: "  the blue button  ")
    XCTAssertEqual(sentRequests("POST", "/api/files").count, 1)
    let body = try XCTUnwrap(sentBody("POST", "/api/routines/teach"))
    XCTAssertEqual(body["agentId"] as? String, "a1")
    XCTAssertEqual(body["name"] as? String, "Weekly report")
    XCTAssertEqual(body["computerId"] as? String, "c1")
    XCTAssertEqual(body["narration"] as? String, "the blue button")
    let steps = try XCTUnwrap(body["steps"] as? [[String: Any]])
    XCTAssertEqual(steps.count, 2)
    XCTAssertEqual(steps[0]["imageFileId"] as? String, "f1")
    XCTAssertEqual(steps[0]["kind"] as? String, "click")
    XCTAssertNil(steps[1]["imageFileId"])
    XCTAssertEqual(steps[1]["text"] as? String, "report")
  }
}
