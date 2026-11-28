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
  var slug: String?
  /** on for every agent, including ones made later (agentIds is then ignored); missing on older hubs */
  var allAgents: Bool?
  /** the agent that saved it, for source "learned" */
  var learnedBy: String?
  /** how many runs read it */
  var uses: Int?
  var lastUsedAt: String?
  var createdAt: String?

  var isLearned: Bool { source == "learned" }
  var forAll: Bool { allAgents == true }
  /** whether this agent can use it: on for everyone, or given to it */
  func has(_ agentId: String) -> Bool { forAll || agentIds?.contains(agentId) == true }
}

/** A harness's own skill or command (GET /api/skills/built-in), for Settings → Skills → Built in. */
struct BuiltInSkill: Decodable, Identifiable, Hashable {
  var name: String
  var description: String?
  var harness: String
  var harnessLabel: String
  var agentIds: [String]
  var id: String { harness + ":" + name }
}
struct BuiltInSkillList: Decodable { var skills: [BuiltInSkill] }
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
  /** on for every agent, including ones made later; missing on older hubs */
  var allAgents: Bool?
  var forAll: Bool { allAgents == true }
  func has(_ agentId: String) -> Bool { forAll || agentIds?.contains(agentId) == true }
  var needsSignIn: Bool { auth?.required == true && auth?.signedIn != true }
  var auth: Auth?
  var warnings: [String]?
  var fields: [ConnectorField]?
  var needs: String?
  var docs: String?
  /** a catalog entry that signs in with one click, and how (the bundled catalog only) */
  var signIn: CatalogSignIn?
  /** always recommended (Composio): its one line ("Use Composio for more apps and easy sign-in.") */
  var recommended: String?
  /** the apps picked inside an app hub like Composio, as last checked (round 16); only on those */
  var linkedApps: LinkedApps?
  /** connected, but no apps picked inside it yet: the card says so, with Pick apps */
  var noAppsPicked: Bool { linkedApps?.picked == false }
}

/** What an app hub (Composio) last said about the apps inside it: `picked` false is none yet, nil is couldn't tell. */
struct LinkedApps: Decodable, Hashable {
  var picked: Bool?
  var names: [String]?
  /** the hub's own page where the person picks apps */
  var pickUrl: String?
  var checkedAt: String?
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
  /** the publisher's brand, used for the trust label */
  var brand: String?
  var website: String?
  var repository: String?
  /** where its logo can be loaded from, best first */
  var logos: [String]?
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
      throw API.Failure(status: 0, message: "The app's library is missing. Reinstall Bubble AI to restore it.")
    }
    return try Wire.decoder.decode(type, from: Data(contentsOf: url))
  }
}
