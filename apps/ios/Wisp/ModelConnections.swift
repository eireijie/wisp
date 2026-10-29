import Foundation

/**
 * Models are the brain, harnesses the body. A person connects a model provider once (a sign-in on
 * their subscription, or an API key); the hub keeps it and hands it to whichever device or VM runs
 * an agent on it. These mirror packages/core/src/models.ts and apps/hub/src/api-models.ts.
 */

/** What a run's plan usage looks like: the busiest window, and each one. */
struct PlanUsage: Decodable, Equatable, Hashable {
  struct Window: Decodable, Equatable, Hashable { var window: String; var usedFraction: Double; var resetsAt: String? }
  var window: String
  var usedFraction: Double
  var resetsAt: String?
  var planType: String?
  var windows: [Window]?
  var capturedAt: String?
}

/** A connection as people see it (GET /api/model-connections): never the secret. */
struct ModelConnection: Decodable, Identifiable, Equatable, Hashable {
  struct User: Decodable, Equatable, Hashable { var id: String; var handle: String; var name: String }
  var id: String
  var provider: String
  var kind: String
  var label: String
  var account: String?
  var plan: String?
  var keyHint: String?
  var lastError: String?
  var usage: PlanUsage?
  var usedBy: [User]?
  var harnesses: [String]?
  var mine: Bool?

  var isSignIn: Bool { kind == "oauth" }
}

/** The connection an agent runs on, as /context and /models report it. */
struct RunConnection: Decodable, Equatable, Hashable {
  var id: String
  var provider: String
  var kind: String
  var label: String?
  var account: String?
  var plan: String?
  var mine: Bool?
}

/** A model a connection offers (GET /api/model-connections/:id/models). */
struct ConnectionModel: Decodable, Identifiable, Equatable, Hashable {
  var id: String
  var label: String
  var description: String?
  var efforts: [String]?
  var defaultEffort: String?
  var contextWindow: Int?
}

struct ConnectionModels: Decodable {
  var connectionId: String?
  var provider: String?
  var harness: String?
  var models: [ConnectionModel]
  var efforts: [String]?
}

/** A provider people can connect (GET /api/model-providers). */
struct ModelProviderInfo: Decodable, Identifiable, Equatable {
  struct SignIn: Decodable, Equatable { var harness: String; var hermesProvider: String? }
  var id: String
  var label: String
  var signInLabel: String?
  var site: String
  var keyUrl: String
  var keyPrefix: String?
  var signIn: [SignIn]?

  var canSignIn: Bool { !(signIn ?? []).isEmpty }
}

/** One row of the support table: this harness can use this kind of connection to this provider. */
struct CredentialSupport: Decodable, Equatable {
  var harness: String
  var provider: String
  var kind: String
}

struct ModelProvidersResponse: Decodable {
  var providers: [ModelProviderInfo]
  var support: [CredentialSupport]
}

/** A sign-in running on one of the person's devices: the link and code to show, then done. */
struct ModelLogin: Decodable, Equatable {
  var id: String
  var provider: String
  var harness: String?
  var status: String
  var url: String?
  var code: String?
  var wantsInput: Bool?
  var output: String?
  var error: String?
  var connectionId: String?
  var nodeId: String?

  var running: Bool { status == "running" }
}

/** Settings → Harnesses: every harness on every computer (each device, and each VM). */
struct HarnessComputer: Decodable, Identifiable, Equatable {
  struct Harness: Decodable, Identifiable, Equatable {
    var id: String
    var label: String
    var version: String?
    var agents: [ModelConnection.User]
  }
  var id: String
  var kind: String
  var name: String
  var nodeId: String
  var online: Bool
  var reported: Bool
  var harnesses: [Harness]

  var isVM: Bool { kind == "vm" }
}

struct HarnessComputersResponse: Decodable { var computers: [HarnessComputer] }

/** Words and numbers the model screens share; kept here so they're tested once. */
enum ModelWords {
  /** Labels the hub uses (MODEL_PROVIDER_INFO), for when the provider list hasn't loaded. */
  static func provider(_ id: String) -> String {
    switch id {
    case "anthropic": "Claude"
    case "openai": "ChatGPT"
    case "openrouter": "OpenRouter"
    case "google": "Gemini"
    case "xai": "Grok"
    default: id.prefix(1).uppercased() + id.dropFirst()
    }
  }

  /** The order the "Not connected" list and the connect screen use. */
  static let providers = ["anthropic", "openai", "openrouter", "google", "xai"]

  /** A plain line icon for a harness (never a brand logo). */
  static func harnessSymbol(_ id: String) -> String {
    switch id {
    case "claude-code": "asterisk"
    case "codex": "chevron.left.forwardslash.chevron.right"
    case "hermes": "chevron.up"
    case "pi": "circle.circle"
    case "opencode", "custom": "terminal"
    case "gemini": "sparkle"
    case "cursor": "cursorarrow"
    default: "terminal"
    }
  }

  /** "Signed in · Max" or "Key ····a91f": the grey caption over a connection's models. */
  static func connectionCaption(kind: String, plan: String?, keyHint: String?) -> String {
    if kind == "oauth" { return ["Signed in", plan].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ") }
    return keyHint.map { "Key ····\($0)" } ?? "API key"
  }

  /** Settings → Models row: "Signed in · Claude Max · yug@…" or "API key ····a91f". */
  static func connectionDetail(_ c: ModelConnection) -> String {
    if c.isSignIn {
      let plan = c.plan.map { "\(provider(c.provider)) \($0)" }
      return (["Signed in", plan, c.account] as [String?]).compactMap { $0 }.joined(separator: " · ")
    }
    return c.keyHint.map { "API key ····\($0)" } ?? "API key"
  }

  /** The quiet line over the message box: "Hermes · Opus 5.5 · High". */
  static func runLine(harness: String, model: String?, effort: String?) -> String {
    var parts = [HarnessChoice.label(harness)]
    if let model, !model.isEmpty { parts.append(model) }
    if let effort, !effort.isEmpty { parts.append(AgentLine.effort(effort)) }
    return parts.joined(separator: " · ")
  }

  /** A model id people can read when no list names it: "gpt-6.1-sol" → "gpt-6.1-sol", "anthropic/claude-x" → "claude-x". */
  static func modelLabel(_ id: String, in lists: [[(id: String, label: String)]]) -> String {
    for list in lists { if let hit = list.first(where: { $0.id == id }) { return hit.label } }
    return id.split(separator: "/").last.map(String.init) ?? id
  }

  /** How much of the plan is left: 0–100. */
  static func percentLeft(_ usage: PlanUsage) -> Int {
    max(0, min(100, Int(((1 - usage.usedFraction) * 100).rounded())))
  }

  /** "26% left · resets 1:40 AM" (a day name when it's more than a day away). */
  static func planLine(_ usage: PlanUsage, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> String {
    var text = "\(percentLeft(usage))% left"
    if let at = usage.resetsAt.flatMap(Wire.date) {
      let f = DateFormatter()
      f.locale = locale
      f.calendar = calendar
      f.timeZone = calendar.timeZone
      f.setLocalizedDateFormatFromTemplate(at.timeIntervalSince(now) > 86_400 ? "EEE j:mm" : "j:mm")
      text += " · resets \(f.string(from: at))"
    }
    return text
  }

  /** "98K of 258K" */
  static func contextLine(used: Int?, window: Int?) -> String? {
    guard let window else { return nil }
    return "\(tokens(used ?? 0)) of \(tokens(window))"
  }

  static func tokens(_ n: Int) -> String {
    if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000).replacingOccurrences(of: ".0M", with: "M") }
    if n >= 1000 { return "\(Int((Double(n) / 1000).rounded()))K" }
    return "\(n)"
  }

  /** The harnesses a connection works with, from the support table. */
  static func harnesses(for provider: String, kind: String, support: [CredentialSupport]) -> [String] {
    support.filter { $0.provider == provider && $0.kind == kind }.map(\.harness)
  }

  /** Whether `harness` can run on this connection. */
  static func supports(_ harness: String, _ c: ModelConnection, support: [CredentialSupport]) -> Bool {
    if let list = c.harnesses { return list.contains(harness) }
    return support.contains { $0.harness == harness && $0.provider == c.provider && $0.kind == c.kind }
  }

  /** The effort to keep after a model change: the old one when the new model offers it, else none. */
  static func keptEffort(_ effort: String?, offered: [String]) -> String? {
    guard let effort, !effort.isEmpty, offered.contains(effort) else { return nil }
    return effort
  }

  /** A sign-in's site, shown as "claude.ai" on the Open button. */
  static func host(_ url: String?) -> String? {
    guard let url, let host = URL(string: url)?.host() else { return nil }
    return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
  }
}

extension Store {
  func modelProviders() async throws -> ModelProvidersResponse {
    try await fetch { try await $0.get("/api/model-providers") }
  }

  func modelConnections() async throws -> [ModelConnection] {
    struct R: Decodable { var connections: [ModelConnection] }
    let r: R = try await fetch { try await $0.get("/api/model-connections") }
    return r.connections
  }

  func connectionModels(_ id: String, harness: String?, agent: String?) async throws -> ConnectionModels {
    var q: [String: String] = [:]
    if let harness { q["harness"] = harness }
    if let agent { q["agent"] = agent }
    return try await fetch { try await $0.get("/api/model-connections/\(id)/models", q) }
  }

  /** Connect an API key; the hub checks it with the provider before keeping it. */
  func connectKey(provider: String, key: String, label: String?) async throws -> ModelConnection {
    var body: Fields = ["provider": AnyEncodable(provider), "kind": AnyEncodable("key"), "key": AnyEncodable(key)]
    if let label, !label.isEmpty { body["label"] = AnyEncodable(label) }
    return try await fetch { try await $0.post("/api/model-connections", body) }
  }

  func renameConnection(_ id: String, label: String) async throws -> ModelConnection {
    try await fetch { try await $0.patch("/api/model-connections/\(id)", ["label": label]) }
  }

  func removeConnection(_ id: String) async throws {
    _ = try await fetch { try await $0.delete("/api/model-connections/\(id)") }
    try? await refreshAgents()
  }

  func startModelLogin(provider: String) async throws -> ModelLogin {
    try await fetch { try await $0.withTimeout(40).post("/api/model-connections/login", ["provider": provider]) }
  }

  func modelLogin(_ id: String) async throws -> ModelLogin {
    try await fetch { try await $0.get("/api/model-connections/login/\(id)") }
  }

  func sendModelLoginCode(_ id: String, text: String) async throws -> ModelLogin {
    try await fetch { try await $0.withTimeout(40).post("/api/model-connections/login/\(id)/input", ["text": text]) }
  }

  func cancelModelLogin(_ id: String) async {
    _ = try? await fetch { try await $0.delete("/api/model-connections/login/\(id)") }
  }

  func harnessComputers() async throws -> [HarnessComputer] {
    let r: HarnessComputersResponse = try await fetch { try await $0.get("/api/harnesses") }
    return r.computers
  }
}
