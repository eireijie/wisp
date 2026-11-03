import Foundation

/**
 * How a conversation reads, as plain functions (the same rules as the web's chatFormat.ts): when a
 * time label goes between messages, which messages group under one name, what a quote says, and
 * the one line a tool call gets.
 */
enum ChatFormat {
  /** A new time label between messages: after 30 quiet minutes, or on a new day. */
  static func needsStamp(_ prev: Message?, _ m: Message, calendar: Calendar = .current) -> Bool {
    guard let prev else { return true }
    return m.date.timeIntervalSince(prev.date) > 30 * 60 || !calendar.isDate(prev.date, inSameDayAs: m.date)
  }

  /**
   * A new chat starts at this message: its chat differs from the one before it, or it's the first
   * message loaded and opens its chat. Messages without a chat (threads, older hubs) never start one.
   */
  static func startsChat(_ prev: Message?, _ m: Message) -> Bool {
    guard let chat = m.conversationId else { return false }
    guard let prev else { return m.id == chat }
    return prev.conversationId != chat
  }

  /** Anything drawn between two messages (a chat divider or a time label) breaks their grouping. */
  static func breaks(_ prev: Message?, _ m: Message, calendar: Calendar = .current) -> Bool {
    startsChat(prev, m) || needsStamp(prev, m, calendar: calendar)
  }

  /** The last loaded message of a chat, which "Continue this chat" replies to. */
  static func lastOfChat(_ chat: String, in list: [Message]) -> Message? {
    list.last { $0.conversationId == chat && $0.author.id != "system" && $0.deletedAt == nil }
  }

  /** "the 9:14 AM chat", "yesterday's 9:14 AM chat", "the Oct 23, 9:14 AM chat": what a check-back points at. */
  static func chatName(_ date: Date, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> String {
    let time = date.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(locale))
    if calendar.isDate(date, inSameDayAs: now) { return "the \(time) chat" }
    if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "yesterday's \(time) chat" }
    return "the \(date.formatted(Date.FormatStyle().month(.abbreviated).day().locale(locale))), \(time) chat"
  }

  /** "Today 9:30 PM", "Yesterday 4:02 PM", "Oct 23, 9:30 AM". */
  static func stamp(_ date: Date, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> String {
    let time = date.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(locale))
    if calendar.isDate(date, inSameDayAs: now) { return "Today \(time)" }
    if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "Yesterday \(time)" }
    return "\(date.formatted(Date.FormatStyle().month(.abbreviated).day().locale(locale))), \(time)"
  }

  /** One author's messages within five minutes sit together under one name; Wisp's own lines never do. */
  static func groups(_ prev: Message?, _ m: Message) -> Bool {
    guard let prev, prev.author == m.author, m.author.id != "system", prev.author.id != "system" else { return false }
    return m.date.timeIntervalSince(prev.date) < 5 * 60
  }

  /** A few words of a message, for the quote in a reply and the "Replying to" bar. */
  static func snippet(_ m: Message) -> String {
    let text = m.body.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    if !text.isEmpty { return text.count > 140 ? String(text.prefix(140)) + "…" : text }
    return m.files.isEmpty ? "" : "Attachment"
  }
}

/** One line for a tool call ("Read main.ts"), and what a memory tool saved. */
enum ToolLine {
  /** "mcp__wisp__memory_search" → "memory_search"; "WebFetch" → "webfetch" */
  static func key(_ name: String) -> String {
    var n = name
    for prefix in ["mcp__wisp__", "mcp__warren__"] where n.hasPrefix(prefix) { n = String(n.dropFirst(prefix.count)) }
    if n.hasPrefix("mcp__") { n = String(n.dropFirst(5)) }
    for prefix in ["wisp.", "warren."] where n.hasPrefix(prefix) { n = String(n.dropFirst(prefix.count)) }
    return n.lowercased()
  }

  private static func word(_ input: [String: LooseValue], _ keys: [String]) -> String? {
    for k in keys { if let s = input[k]?.text, !s.isEmpty { return s } }
    return nil
  }

  private static func clip(_ s: String, _ n: Int) -> String { s.count > n ? String(s.prefix(n - 2)) + "…" : s }

  static func of(_ name: String, input: [String: LooseValue]) -> String {
    let k = key(name)
    let file = word(input, ["file_path", "path", "filename", "file"]).map { ($0 as NSString).lastPathComponent }
    if let file, ["read", "file_view", "view", "cat", "read_file", "open_file"].contains(k) { return "Read \(file)" }
    if let file, ["edit", "multiedit", "write", "apply_patch", "str_replace", "str_replace_editor", "write_file", "edit_file", "create_file"].contains(k) { return "Wrote \(file)" }
    if let q = word(input, ["query", "q", "pattern"]), k.contains("search") || ["grep", "glob", "find"].contains(k) { return "Searched “\(clip(q, 48))”" }
    if let c = word(input, ["command"]), ["bash", "shell", "exec", "exec_command", "run_command", "terminal"].contains(k) { return "Ran \(clip(c, 56))" }
    return k
  }

  /** What a memory_remember call saved, unless it didn't save: the "Remembered · …" chip. */
  static func remembered(_ name: String, input: [String: LooseValue], output: String) -> MessagePart.Remembered? {
    guard key(name) == "memory_remember" else { return nil }
    if output.range(of: "Not saved|Error", options: [.regularExpression, .caseInsensitive]) != nil { return nil }
    let text = word(input, ["text"]) ?? word(input, ["status"]).map { "marked a plan \($0)" } ?? "updated a memory"
    let path = output.range(of: #"people/[^\s"\\]+?\.md"#, options: .regularExpression).map { String(output[$0]) }
    return .init(kind: word(input, ["kind"]) ?? "", text: text, path: path)
  }
}
