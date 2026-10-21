import Foundation

struct WorkspaceTeam: Decodable, Identifiable {
  var id: String = ""
  var name: String = ""
  var emoji: String?
  var description: String?
  var leadId: String?
  var reportsTo: String?
  var channelId: String?
  var folder: String?
  var repo: String?
  var baseBranch: String?
  var members: [TeamAgent]?
}
struct TeamAgent: Codable, Identifiable {
  var agentId: String
  var role: String?
  var roleNotes: String?
  var managerId: String?
  var id: String { agentId }
}
struct AccountSession: Decodable, Identifiable { var id: String; var label: String?; var current: Bool?; var createdAt: String?; var lastUsed: String? }
struct WorkspaceInvite: Decodable, Identifiable { var id: String; var role: String; var createdAt: String?; var expiresAt: String?; var code: String? }
struct AgentPolicy: Codable {
  var askBefore: [String]; var maxHops: Int; var maxRunsPerMinute: Int; var defaultAccess: String
  /** agents making agents (Settings → Agents); missing on older hubs */
  var leadsCreateAgents: Bool?; var subAgents: Bool?; var maxAgentMade: Int?
}
struct MemoryStorage: Decodable {
  struct Sync: Decodable { var allowed: Bool; var reason: String?; var urlPath: String?; var branch: String? }
  struct Move: Decodable { var how: String?; var files: Int? }
  var path: String?
  var source: String?
  var setting: String?
  var pendingRestart: Bool?
  var nextPath: String?
  var restartable: Bool?
  var previous: String?
  var moved: Move?
  var sync: Sync?
  var tokens: [MemoryToken]?
}
struct MemoryToken: Decodable, Identifiable { var id: String; var label: String?; var token: String?; var createdAt: String?; var lastUsed: String? }
struct DeviceRegistration: Decodable { var token: String }
struct HarnessInstall: Decodable { var ok: Bool?; var output: String? }
struct AgentConnection: Decodable, Identifiable { var id: String; var agentId: String; var kind: String?; var device: String?; var createdAt: String?; var lastUsed: String? }
struct ComputerDefaults: Decodable {
  struct Defaults: Decodable { var vmSize: String; var controlIdleMinutes: Int }
  struct Orgo: Decodable { var configured: Bool; var hint: String? }
  var defaults: Defaults
  var orgo: Orgo
}
struct ExportInfo: Decodable { var dataDir: String?; var notes: Int?; var messages: Int?; var files: Int?; var agents: Int? }
struct VoicePreferences: Codable { var listen: String; var speak: String; var openaiKey: String; var elevenlabsKey: String }
