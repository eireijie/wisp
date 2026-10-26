import SwiftUI

/** The password manager Wisp is connected to (GET /api/logins). Wisp stores no passwords. */
struct LoginSource: Decodable, Equatable {
  var kind: String
  var label: String
  var vaultName: String
  var connectedBy: String
  var connectedAt: String
}

/** One login in the manager's vault, and the agents allowed to use it without asking. */
struct LoginItem: Decodable, Identifiable, Equatable {
  var id: String
  var title: String
  var site: String
  var username: String
  var always: [String]
}

struct LoginsResponse: Decodable {
  var source: LoginSource?
  var logins: [LoginItem]
  /** the password manager stopped answering (a revoked token, say) */
  var problem: String?
}

struct LoginsConnected: Decodable { var vaultName: String; var count: Int }

extension Store {
  func logins(fresh: Bool = false) async throws -> LoginsResponse {
    try await fetch { try await $0.get("/api/logins", fresh ? ["fresh": "1"] : [:]) }
  }

  func connectOnePassword(token: String) async throws -> LoginsConnected {
    struct Body: Encodable { var kind = "1password"; var token: String }
    let data: Data = try await fetch { try await $0.put("/api/logins/source", Body(token: token)) }
    return try Wire.decoder.decode(LoginsConnected.self, from: data)
  }

  func disconnectLogins() async throws {
    try await fetch { try await $0.delete("/api/logins/source") }
  }

  func forgetLogin(_ itemId: String, agent agentId: String) async throws {
    let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))
    let item = itemId.addingPercentEncoding(withAllowedCharacters: allowed) ?? itemId
    let agent = agentId.addingPercentEncoding(withAllowedCharacters: allowed) ?? agentId
    try await fetch { try await $0.delete("/api/logins/\(item)/always/\(agent)") }
  }
}

/**
 * Logins: connect a password manager so agents can sign in to websites without ever seeing a
 * password. Wisp never stores a password; the logins listed here live in the manager.
 */
struct LoginsView: View {
  @Environment(Store.self) private var store
  @State private var view: LoginsResponse?
  @State private var connecting = false
  @State private var action = FormAction()

  private func agentName(_ id: String) -> String { store.agent(id)?.name ?? "An agent" }

  var body: some View {
    MarketScreen(title: "Logins", screenId: "logins") {
      Text("Agents sign in to websites through your password manager. Wisp never stores a password.").font(.system(size: 15)).foregroundStyle(Palette.muted).padding(.horizontal, 4)
      if !store.isOwner { MarketNote(text: "Only owners can change these. You can see how they're set.") }
      CardGroup {
        MarketRow(symbol: "key", tile: 50, title: "1Password", subtitle: view?.source != nil ? "Connected" + (connectedBy.map { " by \($0)" } ?? "") : "Paste one token") {
          if view?.source != nil {
            MarketPill(text: view?.problem == nil ? "On" : "Not answering", tone: view?.problem == nil ? .green : .warn, symbol: view?.problem == nil ? "checkmark" : nil)
          } else if store.isOwner {
            AddButton(title: "Connect") { connecting = true }
          }
        }
        MarketRow(symbol: "shield.lefthalf.filled", tile: 50, title: "Bitwarden", subtitle: "Not available yet") { MarketPill(text: "Coming soon") }
      }
      if let source = view?.source {
        if store.isOwner {
          Button("Disconnect \(source.label)", role: .destructive) { disconnect() }.font(.system(size: 13)).padding(.horizontal, 4)
        }
        if let problem = view?.problem {
          Text(problem).font(.footnote).foregroundStyle(Palette.red).padding(.horizontal, 4)
          if store.isOwner { Button("Paste a new token") { connecting = true }.font(.footnote).padding(.horizontal, 4) }
        }
        MarketLabel("Logins agents can use")
        if view?.logins.isEmpty == true && view?.problem == nil {
          Text("No logins in that vault yet. Add one in \(source.label) and it shows up here.").font(.system(size: 13)).foregroundStyle(Palette.muted).padding(.horizontal, 4)
        } else {
          CardGroup {
            ForEach(view?.logins ?? []) { login in
              MarketRow(symbol: "globe", title: login.site, subtitle: login.username.isEmpty ? login.title : login.username) {
                Text(login.always.isEmpty ? "Only you" : ShelfLogic.sentence(login.always.map(agentName))).font(.system(size: 13)).foregroundStyle(Palette.faint).lineLimit(2).multilineTextAlignment(.trailing).frame(maxWidth: 110, alignment: .trailing)
              }
              .contextMenu {
                if store.isOwner { ForEach(login.always, id: \.self) { id in Button("Stop letting \(agentName(id)) use it without asking", role: .destructive) { forget(login, id) } } }
              }
            }
          }
        }
        Text("Every use shows on that computer's activity, like “Nova used the Zendesk login”. Passwords never pass through chat, memory or logs.").font(.system(size: 13)).foregroundStyle(Palette.faint).padding(.horizontal, 4)
      } else {
        Text("Make a vault called “Agents” and a service account that can only see it. Wisp also fills in one-time codes saved there.").font(.system(size: 13)).foregroundStyle(Palette.faint).padding(.horizontal, 4)
        MarketNote(text: "No password manager? That's fine. When an agent needs to sign in, its screen pops up and you sign in yourself.")
      }
      InlineError(error: action.error)
    }
    .sheet(isPresented: $connecting) { ConnectOnePasswordSheet { Task { view = try? await store.logins(fresh: true) } } }
    .task { view = try? await store.logins() }
    .refreshable { view = try? await store.logins(fresh: true) }
  }

  private var connectedBy: String? { view?.source.flatMap { s in store.members.first { $0.id == s.connectedBy }?.name } }

  private func disconnect() {
    action.run {
      try await store.disconnectLogins()
      view = try await store.logins()
    }
  }

  private func forget(_ login: LoginItem, _ agent: String) {
    action.run {
      try await store.forgetLogin(login.id, agent: agent)
      view = try await store.logins()
    }
  }
}

/** Connect 1Password with a service account token. Only the owner can. */
private struct ConnectOnePasswordSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  var onDone: () -> Void
  @State private var token = ""
  @State private var found: LoginsConnected?
  @State private var action = FormAction()

  var body: some View {
    MarketSheet(title: "Connect 1Password", subtitle: "Only the owner can do this", busy: action.busy) {
      if let found {
        MarketNote(text: "Found the \(found.vaultName) vault · \(found.count) \(found.count == 1 ? "login" : "logins")")
        MarketPrimaryButton(title: "Done") { dismiss(); onDone() }
      } else {
        Text("Wisp asks 1Password for one login at a time, only after you approve it in Inbox. Nothing is saved in Wisp.").font(.system(size: 15)).foregroundStyle(Palette.text.opacity(0.9)).padding(.horizontal, 4)
        MarketField(label: "Service account token", placeholder: "ops_…", text: $token, secure: true, mono: true, plain: true)
        Button("Where do I find this?") { if let url = URL(string: "https://developer.1password.com/docs/service-accounts/get-started/") { openURL(url) } }.font(.system(size: 13)).padding(.horizontal, 4)
        Text("Make a vault called “Agents” and a service account that can read only that vault, then copy its token.").font(.system(size: 13)).foregroundStyle(Palette.faint).padding(.horizontal, 4)
        InlineError(error: action.error)
        MarketPrimaryButton(title: "Connect", busy: action.busy, disabled: token.trimmed.isEmpty) {
          action.run { found = try await store.connectOnePassword(token: token.trimmed); token = "" }
        }
      }
    }
  }
}
