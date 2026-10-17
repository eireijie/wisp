import Foundation
import Observation
import UIKit
import UserNotifications

/** Everything the app knows about the workspace, kept current by the hub's live events (/ws). */
@MainActor @Observable
final class Store {
  enum Phase: Equatable { case signedOut, loading, ready, failed(String) }

  var phase: Phase = .signedOut
  var api: API?
  var me: User?
  var role: String = "member"
  var workspace: Workspace?
  var channels: [Channel] = []
  var agents: [Agent] = []
  var members: [Member] = []
  var computers: [Computer] = []
  var approvals: [Approval] = []
  /** top-level messages per channel, oldest first */
  var messages: [String: [Message]] = [:]
  /** replies per thread root */
  var threads: [String: [Message]] = [:]
  var replyCounts: [String: Int] = [:]
  /** what each busy agent is doing right now ("Reading the vault…"), from run events */
  var activity: [String: String] = [:]
  /** the channel each working agent is replying in */
  var activityChannel: [String: String] = [:]
  var connected = false
  /** the channel on screen, so new messages there don't count as unread */
  var openChannel: String?
  /** where a tapped notification wants to go; the screen that shows it clears it */
  var route: Route?
  /** whether this hub has an APNs key (push is optional for self-hosters) */
  var pushAvailable = false
  var notificationStatus: UNAuthorizationStatus = .notDetermined

  private var socket: URLSessionWebSocketTask?
  private var socketGeneration = 0
  private var retry = 0

  init() {
    if let hub = Session.hub, let token = Session.token {
      api = API(base: hub, token: token)
      phase = .loading
      Task { await load() }
    }
  }

  // MARK: signing in and out

  func signIn(hub: URL, email: String, password: String) async throws {
    struct Login: Encodable { var email: String; var password: String }
    struct Token: Decodable { var token: String }
    let t: Token = try await API(base: hub).post("/api/auth/login", Login(email: email, password: password))
    Session.hub = hub
    Session.token = t.token
    api = API(base: hub, token: t.token)
    phase = .loading
    await load()
  }

  func signOut() {
    let old = api
    Task { try? await old?.post("/api/auth/logout", Empty()) }
    Session.token = nil
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
    api = nil
    me = nil
    channels = []; agents = []; members = []; computers = []; approvals = []
    messages = [:]; threads = [:]; activity = [:]; activityChannel = [:]
    route = nil
    phase = .signedOut
    // the hub forgets this phone's push token along with the sign-in
    updateBadge()
  }

  // MARK: loading

  func load() async {
    guard let api else { return }
    do {
      let me: Me = try await api.get("/api/me")
      self.me = me.user
      self.role = me.role ?? "member"
      self.workspace = me.workspace
      async let ch: [Channel] = api.get("/api/channels")
      async let ag: [Agent] = api.get("/api/agents")
      async let mem: [Member] = api.get("/api/members")
      channels = try await ch
      agents = try await ag
      members = (try? await mem) ?? []
      phase = .ready
      connect()
      await refreshComputers()
      await refreshApprovals()
      await setUpPush()
    } catch let e as API.Failure where e.status == 401 {
      signOut()
    } catch {
      if phase != .ready { phase = .failed(error.localizedDescription) }
    }
  }

  func refreshChannels() async {
    if let list: [Channel] = try? await api?.get("/api/channels") { channels = list }
  }

  func refreshComputers() async {
    if let list: [Computer] = try? await api?.get("/api/computers") { computers = list }
  }

  func refreshApprovals() async {
    if let list: [Approval] = try? await api?.get("/api/approvals") { approvals = list }
  }

  func loadMessages(_ channelId: String, thread: String? = nil) async throws {
    guard let api else { return }
    var q = ["limit": "80"]
    if let thread { q["thread"] = thread }
    let page: MessagePage = try await api.get("/api/channels/\(channelId)/messages", q)
    let sorted = page.messages.sorted { $0.createdAt < $1.createdAt }
    if let thread { threads[thread] = sorted.filter { $0.id != thread } } else {
      messages[channelId] = sorted
      replyCounts.merge(page.replyCounts) { $1 }
    }
  }

  func loadEarlier(_ channelId: String) async -> Bool {
    guard let api, let first = messages[channelId]?.first else { return false }
    guard let page: MessagePage = try? await api.get("/api/channels/\(channelId)/messages", ["limit": "60", "before": first.createdAt]) else { return false }
    let older = page.messages.filter { m in !(messages[channelId] ?? []).contains { $0.id == m.id } }.sorted { $0.createdAt < $1.createdAt }
    messages[channelId] = older + (messages[channelId] ?? [])
    replyCounts.merge(page.replyCounts) { $1 }
    return !older.isEmpty
  }

  // MARK: actions

  func send(_ text: String, in channelId: String, thread: String? = nil) async throws {
    struct Body: Encodable { var body: String; var threadId: String? }
    let m: Message = try await api!.post("/api/channels/\(channelId)/messages", Body(body: text, threadId: thread))
    insert(m)
    askForNotificationsIfDue()
  }

  func markRead(_ channelId: String) {
    guard let i = channels.firstIndex(where: { $0.id == channelId }) else { return }
    let had = channels[i].unread ?? 0
    channels[i].unread = 0
    guard had > 0 else { return }
    struct Body: Encodable { var at: String }
    Task { try? await api?.post("/api/channels/\(channelId)/read", Body(at: Wire.now())) }
  }

  /** The DM with an agent, made on first use. */
  func dm(with agent: Agent) async throws -> Channel {
    let ch: Channel = try await api!.post("/api/dm/\(agent.id)", Empty())
    if !channels.contains(where: { $0.id == ch.id }) { await refreshChannels() }
    return channels.first { $0.id == ch.id } ?? ch
  }

  func decide(_ approval: Approval, approve: Bool, note: String = "") async throws {
    struct Body: Encodable { var approve: Bool; var note: String }
    let a: Approval = try await api!.post("/api/approvals/\(approval.id)/decide", Body(approve: approve, note: note))
    upsert(a)
  }

  func control(_ computer: Computer, take: Bool) async throws {
    struct Body: Encodable { var take: Bool }
    let c: Computer = try await api!.post("/api/computers/\(computer.id)/control", Body(take: take))
    upsert(c)
  }

  /** Click, type or press keys on a computer someone has taken control of. */
  func act(_ computer: Computer, _ action: [String: AnyEncodable]) async throws {
    struct Body: Encodable { var action: [String: AnyEncodable] }
    try await api!.post("/api/computers/\(computer.id)/act", Body(action: action))
  }

  func screen(_ computer: Computer, maxAge: Int = 1500) async throws -> Frame {
    let (data, resp) = try await api!.request("GET", "/api/computers/\(computer.id)/screen", query: ["maxAge": String(maxAge)], body: Optional<Empty>.none)
    let w = Int(resp.value(forHTTPHeaderField: "x-frame-width") ?? "") ?? 0
    let h = Int(resp.value(forHTTPHeaderField: "x-frame-height") ?? "") ?? 0
    return Frame(image: data, width: w, height: h)
  }

  // MARK: lookups

  func agent(_ id: String) -> Agent? { agents.first { $0.id == id } }
  func name(of actor: Actor) -> String {
    switch actor.kind {
    case .agent: agent(actor.id)?.name ?? "Agent"
    case .user: actor.id == me?.id ? (me?.preferredName ?? me?.name ?? "You") : members.first { $0.id == actor.id }.map { $0.preferredName ?? $0.name } ?? "Someone"
    }
  }

  /** The agent a DM is with (DM channels are named after their members' ids). */
  func dmAgent(_ ch: Channel) -> Agent? {
    guard ch.isDM else { return nil }
    return agents.first { ch.name.contains($0.id) } ?? agents.first { ch.name.localizedCaseInsensitiveContains($0.handle) }
  }

  func title(of ch: Channel) -> String { ch.isDM ? dmAgent(ch)?.name ?? "Direct message" : ch.name }

  var pendingApprovals: [Approval] { approvals.filter { $0.status == "pending" } }
  var unreadTotal: Int { channels.reduce(0) { $0 + ($1.unread ?? 0) } }

  // MARK: live events

  private func connect() {
    guard let api, let token = api.token else { return }
    socketGeneration += 1
    let gen = socketGeneration
    socket?.cancel(with: .goingAway, reason: nil)
    var comps = URLComponents(url: api.base.appending(path: "/ws"), resolvingAgainstBaseURL: false)!
    comps.scheme = api.base.scheme == "https" ? "wss" : "ws"
    let task = URLSession.shared.webSocketTask(with: comps.url!)
    socket = task
    task.resume()
    let hello = String(data: try! JSONSerialization.data(withJSONObject: ["token": token]), encoding: .utf8)!
    task.send(.string(hello)) { _ in }
    receive(task, gen)
  }

  private func receive(_ task: URLSessionWebSocketTask, _ gen: Int) {
    task.receive { [weak self] result in
      Task { @MainActor in
        guard let self, gen == self.socketGeneration else { return }
        switch result {
        case .success(let msg):
          if case .string(let s) = msg { self.handle(Data(s.utf8)) }
          self.receive(task, gen)
        case .failure:
          self.connected = false
          self.reconnectLater()
        }
      }
    }
  }

  private func reconnectLater() {
    guard api != nil else { return }
    retry += 1
    let delay = min(30.0, pow(1.8, Double(retry)))
    Task {
      try? await Task.sleep(for: .seconds(delay))
      if api != nil && !connected { connect() }
    }
  }

  /** Called when the app comes back to the foreground: sockets don't survive the background. */
  func resume() {
    guard phase == .ready else { return }
    connect()
    Task {
      await refreshChannels()
      if let open = openChannel { try? await loadMessages(open) }
      await refreshComputers()
      await refreshApprovals()
    }
  }

  private struct Envelope: Decodable { var type: String }
  private struct MessageEvent: Decodable { var message: Message }
  private struct StatusEvent: Decodable { var agentId: String; var status: Agent.Status }
  private struct RunEvent: Decodable {
    struct E: Decodable { var type: String; var text: String?; var name: String? }
    var agentId: String
    var channelId: String
    var event: E
  }
  private struct ReactionsEvent: Decodable { var messageId: String; var channelId: String; var threadId: String?; var reactions: [Reaction] }
  private struct ComputerEvent: Decodable { var computer: Computer }
  private struct RemovedEvent: Decodable { var computerId: String }
  private struct ApprovalEvent: Decodable { var approval: Approval }

  private func handle(_ data: Data) {
    guard let env = try? Wire.decoder.decode(Envelope.self, from: data) else { return }
    let d = Wire.decoder
    switch env.type {
    case "ready":
      connected = true
      retry = 0
    case "message":
      guard let e = try? d.decode(MessageEvent.self, from: data) else { return }
      insert(e.message)
      if e.message.author.kind == .agent {
        activity[e.message.author.id] = nil
        activityChannel[e.message.author.id] = nil
      }
      let mine = e.message.author == Actor(kind: .user, id: me?.id ?? "") || e.message.author.id == "system"
      if !mine, let i = channels.firstIndex(where: { $0.id == e.message.channelId }) {
        if openChannel == e.message.channelId { markRead(e.message.channelId) } else if e.message.threadId == nil { channels[i].unread = (channels[i].unread ?? 0) + 1 }
      } else if !channels.contains(where: { $0.id == e.message.channelId }) {
        Task { await refreshChannels() }
      }
    case "agent_status":
      guard let e = try? d.decode(StatusEvent.self, from: data), let i = agents.firstIndex(where: { $0.id == e.agentId }) else { return }
      agents[i].status = e.status
      if e.status != .busy {
        activity[e.agentId] = nil
        activityChannel[e.agentId] = nil
      }
    case "run_event":
      guard let e = try? d.decode(RunEvent.self, from: data) else { return }
      activityChannel[e.agentId] = e.channelId
      switch e.event.type {
      case "status": activity[e.agentId] = e.event.text
      case "tool_call": activity[e.agentId] = "Using \(e.event.name ?? "a tool")"
      case "text": activity[e.agentId] = "Writing…"
      default: break
      }
    case "reactions":
      guard let e = try? d.decode(ReactionsEvent.self, from: data) else { return }
      update(e.messageId, channel: e.channelId, thread: e.threadId) { $0.reactions = e.reactions }
    case "channels_changed":
      Task { await refreshChannels() }
    case "computer":
      if let e = try? d.decode(ComputerEvent.self, from: data) { upsert(e.computer) }
    case "computer_removed":
      if let e = try? d.decode(RemovedEvent.self, from: data) { computers.removeAll { $0.id == e.computerId } }
    case "approval":
      if let e = try? d.decode(ApprovalEvent.self, from: data) { upsert(e.approval) }
    default:
      break
    }
  }

  private func insert(_ m: Message) {
    if let root = m.threadId {
      if threads[root] != nil {
        if !threads[root]!.contains(where: { $0.id == m.id }) { threads[root]!.append(m) }
        replyCounts[root] = threads[root]!.count
      } else {
        replyCounts[root, default: 0] += 1
      }
    } else if messages[m.channelId] != nil, !(messages[m.channelId]!.contains { $0.id == m.id }) {
      messages[m.channelId]!.append(m)
    }
  }

  private func update(_ id: String, channel: String, thread: String?, _ change: (inout Message) -> Void) {
    if let root = thread, let i = threads[root]?.firstIndex(where: { $0.id == id }) { change(&threads[root]![i]) }
    if let i = messages[channel]?.firstIndex(where: { $0.id == id }) { change(&messages[channel]![i]) }
  }

  private func upsert(_ c: Computer) {
    if let i = computers.firstIndex(where: { $0.id == c.id }) { computers[i] = c } else { computers.append(c) }
  }

  private func upsert(_ a: Approval) {
    if let i = approvals.firstIndex(where: { $0.id == a.id }) { approvals[i] = a } else { approvals.insert(a, at: 0) }
  }
}

/** A JSON value for computer actions, whose fields differ by action. */
struct AnyEncodable: Encodable, Sendable {
  let value: any Encodable & Sendable
  init(_ v: any Encodable & Sendable) { value = v }
  func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}
