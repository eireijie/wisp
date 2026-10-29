import Foundation

// Open loops and promises in a chat (apps/hub/src/loops.ts): the follow-ups an agent shows under
// its reply, where a DM stands, check-backs when a chat goes quiet, and the wrap-up when it's done.
// The views are in LoopViews.swift.

/** A follow-up pill under an agent's reply (the "followup" message part); the hub keeps it current. */
struct FollowupPill: Codable, Hashable {
  var followupId: String
  var label: String
  var dueAt: String
  /** "agent" or "person" */
  var waitingOn: String
  /** "pending", "done" or "cancelled" */
  var status: String

  private enum K: String, CodingKey { case followupId, label, dueAt, waitingOn, status }
  init(followupId: String, label: String, dueAt: String, waitingOn: String = "agent", status: String = "pending") {
    self.followupId = followupId; self.label = label; self.dueAt = dueAt; self.waitingOn = waitingOn; self.status = status
  }
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: K.self)
    followupId = (try? c.decode(String.self, forKey: .followupId)) ?? ""
    label = ((try? c.decode(String.self, forKey: .label)) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    dueAt = (try? c.decode(String.self, forKey: .dueAt)) ?? ""
    waitingOn = (try? c.decode(String.self, forKey: .waitingOn)) ?? "agent"
    status = (try? c.decode(String.self, forKey: .status)) ?? "pending"
  }

  var pending: Bool { status == "pending" }
  var date: Date? { Wire.date(dueAt) }
}

/** What an agent got done when a chat wrapped up; empty lines are left out. */
struct WrapUp: Codable, Hashable {
  var did: String
  var saved: String
  var next: String

  var rows: [(key: String, text: String)] {
    [("Did", did), ("Saved", saved), ("Next", next)].filter { !$0.1.isEmpty }
  }
}

/** Where a DM stands, from the chat list (`loop` on GET /api/channels). */
struct ChatLoopState: Codable, Hashable {
  /** "waiting" (on you), "done" or "closed" */
  var status: String
  var summary: String?
}

/** The next thing the agent will come back to in a DM (`next` on GET /api/channels). */
struct ChatNext: Codable, Hashable {
  var label: String
  var dueAt: String
  var waitingOn: String?
}

/** A chat with an agent that waits on you, for its Background screen. */
struct ChatLoop: Decodable, Hashable, Identifiable {
  var channelId: String
  var agentId: String?
  var userId: String?
  var status: String
  var summary: String
  /** check-backs sent since you last wrote */
  var nudges: Int?
  var updatedAt: String?
  var id: String { channelId }
}

/** What the reminder sheet changes: a pill in the chat or a row on the Background screen. */
struct ReminderTarget: Identifiable, Hashable {
  var followupId: String
  var label: String
  var dueAt: String
  var condition: String?
  /** the agent it belongs to, so its Background screen updates */
  var agentId: String?
  var id: String { followupId }
}

enum Loops {
  // MARK: times

  /** "4:35 PM", or "8 PM" on the hour. */
  static func clock(_ date: Date, calendar: Calendar = .current) -> String {
    calendar.component(.minute, from: date) == 0 ? date.formatted(.dateTime.hour()) : date.formatted(.dateTime.hour().minute())
  }

  /** A pill's time: "4:35 PM" today, "Sat" this week, "Nov 3" after that. */
  static func pillTime(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
    if calendar.isDate(date, inSameDayAs: now) { return clock(date, calendar: calendar) }
    if let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day, days > 0, days < 7 {
      return date.formatted(.dateTime.weekday(.abbreviated))
    }
    return date.formatted(.dateTime.month(.abbreviated).day())
  }

  /** "4:35 PM" today, "Tomorrow 9 AM", "Sat 10 AM", "Nov 3, 9 AM". */
  static func when(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
    if calendar.isDate(date, inSameDayAs: now) { return clock(date, calendar: calendar) }
    if isDay(date, after: now, calendar: calendar) { return "Tomorrow \(clock(date, calendar: calendar))" }
    if let days = dayGap(now, date, calendar), days > 0, days < 7 { return "\(date.formatted(.dateTime.weekday(.abbreviated))) \(clock(date, calendar: calendar))" }
    return "\(date.formatted(.dateTime.month(.abbreviated).day())), \(clock(date, calendar: calendar))"
  }

  /** The reminder sheet's line: "Tonight at 8 PM, only if it hasn't gone out". */
  static func sheetLine(_ date: Date?, condition: String?, now: Date = Date(), calendar: Calendar = .current) -> String {
    var line = ""
    if let date {
      let at = clock(date, calendar: calendar)
      if calendar.isDate(date, inSameDayAs: now) { line = calendar.component(.hour, from: date) >= 18 ? "Tonight at \(at)" : "Today at \(at)" }
      else if isDay(date, after: now, calendar: calendar) { line = "Tomorrow at \(at)" }
      else if let days = dayGap(now, date, calendar), days > 0, days < 7 { line = "\(date.formatted(.dateTime.weekday(.wide))) at \(at)" }
      else { line = "\(date.formatted(.dateTime.month(.abbreviated).day())) at \(at)" }
    }
    if let c = onlyIf(condition) { line = line.isEmpty ? c.prefix(1).uppercased() + c.dropFirst() : "\(line), \(c)" }
    return line
  }

  /** A condition as "only if …", however the agent wrote it; nil when there is none. */
  static func onlyIf(_ condition: String?) -> String? {
    let c = (condition ?? "").trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "."))
    guard !c.isEmpty else { return nil }
    if c.lowercased().hasPrefix("only if") { return "o" + c.dropFirst() }
    return "only if " + c.prefix(1).lowercased() + c.dropFirst()
  }

  private static func dayGap(_ from: Date, _ to: Date, _ calendar: Calendar) -> Int? {
    calendar.dateComponents([.day], from: calendar.startOfDay(for: from), to: calendar.startOfDay(for: to)).day
  }

  private static func isDay(_ date: Date, after now: Date, calendar: Calendar) -> Bool { dayGap(now, date, calendar) == 1 }

  // MARK: the reminder sheet

  /** A new time for a reminder: In 1 hour, Tonight (8 PM), Tomorrow morning (9 AM). */
  struct Option: Hashable, Identifiable {
    var title: String
    var date: Date
    var id: String { title }
  }

  /** The sheet's choices from `now`; Tonight is left out once 8 PM has passed. */
  static func options(now: Date = Date(), calendar: Calendar = .current) -> [Option] {
    var out: [Option] = []
    // to the minute, so "In 1 hour" reads 6:48 PM, not 6:48:31
    let hour = calendar.date(byAdding: .hour, value: 1, to: now) ?? now.addingTimeInterval(3600)
    out.append(Option(title: "In 1 hour", date: Date(timeIntervalSinceReferenceDate: (hour.timeIntervalSinceReferenceDate / 60).rounded(.down) * 60)))
    if let tonight = calendar.date(bySettingHour: 20, minute: 0, second: 0, of: now), tonight > now { out.append(Option(title: "Tonight", date: tonight)) }
    if let tomorrow = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)),
       let morning = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow) { out.append(Option(title: "Tomorrow morning", date: morning)) }
    return out
  }

  /** The option a reminder is already set to (within a minute), for its check. */
  static func current(_ options: [Option], dueAt: Date?) -> Option? {
    guard let dueAt else { return nil }
    return options.first { abs($0.date.timeIntervalSince(dueAt)) < 60 }
  }

  /** An ISO time with this phone's offset, as PATCH /api/followups/:id wants it. */
  static func iso(_ date: Date, timeZone: TimeZone = .current) -> String {
    let f = ISO8601DateFormatter()
    f.timeZone = timeZone
    f.formatOptions = [.withInternetDateTime]
    return f.string(from: date)
  }

  // MARK: the chat

  /** The quick replies a message offers: only on the newest message in the chat, with nothing after it. */
  static func replies(_ message: Message, newest: Message?) -> [String] {
    guard message.threadId == nil, message.author.kind == .agent, message.deletedAt == nil, newest?.id == message.id else { return [] }
    for part in message.parts { if case .checkback(let replies) = part { return replies.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty } } }
    return []
  }

  static func isCheckback(_ message: Message) -> Bool { message.parts.contains { if case .checkback = $0 { true } else { false } } }
  static func isClosed(_ message: Message) -> Bool { message.parts.contains { if case .closed = $0 { true } else { false } } }

  /** Just posted (or just updated with a pill): its pieces animate in; older history shows as is. */
  static func fresh(_ message: Message, now: Date = Date()) -> Bool { now.timeIntervalSince(message.date) < 30 }

  // MARK: the chat list

  /** What a DM's row says about where it stands, over the last message's preview. */
  enum ListLine: Equatable {
    /** "Waiting on you · send Sam the deck", in orange */
    case waiting(String)
    /** "Back at 4:35 PM · check the build", with a clock */
    case back(String)
    /** the preview, after a green check */
    case done
  }

  static func listLine(_ channel: Channel, now: Date = Date(), calendar: Calendar = .current) -> ListLine? {
    guard channel.isDM else { return nil }
    if channel.loop?.status == "waiting" {
      let summary = (channel.loop?.summary ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      return .waiting(summary.isEmpty ? "Waiting on you" : "Waiting on you · \(summary)")
    }
    if let next = channel.next, let date = Wire.date(next.dueAt) {
      let label = next.label.trimmingCharacters(in: .whitespacesAndNewlines)
      let at = calendar.isDate(date, inSameDayAs: now) ? "at \(clock(date, calendar: calendar))"
        : isDay(date, after: now, calendar: calendar) ? "tomorrow" : pillTime(date, now: now, calendar: calendar)
      return .back(label.isEmpty ? "Back \(at)" : "Back \(at) · \(label.prefix(1).lowercased() + label.dropFirst())")
    }
    if channel.loop?.status == "done" { return .done }
    return nil
  }

  // MARK: the Background screen

  /** A row under "Keeping track": a follow-up, or a chat that waits on you. */
  struct TrackRow: Identifiable, Hashable {
    var id: String
    var title: String
    var subtitle: String
    /** on you (orange speech bubble) or on the agent (blue clock) */
    var onPerson: Bool
    var reminder: ReminderTarget?
    var channelId: String?
  }

  static func trackRows(followups: [Followup], loops: [ChatLoop], agent: Agent, now: Date = Date(), calendar: Calendar = .current) -> [TrackRow] {
    let shown = followups.filter { ($0.kind ?? "followup") == "followup" && ($0.status ?? "pending") == "pending" }
      .sorted { $0.dueAt < $1.dueAt }
    var rows: [TrackRow] = shown.map { f in
      let date = Wire.date(f.dueAt)
      let at = date.map { when($0, now: now, calendar: calendar) } ?? ""
      let person = f.waitingOn == "person"
      let title = (f.label?.isEmpty == false ? f.label! : f.note)
      let subtitle = person ? "You said you would · nudge \(at.first?.isNumber == true ? "at " : "")\(at)"
        : f.label?.isEmpty == false ? "\(agent.name) said it would · \(at)" : at
      return TrackRow(id: f.id, title: title, subtitle: subtitle, onPerson: person,
                      reminder: ReminderTarget(followupId: f.id, label: title, dueAt: f.dueAt, condition: f.condition, agentId: agent.id), channelId: f.channelId)
    }
    rows += loops.filter { $0.status == "waiting" }.map { l in
      let s = l.summary.trimmingCharacters(in: .whitespacesAndNewlines)
      return TrackRow(id: "loop-" + l.channelId, title: s.isEmpty ? "Your answer" : s.prefix(1).uppercased() + s.dropFirst(),
                      subtitle: (l.nudges ?? 0) > 0 ? "No answer yet · one more try" : "Waiting on you", onPerson: true, reminder: nil, channelId: l.channelId)
    }
    return rows
  }
}

/** A check-back's push: a Reply action that answers in its chat (aps.category "CHECKBACK"). */
enum CheckbackPush {
  static let category = "CHECKBACK"
  static let reply = "REPLY"

  /** The chat a check-back push came from. */
  nonisolated static func channel(_ info: [AnyHashable: Any]) -> String? {
    guard let w = Route.payload(info), let id = w["channelId"] as? String, !id.isEmpty else { return nil }
    return id
  }
}
