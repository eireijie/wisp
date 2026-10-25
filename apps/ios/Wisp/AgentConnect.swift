import SwiftUI

/** Setup text for a connection token: pick the client's format, then copy it. Used when adding an outside agent too. */
struct ConnectionInstructions: View {
  @Environment(Store.self) private var store
  var token: String
  var harness: String
  @State private var format: ConnectionFormat
  @State private var hub = ""
  @State private var copied = false

  init(token: String, harness: String) {
    self.token = token
    self.harness = harness
    _format = State(initialValue: ConnectionFormat.initial(for: harness))
  }

  private var config: String { format.config(hub: hub, token: token) }

  var body: some View {
    Group {
      Section {
        Text("On the agent's computer, install Wisp from its repository and run npm install && npm link to get wisp-mcp. Then add this to its MCP settings and restart the session.")
          .font(.subheadline)
        Picker("Format", selection: $format) {
          ForEach(ConnectionFormat.allCases) { Text($0.label).tag($0) }
        }.pickerStyle(.segmented)
        Text(config)
          .font(.system(.footnote, design: .monospaced))
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
        Button(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc") {
          UIPasteboard.general.string = config
          copied = true
          Task { try? await Task.sleep(for: .seconds(2)); copied = false }
        }
      } footer: {
        Text("This contains the agent's connection token. Copy it before leaving; you can make a new one under Connect.")
      }
    }
    .task { if hub.isEmpty { hub = await store.shareAddress() } }
  }
}

/** Connect an existing session to an agent (a token), and see or disconnect the apps signed in as it. */
struct AgentConnect: View {
  @Environment(Store.self) private var store
  var agent: Agent
  @State private var token: String?
  @State private var apps: [ConnectedApp] = []
  @State private var appsError: String?
  @State private var hub = ""
  @State private var revoking: ConnectedApp?
  @State private var action = FormAction()

  private var current: Agent { store.agent(agent.id) ?? agent }
  private var device: AgentNode? { store.nodes.first { $0.id == current.nodeId } }
  private var label: String { HarnessChoice.label(current.harness) }

  var body: some View {
    Form {
      Section {
        Text(runsText).font(.subheadline)
      } header: { Text("Runs on a device") }

      if store.canManage {
        if let token {
          ConnectionInstructions(token: token, harness: current.harness)
        } else {
          Section {
            Button(action.busy ? "Creating…" : "Create connection token", systemImage: "key") {
              action.run { token = try await store.createAgentToken(current.id) }
            }.disabled(action.busy)
            InlineError(error: action.error)
          } header: { Text("Connect an existing session (MCP)") } footer: {
            Text("Give any MCP-capable session this agent's identity, memory, chat and task tools. The token is shown once.")
          }
        }
      }

      Section {
        Text(hub + "/mcp").font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
        Button("Copy address", systemImage: "doc.on.doc") { UIPasteboard.general.string = hub + "/mcp" }
      } header: { Text("Connect by address") } footer: {
        Text("Add it as a custom connector in Grok, ChatGPT or Claude, then pick @\(current.handle) when you sign in. It needs an https address that works from anywhere.")
      }

      Section {
        if apps.isEmpty && appsError == nil { Text("No apps are connected as @\(current.handle).").foregroundStyle(.secondary) }
        ForEach(apps) { app in
          HStack {
            VStack(alignment: .leading, spacing: 2) {
              Text(app.name)
              Text(detail(app)).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if store.canManage { Button("Disconnect", role: .destructive) { revoking = app }.buttonStyle(.borderless).disabled(action.busy) }
          }
        }
        InlineError(error: appsError)
      } header: { Text("Apps signed in as @\(current.handle)") }
    }
    .navigationTitle("Connect")
    .navigationBarTitleDisplayMode(.inline)
    .task { hub = await store.shareAddress(); await loadApps() }
    .refreshable { await loadApps() }
    .confirmationDialog("Disconnect \(revoking?.name ?? "this app")?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible) {
      Button("Disconnect", role: .destructive) {
        guard let app = revoking else { return }
        action.run {
          try await store.revokeConnectedApp(agent: current.id, app: app.id)
          await loadApps()
        }
      }
    } message: { Text("It stops acting as @\(current.handle) until someone signs it in again.") }
    .managementAlert(action)
  }

  private var runsText: String {
    if harnessRunsOnDevice(current.harness) {
      if let device { return "When someone @mentions @\(current.handle), \(device.name) starts \(label), gives it the Wisp tools, and posts the reply." }
      return "Pick a device for it first so it can answer when it's mentioned."
    }
    return "\(label) doesn't have a headless adapter yet. Connect a running session below."
  }

  private func detail(_ app: ConnectedApp) -> String {
    var parts: [String] = []
    if let used = app.lastUsed.flatMap(Wire.date) { parts.append("Used " + used.formatted(.relative(presentation: .named))) }
    else if let added = app.createdAt.flatMap(Wire.date) { parts.append("Added " + added.formatted(.relative(presentation: .named))) }
    if let by = app.approvedBy { parts.append(by) }
    return parts.joined(separator: " · ")
  }

  private func loadApps() async {
    do { apps = try await store.connectedApps(agent.id); appsError = nil }
    catch { appsError = error.localizedDescription }
  }
}
