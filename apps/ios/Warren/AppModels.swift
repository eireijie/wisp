import Foundation

struct HelperSkill: Decodable, Identifiable {
  struct Plain: Decodable { var does: String; var needs: String; var example: String }
  var id: String
  var name: String
  var description: String?
  var content: String?
  var tags: [String]?
  var agentIds: [String]?
  var source: String?
  var catalogId: String?
  var plain: Plain?
}
struct AppConnector: Decodable, Identifiable {
  struct Auth: Decodable { var required: Bool?; var signedIn: Bool?; var error: String? }
  var id: String
  var name: String
  var kind: String
  var catalogId: String?
  var description: String?
  var category: String?
  var command: String?
  var args: [String]?
  var url: String?
  var headers: [String: String]?
  var env: [String: String]?
  var enabled: Bool?
  var agentIds: [String]?
  var needsSignIn: Bool { auth?.required == true && auth?.signedIn != true }
  var auth: Auth?
  var warnings: [String]?
  var fields: [ConnectorField]?
  var needs: String?
  var docs: String?
}
struct ConnectorField: Decodable, Identifiable {
  var key: String
  var label: String
  var secret: Bool?
  var optional: Bool?
  var hint: String?
  var placeholder: String?
  var link: String?
  var id: String { key }
}
struct ConnectorSignIn: Decodable { var url: String?; var signedIn: Bool? }
struct Marketplace: Decodable { var entries: [MarketplaceEntry]; var featured: Bool? }
struct MarketplaceEntry: Decodable, Identifiable {
  var id: String
  var name: String
  var description: String?
  var publisher: String?
  var domain: String?
  var verified: Bool?
  var website: String?
  var repository: String?
  var installs: [MarketplaceInstall]
}
struct MarketplaceInstall: Decodable {
  var kind: String
  var label: String
  var command: String?
  var args: [String]?
  var url: String?
  var headers: [String: String]?
  var fields: [ConnectorField]?
  var needs: String?
}
enum NativeCatalog {
  static func read<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
    guard let url = Bundle.main.url(forResource: name, withExtension: "json") else {
      throw API.Failure(status: 0, message: "The app's library is missing. Reinstall Warren to restore it.")
    }
    return try Wire.decoder.decode(type, from: Data(contentsOf: url))
  }
}
