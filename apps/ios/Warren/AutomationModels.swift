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
