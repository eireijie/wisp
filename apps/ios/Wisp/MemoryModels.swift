import Foundation

struct MemoryNote: Decodable, Identifiable, Hashable {
  var path: String
  var title: String?
  var tags: [String]?
  var links: [String]?
  var updatedAt: Double?
  var content: String?
  var backlinks: [String]?
  var access: String?
  var editedBy: String?
  var editedAt: String?
  var snippet: String?
  var frontmatter: [String: FrontValue]?
  var id: String { path }
  var name: String { title ?? (path as NSString).lastPathComponent }
  var editable: Bool { access == "edit" || access == "manage" }
}
struct NoteRevision: Decodable, Identifiable {
  var hash: String
  var author: String?
  var date: String?
  var message: String?
  var id: String { hash }
}
struct NoteResolution: Decodable { var path: String? }
struct NoteContent: Decodable { var content: String }
struct MemoryProfile: Decodable {
  struct Person: Decodable { var id: String; var name: String }
  var person: Person
  var level: String
  var items: [MemoryItem]
  var editable: Bool { level == "edit" || level == "manage" }
}
struct MemoryItem: Decodable, Identifiable {
  var path: String
  var kind: String
  var text: String
  var by: String?
  var source: String?
  var messageId: String?
  var channelId: String?
  var created: String?
  var updated: String?
  var pinned: Bool?
  var status: String?
  var due: String?
  var date: String?
  var id: String { path + text }
}
struct RememberResult: Decodable { var saved: Bool; var similar: [MemoryItem]? }
struct MemoryAccess: Decodable { var path: String; var level: String; var rules: [MemoryRule]? }
struct MemorySubject: Codable {
  var kind: String
  var id: String?
  var name: String?
  var team: String?
  var role: String?
}
struct MemoryRule: Decodable, Identifiable {
  var id: String
  var path: String
  var subject: MemorySubject
  var level: String
  var startup: Bool?
  var builtin: Bool?
}
