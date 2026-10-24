import SwiftUI

struct ConnectorsView: View {
  @Environment(Store.self) private var store
  @Environment(\.scenePhase) private var scenePhase
  @State private var catalog: [AppConnector] = []
  @State private var market: [MarketplaceEntry] = []
  @State private var tab = "connected"
  @State private var query = ""
  @State private var adding = false
  @State private var action = FormAction()
  var body: some View {
    List {
      Picker("Connected apps", selection: $tab) { Text("Connected").tag("connected"); Text("Catalog").tag("catalog"); Text("Marketplace").tag("market") }.pickerStyle(.segmented)
      InlineError(error: action.error)
      if tab == "market" {
        ForEach(market) { entry in NavigationLink(entry.name) { MarketplaceDetail(entry: entry) } }
      } else {
        let list = (tab == "connected" ? store.connectors : catalog).filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }
        if list.isEmpty { Text(tab == "connected" ? "No connected apps yet" : "No matches.").foregroundStyle(.secondary) }
        ForEach(list) { connector in
          NavigationLink { if tab == "connected" { ConnectorDetail(connector: connector) } else { ConnectorCatalogDetail(entry: connector) } } label: {
            VStack(alignment: .leading, spacing: 4) { Text(connector.name).font(.headline); Text(connector.description ?? (connector.enabled == false ? "Off" : connector.auth?.signedIn == true ? "Signed in" : connector.kind)).font(.caption).foregroundStyle(.secondary) }
          }
        }
      }
    }.sectionScreen("Connected apps", id: "connectors").searchable(text: $query)
      .toolbar { if store.canManage { Button("Add your own connector", systemImage: "plus") { adding = true } } }
      .sheet(isPresented: $adding) { ConnectorEditor(onSignInError: { action.error = $0 }) }
      .task {
        do { catalog = try NativeCatalog.read("ConnectorCatalog", as: [AppConnector].self); try await store.refreshConnectors() } catch { action.error = error.localizedDescription }
      }
      .task(id: tab + query) {
        if tab == "market" {
          do { try await Task.sleep(for: .milliseconds(250)); market = try await store.marketplace(query) }
          catch { if !Task.isCancelled { action.error = error.localizedDescription } }
        }
      }
      .onChange(of: scenePhase) { _, phase in if phase == .active { action.run { try await store.refreshConnectors() } } }
      .refreshable { do { try await store.refreshConnectors() } catch { action.error = error.localizedDescription } }
  }
}

struct ConnectorDetail: View {
  @Environment(Store.self) private var store
  @Environment(\.openURL) private var openURL
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  var connector: AppConnector
  @State private var editing = false
  @State private var removing = false
  @State private var action = FormAction()
  private var current: AppConnector { store.connectors.first { $0.id == connector.id } ?? connector }
  var body: some View {
    List {
      Text(current.name).font(.title2.bold())
      if let auth = current.auth {
        Text(auth.signedIn == true ? "Signed in" : "Not signed in")
        InlineError(error: auth.error)
      }
      ForEach(current.warnings ?? [], id: \.self) { Text($0).foregroundStyle(.orange) }
      if store.canManage {
        Toggle("On", isOn: Binding(get: { current.enabled != false }, set: { on in action.run { try await store.saveConnector(current.id, ["enabled": AnyEncodable(on)]) } })).disabled(action.busy)
        if current.kind == "mcp-http" {
          if current.needsSignIn { Button("Sign in") { action.run { if let url = try await store.connectorSignIn(current.id) { openURL(url) } } }.disabled(action.busy) }
          if current.auth?.signedIn == true { Button("Sign out") { action.run { try await store.connectorSignOut(current.id) } }.disabled(action.busy) }
        }
        Button("Edit settings") { editing = true }
        Button("Remove", role: .destructive) { removing = true }
      }
      Section("Helpers") { ForEach(current.agentIds ?? [], id: \.self) { Text(store.agent($0)?.name ?? $0) } }
      TechnicalDetails(title: "How it starts") {
        if let url = current.url { Text(url).textSelection(.enabled) }
        if let command = current.command { Text(([command] + (current.args ?? [])).joined(separator: " ")).textSelection(.enabled) }
      }
      Button("Refresh") { action.run { try await store.refreshConnectors() } }
      InlineError(error: action.error)
    }.sectionScreen(current.name, id: "connector")
      .sheet(isPresented: $editing) { ConnectorEditor(existing: current, onSignInError: { action.error = $0 }) }
      .onChange(of: scenePhase) { _, phase in if phase == .active { action.run { try await store.refreshConnectors() } } }
      .confirmationDialog("Remove this connector? Helpers will lose access to it.", isPresented: $removing, titleVisibility: .visible) {
        Button("Remove", role: .destructive) { action.run { try await store.deleteConnector(current.id); dismiss() } }
      }
  }
}

struct ConnectorCatalogDetail: View {
  @Environment(Store.self) private var store
  var entry: AppConnector
  var publisher: String?
  var caution: String?
  @State private var adding = false
  @State private var action = FormAction()
  var body: some View {
    List {
      InlineError(error: action.error)
      Text(entry.description ?? "")
      Section("Before you connect") {
        Text("Your helpers will be able to use \(entry.name) through this connection: read and act on what this app allows.")
        Text(publisher.map { "Run by \($0), not by Wisp." } ?? "On Wisp's list of well-known apps.")
        if let caution { Text(caution) }
      }
      if let needs = entry.needs { Text("Needs: \(needs)") }
      if let docs = entry.docs, let url = URL(string: docs) { Link("Documentation", destination: url) }
      if store.canManage { Button("Connect") { adding = true } }
    }.navigationTitle(entry.name)
      .sheet(isPresented: $adding) { ConnectorEditor(entry: entry, onSignInError: { action.error = $0 }) }
  }
}

struct MarketplaceDetail: View {
  var entry: MarketplaceEntry
  @State private var index = 0
  var body: some View {
    VStack {
      if entry.installs.count > 1 {
        Picker("How to connect", selection: $index) { ForEach(entry.installs.indices, id: \.self) { Text(entry.installs[$0].label).tag($0) } }.padding()
      }
      if entry.installs.indices.contains(index) {
        let install = entry.installs[index]
        ConnectorCatalogDetail(entry: AppConnector(id: "registry:\(entry.id)", name: entry.name, kind: install.kind, description: entry.description, command: install.command, args: install.args, url: install.url, headers: install.headers, fields: install.fields, needs: install.needs, docs: entry.website ?? entry.repository), publisher: entry.publisher, caution: entry.verified != true && entry.domain == nil ? "Nobody has confirmed who they are. Only connect if you trust them." : nil).id(index)
      } else { ContentUnavailableView("No install options", systemImage: "plug") }
    }
  }
}
