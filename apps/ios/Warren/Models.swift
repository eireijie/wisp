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
  }
  struct Edge: Codable, Hashable {
    var from: String
    var to: String
  }
  var nodes: [Node]
  var edges: [Edge]

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
  case other(String)

  private enum K: String, CodingKey { case type, name, fileId, text, computerId, request, approvalId }

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

  var date: Date { Wire.date(createdAt) ?? .distantPast }
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
