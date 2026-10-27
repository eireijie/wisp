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
  /** chats with it that wait on you, and whether it checks back when one goes quiet (on unless turned off) */
  var loops: [ChatLoop]?
  var checkback: Bool?
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
struct Followup: Decodable, Identifiable {
  var id: String; var agentId: String?; var userId: String?; var dueAt: String; var note: String; var status: String?
  /** what shows under the agent's reply ("Check the build"); nil on older hubs and for ones not shown */
  var label: String?
  /** "agent" (it said it would) or "person" (you said you would) */
  var waitingOn: String?
  /** "only if it hasn't gone out" */
  var condition: String?
  /** "followup", or "checkback" when Wisp set it for a chat that went quiet */
  var kind: String?
  var channelId: String?
  var messageId: String?
}

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

/** GET /api/usage?range=: what agents used over a period, split into chats/tasks and work done on their own. */
struct UsageReport: Decodable, Equatable {
  struct Bucket: Decodable, Equatable { var start: String; var chat: Int; var background: Int }
  struct Totals: Decodable, Equatable { var tokens: Int; var runs: Int; var failed: Int; var estimated: Bool }
  struct AgentUse: Decodable, Equatable, Identifiable { var agentId: String; var tokens: Int; var runs: Int; var id: String { agentId } }
  struct ModelUse: Decodable, Equatable, Identifiable { var model: String; var tokens: Int; var id: String { model } }
  struct Background: Decodable, Equatable { var todayTokens: Int; var dailyTokens: Int?; var resetsAt: String }
  var range: String
  var tz: String
  var buckets: [Bucket]
  var totals: Totals
  var previousTokens: Int
  var agents: [AgentUse]
  var models: [ModelUse]
  var background: Background
}

/** A setting or mod an agent changed for someone, kept so they can see it and undo it. */
struct Change: Decodable, Identifiable {
  var id: String
  var agentId: String
  var lines: [String]
  var createdAt: String
  var undoneAt: String?
}
