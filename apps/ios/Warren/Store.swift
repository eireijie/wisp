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
  var sections: [ChannelSection] = []
  var nodes: [AgentNode] = []
  var teams: [WorkspaceTeam] = []
  var tasks: [WorkTask] = []
  var taskLead: String?
  var taskLeadOverride: String?
  var notes: [MemoryNote] = []
  var profiles: [String: MemoryProfile] = [:]
  var routines: [Routine] = []
  var backgrounds: [String: AgentBackground] = [:]
  var skills: [HelperSkill] = []
  var connectors: [AppConnector] = []
  var sessions: [AccountSession] = []
  var invites: [WorkspaceInvite] = []
  var prefs: Me.Prefs?
  var memoryStorage: MemoryStorage?
  var agentPolicy: AgentPolicy?
  var routinesVersion = 0
  var backgroundVersion = 0
  var allowance: Allowance?
  var changes: [Change]?
  var simple = false
  /** the optional features this organization has on (all on when the hub doesn't say) */
  var features: Features = .everything
  /** every organization you belong to, for the switcher at the top of Chats */
  var orgs: [OrgSummary] = []
  var agentDefaults: AgentDefaults?
  var syncError: String?
  var sessionMessage: String?
  var channelVersion = 0
  var memoryVersion = 0
  var agents: [Agent] = [] {
    didSet { recordCompletions(previous: oldValue) }
  }
  private var completedUntil: [String: Date] = [:]
  var members: [Member] = []
  var computers: [Computer] = []
  var approvals: [Approval] = []
  /** top-level messages per channel, oldest first */
  var messages: [String: [Message]] = [:]
  /** replies per thread root (a reply can be the root of a sub-thread) */
  var threads: [String: [Message]] = [:]
  /** thread roots as loaded with their thread: a sub-thread's root is a reply in another thread */
  var roots: [String: Message] = [:]
  var replyCounts: [String: Int] = [:]
  var noEarlierThreads: Set<String> = []
  private var seenReplies: Set<String> = []
  private var removedReplies: Set<String> = []
  /** discussions shown in the chat, with who has answered this round */
  var discussions: [String: Discussion] = [:]
  /** what each busy agent is doing right now ("Reading the vault…"), from run events */
  var activity: [String: String] = [:]
  /** the channel each working agent is replying in */
  var activityChannel: [String: String] = [:]
  /** the thread it's working in (none at the top of the channel) */
  var activityThread: [String: String] = [:]
  /** the threads above that one, outermost first, so a thread shows who's working in its sub-threads */
  var activityPath: [String: [String]] = [:]
  /** the steps of each working agent's current run, oldest first */
  var activitySteps: [String: [String]] = [:]
  /** the run each working agent is on, so it can be stopped */
  var activityRun: [String: String] = [:]
  var activitySince: [String: Date] = [:]
  var connected = false
  /** the channel on screen, so new messages there don't count as unread */
  var openChannel: String?
  /** threads on screen (root → channel), refreshed when the connection comes back */
  var openThreads: [String: String] = [:]
  /** where a tapped notification wants to go; the screen that shows it clears it */
  var route: Route?
  /** whether this hub has an APNs key (push is optional for self-hosters) */
  var pushAvailable = false
  var notificationStatus: UNAuthorizationStatus = .notDetermined
  var pushRegistrationError: String?
  @ObservationIgnored var pushToken: String?
  @ObservationIgnored var pushUploadTask: Task<Void, Never>?

  private var socket: URLSessionWebSocketTask?
  private var socketGeneration = 0
  private var retry = 0
  /**
   * Bumped on every sign-in, sign-out and organization switch, so loads and socket callbacks that
   * started under an old session drop what they got instead of mixing it into the new one.
   */
  private(set) var session = 0
  /** whether this session's socket has been ready before: a later "ready" is a reconnect */
  private var connectedOnce = false

  @ObservationIgnored private let persistToken: (String?) throws -> Void

  init(loadSession: Bool = true, persistToken: @escaping (String?) throws -> Void = { try Session.saveToken($0) }) {
    self.persistToken = persistToken
    #if DEBUG
    if loadSession, let address = ProcessInfo.processInfo.environment["WARREN_HUB"],
       let hub = URL(string: address), let token = ProcessInfo.processInfo.environment["WARREN_TOKEN"], !token.isEmpty {
      api = API(base: hub, token: token)
      phase = .loading
      Task { await load() }
      return
    }
    #endif
    if loadSession, let hub = Session.hub, let token = Session.token {
      api = API(base: hub, token: token)
      phase = .loading
      Task { await load() }
    }
  }

  // MARK: signing in and out

  /** A pairing link that opened the app (from the Camera app); the pairing screen picks it up. */
  var pendingPair: PairLink?

  /** Signed in by pairing with Warren on a computer (Settings → Mobile). */
  func adopt(hub: URL, token: String) throws {
    do { try persistToken(token) } catch {
      if api != nil { signOut() }
      throw error
    }
    sessionMessage = nil
    disconnect()
    clearData()
    Session.hub = hub
    api = API(base: hub, token: token)
    phase = .loading
    // not tied to the pairing screen's task, which ends as soon as that screen goes away
    Task { await load() }
  }

  func signOut() {
    let old = api
    Task { try? await old?.post("/api/auth/logout", Empty()) }
    try? persistToken(nil)
    disconnect()
    api = nil
    clearData()
    phase = .signedOut
    // the hub forgets this phone's push token along with the sign-in
    updateBadge()
  }

  /** Moves this phone to another organization with a session token scoped to it, then reloads everything. */
  func switchSession(token: String) throws {
    guard let base = api?.base else { return }
    // The hub has revoked the old token; a persistence failure must also leave memory signed out.
    do { try persistToken(token) } catch { signOut(); throw error }
    sessionMessage = nil
    Session.hub = base
    api = API(base: base, token: token)
    disconnect()
    clearData()
    phase = .loading
    Task { await load() }
  }

  /** Closes the live connection and starts a new session: anything still in flight from the old one is dropped. */
  private func disconnect() {
    pushUploadTask?.cancel()
    pushUploadTask = nil
    session += 1
    socketGeneration += 1
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
    connected = false
    retry = 0
  }

  /** The current connection, checked again after `work` so a result from before a sign-out or switch is dropped. */
  @discardableResult
  func fetch<T>(_ work: (API) async throws -> T) async throws -> T {
    let api = try connection()
    let gen = session
    do {
      let value = try await work(api)
      guard gen == session else { throw Stale() }
      return value
    } catch {
      guard gen == session else { throw Stale() }
      throw error
    }
  }

  /** The same local cleanup as sign-out, while keeping the saved hub address. */
  func authenticationExpired(generation: Int) {
    guard generation == session else { return }
    signOut()
    sessionMessage = "Signed out: sign in again"
  }

  func recordSyncError(_ error: Error) {
    guard !(error is Stale), !(error is API.AuthenticationExpired), api != nil else { return }
    syncError = error.localizedDescription
  }

  /** What a request from an earlier session ends with: nothing to show, since that session is gone. */
  struct Stale: LocalizedError { var errorDescription: String? { "You signed out." } }

  private func clearData() {
    connectedOnce = false
    me = nil
    workspace = nil
    features = .everything; orgs = []; agentDefaults = nil
    activitySteps = [:]; activityRun = [:]; activitySince = [:]
    sections = []; nodes = []; teams = []; syncError = nil
    tasks = []; notes = []; profiles = [:]; routines = []; backgrounds = [:]
    skills = []; connectors = []; sessions = []; invites = []; prefs = nil
    taskLead = nil; taskLeadOverride = nil; memoryStorage = nil; agentPolicy = nil
    channels = []; agents = []; members = []; computers = []; screenCodes = [:]; approvals = []
    messages = [:]; threads = [:]; roots = [:]; replyCounts = [:]; activity = [:]; activityChannel = [:]
    activityThread = [:]; activityPath = [:]; discussions = [:]
    openChannel = nil; openThreads = [:]
    noEarlierThreads = []; seenReplies = []; removedReplies = []
    allowance = nil; changes = nil; pushAvailable = false; pushRegistrationError = nil
    route = nil
  }

  // MARK: loading

  func load() async {
    guard api != nil else { return }
    let gen = session
    do {
      let api = try connection()
      let me: Me = try await api.get("/api/me")
      guard gen == session else { return }
      self.me = me.user
      self.role = me.role ?? "member"
      self.prefs = me.prefs
      self.simple = me.prefs?.experience == "simple"
      self.workspace = me.workspace
      self.features = me.features ?? .everything
      async let ch: [Channel] = api.get("/api/channels")
      async let ag: [Agent] = api.get("/api/agents")
      let (loadedChannels, loadedAgents) = try await (ch, ag)
      guard gen == session else { return }
      channels = loadedChannels
      agents = loadedAgents
      try await refreshManagement()
      guard gen == session else { return }
      phase = .ready
      connect()
      await refreshComputers()
      guard gen == session else { return }
      await refreshApprovals()
      guard gen == session else { return }
      await refreshOrgs()
      guard gen == session else { return }
      await setUpPush()
    } catch {
      guard gen == session else { return }
      if phase != .ready { phase = .failed(error.localizedDescription) }
      else { recordSyncError(error) }
    }
  }

  func refreshChannels() async {
    do {
      channels = try await fetch { try await $0.get("/api/channels") }
    } catch is Stale {
    } catch {
      if !Task.isCancelled { recordSyncError(error) }
    }
  }

  func refreshComputers() async {
    if let list: [Computer] = try? await fetch({ try await $0.get("/api/computers") }) { computers = list }
  }

  func refreshApprovals() async {
    if let list: [Approval] = try? await fetch({ try await $0.get("/api/approvals") }) { approvals = list }
  }

  func loadMessages(_ channelId: String, thread: String? = nil) async throws {
    var q = ["limit": "80"]
    if let thread { q["thread"] = thread }
    let page: MessagePage = try await fetch { try await $0.get("/api/channels/\(channelId)/messages", q) }
    let sorted = page.messages.sorted { $0.createdAt < $1.createdAt }
    if let thread {
      threads[thread] = sorted.filter { $0.id != thread }
      if let root = sorted.first(where: { $0.id == thread }) { roots[thread] = root }
      if sorted.count < 80 { noEarlierThreads.insert(thread) } else { noEarlierThreads.remove(thread) }
      seenReplies.formUnion(sorted.filter { $0.threadId != nil }.map(\.id))
      replyCounts[thread] = max(replyCounts[thread] ?? 0, threads[thread]?.count ?? 0)
    } else {
      messages[channelId] = sorted
    }
    replyCounts.merge(page.replyCounts) { $1 }
  }

  /** A failed request throws; only a successful empty page means history is exhausted. */
  func loadEarlier(_ channelId: String, thread: String? = nil) async throws -> Bool {
    let list = thread.map { threads[$0] ?? [] } ?? (messages[channelId] ?? [])
    guard let first = list.first else {
      if let thread { noEarlierThreads.insert(thread) }
      return false
    }
    var query = ["limit": "60", "before": first.createdAt]
    if let thread { query["thread"] = thread }
    let page: MessagePage = try await fetch { try await $0.get("/api/channels/\(channelId)/messages", query) }
    let current = thread.map { threads[$0] ?? [] } ?? (messages[channelId] ?? [])
    let older = page.messages.filter { m in m.id != thread && !current.contains { $0.id == m.id } }.sorted { $0.createdAt < $1.createdAt }
    if let thread {
      threads[thread] = older + current
      if let root = page.messages.first(where: { $0.id == thread }) { roots[thread] = root }
      seenReplies.formUnion(page.messages.filter { $0.threadId != nil }.map(\.id))
      replyCounts[thread] = max(replyCounts[thread] ?? 0, threads[thread]?.count ?? 0)
      if older.isEmpty { noEarlierThreads.insert(thread) }
    } else {
      messages[channelId] = older + current
    }
    replyCounts.merge(page.replyCounts) { $1 }
    return !older.isEmpty
  }

  /** Fetch a specific approval, including one that has already been decided. */
  func loadApproval(_ id: String) async throws -> Bool {
    do {
      let approval: Approval = try await fetch { try await $0.get("/api/approvals/\(id)") }
      upsert(approval)
      return true
    } catch let error as API.Failure where error.status == 404 {
      return false
    }
  }

  /** Offline wins, then approval requests and failures, then current work. */
  func mood(for agent: Agent?) -> GhostMood {
    guard let agent else { return .awake }
    let computer = computers.first { $0.id == agent.computerId }
    if agent.status == .offline || computer?.paused == true || computer?.status == "offline" { return .asleep }
    if approvals.contains(where: { $0.agentId == agent.id && $0.status == "pending" }) { return .waiting }
    if computer?.status == "error" { return .error }
    if agent.status == .busy { return .working }
    if let until = completedUntil[agent.id], until > Date() { return .done }
    return .awake
  }

  private func recordCompletions(previous: [Agent]) {
    let statuses = Dictionary(uniqueKeysWithValues: previous.map { ($0.id, $0.status) })
    completedUntil = completedUntil.filter { id, _ in agents.contains { $0.id == id && $0.status == .online } }
    for agent in agents where agent.status == .online && statuses[agent.id] == .busy {
      let until = Date().addingTimeInterval(4)
      completedUntil[agent.id] = until
      Task { [weak self] in
        try? await Task.sleep(for: .seconds(4))
        guard let self, completedUntil[agent.id] == until else { return }
        completedUntil[agent.id] = nil
      }
    }
  }

  /** The hub merges settings, so only send the appearance being edited. */
  func saveLook(_ look: GhostLook, for agent: Agent) async throws {
    struct Settings: Encodable { var appearance: GhostLook }
    struct Body: Encodable { var settings: Settings }
    let updated: Agent = try await fetch { try await $0.send("PATCH", "/api/agents/\(agent.id)", body: Body(settings: Settings(appearance: look.resolved))) }
    if let i = agents.firstIndex(where: { $0.id == updated.id }) { agents[i] = updated }
    else { agents.append(updated) }
  }

  // MARK: actions

  func send(_ text: String, in channelId: String, thread: String? = nil, files: [String] = []) async throws {
    struct Body: Encodable { var body: String; var threadId: String?; var fileIds: [String] }
    let m: Message = try await fetch { try await $0.post("/api/channels/\(channelId)/messages", Body(body: text, threadId: thread, fileIds: files)) }
    insert(m)
    askForNotificationsIfDue()
  }

  func markRead(_ channelId: String) {
    guard channels.contains(where: { $0.id == channelId }) else { return }
    Task {
      do { try await readChannel(channelId) }
      catch { recordSyncError(error) }
    }
  }

  /** The DM with an agent, made on first use. */
  func dm(with agent: Agent) async throws -> Channel {
    let ch: Channel = try await fetch { try await $0.post("/api/dm/\(agent.id)", Empty()) }
    if !channels.contains(where: { $0.id == ch.id }) { await refreshChannels() }
    return channels.first { $0.id == ch.id } ?? ch
  }

  /** `code`: the screen's code, when saying yes lends a device's own screen that has one. */
  func decide(_ approval: Approval, approve: Bool, note: String = "", code: String? = nil) async throws {
    struct Body: Encodable { var approve: Bool; var note: String; var code: String? }
    let a: Approval = try await fetch { try await $0.post("/api/approvals/\(approval.id)/decide", Body(approve: approve, note: note, code: approve ? code : nil)) }
    upsert(a)
  }

  /** The computer a device-loan approval would lend, for its code. */
  func loanScreen(_ approval: Approval) -> Computer? {
    guard let loan = approval.loan else { return nil }
    return computers.first { $0.kind == "device" && $0.nodeId == loan.nodeId }
  }

  /**
   * Codes typed for screens since the app opened, so watching one again doesn't ask again. Only in
   * memory, never saved: the device checks them and Warren keeps none.
   */
  @ObservationIgnored var screenCodes: [String: String] = [:]

  struct LiveView: Decodable { var transport: String; var url: String }

  /**
   * Open a live view: the hub's one-time link, with the screen's code when it has one. The socket
   * keeps what the code opened open until it closes.
   */
  func openView(_ computer: Computer, code: String?) async throws -> (LiveView, URLSessionWebSocketTask) {
    struct Body: Encodable { var code: String? }
    // one connection for both steps: signing out while this waits mustn't leave the second one without it
    let api = try connection()
    let view: LiveView = try await fetch { try await $0.post("/api/computers/\(computer.id)/view", Body(code: code)) }
    var comps = URLComponents(url: api.base, resolvingAgainstBaseURL: false)!
    comps.scheme = comps.scheme == "https" ? "wss" : "ws"
    guard let base = comps.url, let url = URL(string: view.url, relativeTo: base) else { throw API.Failure(status: 0, message: "The hub sent a live view this app doesn't understand.") }
    let ws = URLSession.shared.webSocketTask(with: url.absoluteURL)
    ws.maximumMessageSize = 16 << 20 // a frame is a whole screenshot
    return (view, ws)
  }

  /** Lend a device's own screen to agents for `minutes` (nil: until you stop it), or stop with `off`. */
  func lend(_ computer: Computer, minutes: Int?, code: String?) async throws {
    struct Body: Encodable {
      var minutes: Int?
      var code: String?
      func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(minutes, forKey: .minutes) // null means until you stop it, so it's always sent
        try c.encodeIfPresent(code, forKey: .code)
      }
      enum CodingKeys: String, CodingKey { case minutes, code }
    }
    let c: Computer = try await fetch { try await $0.post("/api/computers/\(computer.id)/lend", Body(minutes: minutes, code: code)) }
    upsert(c)
  }

  func stopLending(_ computer: Computer) async throws {
    struct Body: Encodable { var off = true }
    let c: Computer = try await fetch { try await $0.post("/api/computers/\(computer.id)/lend", Body()) }
    upsert(c)
  }

  func control(_ computer: Computer, take: Bool) async throws {
    struct Body: Encodable { var take: Bool }
    let c: Computer = try await fetch { try await $0.post("/api/computers/\(computer.id)/control", Body(take: take)) }
    upsert(c)
  }

  /** Click, type or press keys on a computer someone has taken control of. */
  func act(_ computer: Computer, _ action: [String: AnyEncodable]) async throws {
    struct Body: Encodable { var action: [String: AnyEncodable] }
    try await fetch { try await $0.post("/api/computers/\(computer.id)/act", Body(action: action)) }
  }

  /** The keys that paste on a computer: ⌘V on a Mac's own screen, Ctrl+V everywhere else. */
  func pasteKeys(_ computer: Computer) async -> String {
    guard computer.kind == "device", let nodeId = computer.nodeId else { return "ctrl+v" }
    struct Node: Decodable {
      struct Caps: Decodable { var platform: String }
      var id: String
      var capabilities: Caps?
    }
    let nodes: [Node] = (try? await fetch { try await $0.get("/api/nodes") }) ?? []
    return nodes.first { $0.id == nodeId }?.capabilities?.platform == "darwin" ? "cmd+v" : "ctrl+v"
  }

  /** The text on a computer's clipboard. */
  func clipboard(_ computer: Computer) async throws -> String {
    struct Clip: Decodable { var text: String }
    let c: Clip = try await fetch { try await $0.get("/api/computers/\(computer.id)/clipboard") }
    return c.text
  }

  func setClipboard(_ computer: Computer, _ text: String) async throws {
    struct Body: Encodable { var text: String }
    let _: Data = try await fetch { try await $0.request("PUT", "/api/computers/\(computer.id)/clipboard", body: Body(text: text)) }.0
  }

  func screen(_ computer: Computer, maxAge: Int = 1500) async throws -> Frame {
    let (data, resp) = try await fetch { try await $0.request("GET", "/api/computers/\(computer.id)/screen", query: ["maxAge": String(maxAge)], body: Optional<Empty>.none) }
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
  var unreadTotal: Int { channels.reduce(0) { $0 + $1.badge } }
  /** agents waiting on you: asking for an OK, or for help on their computer */
  var needsYouCount: Int { pendingApprovals.count + computers.filter { $0.help != nil }.count }

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
        case .failure(let error):
          self.connected = false
          if Self.isSocketAuthenticationFailure(code: task.closeCode.rawValue,
            reason: task.closeReason.map { String(decoding: $0, as: UTF8.self) },
            status: (task.response as? HTTPURLResponse)?.statusCode) || (error as? URLError)?.code == .userAuthenticationRequired {
            self.authenticationExpired(generation: self.session)
          } else {
            self.reconnectLater()
          }
        }
      }
    }
  }

  static func isSocketAuthenticationFailure(code: Int, reason: String?, status: Int?) -> Bool {
    if status == 401 { return true }
    // The hub also uses 4401 for a hello timeout, which can be a temporary connection problem.
    if code == 4401 { return reason != "auth timeout" }
    return code == 1008 && (reason?.lowercased().contains("unauthorized") == true)
  }

  private func reconnectLater() {
    guard api != nil else { return }
    retry += 1
    let delay = min(30.0, pow(1.8, Double(retry)))
    let gen = socketGeneration
    Task {
      try? await Task.sleep(for: .seconds(delay))
      // a sign-out, a switch or a newer connection since then makes this one moot
      if api != nil && !connected && gen == socketGeneration { connect() }
    }
  }

  /** The conversation on screen and its open threads, again: events missed while offline aren't replayed. */
  func refreshOpen() async {
    let gen = session
    if let open = openChannel { try? await loadMessages(open) }
    guard gen == session else { return }
    for (root, channelId) in openThreads {
      guard gen == session else { return }
      try? await loadMessages(channelId, thread: root)
    }
    for d in discussions.values where d.live {
      guard gen == session else { return }
      await loadDiscussion(d.id)
    }
  }

  /** Called when the app comes back to the foreground: sockets don't survive the background. */
  func resume() {
    guard phase == .ready else { return }
    // the new socket's "ready" does the catch-up, so it isn't done twice
    connect()
    Task { await setUpPush() }
  }

  /** Events missed while offline aren't replayed. Reload every collection those events maintain. */
  func refreshAfterReconnect() async {
    let gen = session
    activity = [:]; activityChannel = [:]; activityThread = [:]; activityPath = [:]
    activitySteps = [:]; activityRun = [:]; activitySince = [:]
    func refresh(_ work: () async throws -> Void) async {
      guard gen == session else { return }
      do { try await work() }
      catch is Stale {}
      catch { if gen == session { recordSyncError(error) } }
    }
    await refresh {
      let me: Me = try await fetch { try await $0.get("/api/me") }
      self.me = me.user
      prefs = me.prefs
      simple = me.prefs?.experience == "simple"
      role = me.role ?? "member"
      features = me.features ?? .everything
      syncError = nil
    }
    await refresh { try await refreshAgents() }
    await refresh { try await refreshManagement() }
    await refresh { await refreshChannels() }
    await refresh { await refreshOpen() }
    await refresh { await refreshComputers() }
    await refresh { await refreshApprovals() }
    await refresh { try await refreshTaskLead() }
    await refresh { try await refreshTasks() }
    await refresh { try await refreshRoutines() }
    await refresh { try await refreshNotes() }
    await refresh { try await refreshChanges() }
    await refresh { if allowance != nil { try await refreshAllowance() } }
    for id in Array(backgrounds.keys) { await refresh { try await refreshBackground(id) } }
    for user in Array(profiles.keys) { await refresh { try await refreshProfile(user) } }
    await refresh { await refreshOrgs() }
    guard gen == session else { return }
    channelVersion += 1
    memoryVersion += 1
    routinesVersion += 1
    backgroundVersion += 1
  }

  private struct Envelope: Decodable { var type: String }
  private struct MessageEvent: Decodable { var message: Message }
  private struct MessageRemovedEvent: Decodable { var messageId: String; var channelId: String; var threadId: String? }
  private struct DiscussionEvent: Decodable { struct D: Decodable { var id: String }; var discussion: D }
  private struct StatusEvent: Decodable { var agentId: String; var status: Agent.Status }
  private struct RunEvent: Decodable {
    struct E: Decodable { var type: String; var text: String?; var name: String? }
    var runId: String?
    var agentId: String
    var channelId: String
    /** where it works: the thread (none at the top of the channel) and the threads above it, outermost first */
    var threadId: String?
    var threadPath: [String]?
    var event: E
  }
  private struct FeaturesEvent: Decodable { var features: Features }
  private struct ReactionsEvent: Decodable { var messageId: String; var channelId: String; var threadId: String?; var reactions: [Reaction] }
  private struct ComputerEvent: Decodable { var computer: Computer }
  private struct RemovedEvent: Decodable { var computerId: String }
  private struct ApprovalEvent: Decodable { var approval: Approval }

  func handle(_ data: Data) {
    guard let env = try? Wire.decoder.decode(Envelope.self, from: data) else { return }
    let d = Wire.decoder
    switch env.type {
    case "ready":
      connected = true
      retry = 0
      // the first connect follows a full load; only a reconnect has events to catch up on
      if connectedOnce { Task { await refreshAfterReconnect() } }
      else {
        connectedOnce = true
        Task {
          do { try await refreshAgents(); try await refreshManagement() } catch { recordSyncError(error) }
          await refreshChannels()
          await refreshOpen()
        }
      }
    case "message":
      guard let e = try? d.decode(MessageEvent.self, from: data) else { return }
      insert(e.message)
      if e.message.author.kind == .agent {
        activity[e.message.author.id] = nil
        activityChannel[e.message.author.id] = nil
        activityThread[e.message.author.id] = nil
        activityPath[e.message.author.id] = nil
      }
      let mine = e.message.author == Actor(kind: .user, id: me?.id ?? "") || e.message.author.id == "system"
      if !mine, let i = channels.firstIndex(where: { $0.id == e.message.channelId }) {
        if openChannel == e.message.channelId { markRead(e.message.channelId) } else if e.message.threadId == nil && !channels[i].isMuted { channels[i].unread = (channels[i].unread ?? 0) + 1 }
      } else if !channels.contains(where: { $0.id == e.message.channelId }) {
        Task { await refreshChannels() }
      }
    case "message_updated":
      guard let e = try? d.decode(MessageEvent.self, from: data) else { return }
      replace(e.message)
    case "message_removed":
      guard let e = try? d.decode(MessageRemovedEvent.self, from: data) else { return }
      remove(e.messageId, channel: e.channelId, thread: e.threadId)
    case "discussion":
      // the event has the discussion; who has answered comes with a fetch
      guard let e = try? d.decode(DiscussionEvent.self, from: data), discussions[e.discussion.id] != nil else { return }
      Task { await loadDiscussion(e.discussion.id) }
    case "agent_status":
      guard let e = try? d.decode(StatusEvent.self, from: data) else { return }
      guard let i = agents.firstIndex(where: { $0.id == e.agentId }) else {
        Task { do { try await refreshAgents() } catch { recordSyncError(error) } }
        return
      }
      agents[i].status = e.status
      if e.status != .busy {
        activity[e.agentId] = nil
        activityChannel[e.agentId] = nil
        activityThread[e.agentId] = nil
        activityPath[e.agentId] = nil
        activitySteps[e.agentId] = nil
        activityRun[e.agentId] = nil
        activitySince[e.agentId] = nil
      } else if activitySince[e.agentId] == nil {
        activitySince[e.agentId] = Date()
      }
    case "run_event":
      guard let e = try? d.decode(RunEvent.self, from: data) else { return }
      activityChannel[e.agentId] = e.channelId
      activityThread[e.agentId] = e.threadId
      activityPath[e.agentId] = e.threadPath ?? []
      if let run = e.runId, activityRun[e.agentId] != run {
        activityRun[e.agentId] = run
        activitySteps[e.agentId] = []
        activitySince[e.agentId] = Date()
      }
      switch e.event.type {
      case "status":
        activity[e.agentId] = e.event.text
        if let text = e.event.text, text != "started" { addStep(text, for: e.agentId) }
      case "tool_call":
        activity[e.agentId] = "Using \(e.event.name ?? "a tool")"
        addStep("Used \(e.event.name ?? "a tool")", for: e.agentId)
      case "text": activity[e.agentId] = "Writing…"
      default: break
      }
    case "features":
      if let e = try? d.decode(FeaturesEvent.self, from: data) { features = e.features }
    case "reactions":
      guard let e = try? d.decode(ReactionsEvent.self, from: data) else { return }
      update(e.messageId, channel: e.channelId, thread: e.threadId) { $0.reactions = e.reactions }
    case "channels_changed":
      channelVersion += 1
      Task { await refreshChannels() }
      // a channel's team may have changed, and with it the automatic lead
      Task { try? await refreshTeams(); try? await refreshTaskLead() }
    case "sections_changed":
      Task { do { try await refreshSections() } catch { recordSyncError(error) } }
    case "agent_created", "agent_updated", "agent_removed", "agents_changed":
      Task { do { try await refreshAgents() } catch { recordSyncError(error) } }
    case "lead_changed":
      Task { do { try await refreshTaskLead() } catch { recordSyncError(error) } }
    case "tasks_changed":
      Task { do { try await refreshTasks() } catch { recordSyncError(error) } }
    case "routines_changed":
      routinesVersion += 1
      Task { do { try await refreshRoutines() } catch { recordSyncError(error) } }
    case "background_changed":
      backgroundVersion += 1
      if let event = try? JSONSerialization.jsonObject(with: data) as? [String: String], let id = event["agentId"], backgrounds[id] != nil {
        Task { do { try await refreshBackground(id) } catch { recordSyncError(error) } }
      }
      if allowance != nil { Task { try? await refreshAllowance() } }
    case "changes_changed":
      Task { try? await refreshChanges() }
    case "memory_changed":
      memoryVersion += 1
      Task { do { try await refreshNotes() } catch { recordSyncError(error) } }
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

  private func addStep(_ text: String, for agentId: String) {
    var steps = activitySteps[agentId] ?? []
    guard steps.last != text else { return }
    steps.append(text)
    activitySteps[agentId] = Array(steps.suffix(30))
  }

  private func insert(_ m: Message) {
    if let root = m.threadId {
      let cached = threads[root]?.contains { $0.id == m.id } == true
      let unseen = seenReplies.insert(m.id).inserted && !cached && !removedReplies.contains(m.id)
      if threads[root] != nil && !cached && !removedReplies.contains(m.id) { threads[root]!.append(m) }
      if unseen { replyCounts[root, default: 0] += 1 }
    } else if messages[m.channelId] != nil, !(messages[m.channelId]!.contains { $0.id == m.id }) {
      messages[m.channelId]!.append(m)
    }
  }

  /** An edited message, or a deleted thread root kept (blank) for its replies, wherever it's loaded. */
  func replace(_ m: Message) {
    if let i = messages[m.channelId]?.firstIndex(where: { $0.id == m.id }) { messages[m.channelId]![i] = m }
    if let root = m.threadId, let i = threads[root]?.firstIndex(where: { $0.id == m.id }) { threads[root]![i] = m }
    if roots[m.id] != nil { roots[m.id] = m }
  }

  /** A deleted message, gone from its channel or thread. */
  func remove(_ id: String, channel: String, thread: String?) {
    messages[channel]?.removeAll { $0.id == id }
    if let root = thread, removedReplies.insert(id).inserted {
      threads[root]?.removeAll { $0.id == id }
      if let n = replyCounts[root] { replyCounts[root] = max(0, n - 1) }
    }
    roots[id] = nil
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
