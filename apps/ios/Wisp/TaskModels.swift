import Foundation

struct WorkTask: Decodable, Identifiable {
  var id: String
  var title: String
  var brief: String
  var status: String
  var from: Actor?
  var toAgentId: String?
  var result: String?
  var channelId: String?
  var threadId: String?
  var teamId: String?
  var parentId: String?
  var reviewOf: String?
  var branch: String?
  var mergedAt: String?
  var createdAt: String?
  var updatedAt: String?
  var cancelled: Bool { status == "cancelled" || result?.hasPrefix("Cancelled") == true }
  var closed: Bool { status == "done" || status == "failed" || status == "cancelled" }
  var notificationInfo: [String: String] {
    var info = ["kind": "task"]
    if let channelId { info["channelId"] = channelId }
    if let threadId { info["threadId"] = threadId }
    return info
  }
}

struct TaskMerge: Decodable { var output: String?; var task: WorkTask? }
struct WorkspaceLead: Decodable { var lead: String?; var leadId: String? }
struct UploadedFile: Decodable, Identifiable { var id: String; var name: String; var size: Int?; var mime: String? }
