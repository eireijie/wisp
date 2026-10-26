import SwiftUI

/** Setup text for a connection token: pick the client's format, then copy it. Used when inviting an outside agent too. */
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
    VStack(alignment: .leading, spacing: 14) {
      CardCaption("On the agent's computer, install Wisp from its repository and run npm install && npm link to get wisp-mcp. Then add this to its MCP settings and restart the session.")
      Segments(options: ConnectionFormat.allCases.map { ($0, $0.label) }, selection: $format, id: "connect-format")
      CodeCard(text: config, copied: $copied)
      CardCaption("This contains the agent's connection token. Copy it before leaving; you can make a new one under Connect via MCP.")
    }
    .task { if hub.isEmpty { hub = await store.shareAddress() } }
  }
}

/** Code in a card with a Copy button. */
struct CodeCard: View {
  var text: String
  @Binding var copied: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(text).font(.system(size: 13, design: .monospaced)).foregroundStyle(Palette.text).textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
      Button {
        UIPasteboard.general.string = text
        copied = true
        Task { try? await Task.sleep(for: .seconds(2)); copied = false }
      } label: {
        Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc").font(.system(size: 15, weight: .medium)).foregroundStyle(Palette.text)
          .padding(.horizontal, 14).frame(height: 34).background(Capsule().fill(Color(light: 0xE3E3EA, dark: 0x2E2E32)))
      }.buttonStyle(.plain).accessibilityIdentifier("code-copy")
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(16)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
  }
}

/** Connect (agent-Connect.dc.html): connect an existing session to an agent (a token), by address, and see or disconnect the apps signed in as it. */
struct AgentConnect: View {
  @Environment(Store.self) private var store
  var agent: Agent
  @State private var token: String?
  @State private var apps: [ConnectedApp] = []
  @State private var appsError: String?
  @State private var hub = ""
  @State private var revoking: ConnectedApp?
  @State private var copiedAddress = false
  @State private var action = FormAction()

  private var current: Agent { store.agent(agent.id) ?? agent }
  private var device: AgentNode? { store.nodes.first { $0.id == current.nodeId } }
  private var label: String { HarnessChoice.label(current.harness) }

  var body: some View {
    AgentFrame(title: "Connect", subtitle: current.name) {
      CardGroup {
        RowLabel(title: harnessRunsOnDevice(current.harness) ? "Runs on a device" : "Runs where it already is", subtitle: runsText, value: device?.name, chevron: false, leading: { rowIcon("desktopcomputer") })
      }
      CardCaption("Connect an outside session")
      CardCaption("Any MCP-capable session can act as \(current.name). Make a connection token and paste it in.")
      if store.canManage {
        if let token {
          ConnectionInstructions(token: token, harness: current.harness)
        } else {
          PillButton(title: "Make a connection token", busy: action.busy, id: "connect-token") {
            action.run { token = try await store.createAgentToken(current.id) }
          }.disabled(action.busy)
          CardCaption("The token is shown once.")
        }
      }
      CardCaption("Connect by address")
      AgentCard {
        Text(hub + "/mcp").font(.system(size: 14, design: .monospaced)).foregroundStyle(Palette.text).textSelection(.enabled)
        Button {
          UIPasteboard.general.string = hub + "/mcp"
          copiedAddress = true
          Task { try? await Task.sleep(for: .seconds(2)); copiedAddress = false }
        } label: {
          Label(copiedAddress ? "Copied" : "Copy address", systemImage: copiedAddress ? "checkmark" : "doc.on.doc").font(.system(size: 15, weight: .medium)).foregroundStyle(Palette.text)
        }.buttonStyle(.plain)
      }
      CardCaption("Add it as a custom connector in Grok, ChatGPT or Claude, then pick @\(current.handle) when you sign in. It needs an https address that works from anywhere.")

      CardCaption("Connected")
      if apps.isEmpty && appsError == nil {
        AgentCard { Text("No apps are connected as @\(current.handle).").font(.system(size: 15)).foregroundStyle(Palette.muted) }
      } else {
        CardGroup {
          ForEach(apps) { app in
            HStack(spacing: 12) {
              VStack(alignment: .leading, spacing: 2) {
                Text(app.name).font(.system(size: 17)).foregroundStyle(Palette.text)
                Text(detail(app)).font(.system(size: 14)).foregroundStyle(Palette.faint)
              }
              Spacer(minLength: 8)
              if store.canManage {
                Button("Disconnect") { revoking = app }.font(.system(size: 15, weight: .medium)).foregroundStyle(Palette.red).buttonStyle(.plain).disabled(action.busy)
              }
            }
            .padding(.horizontal, 18).padding(.vertical, 8).frame(minHeight: 60)
          }
        }
      }
      AgentError(text: appsError ?? action.error)
    }
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
