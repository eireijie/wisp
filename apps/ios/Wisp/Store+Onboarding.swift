import Foundation

/** What the hub hands back when a one-click sign-in starts: the connectors it made, and the page to sign in on (none: already signed in). */
struct ConnectStart: Decodable {
  var url: String?
  var signedIn: Bool?
  var connectors: [AppConnector]
}

/** Whether an app's key works (POST /api/connectors/:id/check); apps Bubble AI can't read itself aren't checked. */
struct ConnectorCheck: Decodable {
  var ok: Bool
  var checked: Bool?
  var error: String?
}

/** Whether an agent's AI is signed in where it runs (GET /api/agents/:id/harness). */
struct AgentHarnessStatus: Decodable {
  var signedIn: Bool?
  var inComputer: Bool?
}

/** A watch on a connected app (GET /api/watches), as Here's your Bubble AI lists it. */
struct AppWatch: Decodable, Identifiable {
  var id: String
  var label: String
  var agentIds: [String]
  var paused: Bool
}

extension Store {
  /** The address this phone reaches Bubble AI at: where a sign-in page sends the person back to. */
  var hubOrigin: String? {
    guard let base = api?.base, let scheme = base.scheme, let host = base.host else { return nil }
    return "\(scheme)://\(host)\(base.port.map { ":\($0)" } ?? "")"
  }

  /** Which catalog apps can sign in from where this phone reaches Bubble AI, and why not where they can't. */
  func signInOptions() async throws -> [String: SignInOption] {
    guard let origin = hubOrigin else { return [:] }
    return try await fetch { try await $0.get("/api/connectors/sign-in", ["origin": origin]) }
  }

  /**
   * Connect catalog apps by signing in: the hub makes the connectors and hands back its sign-in
   * page, which the app opens in the system browser sheet. Bubble AI's hub does the sign-in; the app
   * never sees a password or a token. Several apps from one company share one sign-in.
   */
  /**
   * Make it yours (round 7): the person's picks go to the agent as their first message in its chat;
   * it answers with the apps it suggests connecting (or Bubble AI's own short list when it can't).
   * Its creator only, once per agent: a second send is refused (409) and changes nothing.
   */
  func sendSetupPicks(_ agentId: String, text: String, goals: [String]) async throws {
    struct Sent: Decodable { var messageId: String; var channelId: String; var answered: Bool }
    let body: Fields = ["text": AnyEncodable(text), "goals": AnyEncodable(goals)]
    let _: Sent = try await fetch { try await $0.post("/api/agents/\(agentId)/setup-picks", body) }
    await refreshChannels()
  }

  func connectApps(_ catalogIds: [String]) async throws -> ConnectStart {
    guard let origin = hubOrigin else { throw API.Failure(status: 0, message: "Bubble AI isn't connected.") }
    let body: Fields = ["catalogIds": AnyEncodable(catalogIds), "origin": AnyEncodable(origin), "returnTo": AnyEncodable("close"), "allAgents": AnyEncodable(true)]
    let start: ConnectStart = try await fetch { try await $0.post("/api/connectors/connect", body) }
    try? await refreshConnectors()
    return start
  }

  /** Back from an app hub's own page (Composio's Pick apps): ask which apps are picked now, and show it. */
  func recheckLinkedApps(_ connectorId: String) async {
    struct Answer: Decodable { var linkedApps: LinkedApps? }
    let _: Answer? = try? await fetch { try await $0.get("/api/connectors/\(connectorId)/linked-apps") }
    try? await refreshConnectors()
  }

  /** One read to check a key works. A hub that can't say counts as unchecked, not as wrong. */
  func checkConnector(_ id: String) async -> ConnectorCheck {
    let check: ConnectorCheck? = try? await fetch { try await $0.post("/api/connectors/\(id)/check", Empty()) }
    return check ?? ConnectorCheck(ok: true, checked: false)
  }

  func agentHarnessStatus(_ agentId: String) async -> AgentHarnessStatus? {
    try? await fetch { try await $0.get("/api/agents/\(agentId)/harness") }
  }

  /** An agent made with greet "later" says its hello now: "sent", "already", "signin", or still on its way. */
  func greet(_ agentId: String) async -> String? {
    struct Result: Decodable { var status: String }
    let r: Result? = try? await fetch { try await $0.post("/api/agents/\(agentId)/greet", Empty()) }
    return r?.status
  }

  /** What its hello read in your apps just before it. Only its creator gets any back. */
  func helloRead(_ agentId: String) async -> [HelloRead.App] {
    let r: HelloRead? = try? await fetch { try await $0.get("/api/agents/\(agentId)/hello-read") }
    return r?.read ?? []
  }

  func watches() async -> [AppWatch] {
    struct List: Decodable { var watches: [AppWatch] }
    let r: List? = try? await fetch { try await $0.get("/api/watches") }
    return r?.watches ?? []
  }

  func setWatchPaused(_ id: String, _ paused: Bool) async throws {
    try await fetch { try await $0.raw("PATCH", "/api/watches/\(id)", body: ["paused": paused]) }
  }

  func setRoutineEnabled(_ id: String, _ enabled: Bool) async throws {
    let saved: Routine = try await fetch { try await $0.patch("/api/routines/\(id)", ["enabled": enabled]) }
    if let i = routines.firstIndex(where: { $0.id == saved.id }) { routines[i] = saved }
  }

  /** The agent's own chat, once the hub has made it. */
  func dmChannel(of agentId: String) -> Channel? { channels.first { $0.isDM && $0.name.hasSuffix(":\(agentId)") } }

  /** Is one of your own devices a Mac? Apple apps are read there. */
  var onAMac: Bool { nodes.contains { $0.mine == true && $0.capabilities?.platform == "darwin" } }

  /** Should this phone open on the first run: nobody has made an agent here yet, and this person can. */
  func wantsOnboarding() -> Bool {
    guard let id = workspace?.id, role != "guest" else { return false }
    #if DEBUG
    if envVar("ONBOARDING") == "1" { return true }
    #endif
    return agents.isEmpty && !OnboardingAnswers.load(id).closed
  }
}
