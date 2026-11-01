import Foundation

// Models and plain logic for the agent screens that mirror the web's: permissions, connect,
// import, computer, personality history and voice. No views here, so it can be unit tested.

/** The voice an agent speaks with, per speech engine ("" or nil = picked for it automatically). */
struct AgentVoice: Codable, Hashable {
  var device: String?
  var openai: String?
  var elevenlabs: String?

  subscript(engine: String) -> String? {
    get { engine == "openai" ? openai : engine == "elevenlabs" ? elevenlabs : device }
    set {
      switch engine {
      case "openai": openai = newValue
      case "elevenlabs": elevenlabs = newValue
      default: device = newValue
      }
    }
  }
}

// MARK: permissions

/** What an agent may do with files and commands on its device. */
enum AgentAccess: String, CaseIterable, Identifiable {
  case readOnly = "read-only", edit, full
  var id: String { rawValue }

  /** An agent with nothing saved edits files (the hub's default). */
  static func from(_ value: String?) -> AgentAccess { value.flatMap(AgentAccess.init(rawValue:)) ?? .edit }

  var label: String {
    switch self {
    case .readOnly: "Read only"
    case .edit: "Can edit files"
    case .full: "Full access"
    }
  }

  var body: String {
    switch self {
    case .readOnly: "Reads files and answers. Can't change anything on the device."
    case .edit: "Edits files in its own working folder. Recommended."
    case .full: "No sandbox or permission checks. Only works on devices started with --allow-full-access."
    }
  }

  /** The reach of this level in plain words. */
  func scope(name: String, handle: String, device: String?) -> String {
    guard let device else { return "It has no device yet, so it can't touch any files." }
    switch self {
    case .readOnly: return "\(name) asks before changing any file on \(device)."
    case .edit: return "\(name) may change files in its own working folder on \(device) (~/.wisp/agents/\(handle)) and asks before changing files elsewhere. Some harnesses can't enforce this strictly."
    case .full: return "\(name) may change files and run commands on \(device), if \(device) allows full access (a device can refuse and drop it to Edit)."
    }
  }
}

/** One row of "In memory": a rule that gives the agent (or its folder) access to a path. */
struct AgentMemoryRule: Decodable, Identifiable {
  struct Creator: Decodable { var kind: String; var id: String }
  var id: String?
  var path: String
  var subject: MemorySubject
  var level: String
  var startup: Bool?
  var builtin: Bool?
  var createdBy: Creator?
  var rowId: String { "\(path)|\(subject.kind)|\(subject.id ?? subject.name ?? "")|\(id ?? "default")" }
}

/** `GET /api/access/agents/:id`: what its memory access comes from, and who its folder is shared with. */
struct AgentMemoryAccess: Decodable {
  var rules: [AgentMemoryRule]
  var sharedOut: [AgentMemoryRule]
}

enum AccessText {
  static func level(_ level: String) -> String {
    ["none": "No access", "read": "Can read", "edit": "Can edit", "manage": "Can manage"][level] ?? level
  }

  /** "agents/agt_x/notes" becomes "@atlas/notes"; "" becomes "the whole vault". */
  static func path(_ path: String, agents: [Agent], members: [Member]) -> String {
    if path.isEmpty { return "the whole vault" }
    let parts = path.split(separator: "/", maxSplits: 2, omittingEmptySubsequences: false).map(String.init)
    if parts.count >= 2 {
      let rest = parts.count > 2 ? "/" + parts[2] : ""
      if parts[0] == "agents", let agent = agents.first(where: { $0.id == parts[1] }) { return "@\(agent.handle)\(rest)" }
      if parts[0] == "people", let member = members.first(where: { $0.id == parts[1] }) { return "\(member.name)\(rest)" }
    }
    return path
  }

  static func subject(_ subject: MemorySubject, agents: [Agent], members: [Member]) -> String {
    switch subject.kind {
    case "all_agents": return "All agents"
    case "members": return "Everyone (members)"
    case "guests": return "Guests"
    case "team": return "Team “\(subject.name ?? "")”"
    case "role": return "\(subject.role ?? "") on “\(subject.team ?? "")”"
    case "agent": return "@" + (agents.first { $0.id == subject.id }?.handle ?? "deleted agent")
    default: return members.first { $0.id == subject.id }?.name ?? "someone"
    }
  }
}

// MARK: connect

/** An app (Grok, ChatGPT, Claude...) someone connected as this agent. */
struct ConnectedApp: Decodable, Identifiable, Hashable {
  var id: String
  var name: String
  var approvedBy: String?
  var createdAt: String?
  var lastUsed: String?
}

/** The configuration that connects an existing MCP session to an agent, in each client's format. */
enum ConnectionFormat: String, CaseIterable, Identifiable {
  case claude, codex, json
  var id: String { rawValue }
  var label: String {
    switch self {
    case .claude: "Claude Code"
    case .codex: "Codex"
    case .json: "Other MCP clients"
    }
  }

  static func initial(for harness: String) -> ConnectionFormat {
    harness == "claude-code" ? .claude : harness == "codex" ? .codex : .json
  }

  /** Shell and TOML have their own quoting rules; hub addresses can contain odd characters. */
  static func shell(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }

  private static func quoted(_ value: String) -> String {
    guard let data = try? JSONEncoder().encode(value), let text = String(data: data, encoding: .utf8) else { return "\"\"" }
    return text.replacingOccurrences(of: "\\/", with: "/")
  }

  func config(hub: String, token: String) -> String {
    switch self {
    case .claude:
      return "claude mcp add wisp --env WISP_URL=\(Self.shell(hub)) --env WISP_TOKEN=\(Self.shell(token)) -- wisp-mcp"
    case .codex:
      return "[mcp_servers.wisp]\ncommand = \"wisp-mcp\"\nenv = { WISP_URL = \(Self.quoted(hub)), WISP_TOKEN = \(Self.quoted(token)) }"
    case .json:
      return """
      {
        "mcpServers": {
          "wisp": {
            "command": "wisp-mcp",
            "env": {
              "WISP_URL": \(Self.quoted(hub)),
              "WISP_TOKEN": \(Self.quoted(token))
            }
          }
        }
      }
      """
    }
  }
}

/** Whether a harness is started by a device (natively or over ACP) rather than joining through MCP. */
func harnessRunsOnDevice(_ harness: String) -> Bool {
  harness.hasPrefix("acp:") || (HarnessChoice.all.first { $0.id == harness }?.protocolName ?? "mcp") != "mcp"
}

/** Harnesses that can move into a VM along with their computer. */
func harnessRunsInVM(_ harness: String) -> Bool { ["claude-code", "codex", "hermes", "kimi"].contains(harness) }

// MARK: import

/** A saved agent setup found on a device (a Hermes profile, an OpenClaw workspace, a Claude Code subagent). */
struct DiscoveredAgent: Decodable, Identifiable, Hashable {
  var key: String
  var harness: String
  var name: String
  var description: String?
  var model: String?
  var path: String
  var hasSoul: Bool?
  var memoryCount: Int?
  var id: String { key }

  var summary: String {
    [description, hasSoul == true ? "has a personality" : nil,
     (memoryCount ?? 0) > 0 ? "\(memoryCount!) note\(memoryCount == 1 ? "" : "s")" : nil, model]
      .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
  }
}

/** A device and the saved setups its agent scan found (`GET /api/nodes`, only the parts import needs). */
struct ScannedDevice: Decodable, Identifiable, Hashable {
  var id: String
  var name: String
  var online: Bool
  var mine: Bool?
  var shared: Bool?
  var discovered: [DiscoveredAgent]?
  var usable: Bool { mine == true || shared == true }
}

enum AgentImportLogic {
  /** A free handle from a name: "Claude Code (your setup)" becomes "claude", or "claude-2" when that's taken. */
  static func freeHandle(_ name: String, taken: [String]) -> String {
    var base = name.lowercased().replacingOccurrences(of: "[^a-z0-9-]+", with: "-", options: .regularExpression)
      .replacingOccurrences(of: "^[^a-z]+", with: "", options: .regularExpression)
    base = String(base.split(separator: "-", omittingEmptySubsequences: false).first ?? "").prefix(28).description
    if base.isEmpty { base = "agent" }
    var handle = base
    var n = 2
    while taken.contains(handle) { handle = "\(base)-\(n)"; n += 1 }
    return handle
  }

  /** Whether an agent in this workspace already is the one found. */
  static func alreadyHere(_ found: DiscoveredAgent, on device: ScannedDevice, agents: [Agent]) -> Bool {
    agents.contains { $0.nodeId == device.id && $0.harness == found.harness && $0.name == found.name }
  }
}

// MARK: personality

enum SoulText {
  static func path(_ agentId: String) -> String { "agents/\(agentId)/SOUL.md" }

  /** Starter SOUL.md, the same one the web offers. */
  static func template(name: String, handle: String) -> String {
    """
    # \(name)

    Who @\(handle) is. Read at the start of every conversation. Keep it short: every line should change how you behave.

    ## Personality
    - Curious, direct, and kind.
    - Has opinions and shares them, then defers to the person who decides.

    ## Voice
    - Short sentences, plain words, no filler.
    - Leads with the answer; adds detail only when it helps.

    ## Values
    - Tell the truth, including "I don't know" and "I was wrong".
    - Leave things better documented than you found them: write what you learn to memory.

    ## Boundaries
    - Ask before doing anything that's hard to undo.
    - Never pretend a task is done when it isn't.

    """
  }
}

// MARK: voice

/** `GET /api/voice/settings`: how the person's calls speak (keys come back masked). */
struct VoiceSettings: Decodable {
  var listen: String
  var speak: String
}

/** A voice an engine offers: the id saved on the agent, and how to show it. */
struct VoiceChoice: Identifiable, Hashable {
  var id: String
  var label: String
  var detail: String?
}

/** A voice installed on this phone, reduced to what choosing one needs. */
struct DeviceVoice: Hashable {
  var name: String
  var lang: String
  var id: String
  /** higher sounds better (enhanced and premium downloads) */
  var quality = 0
  var isDefault = false
}

enum AgentVoices {
  static let openai = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"]
  static let elevenlabs: [(id: String, name: String)] = [("JBFqnCBsd6RMkjVDRZzb", "George"), ("EXAVITQu4vr4xnSDxMaL", "Sarah"), ("21m00Tcm4TlvDq8ikWAM", "Rachel")]

  /** The macOS novelty voices: fun, but nobody wants one as a helper's everyday voice. */
  private static let novelty: Set<String> = ["albert", "bad news", "bahh", "boing", "bubbles", "cellos", "good news", "jester", "organ", "superstar", "trinoids", "whisper", "wobble", "zarvox", "fred", "junior", "ralph", "kathy"]

  private static func tag(_ lang: String) -> String { lang.replacingOccurrences(of: "_", with: "-").lowercased() }
  private static func base(_ lang: String) -> String { tag(lang).split(separator: "-").first.map(String.init) ?? "" }
  private static func bare(_ name: String) -> String {
    name.replacingOccurrences(of: "\\s*\\(.*$", with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces).lowercased()
  }

  static func isNovelty(_ voice: DeviceVoice) -> Bool { novelty.contains(bare(voice.name)) }

  /** A short, friendly list for a person's language: same region first, then good-sounding voices. */
  static func recommend(_ voices: [DeviceVoice], language: String, count: Int = 4) -> [DeviceVoice] {
    let wanted = tag(language.isEmpty ? "en" : language)
    let usable = voices.filter { !isNovelty($0) }
    let sameBase = usable.filter { base($0.lang) == base(wanted) }
    let pool = sameBase.isEmpty ? usable : sameBase
    func score(_ v: DeviceVoice) -> Int { (tag(v.lang) == wanted ? 8 : 0) + (v.isDefault ? 2 : 0) + v.quality }
    var seen = Set<String>()
    let ordered = pool.enumerated().sorted { a, b in
      let (x, y) = (score(a.element), score(b.element))
      return x != y ? x > y : a.offset < b.offset
    }.map(\.element)
    return Array(ordered.filter { seen.insert(bare($0.name)).inserted }.prefix(count))
  }

  /** Search by name and narrow to one language; an empty `lang` means every language. */
  static func filter(_ voices: [DeviceVoice], query: String, lang: String) -> [DeviceVoice] {
    let q = query.trimmingCharacters(in: .whitespaces).lowercased()
    return voices.filter { (lang.isEmpty || tag($0.lang) == tag(lang)) && (q.isEmpty || $0.name.lowercased().contains(q)) }
  }

  /** The language filter to start on: the person's own, if any voice speaks it. */
  static func defaultLanguage(_ voices: [DeviceVoice], language: String) -> String {
    let wanted = tag(language.isEmpty ? "en" : language)
    if let exact = voices.first(where: { tag($0.lang) == wanted }) { return exact.lang }
    return voices.first { base($0.lang) == base(wanted) }?.lang ?? ""
  }

  /** The same hash the web uses to pick an agent's automatic voice from its handle. */
  static func index(_ seed: String, count: Int) -> Int {
    var hash: UInt32 = 0
    for unit in seed.utf16 { hash = hash &* 31 &+ UInt32(unit) }
    return count > 0 ? Int(hash % UInt32(count)) : 0
  }

  /** The engine's voices, with "Automatic" first. A saved voice this list lacks still shows up. */
  static func choices(engine: String, agent: Agent, selected: String, recommended: [DeviceVoice], all: [DeviceVoice], language: (String) -> String) -> [VoiceChoice] {
    var result = [VoiceChoice(id: "", label: "Automatic for \(agent.name)", detail: "A voice picked for this agent")]
    func device(_ v: DeviceVoice) -> VoiceChoice { VoiceChoice(id: v.id, label: v.name, detail: language(v.lang)) }
    switch engine {
    case "openai": result += openai.map { VoiceChoice(id: $0, label: $0.prefix(1).uppercased() + $0.dropFirst()) }
    case "elevenlabs": result += elevenlabs.map { VoiceChoice(id: $0.id, label: $0.name) }
    default:
      if !selected.isEmpty, !recommended.contains(where: { $0.id == selected }), let picked = all.first(where: { $0.id == selected }) { result.append(device(picked)) }
      result += recommended.map(device)
    }
    if !selected.isEmpty, !result.contains(where: { $0.id == selected }) { result.append(VoiceChoice(id: selected, label: "Saved voice", detail: selected)) }
    return result
  }
}
