import Foundation

/** One message found by search, with the name of the channel it is in (GET /api/search). */
struct SearchMessage: Decodable, Identifiable {
  var message: Message
  var channelName: String
  var id: String { message.id }

  init(from decoder: Decoder) throws {
    message = try Message(from: decoder)
    channelName = (try? decoder.container(keyedBy: Key.self).decode(String.self, forKey: .channelName)) ?? ""
  }
  private enum Key: String, CodingKey { case channelName }
}

/** Everything the search box finds: channels, agents, messages and memory notes. */
struct SearchResults: Decodable {
  var channels: [Channel] = []
  var agents: [Agent] = []
  var messages: [SearchMessage] = []
  var notes: [MemoryNote] = []

  var isEmpty: Bool { channels.isEmpty && agents.isEmpty && messages.isEmpty && notes.isEmpty }

  init() {}
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Key.self)
    channels = (try? c.decode([Channel].self, forKey: .channels)) ?? []
    agents = (try? c.decode([Agent].self, forKey: .agents)) ?? []
    messages = (try? c.decode([SearchMessage].self, forKey: .messages)) ?? []
    notes = (try? c.decode([MemoryNote].self, forKey: .notes)) ?? []
  }
  private enum Key: String, CodingKey { case channels, agents, messages, notes }
}

extension Store {
  func search(_ query: String) async throws -> SearchResults {
    try await fetch { try await $0.get("/api/search", ["q": query]) }
  }
}

/** Turns raw hub text into the short, clean lines search results show (the same rules as the web's palette). */
enum SearchText {
  private static func replace(_ text: String, _ pattern: String, _ template: String = " ", options: NSRegularExpression.Options = []) -> String {
    guard let re = try? NSRegularExpression(pattern: pattern, options: options) else { return text }
    return re.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
  }

  /** Internal ids look like usr_yN7fNNXTN6NP: a short prefix and a random tail with a digit or capital. */
  static func stripIds(_ text: String) -> String {
    guard let re = try? NSRegularExpression(pattern: #"\b[a-z]{2,6}_[A-Za-z0-9]{6,}\b"#) else { return text }
    var out = text
    for m in re.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
      guard let r = Range(m.range, in: out) else { continue }
      let token = out[r]
      let tail = token[token.index(after: token.firstIndex(of: "_")!)...]
      if tail.contains(where: { $0.isNumber || $0.isUppercase }) { out.replaceSubrange(r, with: "") }
    }
    return out
  }

  /** One clean line: no Markdown, ids, vault paths or agent-only instructions. */
  static func clean(_ text: String, max: Int = 140) -> String {
    var t = replace(text, "```[\\s\\S]*?(```|$)")
    t = t.split(separator: "\n", omittingEmptySubsequences: false).filter { line in
      let s = line.trimmingCharacters(in: .whitespaces)
      if s.hasPrefix("["), s.hasSuffix("]"), !s.dropFirst().dropLast().contains("]") { return false }
      let l = s.lowercased()
      return !(l.hasPrefix("[system") || l.hasPrefix("[meta") || l.hasPrefix("[internal"))
    }.joined(separator: "\n")
    t = replace(t, "<[^>]+>")
    t = replace(t, #"!\[([^\]]*)\]\([^)]*\)"#, "$1")
    t = replace(t, #"\[([^\]]+)\]\([^)]*\)"#, "$1")
    t = replace(t, #"^\s{0,3}#{1,6}\s+"#, "", options: .anchorsMatchLines)
    t = replace(t, #"^\s*>+\s?"#, "", options: .anchorsMatchLines)
    t = replace(t, #"^\s*([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?"#, "", options: .anchorsMatchLines)
    t = replace(t, "\\|")
    t = replace(t, "(\\*\\*|__|~~)", "")
    t = replace(t, "`+", "")
    t = replace(t, #"This is task\s+\S+\.?"#, options: .caseInsensitive)
    t = replace(t, #"When finished, report back[^.]*\.?"#, options: .caseInsensitive)
    t = replace(t, #"\b(?:people|agents|teams|groups|shared)/[\w./-]+"#, options: .caseInsensitive)
    t = replace(t, #"\b(?:[\w-]+/)+[\w-]+\.md\b"#, options: .caseInsensitive)
    t = stripIds(t)
    t = replace(t, "\\s+", " ")
    t = replace(t, "\\s+([.,;:!?])", "$1").trimmingCharacters(in: .whitespacesAndNewlines)
    return t.count <= max ? t : String(t.prefix(max - 1)).trimmingCharacters(in: .whitespaces) + "…"
  }

  /** "dinner-preferences.md" becomes "Dinner preferences". */
  static func humanize(_ name: String) -> String {
    var t = name
    if t.lowercased().hasSuffix(".md") { t = String(t.dropLast(3)) }
    t = replace(t, "[-_]+", " ")
    t = replace(t, "\\s+", " ").trimmingCharacters(in: .whitespaces)
    return t.prefix(1).uppercased() + t.dropFirst()
  }

  /** Where a note lives, in words: "Memory › Shared › Dinner preferences". */
  static func noteLocation(path: String, title: String, people: [String: String], agents: [String: String], teams: [String: String] = [:]) -> String {
    var parts = path.split(separator: "/").map(String.init)
    let file = parts.popLast() ?? ""
    let last = clean(title, max: 60).isEmpty ? (humanize(file).isEmpty ? "Note" : humanize(file)) : clean(title, max: 60)
    var crumbs = ["Memory"]
    let top = parts.first, id = parts.count > 1 ? parts[1] : nil
    let rest = Array(parts.dropFirst(2))
    switch top {
    case "shared": crumbs += ["Shared"] + ([id].compactMap { $0 } + rest).map(humanize)
    case "people": crumbs += [id.flatMap { people[$0] } ?? "A person"] + rest.map(humanize)
    case "agents": crumbs += [id.flatMap { agents[$0] }.map { "@\($0)" } ?? "An agent"] + rest.map(humanize)
    case "teams": crumbs += [id.flatMap { teams[$0] }.map { $0 } ?? "A team"] + rest.map(humanize)
    case "groups": crumbs += ["Groups"] + ([id].compactMap { $0 } + rest).map(humanize)
    default: crumbs += parts.map(humanize)
    }
    if crumbs.last != last { crumbs.append(last) }
    return crumbs.joined(separator: " › ")
  }

  /** What a message result is: one that hands out a task, one about a routine, or just a message. */
  static func kind(of message: Message) -> String {
    if message.parts.contains(where: { if case .task = $0 { true } else { false } }) { return "Task" }
    if message.parts.contains(where: { if case .routine = $0 { true } else { false } }) { return "Routine" }
    return "Message"
  }

  /** "DM with @maya" or "#general". DM channel names end with the agent id. */
  static func location(channelName: String, agentHandles: [String: String]) -> String {
    guard channelName.hasPrefix("dm:") else { return channelName }
    let id = channelName.split(separator: ":").last.map(String.init) ?? ""
    return agentHandles[id].map { "DM with @\($0)" } ?? "Direct message"
  }
}
