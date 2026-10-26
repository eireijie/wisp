import Foundation

/** A computer asking to join this Wisp; an owner approves it by matching the code. */
struct JoinRequest: Decodable, Identifiable, Equatable {
  var id: String
  var name: String
  var kind: String?
  var platform: String?
  var code: String
  var createdAt: String?
  /** 123456 shows as "123 456", the way the computer shows it */
  var displayCode: String {
    let plain = code.filter { !$0.isWhitespace }
    guard plain.count == 6 else { return code }
    return "\(plain.prefix(3)) \(plain.suffix(3))"
  }
}

/** A link a new computer pastes into Join my Wisp. */
struct JoinInvite: Decodable { var url: String; var expiresAt: String }

/** How this hub can be reached from outside the home network (GET /api/reach). */
struct ReachInfo: Decodable {
  struct Tailscale: Decodable {
    var state: String
    var dnsName: String?
    var serving: Bool?
    var funnel: Bool?
    var ip: String?
    var tailnet: String?
    var authUrl: String?
    var error: String?
  }
  struct Cloudflare: Decodable { var state: String; var url: String?; var error: String? }
  var publicUrl: String?
  var lan: [String]?
  var tailscale: Tailscale
  var download: String?
  var hubPlatform: String?
  var cloudflare: Cloudflare?

  var cloudflareRunning: Bool { cloudflare?.state == "running" }
  /** the hub has an address that works away from home */
  var awayOn: Bool { publicUrl != nil || cloudflareRunning }
  var computerName: String { hubPlatform == "darwin" ? "Mac" : hubPlatform == "win32" ? "PC" : "computer" }
  var summary: String {
    if cloudflareRunning { return "On, with Cloudflare" }
    if tailscale.serving == true { return tailscale.funnel == true ? "On, with Tailscale (public)" : "On, with Tailscale" }
    if publicUrl != nil { return "On, with your public address" }
    return "Only at home for now"
  }
  /** the https address other apps (ChatGPT, Grok, Claude) can reach, if there is one */
  var connectorOrigin: String? {
    let candidate = cloudflareRunning ? cloudflare?.url : (tailscale.funnel == true ? publicUrl : nil)
    guard let candidate, var parts = URLComponents(string: candidate), parts.scheme == "https", parts.host?.isEmpty == false else { return nil }
    parts.path = ""; parts.query = nil; parts.fragment = nil
    return parts.url?.absoluteString
  }
}

/** An app (Grok, ChatGPT, Claude) connected to an agent through the hub's /mcp address. */
struct McpClient: Decodable, Identifiable {
  var id: String
  var name: String
  var agentId: String?
  var agentName: String?
  var createdAt: String?
  var lastUsed: String?
}

// MARK: - Harness settings

struct HarnessSettingItem: Decodable, Identifiable, Equatable {
  var id: String
  var name: String
  var description: String?
  var enabled: Bool
  /** false when the harness has no off switch for it */
  var canToggle: Bool
  var detail: String?
}

struct HarnessAccount: Decodable, Identifiable, Equatable {
  var id: String
  var label: String
  var isDefault: Bool
  /** nil when the device can't tell */
  var signedIn: Bool?
  var who: String?
}

struct HarnessProvider: Decodable, Identifiable, Equatable {
  var id: String
  var signedIn: Bool
}

/** One harness's own settings on a device, read from its config file there. */
struct HarnessSettings: Decodable, Equatable {
  var harness: String
  var account: String
  var accounts: [HarnessAccount]
  var multiAccount: Bool
  var agentAccounts: [String: String]
  var configPath: String
  var model: String?
  var provider: String?
  var providers: [HarnessProvider]?
  var apps: [HarnessSettingItem]
  var plugins: [HarnessSettingItem]
  var skills: [HarnessSettingItem]
  var fixed: [String]?
  var modelChoices: [String]?
  /** the reasoning effort it thinks with by default; only harnesses whose config has one Wisp can change send it */
  var effort: String?
  var hasEffort = false
  var error: String?

  enum CodingKeys: String, CodingKey { case harness, account, accounts, multiAccount, agentAccounts, configPath, model, provider, providers, apps, plugins, skills, fixed, modelChoices, effort, error }
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    harness = try c.decode(String.self, forKey: .harness)
    account = try c.decodeIfPresent(String.self, forKey: .account) ?? "default"
    accounts = try c.decodeIfPresent([HarnessAccount].self, forKey: .accounts) ?? []
    multiAccount = try c.decodeIfPresent(Bool.self, forKey: .multiAccount) ?? false
    agentAccounts = try c.decodeIfPresent([String: String].self, forKey: .agentAccounts) ?? [:]
    configPath = try c.decodeIfPresent(String.self, forKey: .configPath) ?? ""
    model = try c.decodeIfPresent(String.self, forKey: .model)
    provider = try c.decodeIfPresent(String.self, forKey: .provider)
    providers = try c.decodeIfPresent([HarnessProvider].self, forKey: .providers)
    apps = try c.decodeIfPresent([HarnessSettingItem].self, forKey: .apps) ?? []
    plugins = try c.decodeIfPresent([HarnessSettingItem].self, forKey: .plugins) ?? []
    skills = try c.decodeIfPresent([HarnessSettingItem].self, forKey: .skills) ?? []
    fixed = try c.decodeIfPresent([String].self, forKey: .fixed)
    modelChoices = try c.decodeIfPresent([String].self, forKey: .modelChoices)
    hasEffort = c.contains(.effort)
    effort = try c.decodeIfPresent(String.self, forKey: .effort)
    error = try c.decodeIfPresent(String.self, forKey: .error)
  }
  var currentAccount: HarnessAccount? { accounts.first { $0.id == account } ?? accounts.first }
  var modelFixed: Bool { fixed?.contains { $0 == "model" || $0 == "file" } == true }
  var providerFixed: Bool { fixed?.contains { $0 == "provider" || $0 == "file" } == true }
}

struct HarnessesResponse: Decodable {
  struct Device: Decodable { var id: String; var name: String }
  struct User: Decodable, Identifiable { var id: String; var handle: String; var name: String; var harness: String }
  struct Catalog: Decodable { var harness: String; var models: [ModelOption]; var defaultModel: String?; var efforts: [String]? }
  var device: Device
  var harnesses: [HarnessSettings]
  var agents: [User]
  var catalog: [Catalog]?
}

/** One edit to a harness's settings; only the fields of its kind are sent. */
struct HarnessChange: Encodable {
  var op: String
  var model: String?
  var provider: String?
  var effort: String?
  var kind: String?
  var id: String?
  var enabled: Bool?
}

/** A harness sign-in running on the device, or the command to run there instead. */
struct HarnessLogin: Decodable {
  var id: String?
  var status: String?
  var url: String?
  var code: String?
  var error: String?
  var manual: String?
}

struct HarnessSkillFile: Decodable { var name: String; var description: String; var content: String }

// MARK: - Appearance

/** The color themes the web offers, by the same ids. Swatches are [light accent, dark accent]. */
struct AppTheme: Identifiable, Equatable {
  var id: String
  var name: String
  var blurb: String
  var light: UInt32
  var dark: UInt32
  static let all: [AppTheme] = [
    AppTheme(id: "mono", name: "Mono", blurb: "Black and white. Color only for status and agents.", light: 0x171717, dark: 0xf5f5f5),
    AppTheme(id: "mint", name: "Ghost mint", blurb: "Fresh mint with cool grays.", light: 0x1aa577, dark: 0x43d19c),
    AppTheme(id: "iris", name: "Iris", blurb: "Calm periwinkle with cool grays.", light: 0x5b5fe0, dark: 0x8b8ef8),
    AppTheme(id: "lilac", name: "Lilac", blurb: "Soft and a little playful.", light: 0x8455e0, dark: 0xb593ff),
    AppTheme(id: "sky", name: "Sky", blurb: "Clear blue, bright and simple.", light: 0x1aa3e8, dark: 0x38bdf8)
  ]
  static func named(_ id: String) -> AppTheme { all.first { $0.id == id } ?? all[0] }
}
