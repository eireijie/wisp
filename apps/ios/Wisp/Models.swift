import Foundation

// The hub's JSON, as packages/core/src/types.ts and computers.ts describe it. Only the fields the
// app shows are decoded; anything else the hub sends is ignored, so newer hubs keep working.

struct Actor: Codable, Hashable {
  enum Kind: String, Codable { case user, agent }
  var kind: Kind
  var id: String
}

struct User: Codable, Identifiable, Hashable {
  var id: String
  var email: String
  var name: String
  var preferredName: String?
  var timezone: String?
}

struct Workspace: Codable, Hashable {
  var id: String
  var name: String
}

struct Me: Codable {
  struct Prefs: Codable { var experience: String?; var sendWith: String?; var clock: String?; var toolCalls: String?; var sidebar: SidebarLayout?; var learn: LearnProgress?; var background: OptionalBackground? }
  var prefs: Prefs?
  var kind: String
  var user: User?
  var role: String?
  /** owner of the hub's first workspace: only they can make new workspaces; missing on older hubs */
  var hubOwner: Bool?
  var workspace: Workspace?
  /** resolved by the hub for the current organization; missing on older hubs (everything on) */
  var features: Features?
}

struct Member: Codable, Identifiable, Hashable {
  var id: String
  var email: String
  var name: String
  var preferredName: String?
  var role: String
}

struct GhostLook: Codable, Hashable {
  var color: String
  var color2: String?
  var eyes: String?
  var mouth: String?
  var cheeks: Bool?
  var shape: String?
  var glow: Bool?
  var hat: String?
  var accessory: String?
  var motion: String?
  /** the bubble's shape (2026-11-25); unset on looks saved before bubbles, which show as "round" */
  var bubble: String? = nil
  /** true once eyes, mouth, hat, wear and motion were picked for the bubble (web PR 132); unset looks show plain eyes and nothing worn */
  var parts: Bool? = nil
  /** a photo shown instead of the bubble (a hub file, /api/files/<id>; round 11 board 12) */
  var photo: String? = nil
  /** fields this version doesn't know, kept as they came so saving never drops them */
  var extra: [String: JSONAny] = [:]
}

extension GhostLook {
  private struct Key: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ s: String) { stringValue = s }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
  }
  private static let known: Set<String> = ["color", "color2", "eyes", "mouth", "cheeks", "shape", "glow", "hat", "accessory", "motion", "bubble", "parts", "photo"]

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Key.self)
    func s(_ k: String) -> String? { try? c.decodeIfPresent(String.self, forKey: Key(k)) }
    func b(_ k: String) -> Bool? { try? c.decodeIfPresent(Bool.self, forKey: Key(k)) }
    self.init(color: s("color") ?? "#f4f1ff", color2: s("color2"), eyes: s("eyes"), mouth: s("mouth"), cheeks: b("cheeks"), shape: s("shape"),
              glow: b("glow"), hat: s("hat"), accessory: s("accessory"), motion: s("motion"), bubble: s("bubble"), parts: b("parts"), photo: s("photo"))
    for key in c.allKeys where !Self.known.contains(key.stringValue) {
      if let v = try? c.decode(JSONAny.self, forKey: key) { extra[key.stringValue] = v }
    }
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: Key.self)
    try c.encode(color, forKey: Key("color"))
    try c.encodeIfPresent(color2, forKey: Key("color2"))
    try c.encodeIfPresent(eyes, forKey: Key("eyes"))
    try c.encodeIfPresent(mouth, forKey: Key("mouth"))
    try c.encodeIfPresent(cheeks, forKey: Key("cheeks"))
    try c.encodeIfPresent(shape, forKey: Key("shape"))
    try c.encodeIfPresent(glow, forKey: Key("glow"))
    try c.encodeIfPresent(hat, forKey: Key("hat"))
    try c.encodeIfPresent(accessory, forKey: Key("accessory"))
    try c.encodeIfPresent(motion, forKey: Key("motion"))
    try c.encodeIfPresent(bubble, forKey: Key("bubble"))
    try c.encodeIfPresent(parts, forKey: Key("parts"))
    try c.encodeIfPresent(photo, forKey: Key("photo"))
    for (k, v) in extra where !Self.known.contains(k) { try c.encode(v, forKey: Key(k)) }
  }
}

/** Any JSON value, kept as it came (for fields a newer hub sends that this version doesn't know). */
indirect enum JSONAny: Codable, Hashable, Sendable {
  case string(String), number(Double), bool(Bool), array([JSONAny]), object([String: JSONAny]), null

  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() { self = .null }
    else if let v = try? c.decode(Bool.self) { self = .bool(v) }
    else if let v = try? c.decode(Double.self) { self = .number(v) }
    else if let v = try? c.decode(String.self) { self = .string(v) }
    else if let v = try? c.decode([JSONAny].self) { self = .array(v) }
    else { self = .object(try c.decode([String: JSONAny].self)) }
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .string(let v): try c.encode(v)
    case .number(let v): try c.encode(v)
    case .bool(let v): try c.encode(v)
    case .array(let v): try c.encode(v)
    case .object(let v): try c.encode(v)
    case .null: try c.encodeNil()
    }
  }
}

struct Agent: Codable, Identifiable, Hashable {
  struct Settings: Codable, Hashable {
    var appearance: GhostLook?
    var description: String?
    var effort: String?
    var fast: Bool?
    var soulLocked: Bool?
    /** its harness may load the device owner's own plugins and helpers (off unless set; only that owner turns it on) */
    var ownPlugins: Bool?
    /** its people's own computers it may use, by device id: "ask" first or "tell" after; left out it can't */
    var useDevices: [String: String]?
    var anyoneCanAsk: Bool?
    var role: String?
    var roleNotes: String?
    var runIn: String?
    var headless: Bool?
    /** what it may do on its device: "read-only", "edit" (the default) or "full" */
    var access: String?
    /** the voice it speaks with, per speech engine */
    var voice: AgentVoice?
    /** who it answers: "me" (its creator), "anyone", or "people" (respondPeople); unset is anyone */
    var respondTo: String?
    var respondPeople: [String]?
    /** the person who made it; they (or an owner) decide who it answers */
    var createdBy: String?
    /** the model connection it runs on (Settings → Models); nil runs on its computer's own sign-in */
    var connectionId: String?
    /** its first chat with the person it works for: the hello Bubble AI wrote for it, then a few questions */
    var setup: AgentSetup?
    /** its own chat background (the profile's Background tab); nil uses the person's default */
    var background: OptionalBackground?
  }
  enum Status: String, Codable { case online, busy, offline }

  var id: String
  var handle: String
  var name: String
  var harness: String
  var model: String?
  var nodeId: String?
  var computerId: String?
  var groups: [String]?
  var settings: Settings?
  var status: Status
  /** set by the hub while its harness is known not to be signed in where it runs, so it can't answer yet */
  var signIn: AgentSignIn?
  var instructions: String?

  /** online, but it can't answer until someone signs its harness in where it runs */
  var needsSignIn: Bool { status == .online && signIn != nil }
}

/** Where an agent's harness needs signing in: its device, or its own computer (a VM) when it runs in there. */
struct AgentSignIn: Codable, Hashable {
  var harness: String
  /** the device or computer's name */
  var where_: String
  var nodeId: String
  /** set when it runs inside its own computer: the sign-in happens on that computer's screen */
  var computerId: String?
  var account: String?
  enum CodingKeys: String, CodingKey { case harness, where_ = "where", nodeId, computerId, account }
}

struct Channel: Codable, Identifiable, Hashable {
  var id: String
  var name: String
  var kind: String // "channel" | "dm"
  var topic: String
  var sectionId: String?
  var joined: Bool?
  var memberCount: Int?
  /** the agents in it, in the order they joined (the first few); nil from older hubs */
  var agentIds: [String]?
  var unread: Int?
  var lastReadAt: String?
  var createdAt: String

  struct Settings: Codable, Hashable {
    var defaultAgentId: String?
    var replyInThread: Bool?
    var instructions: String?
    /** the channel's agent team, drawn as a flow chart; nil = no team (only @mentioned agents, or defaultAgentId, answer) */
    var team: ChannelTeam?
    /** the image chosen as the team's icon; nil = its first two agents' ghosts */
    var iconFileId: String?
  }
  var `private`: Bool?
  var archivedAt: String?
  var settings: Settings?
  var notify: String?
  var starred: Bool?
  var pinnedIds: [String]?
  /** when the newest message was sent, from the channel list (messages themselves load per chat) */
  struct Last: Codable, Hashable { var at: String }
  var last: Last?
  /** a DM with an agent: whether it waits on you ("waiting", "done", "closed"), and what the agent comes back to next (Loops.swift) */
  var loop: ChatLoopState?
  var next: ChatNext?

  var isDM: Bool { kind == "dm" }
  var isMuted: Bool { notify == "mute" }
  var badge: Int { isMuted || archivedAt != nil || joined == false ? 0 : unread ?? 0 }
}

/**
 * A channel's agent team (ChannelTeam in packages/core/src/types.ts). Leads read every new message;
 * an edge means "hands work to". x and y are where each agent sits on the web's flow chart.
 */
struct ChannelTeam: Codable, Hashable {
  struct Node: Codable, Hashable {
    var agentId: String
    var lead: Bool
    var x: Double
    var y: Double
    /** its role on this team and what that role means; nil = none */
    var role: String? = nil
    var roleNotes: String? = nil
  }
  struct Edge: Codable, Hashable {
    var from: String
    var to: String
  }
  var nodes: [Node]
  var edges: [Edge]
  /** a memory folder the whole team shares, e.g. teams/web; nil or "" = none */
  var folder: String? = nil
  /** the git repository it codes in, and the branch work merges into */
  var repo: String? = nil
  var baseBranch: String? = nil
  /** an agent outside the team it reports to */
  var reportsTo: String? = nil
  /** roles and the steps they take (TeamFlow.swift); with these the team runs step by step, nil = a plain chart */
  var roles: [Role]? = nil
  var steps: [Step]? = nil

  static let empty = ChannelTeam(nodes: [], edges: [])

  /** A job on the team (TeamRole in packages/core): every agent on the team reads its description. */
  struct Role: Codable, Hashable, Identifiable {
    var id: String
    var name: String
    var description: String
    /** nil until someone picks an agent for it */
    var agentId: String?
    /** the harness a template suggests for it; only a hint */
    var harness: String? = nil

    private enum K: String, CodingKey { case id, name, description, agentId, harness }
    // the hub wants agentId even when nobody fills the role yet
    func encode(to encoder: Encoder) throws {
      var c = encoder.container(keyedBy: K.self)
      try c.encode(id, forKey: .id)
      try c.encode(name, forKey: .name)
      try c.encode(description, forKey: .description)
      try c.encode(agentId, forKey: .agentId)
      try c.encodeIfPresent(harness, forKey: .harness)
    }
  }
}

struct Reaction: Codable, Hashable {
  var emoji: String
  var actors: [Actor]
}

enum MessagePart: Codable, Hashable {
  /** a tool the agent used: its name, one line of what it did ("Read main.ts"), and what it saved to memory when that's what it was */
  case toolCall(name: String, line: String = "", remembered: Remembered? = nil)
  case file(fileId: String, name: String)
  case status(String)
  /** the run this message reports failed: why in one line, and the one fix (install, sign in, choose device, try again) */
  case runFailed(RunFailure)
  case notice(String)
  /** the summary a /compact asked for: shown collapsed, not as a normal message */
  case summary
  case computer(computerId: String, request: String?)
  case approval(approvalId: String)
  case change(changeId: String)
  case task(taskId: String)
  case routine(routineId: String)
  case discussion(discussionId: String)
  /** an agent's answer to /context: how full its conversation is (nil before its first reply) */
  case context(ContextUsage?)
  /** something the agent will come back to, as a pill under its reply ("Check the build · 4:35 PM") */
  case followup(FollowupPill)
  /** the agent came back on its own: "Checking back" over the bubble, and quick answers under it */
  case checkback(replies: [String])
  /** the agent finished what the chat was about: Did / Saved / Next */
  case wrapup(WrapUp)
  /** the agent dropped what the chat was about after no answer */
  case closed
  /** the agent saved a skill during this reply ("learned") or followed one ("used"): a quiet line under it */
  case skill(action: String, skillId: String, slug: String)
  /** what an agent read through the Apple mod during this reply ("Read your last 5 texts with Sam"): a quiet line with the app's icon */
  case appleRead(app: String, text: String)
  /** apps the agent suggests connecting, each with a one-tap Connect (round 7's connect_suggest; Composio always first) */
  case connect([ConnectSuggestion])
  case other(String)

  /** what an agent saved about someone during a reply (the "Remembered" chip): the kind of note, its words, and the note it went to */
  struct Remembered: Codable, Hashable {
    var kind: String
    var text: String
    var path: String?
  }

  private enum K: String, CodingKey { case runId, retry, fix, reason, why, harness, nodeId, type, name, fileId, text, computerId, request, approvalId, changeId, taskId, routineId, discussionId, usage, input, output, replies, did, saved, next, action, skillId, slug, app, apps }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: K.self)
    let type = (try? c.decode(String.self, forKey: .type)) ?? ""
    switch type {
    case "tool_call":
      let name = (try? c.decode(String.self, forKey: .name)) ?? "tool"
      let input = (try? c.decode([String: LooseValue].self, forKey: .input)) ?? [:]
      let output = (try? c.decode(LooseValue.self, forKey: .output))?.text ?? ""
      self = .toolCall(name: name, line: ToolLine.of(name, input: input), remembered: ToolLine.remembered(name, input: input, output: output))
    case "file": self = .file(fileId: (try? c.decode(String.self, forKey: .fileId)) ?? "", name: (try? c.decode(String.self, forKey: .name)) ?? "file")
    case "status": self = .status((try? c.decode(String.self, forKey: .text)) ?? "")
    case "run_failed":
      let str = { (k: K) -> String? in (try? c.decode(String.self, forKey: k)).flatMap { $0.isEmpty ? nil : $0 } }
      self = .runFailed(RunFailure(runId: str(.runId) ?? "", retry: (try? c.decode(Bool.self, forKey: .retry)) ?? false, fix: str(.fix), reason: str(.reason), why: str(.why), harness: str(.harness), nodeId: str(.nodeId)))
    case "summary": self = .summary
    case "notice": self = .notice((try? c.decode(String.self, forKey: .text)) ?? "")
    case "computer": self = .computer(computerId: (try? c.decode(String.self, forKey: .computerId)) ?? "", request: try? c.decode(String.self, forKey: .request))
    case "approval": self = .approval(approvalId: (try? c.decode(String.self, forKey: .approvalId)) ?? "")
    case "change": self = .change(changeId: (try? c.decode(String.self, forKey: .changeId)) ?? "")
    case "task": self = .task(taskId: (try? c.decode(String.self, forKey: .taskId)) ?? "")
    case "routine": self = .routine(routineId: (try? c.decode(String.self, forKey: .routineId)) ?? "")
    case "discussion": self = .discussion(discussionId: (try? c.decode(String.self, forKey: .discussionId)) ?? "")
    case "context": self = .context(try? c.decode(ContextUsage.self, forKey: .usage))
    case "followup":
      // one without an id or a label can't be shown or changed
      guard let pill = try? FollowupPill(from: decoder), !pill.followupId.isEmpty, !pill.label.isEmpty else { self = .other(type); return }
      self = .followup(pill)
    case "checkback": self = .checkback(replies: (try? c.decode([String].self, forKey: .replies)) ?? [])
    case "wrapup":
      let line = { (k: K) in ((try? c.decode(String.self, forKey: k)) ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
      self = .wrapup(WrapUp(did: line(.did), saved: line(.saved), next: line(.next)))
    case "closed": self = .closed
    case "skill":
      let slug = (try? c.decode(String.self, forKey: .slug)) ?? ""
      guard !slug.isEmpty else { self = .other(type); return }
      self = .skill(action: (try? c.decode(String.self, forKey: .action)) ?? "used", skillId: (try? c.decode(String.self, forKey: .skillId)) ?? "", slug: slug)
    case "apple_read":
      let text = (try? c.decode(String.self, forKey: .text)) ?? ""
      guard !text.isEmpty else { self = .other(type); return }
      self = .appleRead(app: (try? c.decode(String.self, forKey: .app)) ?? "", text: text)
    case "connect":
      let apps = ((try? c.decode([LossyItem<ConnectSuggestion>].self, forKey: .apps)) ?? []).compactMap(\.value)
      self = apps.isEmpty ? .other(type) : .connect(apps)
    default: self = .other(type)
    }
  }

  func encode(to encoder: Encoder) throws {} // never sent back to the hub
}

/** One app an agent suggests connecting (ConnectSuggestion in packages/core/src/types.ts). */
struct ConnectSuggestion: Codable, Hashable, Identifiable {
  /** a catalog id (ConnectorCatalog.json) */
  var id: String
  var name: String
  var why: String
  /** always recommended (Composio): shown with a "Recommended" mark */
  var recommended: Bool?
}

/** One item of a list that may hold ones this app can't read: those are skipped, not the whole list. */
struct LossyItem<T: Decodable>: Decodable {
  var value: T?
  init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

/**
 * A reply that failed (the run_failed part): why, as a code and one plain line, and the one fix.
 * fix is "install" (with harness and nodeId), "signin" / "computer" / "connection", or "device".
 */
struct RunFailure: Hashable {
  var runId: String
  var retry: Bool
  var fix: String?
  var reason: String?
  var why: String?
  var harness: String?
  var nodeId: String?

  enum Action: Equatable { case install, signIn, device, retry, none }
  /** The one button it offers, like the web's fixAction. */
  var action: Action {
    if fix == "install", nodeId != nil, harness != nil { return .install }
    if fix == "signin" || fix == "computer" || fix == "connection" { return .signIn }
    if fix == "device" { return .device }
    return retry ? .retry : .none
  }
  /** The short reason on the line. */
  var line: String { let t = why?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""; return t.isEmpty ? "Couldn't finish." : t }
}

/** The message a reply answers: who said it and a few of their words (ReplyQuote in packages/core/src/types.ts). */
struct ReplyQuote: Codable, Hashable {
  var id: String
  var author: Actor
  var snippet: String
  var deleted: Bool?
  /** when the quoted message was written, and the chat it's in (top-level messages): a quote from an earlier chat shows its date */
  var createdAt: String?
  var conversationId: String?
}

/** An earlier chat a message brings back (a reply into it, or an agent checking back on it): its id and when it started. */
struct MessageContext: Codable, Hashable {
  var conversationId: String
  var at: String

  var date: Date { Wire.date(at) ?? .distantPast }
}

/** A JSON value read loosely, for the parts of a tool call the app only shows as words. */
enum LooseValue: Decodable, Hashable {
  case string(String), number(Double), bool(Bool), null, other

  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if let s = try? c.decode(String.self) { self = .string(s) }
    else if let n = try? c.decode(Double.self) { self = .number(n) }
    else if let b = try? c.decode(Bool.self) { self = .bool(b) }
    else if c.decodeNil() { self = .null }
    else { self = .other }
  }

  var text: String? { if case .string(let s) = self { s } else { nil } }
}

struct Message: Codable, Identifiable, Hashable {
  var id: String
  var channelId: String
  var threadId: String?
  var author: Actor
  var body: String
  var parts: [MessagePart]
  var reactions: [Reaction]?
  /** set when this replies to another message in the same chat: a quote, not a thread */
  var replyToId: String?
  var replyTo: ReplyQuote?
  /** the chat it's part of at the top of a DM or team (the id of the chat's first message); threads have none, nor do old hubs */
  var conversationId: String? = nil
  /** an earlier chat this message brings back */
  var context: MessageContext? = nil
  var createdAt: String
  /** set when its author changed the text */
  var editedAt: String?
  /** set when it was deleted but kept so its thread's replies stay reachable; body and parts are empty */
  var deletedAt: String?

  var date: Date { Wire.date(createdAt) ?? .distantPast }
  var files: [(id: String, name: String)] { parts.compactMap { if case .file(let id, let name) = $0 { (id, name) } else { nil } } }
}

/** How full an agent's conversation is (ContextUsage in packages/core/src/types.ts). */
struct ContextUsage: Codable, Hashable {
  var model: String?
  var contextUsed: Int?
  var contextWindow: Int?
}

/** Agents talking something through in rounds in a thread, then a decision (Discussion + progress). */
struct Discussion: Codable, Identifiable, Hashable {
  struct Progress: Codable, Hashable { var agentId: String; var status: String }
  var id: String
  var channelId: String
  var threadId: String
  var topic: String
  var participants: [String]
  var moderatorId: String
  var rounds: Int
  /** 0 before it starts; rounds + 1 while the moderator writes the decision */
  var round: Int
  var status: String // running | summarizing | done | cancelled
  var decisionPath: String?
  var progress: [Progress]?

  var live: Bool { status == "running" || status == "summarizing" }
}

struct MessagePage: Codable {
  var messages: [Message]
  /** replies per message; in a thread, per reply (any reply can start a sub-thread) */
  var replyCounts: [String: Int]
}

struct Computer: Codable, Identifiable, Hashable {
  struct Controller: Codable, Hashable { var id: String; var since: String }
  struct Help: Codable, Hashable { var agentId: String; var request: String; var channelId: String; var threadId: String?; var at: String? }

  var id: String
  var name: String
  var kind: String // device | vm | orgo
  var nodeId: String?
  var status: String // ready | starting | stopped | offline | error
  var statusText: String
  var paused: Bool?
  var controller: Controller?
  var help: Help?
  /** "pin" or "password" when opening this screen needs the code picked at the device */
  var code: String?
  /** whether its device is connected (older hubs don't say) */
  var online: Bool?
  /** a device's own screen: whose it is */
  var ownerId: String?
  /** the agents that use it */
  var agents: [String]?
  /** what an agent did on it last */
  var activity: Activity?
  struct Activity: Codable, Hashable { var agentId: String; var text: String; var at: String }

  /** The word for this screen's code. */
  var codeLabel: String { code == "pin" ? "PIN" : "password" }

  var kindLabel: String {
    switch kind {
    case "vm": "Computer on a device"
    case "orgo": "Cloud computer"
    default: "Device screen"
    }
  }
}

struct Approval: Codable, Identifiable, Hashable {
  var id: String
  var agentId: String
  var channelId: String
  var threadId: String?
  var summary: String
  var details: String
  var status: String // pending | approved | denied
  var decidedBy: String?
  var note: String
  var createdAt: String
  var decidedAt: String?
  /** set when an agent asks to use a login from the password manager: only whoever connected it decides */
  var login: Login?

  struct Login: Codable, Hashable {
    var title: String
    var site: String
    var username: String?
    var source: String?
    var ownerId: String
  }
  /** set when it's an ask-me step of a team's flow: deciding it moves that request on */
  var flow: Flow? = nil
  struct Flow: Codable, Hashable { var flowId: String; var stepId: String }
  /** set when an agent asks to add, replace or delete a file on a storage (the Storage mod): owners decide */
  var storage: Storage? = nil
  struct Storage: Codable, Hashable {
    var connectionName: String
    var service: String
    var action: String // upload | replace | delete | mkdir
    var path: String
    var size: Int?
  }
  /** set when an agent asks to send a text or change an event or reminder (the Apple mod) */
  var apple: AppleRequest? = nil
}

struct Frame { var image: Data; var width: Int; var height: Int }

enum Wire {
  static let decoder = JSONDecoder()
  nonisolated(unsafe) private static let isoFrac: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()
  nonisolated(unsafe) private static let iso = ISO8601DateFormatter()

  private static let day: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    f.isLenient = false
    return f
  }()
  static func date(_ s: String) -> Date? { isoFrac.date(from: s) ?? iso.date(from: s) ?? (s.count == 10 ? day.date(from: s) : nil) }
  static func now() -> String { isoFrac.string(from: Date()) }
}

extension Channel {
  /** The name people read: a slug like "audit-crew" reads "Audit crew"; a name someone typed stays as typed. */
  var label: String { Channel.label(name) }

  static func label(_ name: String) -> String {
    guard !name.contains(" "), name == name.lowercased(), name.contains(where: { $0 == "-" || $0 == "_" }) else { return name }
    let words = name.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
    return words.prefix(1).uppercased() + words.dropFirst()
  }
}
