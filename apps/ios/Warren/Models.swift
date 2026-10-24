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
  struct Prefs: Codable { var experience: String?; var sendWith: String?; var clock: String?; var toolCalls: String? }
  var prefs: Prefs?
  var kind: String
  var user: User?
  var role: String?
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
}

struct Agent: Codable, Identifiable, Hashable {
  struct Settings: Codable, Hashable {
    var appearance: GhostLook?
    var description: String?
    var effort: String?
    var fast: Bool?
    var soulLocked: Bool?
    var anyoneCanAsk: Bool?
    var role: String?
    var roleNotes: String?
    var runIn: String?
    var headless: Bool?
    /** who it answers: "me" (its creator), "anyone", or "people" (respondPeople); unset is anyone */
    var respondTo: String?
    var respondPeople: [String]?
    /** the person who made it; they (or an owner) decide who it answers */
    var createdBy: String?
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
  var instructions: String?
}

struct Channel: Codable, Identifiable, Hashable {
  var id: String
  var name: String
  var kind: String // "channel" | "dm"
  var topic: String
  var sectionId: String?
  var joined: Bool?
  var memberCount: Int?
  var unread: Int?
  var lastReadAt: String?
  var createdAt: String

  struct Settings: Codable, Hashable {
    var defaultAgentId: String?
    var replyInThread: Bool?
    var instructions: String?
    /** the channel's agent team, drawn as a flow chart; nil = no team (only @mentioned agents, or defaultAgentId, answer) */
    var team: ChannelTeam?
  }
  var `private`: Bool?
  var archivedAt: String?
  var settings: Settings?
  var notify: String?
  var starred: Bool?
  var pinnedIds: [String]?

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

  static let empty = ChannelTeam(nodes: [], edges: [])
}

struct Reaction: Codable, Hashable {
  var emoji: String
  var actors: [Actor]
}

enum MessagePart: Codable, Hashable {
  case toolCall(name: String)
  case file(fileId: String, name: String)
  case status(String)
  case notice(String)
  case computer(computerId: String, request: String?)
  case approval(approvalId: String)
  case change(changeId: String)
  case task(taskId: String)
  case routine(routineId: String)
  case discussion(discussionId: String)
  /** an agent's answer to /context: how full its conversation is (nil before its first reply) */
  case context(ContextUsage?)
  case other(String)

  private enum K: String, CodingKey { case type, name, fileId, text, computerId, request, approvalId, changeId, taskId, routineId, discussionId, usage }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: K.self)
    let type = (try? c.decode(String.self, forKey: .type)) ?? ""
    switch type {
    case "tool_call": self = .toolCall(name: (try? c.decode(String.self, forKey: .name)) ?? "tool")
    case "file": self = .file(fileId: (try? c.decode(String.self, forKey: .fileId)) ?? "", name: (try? c.decode(String.self, forKey: .name)) ?? "file")
    case "status": self = .status((try? c.decode(String.self, forKey: .text)) ?? "")
    case "notice": self = .notice((try? c.decode(String.self, forKey: .text)) ?? "")
    case "computer": self = .computer(computerId: (try? c.decode(String.self, forKey: .computerId)) ?? "", request: try? c.decode(String.self, forKey: .request))
    case "approval": self = .approval(approvalId: (try? c.decode(String.self, forKey: .approvalId)) ?? "")
    case "change": self = .change(changeId: (try? c.decode(String.self, forKey: .changeId)) ?? "")
    case "task": self = .task(taskId: (try? c.decode(String.self, forKey: .taskId)) ?? "")
    case "routine": self = .routine(routineId: (try? c.decode(String.self, forKey: .routineId)) ?? "")
    case "discussion": self = .discussion(discussionId: (try? c.decode(String.self, forKey: .discussionId)) ?? "")
    case "context": self = .context(try? c.decode(ContextUsage.self, forKey: .usage))
    default: self = .other(type)
    }
  }

  func encode(to encoder: Encoder) throws {} // never sent back to the hub
}

struct Message: Codable, Identifiable, Hashable {
  var id: String
  var channelId: String
  var threadId: String?
  var author: Actor
  var body: String
  var parts: [MessagePart]
  var reactions: [Reaction]?
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
  struct Help: Codable, Hashable { var agentId: String; var request: String; var channelId: String; var threadId: String? }

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
  var config: Config?

  struct Config: Codable, Hashable {
    /** a device's own screen lent to agents: until when (nil until you stop it) */
    struct Lend: Codable, Hashable { var until: String? }
    var lend: Lend?
  }

  /** The word for this screen's code. */
  var codeLabel: String { code == "pin" ? "PIN" : "password" }

  /** Is a device's own screen lent to agents right now? */
  var lentNow: Bool {
    guard kind == "device", let lend = config?.lend else { return false }
    guard let until = lend.until else { return true }
    return (Wire.date(until) ?? .distantPast) > Date()
  }

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
  /** an agent asking to borrow a device's own screen */
  var loan: Loan?

  struct Loan: Codable, Hashable {
    var nodeId: String
    var deviceName: String
    var ownerId: String
  }
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
