import Foundation

/**
 * The optional features an organization switches on in Settings → Mods (packages/core/src/features.ts).
 * A hub that doesn't send features (older hubs, older organizations) means everything is on.
 */
struct Features: Codable, Hashable {
  var background = true
  var routines = true
  var teach = true
  var tasks = true
  var voice = true
  var buddy = true
  var invite = true
  var remoteDesktop = true

  static let everything = Features()
  static let simple = Features(background: false, routines: false, teach: false, tasks: false, voice: false, buddy: false, invite: false, remoteDesktop: false)

  init(background: Bool = true, routines: Bool = true, teach: Bool = true, tasks: Bool = true, voice: Bool = true, buddy: Bool = true, invite: Bool = true, remoteDesktop: Bool = true) {
    self.background = background; self.routines = routines; self.teach = teach
    self.tasks = tasks; self.voice = voice; self.buddy = buddy; self.invite = invite; self.remoteDesktop = remoteDesktop
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: FeatureKey.self)
    self.init()
    for key in FeatureKey.allCases { self[key] = (try? c.decodeIfPresent(Bool.self, forKey: key)) ?? true }
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: FeatureKey.self)
    for key in FeatureKey.allCases { try c.encode(self[key], forKey: key) }
  }

  subscript(key: FeatureKey) -> Bool {
    get {
      switch key {
      case .background: background
      case .routines: routines
      case .teach: teach
      case .tasks: tasks
      case .voice: voice
      case .buddy: buddy
      case .invite: invite
      case .remoteDesktop: remoteDesktop
      }
    }
    set {
      switch key {
      case .background: background = newValue
      case .routines: routines = newValue
      case .teach: teach = newValue
      case .tasks: tasks = newValue
      case .voice: voice = newValue
      case .buddy: buddy = newValue
      case .invite: invite = newValue
      case .remoteDesktop: remoteDesktop = newValue
      }
    }
  }

  var onCount: Int { FeatureKey.allCases.filter { self[$0] }.count }
  /** Simple (all off), Everything (all on) or Custom, as the Quick start control shows it. */
  var preset: String { onCount == 0 ? "simple" : onCount == FeatureKey.allCases.count ? "everything" : "custom" }
}

enum FeatureKey: String, CaseIterable, CodingKey, Identifiable {
  case background, routines, teach, tasks, voice, buddy, invite, remoteDesktop
  var id: String { rawValue }

  enum Group: String, CaseIterable {
    case own, many, extras
    var title: String {
      switch self {
      case .own: "Agents on their own"
      case .many: "Organizing many agents"
      case .extras: "Extras"
      }
    }
    var keys: [FeatureKey] { FeatureKey.allCases.filter { $0.group == self } }
  }

  var name: String {
    switch self {
    case .background: "Background agents"
    case .routines: "Routines"
    case .teach: "Teach a task"
    case .tasks: "Tasks board"
    case .voice: "Voice calls"
    case .buddy: "Desk buddy"
    case .invite: "Invite people"
    case .remoteDesktop: "Remote desktop"
    }
  }

  var detail: String {
    switch self {
    case .background: "Agents check your apps on their own and message you first."
    case .routines: "Run a task on a schedule, like a morning summary."
    case .teach: "Do something once while an agent watches, and it becomes a skill."
    case .tasks: "Give out work and track it from start to done."
    case .voice: "Call an agent and talk instead of typing."
    case .buddy: "A small ghost on your desktop that shows what your agents are up to."
    case .invite: "Let other people into this workspace. Adds a People page and lets agents answer more than just you."
    case .remoteDesktop: "Reach your devices from anywhere with RustDesk, from each device's page."
    }
  }

  var group: Group {
    switch self {
    case .background, .routines, .teach: .own
    case .tasks: .many
    case .voice, .buddy, .invite, .remoteDesktop: .extras
    }
  }

  var symbol: String {
    switch self {
    case .background: "bell.badge"
    case .routines: "clock"
    case .teach: "record.circle"
    case .tasks: "checklist"
    case .voice: "phone"
    case .buddy: "theatermask.and.paintbrush"
    case .invite: "person.badge.plus"
    case .remoteDesktop: "display"
    }
  }
}

struct FeaturesResponse: Decodable { var features: Features }

/** An organization you belong to, as the switcher lists it (GET /api/orgs). */
struct OrgSummary: Decodable, Identifiable, Hashable {
  var id: String
  var name: String
  var role: String?
  var members: Int?
  var agents: Int?
  var current: Bool?
  var unread: Bool?
  /** you own it, it is not the first organization, and you are in another one */
  var canDelete: Bool?

  var subtitle: String {
    let people = members ?? 1, bots = agents ?? 0
    let who = people <= 1 ? "Just you" : "\(people) people"
    return "\(who) · \(bots) \(bots == 1 ? "agent" : "agents")"
  }
}

struct OrgCreated: Decodable {
  struct Org: Decodable { var id: String; var name: String }
  var org: Org?
  var token: String
}

struct SessionToken: Decodable { var token: String }

/** What "Use my defaults" fills in for a new agent (GET /api/settings/agent-defaults). */
struct AgentDefaults: Codable, Hashable {
  var harness: String?
  var model: String?
  var computer: String? // "own-vm" | "none"
  var nodeId: String?
  /** a default model for each AI tool (harness id to model id) */
  var models: [String: String]?
}
