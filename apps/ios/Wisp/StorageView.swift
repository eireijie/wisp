import SwiftUI

/** A service agents can keep files on (packages/core/src/storage.ts). */
enum StorageService: String, Codable, CaseIterable, Identifiable {
  case nextcloud, gdrive, dropbox, truenas, webdav
  var id: String { rawValue }
  var name: String {
    switch self {
    case .nextcloud: "Nextcloud"
    case .gdrive: "Google Drive"
    case .dropbox: "Dropbox"
    case .truenas: "TrueNAS"
    case .webdav: "Other server"
    }
  }
  /** the brand's real logo from the hub, or nothing for "Other server" */
  var logos: [String] { self == .webdav ? [] : AppLogo.byName(name) }
}

struct StorageFolder: Codable, Hashable {
  var path: String
  var access: String // read | write
  var label: String { path == "/" ? "Everything" : String(path.dropFirst()) }
}

/** A connected storage as the hub shows it: never a password or token. */
struct StorageConnection: Decodable, Identifiable, Hashable {
  var id: String
  var name: String
  var service: StorageService
  var url: String?
  var account: String
  var folders: [StorageFolder]
  var allAgents: Bool
  var agentIds: [String]
  var always: [Always]
  var problem: String?
  struct Always: Decodable, Hashable { var agentId: String; var folder: String }

  var host: String? { url.flatMap { URL(string: $0)?.host } }
}

struct StorageEntry: Decodable, Identifiable, Hashable {
  var name: String
  var path: String
  var type: String
  var id: String { path }
}

struct StorageList: Decodable {
  var connections: [StorageConnection]
  var apps: [String: App]
  struct App: Decodable { var clientId: String }
}

extension Store {
  func storage() async throws -> StorageList { try await fetch { try await $0.get("/api/storage") } }

  func connectStorageServer(service: StorageService, url: String, username: String?, password: String?, loginItemId: String?) async throws -> StorageConnection {
    struct Body: Encodable { var service: String; var url: String; var username: String?; var password: String?; var loginItemId: String? }
    return try await fetch { try await $0.post("/api/storage/webdav", Body(service: service.rawValue, url: url, username: username, password: password, loginItemId: loginItemId)) }
  }

  func startNextcloud(server: String) async throws -> (pendingId: String, loginUrl: String) {
    struct Body: Encodable { var server: String }
    struct Out: Decodable { var pendingId: String; var loginUrl: String }
    let out: Out = try await fetch { try await $0.post("/api/storage/nextcloud/start", Body(server: server)) }
    return (out.pendingId, out.loginUrl)
  }

  /** The connection once the person approved Wisp in Nextcloud, or nil while waiting. */
  func pollNextcloud(_ pendingId: String) async throws -> StorageConnection? {
    struct Body: Encodable { var pendingId: String }
    struct Out: Decodable { var connection: StorageConnection? }
    let out: Out = try await fetch { try await $0.post("/api/storage/nextcloud/poll", Body(pendingId: pendingId)) }
    return out.connection
  }

  func startStorageSignIn(service: StorageService, clientId: String, clientSecret: String?) async throws -> URL {
    struct Body: Encodable { var service: String; var origin: String; var clientId: String; var clientSecret: String? }
    struct Out: Decodable { var url: String }
    let origin = api?.base.absoluteString ?? ""
    let out: Out = try await fetch { try await $0.post("/api/storage/oauth/start", Body(service: service.rawValue, origin: origin, clientId: clientId, clientSecret: clientSecret)) }
    guard let url = URL(string: out.url) else { throw API.Failure(status: 502, message: "The sign-in address didn't make sense.") }
    return url
  }

  func updateStorage(_ id: String, folders: [StorageFolder]? = nil, allAgents: Bool? = nil, agentIds: [String]? = nil) async throws -> StorageConnection {
    struct Body: Encodable { var folders: [StorageFolder]?; var allAgents: Bool?; var agentIds: [String]? }
    return try await fetch { try await $0.patch("/api/storage/\(id)", Body(folders: folders, allAgents: allAgents, agentIds: agentIds)) }
  }

  func removeStorage(_ id: String) async throws {
    try await fetch { try await $0.delete("/api/storage/\(id)") }
  }

  func browseStorage(_ id: String, path: String) async throws -> [StorageEntry] {
    struct Out: Decodable { var entries: [StorageEntry] }
    let out: Out = try await fetch { try await $0.get("/api/storage/\(id)/browse", ["path": path]) }
    return out.entries
  }

  func forgetStorageAlways(_ id: String, agent agentId: String, folder: String) async throws -> StorageConnection {
    let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))
    let agent = agentId.addingPercentEncoding(withAllowedCharacters: allowed) ?? agentId
    let q = folder.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+"))) ?? folder
    let data = try await fetch { try await $0.delete("/api/storage/\(id)/always/\(agent)?folder=\(q)") }
    return try Wire.decoder.decode(StorageConnection.self, from: data)
  }
}

/** A storage's logo tile, or a plain server for "Other server". */
struct StorageLogo: View {
  var service: StorageService
  var size: CGFloat = 40
  var body: some View {
    if service.logos.isEmpty { MarketTile(symbol: "server.rack", size: size) } else { AppLogo(sources: service.logos, symbol: "externaldrive", size: size) }
  }
}

/**
 * Storage (the Storage mod): owners connect Nextcloud, a NAS, Google Drive or Dropbox, and pick
 * the folders agents may use and which agents. Members can look.
 */
struct StorageView: View {
  @Environment(Store.self) private var store
  @Environment(\.scenePhase) private var scenePhase
  @State private var list: StorageList?
  @State private var adding = false
  @State private var error: String?

  var body: some View {
    MarketScreen(title: "Storage", screenId: "storage") {
      if store.isOwner { CircleButton(symbol: "plus", label: "Add storage", id: "storage-add") { adding = true } }
    } content: {
      if !store.isOwner { MarketNote(text: "Only owners can change these. You can see how they're set.") }
      if let list {
        if list.connections.isEmpty {
          MarketNote(text: "Nothing connected yet.")
        } else {
          CardGroup {
            ForEach(list.connections) { c in
              NavigationLink { StorageConnectionView(connection: c, onChange: load) } label: {
                HStack(spacing: 0) {
                  MarketRow(logos: c.service.logos, symbol: "server.rack", title: c.name, subtitle: subtitle(c))
                  Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.faint).padding(.trailing, 16)
                }
              }
              .buttonStyle(.plain)
            }
          }
        }
      }
      if let error { Text(error).font(.footnote).foregroundStyle(Palette.red).padding(.horizontal, 4) }
    }
    .sheet(isPresented: $adding) { AddStorageSheet(apps: list?.apps ?? [:]) { Task { await load() } } }
    .task { await load() }
    .refreshable { await load() }
    // back from signing in to Google or Dropbox in the browser
    .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await load() } } }
  }

  private func subtitle(_ c: StorageConnection) -> String {
    if let problem = c.problem { return problem }
    let who = c.allAgents ? "Every agent" : c.agentIds.isEmpty ? "No agents yet" : c.agentIds.map { "@\(store.agent($0)?.handle ?? "?")" }.joined(separator: ", ")
    return [c.host ?? c.account, "\(c.folders.count) \(c.folders.count == 1 ? "folder" : "folders")", who].filter { !$0.isEmpty }.joined(separator: " · ")
  }

  private func load() async {
    do { list = try await store.storage(); error = nil } catch { self.error = error.localizedDescription }
  }
}

extension MarketRow where Trailing == EmptyView {
  init(logos: [String], symbol: String, title: String, subtitle: String?) {
    self.init(symbol: symbol, logos: logos, title: title, subtitle: subtitle) { EmptyView() }
  }
}

// --- adding ----------------------------------------------------------------------------------

private struct AddStorageSheet: View {
  @Environment(\.dismiss) private var dismiss
  var apps: [String: StorageList.App]
  var onDone: () -> Void
  @State private var service: StorageService?

  var body: some View {
    switch service {
    case .nextcloud?: ConnectNextcloud(back: { service = nil }, done: finish)
    case .gdrive?, .dropbox?: ConnectCloud(service: service!, savedClientId: apps[service!.rawValue]?.clientId, back: { service = nil })
    case let s?: ConnectServer(service: s, back: { service = nil }, done: finish)
    case nil:
      MarketSheet(title: "Add storage") {
        CardGroup {
          ForEach(StorageService.allCases) { s in
            Button { service = s } label: {
              MarketRow(logos: s.logos, symbol: "server.rack", title: s.name, subtitle: s == .webdav ? "ownCloud, Synology, QNAP, anything with WebDAV" : nil)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("storage-pick-\(s.rawValue)")
          }
        }
      }
    }
  }

  private func finish() {
    dismiss()
    onDone()
  }
}

/** A connect screen's top: back to the list, and the service's logo. */
private struct ConnectHead: View {
  var service: StorageService
  var back: () -> Void
  var body: some View {
    HStack(spacing: 12) {
      CircleButton(symbol: "chevron.left", label: "Back", size: 36, action: back)
      StorageLogo(service: service, size: 32)
    }
  }
}

private struct ConnectNextcloud: View {
  @Environment(Store.self) private var store
  @Environment(\.openURL) private var openURL
  var back: () -> Void
  var done: () -> Void
  @State private var server = ""
  @State private var waiting = false
  @State private var action = FormAction()

  var body: some View {
    MarketSheet(title: "Nextcloud", busy: action.busy) {
      ConnectHead(service: .nextcloud, back: back)
      MarketField(label: "Address", placeholder: "https://cloud.example.com", text: $server, keyboard: .URL, plain: true)
      MarketPrimaryButton(title: "Sign in with Nextcloud", busy: waiting, disabled: server.trimmed.isEmpty) { start() }
        .accessibilityIdentifier("storage-nextcloud-signin")
      Text("Your Nextcloud opens in the browser to approve Wisp. Wisp gets its own app password, which you can revoke there under Security. It never sees your password.")
        .font(.system(size: 13)).foregroundStyle(Palette.muted).padding(.horizontal, 4)
      if waiting {
        HStack(spacing: 10) { ProgressView(); Text("Waiting for you to approve in the browser…") }.font(.system(size: 15)).foregroundStyle(Palette.muted).padding(.horizontal, 4)
      }
      InlineError(error: action.error)
    }
  }

  private func start() {
    action.run {
      let (pending, login) = try await store.startNextcloud(server: server.trimmed)
      if let url = URL(string: login) { openURL(url) }
      waiting = true
      defer { waiting = false }
      while !Task.isCancelled {
        try await Task.sleep(for: .seconds(2))
        if try await store.pollNextcloud(pending) != nil { done(); return }
      }
    }
  }
}

private struct ConnectServer: View {
  @Environment(Store.self) private var store
  var service: StorageService
  var back: () -> Void
  var done: () -> Void
  @State private var url = ""
  @State private var how = "manager"
  @State private var logins: LoginsResponse?
  @State private var loginId = ""
  @State private var username = ""
  @State private var password = ""
  @State private var action = FormAction()

  private var ready: Bool { !url.trimmed.isEmpty && (how == "manager" ? !loginId.isEmpty : !username.trimmed.isEmpty && !password.isEmpty) }

  var body: some View {
    MarketSheet(title: service.name, busy: action.busy) {
      ConnectHead(service: service, back: back)
      MarketField(label: "WebDAV address", placeholder: service == .truenas ? "https://nas.local:8081/files" : "https://files.example.com/dav", text: $url, keyboard: .URL, plain: true)
      MarketLabel("Sign in with")
      SegPicker(options: [("manager", "Password manager"), ("password", "App password")], selection: $how)
      if how == "manager" {
        if let source = logins?.source {
          MarketLabel("Login")
          Picker("Login", selection: $loginId) {
            Text("Pick a login…").tag("")
            ForEach(logins?.logins ?? []) { l in Text("\(l.title) · \(l.username.isEmpty ? l.site : l.username)").tag(l.id) }
          }
          .pickerStyle(.menu)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 8).frame(minHeight: 50)
          .background(Palette.control, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          Text("Wisp reads it from \(source.label) each time it opens the server and never keeps it. Use a user that can only reach the shares agents need.")
            .font(.system(size: 13)).foregroundStyle(Palette.muted).padding(.horizontal, 4)
        } else {
          Text("No password manager is connected. Connect one in Settings → Logins, or use an app password.").font(.system(size: 13)).foregroundStyle(Palette.muted).padding(.horizontal, 4)
        }
      } else {
        MarketField(label: "User name", placeholder: "", text: $username, plain: true)
        MarketField(label: "App password", placeholder: "", text: $password, secure: true)
        Text("Kept encrypted on your hub. Only owners can change it.").font(.system(size: 13)).foregroundStyle(Palette.muted).padding(.horizontal, 4)
      }
      InlineError(error: action.error)
      MarketPrimaryButton(title: action.busy ? "Checking…" : "Connect", busy: action.busy, disabled: !ready) {
        action.run {
          _ = try await store.connectStorageServer(service: service, url: url.trimmed, username: how == "password" ? username.trimmed : nil, password: how == "password" ? password : nil, loginItemId: how == "manager" ? loginId : nil)
          done()
        }
      }
      .accessibilityIdentifier("storage-connect")
    }
    .task {
      logins = try? await store.logins()
      if logins?.source == nil { how = "password" }
    }
  }
}

private struct ConnectCloud: View {
  @Environment(Store.self) private var store
  @Environment(\.openURL) private var openURL
  @Environment(\.dismiss) private var dismiss
  var service: StorageService
  var savedClientId: String?
  var back: () -> Void
  @State private var clientId = ""
  @State private var secret = ""
  @State private var action = FormAction()

  private var google: Bool { service == .gdrive }
  private var saved: Bool { savedClientId != nil && clientId.trimmed == savedClientId }
  private var ready: Bool { !clientId.trimmed.isEmpty && (!google || saved || !secret.trimmed.isEmpty) }
  private var help: URL? { URL(string: google ? "https://developers.google.com/workspace/guides/create-credentials#oauth-client-id" : "https://www.dropbox.com/developers/apps") }

  var body: some View {
    MarketSheet(title: service.name, busy: action.busy) {
      ConnectHead(service: service, back: back)
      VStack(alignment: .leading, spacing: 4) {
        Text("Your \(google ? "Google" : "Dropbox") app").font(.system(size: 15, weight: .semibold))
        Text("Wisp runs on your own server, so it signs in to \(service.name) through an app you make \(google ? "in Google Cloud" : "in the Dropbox App Console"). Once per workspace.")
          .font(.system(size: 13)).foregroundStyle(Palette.muted)
        Button("How") { if let help { openURL(help) } }.font(.system(size: 13, weight: .medium))
        Text("Redirect address: \((store.api?.base.absoluteString ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/")))/api/storage/oauth/callback")
          .font(.system(size: 12, design: .monospaced)).foregroundStyle(Palette.faint).textSelection(.enabled)
      }
      .padding(.horizontal, 4)
      MarketField(label: google ? "Client ID" : "App key", placeholder: "", text: $clientId, mono: true, plain: true)
      if google { MarketField(label: "Client secret", placeholder: saved ? "Saved" : "", text: $secret, secure: true) }
      InlineError(error: action.error)
      MarketPrimaryButton(title: "Sign in with \(google ? "Google" : "Dropbox")", busy: action.busy, disabled: !ready) {
        action.run {
          let url = try await store.startStorageSignIn(service: service, clientId: clientId.trimmed, clientSecret: secret.trimmed.isEmpty ? nil : secret.trimmed)
          openURL(url)
          dismiss()
        }
      }
    }
    .onAppear { clientId = savedClientId ?? "" }
  }
}

// --- one connection --------------------------------------------------------------------------

struct StorageConnectionView: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State var connection: StorageConnection
  var onChange: () async -> Void
  @State private var picking = false
  @State private var removing = false
  @State private var action = FormAction()

  private var c: StorageConnection { connection }

  var body: some View {
    MarketScreen(title: c.name, screenId: "storage-connection") {
      HStack(spacing: 12) {
        StorageLogo(service: c.service, size: 40)
        Text([c.host, c.account.isEmpty ? nil : c.account].compactMap { $0 }.joined(separator: " · ")).font(.system(size: 13)).foregroundStyle(Palette.faint)
      }
      .padding(.horizontal, 4)
      if let problem = c.problem { MarketNote(text: problem, tone: .warn) }

      MarketLabel("Folders agents can use")
      CardGroup {
        ForEach(c.folders, id: \.path) { f in
          HStack(spacing: 12) {
            Image(systemName: "folder").font(.system(size: 16)).foregroundStyle(Palette.muted)
            Text(f.label).font(.system(size: 15)).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 8)
            Menu {
              Button("Read only") { setAccess(f, "read") }
              Button("Can change") { setAccess(f, "write") }
              Divider()
              Button("Remove", role: .destructive) { save(folders: c.folders.filter { $0.path != f.path }) }
            } label: {
              HStack(spacing: 4) {
                Text(f.access == "write" ? "Can change" : "Read only")
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 11))
              }
              .font(.system(size: 15)).foregroundStyle(Palette.muted)
            }
            .disabled(!store.isOwner)
            .accessibilityLabel("What agents can do in \(f.label)")
          }
          .padding(.horizontal, 16).frame(minHeight: 54)
        }
        if store.isOwner {
          Button { picking = true } label: {
            Text("Add folder").font(.system(size: 15)).foregroundStyle(Palette.text).frame(maxWidth: .infinity, minHeight: 50, alignment: .leading).padding(.horizontal, 16).contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityIdentifier("storage-add-folder")
        } else if c.folders.isEmpty {
          MarketRow(title: "No folders yet")
        }
      }
      Text("Agents ask you before adding, changing or deleting files.").font(.system(size: 13)).foregroundStyle(Palette.muted).padding(.horizontal, 4)
      if !c.always.isEmpty {
        ForEach(c.always, id: \.self) { a in
          HStack {
            Text("\(store.agent(a.agentId)?.name ?? "An agent") changes files in \(a.folder == "/" ? "everything" : String(a.folder.dropFirst())) without asking").font(.system(size: 13)).foregroundStyle(Palette.faint)
            Spacer()
            if store.isOwner { Button("Stop") { forget(a) }.font(.system(size: 13, weight: .medium)) }
          }
          .padding(.horizontal, 4)
        }
      }

      MarketLabel("Who can use it")
      AgentAccessPicker(
        allAgents: Binding(get: { c.allAgents }, set: { save(allAgents: $0) }),
        isOn: { agent in Binding(get: { c.agentIds.contains(agent.id) }, set: { on in save(agentIds: on ? c.agentIds + [agent.id] : c.agentIds.filter { $0 != agent.id }) }) },
        disabled: !store.isOwner
      )

      InlineError(error: action.error)
      if store.isOwner {
        CardGroup {
          Button(role: .destructive) { removing = true } label: { Text("Remove storage").font(.system(size: 15)).foregroundStyle(Palette.red).frame(maxWidth: .infinity, minHeight: 50) }.buttonStyle(.plain)
        }
        .padding(.top, 8)
      }
    }
    .sheet(isPresented: $picking) {
      NavigationStack { FolderPicker(connection: c, path: "/") { path in picking = false; if !c.folders.contains(where: { $0.path == path }) { save(folders: c.folders + [StorageFolder(path: path, access: "read")]) } } }
        .presentationBackground(Palette.sheet)
    }
    .confirmationDialog("Remove \(c.name)? Agents stop being able to use it. Nothing on the storage itself changes.", isPresented: $removing, titleVisibility: .visible) {
      Button("Remove storage", role: .destructive) {
        action.run {
          try await store.removeStorage(c.id)
          await onChange()
          dismiss()
        }
      }
    }
  }

  private func setAccess(_ f: StorageFolder, _ access: String) {
    save(folders: c.folders.map { $0.path == f.path ? StorageFolder(path: f.path, access: access) : $0 })
  }

  private func save(folders: [StorageFolder]? = nil, allAgents: Bool? = nil, agentIds: [String]? = nil) {
    action.run {
      connection = try await store.updateStorage(c.id, folders: folders, allAgents: allAgents, agentIds: agentIds)
      await onChange()
    }
  }

  private func forget(_ a: StorageConnection.Always) {
    action.run { connection = try await store.forgetStorageAlways(c.id, agent: a.agentId, folder: a.folder) }
  }
}

/** Walk the storage's folders a level at a time and pick one. */
private struct FolderPicker: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var connection: StorageConnection
  var path: String
  var pick: (String) -> Void
  @State private var folders: [StorageEntry]?
  @State private var error: String?

  var body: some View {
    List {
      if let folders {
        ForEach(folders) { f in
          NavigationLink { FolderPicker(connection: connection, path: f.path, pick: pick) } label: { Label(f.name, systemImage: "folder") }
        }
        if folders.isEmpty { Text("No folders inside.").foregroundStyle(Palette.muted) }
      } else if let error {
        Text(error).foregroundStyle(Palette.red)
      } else {
        ProgressView()
      }
    }
    .navigationTitle(path == "/" ? connection.name : String(path.split(separator: "/").last ?? ""))
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .cancellationAction) { if path == "/" { Button("Cancel") { dismiss() } } }
      ToolbarItem(placement: .confirmationAction) { Button(path == "/" ? "Use everything" : "Use this folder") { pick(path) }.accessibilityIdentifier("storage-use-folder") }
    }
    .task {
      do { folders = try await store.browseStorage(connection.id, path: path).filter { $0.type == "folder" } } catch { self.error = error.localizedDescription }
    }
  }
}
