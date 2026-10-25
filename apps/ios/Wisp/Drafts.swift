import Foundation

/** Words typed but not sent, kept per conversation on this device so leaving a chat doesn't lose them. */
@MainActor enum ComposerDrafts {
  struct Draft: Codable, Equatable { var text: String; var at: Date }
  static let storageKey = "wisp.drafts"
  static let limit = 40

  static func key(channel: String, thread: String?) -> String { thread.map { "\(channel)/t/\($0)" } ?? channel }

  static func all(_ defaults: UserDefaults = WispPreferences.standard) -> [String: Draft] {
    guard let data = defaults.data(forKey: storageKey) else { return [:] }
    return (try? JSONDecoder().decode([String: Draft].self, from: data)) ?? [:]
  }

  static func load(_ key: String, defaults: UserDefaults = WispPreferences.standard) -> String {
    all(defaults)[key]?.text ?? ""
  }

  /** An empty (or blank) draft removes the entry; the oldest drafts go once there are too many. */
  static func save(_ text: String, key: String, defaults: UserDefaults = WispPreferences.standard, now: Date = Date()) {
    var drafts = all(defaults)
    if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      guard drafts.removeValue(forKey: key) != nil else { return }
    } else {
      if drafts[key]?.text == text { return }
      drafts[key] = Draft(text: text, at: now)
      if drafts.count > limit {
        for old in drafts.sorted(by: { $0.value.at < $1.value.at }).prefix(drafts.count - limit) { drafts[old.key] = nil }
      }
    }
    if let data = try? JSONEncoder().encode(drafts) { defaults.set(data, forKey: storageKey) }
  }
}
