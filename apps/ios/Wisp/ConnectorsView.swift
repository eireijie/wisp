import SwiftUI

/** The connected apps list now lives in the Marketplace; this opens it on the Apps tab. */
struct ConnectorsView: View {
  var body: some View { MarketplaceView(start: .apps) }
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
  var trust: TrustLabel?
  var summary: ConnectSummary?
  /** values already known (an app found on a device keeps its non-secret settings) */
  var presetEnv: [String: String] = [:]
  @State private var adding = false
  @State private var action = FormAction()
  var body: some View {
    List {
      InlineError(error: action.error)
      Text(entry.description ?? "")
      if let trust { Section { TrustBadge(trust: trust); Text(trust.explanation).font(.footnote).foregroundStyle(.secondary) } }
      Section("Before you connect") {
        let s = summary ?? MarketText.summary(builtIn: entry)
        Text(s.can)
        Text(s.runBy)
        if let caution = s.caution { Text(caution).foregroundStyle(.orange) }
      }
      if let needs = entry.needs { Text("Needs: \(needs)") }
      if let docs = entry.docs, let url = URL(string: docs) { Link("Documentation", destination: url) }
      if store.canManage { Button("Connect") { adding = true } }
    }.navigationTitle(entry.name)
      .sheet(isPresented: $adding) { ConnectorEditor(entry: entry, presetEnv: presetEnv, onSignInError: { action.error = $0 }) }
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
        ConnectorCatalogDetail(entry: AppConnector(id: "registry:\(entry.id)", name: entry.name, kind: install.kind, description: entry.description, command: install.command, args: install.args, url: install.url, headers: install.headers, fields: install.fields, needs: install.needs, docs: entry.website ?? entry.repository), trust: MarketText.trust(entry), summary: MarketText.summary(entry, install)).id(index)
      } else { ContentUnavailableView("No install options", systemImage: "plug") }
    }
  }
}
