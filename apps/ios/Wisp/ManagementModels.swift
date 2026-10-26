import Foundation

struct ChannelSection: Codable, Identifiable, Hashable {
  var id: String
  var name: String
  var emoji: String
  var position: Int
  var title: String { emoji.isEmpty ? name : "\(emoji) \(name)" }
}

struct ChannelMember: Decodable, Identifiable {
  var kind: Actor.Kind
  var id: String
  var name: String
  var handle: String?
  var role: String?
  var actor: Actor { Actor(kind: kind, id: id) }
}

struct ChannelPin: Decodable, Identifiable {
  var message: Message
  var id: String { message.id }
}

struct AgentNode: Decodable, Identifiable, Hashable {
  struct Harness: Decodable, Hashable { var id: String; var version: String? }
  var id: String
  var name: String
  var ownerId: String?
  var ownerName: String?
  var mine: Bool?
  var shared: Bool?
  var online: Bool
  var role: String?
  var paused: Bool?
  var lastSeen: String?
  var agents: [String]?
  var harnesses: [Harness]?
  var capabilities: DeviceCapabilities?
  /** the remote desktop app its owner uses to reach it; only they get it */
  var remoteDesktop: OwnRemoteDesktop?
  /** a Wisp update in progress on the device (idle, updating, restarting or failed) */
  struct Update: Decodable, Hashable { var state: String; var message: String? }
  var update: Update?
  var isUpdating: Bool { update?.state == "updating" || update?.state == "restarting" }
  var usable: Bool { mine == true || shared == true }
}

struct AgentModels: Decodable {
  struct Catalog: Decodable {
    var models: [ModelOption]
    var efforts: [String]
    var defaultModel: String?
    var defaultEffort: String?
  }
  var catalog: Catalog?

  func settings(model: String, effort: String, fast: Bool) -> Fields? {
    guard let catalog else { return nil }
    let selected = catalog.models.first { $0.id == (model.isEmpty ? catalog.defaultModel : model) }
    let efforts = selected?.efforts ?? catalog.efforts
    return ["effort": .nullable(efforts.contains(effort) ? effort : ""), "fast": AnyEncodable(fast && selected?.fast != nil)]
  }

  /** The update that sets a model with its effort and fast mode; without a catalog, resetting to the default model still clears the effort. */
  static func modelFields(_ models: AgentModels?, model: String, effort: String, fast: Bool) -> Fields {
    var fields: Fields = ["model": .nullable(model)]
    if let settings = models?.settings(model: model, effort: effort, fast: fast) { fields["settings"] = AnyEncodable(settings) }
    else if model.isEmpty && effort.isEmpty { fields["settings"] = AnyEncodable(["effort": AnyEncodable.nullable("")]) }
    return fields
  }
}

struct ModelOption: Decodable, Identifiable {
  struct Fast: Decodable { var description: String? }
  var id: String
  var label: String
  var description: String?
  var efforts: [String]?
  var defaultEffort: String?
  var fast: Fast?
}

struct AgentRun: Decodable, Identifiable {
  var id: String
  var status: String
  var trigger: String?
  var channelName: String?
  var error: String?
  var hint: String?
  var createdAt: String?
  var finishedAt: String?
  var kind: String?
  var channelId: String?
  var threadId: String?
}

struct HarnessState: Decodable {
  var possible: Bool
  var inComputer: Bool
  var signedIn: Bool?
  var computerId: String?
}


typealias Fields = [String: AnyEncodable]

extension AnyEncodable {
  static var null: AnyEncodable { AnyEncodable(Optional<String>.none) }
  static func nullable(_ value: String) -> AnyEncodable { value.isEmpty ? .null : AnyEncodable(value) }
}

enum ManagementText {
  static func channelName(_ text: String) -> String {
    String(text.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
      .replacingOccurrences(of: "[^a-z0-9_-]+", with: "-", options: .regularExpression)
      .trimmingCharacters(in: CharacterSet(charactersIn: "-")).prefix(80))
  }

  static func handle(_ text: String) -> String {
    String(text.lowercased().replacingOccurrences(of: "[^a-z0-9-]+", with: "-", options: .regularExpression)
      .replacingOccurrences(of: "^[^a-z]+", with: "", options: .regularExpression)
      .replacingOccurrences(of: "-+$", with: "", options: .regularExpression).prefix(32))
  }
}
