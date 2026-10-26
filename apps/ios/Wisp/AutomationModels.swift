import Foundation

struct Routine: Decodable, Identifiable {
  var id: String
  var agentId: String
  var name: String
  var notePath: String
  var schedule: String?
  var timezone: String?
  var channelId: String?
  var enabled: Bool?
  var status: String?
  var lastRunAt: String?
  var lastCompletedAt: String?
}
struct RoutineRun: Decodable { var channelId: String?; var messageId: String? }
struct AgentBackground: Decodable {
  var background: BackgroundWork?
  var followups: [Followup]?
  var notAllowed: String?
  var sources: [BackgroundSource]?
  var usage: BackgroundUsage?
  var defaultDailyCap: Int?
}
struct BackgroundWork: Decodable {
  var enabled: Bool?
  var everyMinutes: Int?
  var focus: String?
  var quietStart: String?
  var quietEnd: String?
  var nextAt: String?
  var nextReason: String?
  var lastAt: String?
  var lastNote: String?
  var checking: Bool?
  var model: String?
  var effort: String?
  var dailyCap: Int?
}
struct BackgroundSource: Decodable { var kind: String; var name: String; var detail: String? }
struct BackgroundUsage: Decodable { var lastTokens: Int?; var todayTokens: Int?; var weekTokens: Int?; var checksToday: Int?; var capReached: Bool? }
struct Followup: Decodable, Identifiable { var id: String; var agentId: String?; var userId: String?; var dueAt: String; var note: String; var status: String? }

/** How much background checks may use each day, across all of a person's agents. */
struct Allowance: Decodable {
  struct Use: Decodable, Identifiable { var agentId: String; var tokens: Int; var checks: Int; var id: String { agentId } }
  /** tokens a day; nil = no limit */
  var dailyTokens: Int?
  var todayTokens: Int
  var estimated: Bool?
  var agents: [Use]

  /** The amounts people pick from, smallest first; nil = no limit. */
  static let levels: [(label: String, tokens: Int?)] = [("Low", 300_000), ("Medium", 1_000_000), ("High", 3_000_000), ("No limit", nil)]
  /** 0, 340k, 1.2M */
  static func text(_ n: Int) -> String {
    if n == 0 { return "0" }
    if n >= 1_000_000 {
      let m = (Double(n) / 1_000_000 * 10).rounded() / 10
      return m == m.rounded() ? "\(Int(m))M" : "\(m)M"
    }
    return "\(max(1, Int((Double(n) / 1000).rounded())))k"
  }
}

/** A setting or mod an agent changed for someone, kept so they can see it and undo it. */
struct Change: Decodable, Identifiable {
  var id: String
  var agentId: String
  var lines: [String]
  var createdAt: String
  var undoneAt: String?
}
