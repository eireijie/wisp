import Foundation

struct HubUpdate: Decodable {
  struct Version: Decodable { var commit: String?; var date: String? }
  struct Check: Decodable { var behind: Int?; var changes: [String]?; var canUpdate: Bool?; var managedByApp: Bool?; var reason: String? }
  struct State: Decodable { var state: String; var message: String?; var log: [String]? }
  var version: Version?
  var check: Check?
  var update: State?
}

