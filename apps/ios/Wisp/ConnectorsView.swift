import SwiftUI

/** The connected apps list now lives in the Marketplace; this opens it on the Apps tab. */
struct ConnectorsView: View {
  var body: some View { MarketplaceView(start: .apps) }
}

/** Which app the editor is for: your own, one from a catalog, or one already set up. */
struct ConnectorEditorTarget: Identifiable {
  var id = UUID()
  var existing: AppConnector?
  var entry: AppConnector?
  var presetEnv: [String: String] = [:]
  var summary: ConnectSummary?
}

/**
 * Connecting an app is three steps: the editor (which helpers get it, the keys it needs), then, if
 * the app asks for a sign-in, a page that opens it in the browser, then the connected state.
 */
private struct ConnectFlow: ViewModifier {
  @Binding var editor: ConnectorEditorTarget?
  @Binding var chat: ChatTarget?
  @State private var pending: AppConnector?
  @State private var result: AppConnector?

  func body(content: Content) -> some View {
    content
      .sheet(item: $editor, onDismiss: { if let pending { result = pending; self.pending = nil } }) { target in
        ConnectorEditor(existing: target.existing, entry: target.entry, presetEnv: target.presetEnv, summary: target.summary, onSaved: { connector in
          // an edit of an app that was already connected just saves; a new one goes on to sign-in or the connected state
          if target.existing == nil { pending = connector }
        })
      }
      .sheet(item: $result) { connector in ConnectResultSheet(connectorId: connector.id, onOpenChat: { chat = $0 }) }
  }
}

extension View {
  /** The editor sheet for `editor`, then the sign-in and connected steps. */
  func connectFlow(_ editor: Binding<ConnectorEditorTarget?>, chat: Binding<ChatTarget?>) -> some View {
    modifier(ConnectFlow(editor: editor, chat: chat))
  }
}

/** After saving an app: its sign-in (the page opens in the browser), then who can use it now. */
struct ConnectResultSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  @Environment(\.scenePhase) private var scenePhase
  var connectorId: String
  var onOpenChat: (ChatTarget) -> Void
  @State private var action = FormAction()
  private var connector: AppConnector? { store.connectors.first { $0.id == connectorId } }
  private var helpers: [Agent] { store.agents.filter { connector?.agentIds?.contains($0.id) == true } }

  var body: some View {
    if let connector {
      if connector.needsSignIn { signIn(connector) } else { connected(connector) }
    } else {
      MarketSheet(title: "Connected") { MarketPrimaryButton(title: "Done") { dismiss() } }
    }
  }

  private func signIn(_ c: AppConnector) -> some View {
    MarketSheet(title: "Connect \(c.name)", busy: action.busy) {
      CardGroup {
        MarketRow(symbol: "powerplug", tile: 50, title: "Sign in to \(c.name)", subtitle: "A page opens in your browser. Choose the account and allow Wisp to use \(c.name) for your helpers.")
      }
      Text("Wisp never sees or keeps your password.").font(.system(size: 14)).foregroundStyle(Palette.faint).padding(.horizontal, 4)
      InlineError(error: action.error)
      HStack(spacing: 10) {
        Button { dismiss() } label: { Text("Not now").frame(maxWidth: .infinity) }.secondaryButton()
        Button {
          action.run { if let url = try await store.connectorSignIn(c.id) { openURL(url) } }
        } label: { Text("Open sign-in").frame(maxWidth: .infinity) }.primaryButton().disabled(action.busy)
      }
    }
    // back from the browser: the sign-in is done on the hub's side by now
    .onChange(of: scenePhase) { _, phase in if phase == .active { Task { try? await store.refreshConnectors() } } }
  }

  private func connected(_ c: AppConnector) -> some View {
    MarketSheet(title: "\(c.name) is connected", subtitle: helpers.isEmpty ? "No helper can use it yet." : "\(ShelfLogic.sentence(helpers.map(\.name))) can use it now.") {
      MarketLabel("Pick who can use it")
      CardGroup {
        ForEach(store.agents) { agent in
          MarketToggleRow(title: agent.name, subtitle: "@\(agent.handle)", isOn: Binding(get: { c.agentIds?.contains(agent.id) == true }, set: { on in
            action.run { try await store.attachConnector(c, agentIds: [agent.id], on: on) }
          }), disabled: action.busy || !ConnectorSupport.allows(agent, kind: c.kind)) { AgentAvatar(agent: agent, size: 30, showStatus: false) }
        }
      }
      if let first = helpers.first {
        CardGroup {
          Button {
            action.run {
              let channel = try await store.dm(with: first)
              dismiss(); onOpenChat(ChatTarget(channel: channel, draft: "Use \(c.name) to help me. What can you do with it?"))
            }
          } label: { MarketRow(symbol: "bubble.left", title: "Try it in a chat", subtitle: "Ask \(first.name) to use \(c.name)") }.buttonStyle(.plain)
        }
      }
      InlineError(error: action.error)
      MarketPrimaryButton(title: "Done") { dismiss() }
    }
  }
}

/** Manage a connected app: its status, which helpers use it, and its account. */
struct ConnectorDetail: View {
  @Environment(Store.self) private var store
  @Environment(\.openURL) private var openURL
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  var connector: AppConnector
  @State private var editor: ConnectorEditorTarget?
  @State private var chat: ChatTarget?
  @State private var removing = false
  @State private var action = FormAction()
  private var current: AppConnector { store.connectors.first { $0.id == connector.id } ?? connector }
  private var where_: String { current.url ?? current.command.map { ([$0] + (current.args ?? [])).joined(separator: " ") } ?? "" }

  var body: some View {
    MarketScreen(title: current.name, screenId: "connector") {
      CardGroup {
        MarketRow(symbol: "powerplug", tile: 50, title: current.enabled == false ? "Off" : current.needsSignIn ? "Needs sign-in" : "Connected", subtitle: where_.isEmpty ? nil : where_) {
          MarketPill(text: current.enabled == false ? "Off" : current.needsSignIn ? "Sign in" : "On", tone: current.enabled == false ? .grey : current.needsSignIn ? .warn : .green)
        }
      }
      InlineError(error: current.auth?.error)
      ForEach(current.warnings ?? [], id: \.self) { Text($0).font(.footnote).foregroundStyle(MarketColor.warn) }
      MarketLabel("Helpers who can use it")
      CardGroup {
        ForEach(store.agents) { agent in
          MarketToggleRow(title: agent.name, subtitle: "@\(agent.handle)", isOn: Binding(get: { current.agentIds?.contains(agent.id) == true }, set: { on in
            action.run { try await store.attachConnector(current, agentIds: [agent.id], on: on) }
          }), disabled: action.busy || !store.canManage || !ConnectorSupport.allows(agent, kind: current.kind)) { AgentAvatar(agent: agent, size: 30, showStatus: false) }
        }
        if store.agents.isEmpty { MarketRow(title: "No helpers yet", subtitle: "Add one from the Agents tab.") }
      }
      if store.canManage {
        MarketLabel("Account")
        CardGroup {
          Button { action.run { try await store.refreshConnectors() } } label: { MarketRow(symbol: "arrow.clockwise", title: "Refresh", subtitle: "Check the connection") }.buttonStyle(.plain)
          if current.kind == "mcp-http" {
            Button { action.run { if let url = try await store.connectorSignIn(current.id) { openURL(url) } } } label: {
              MarketRow(symbol: "arrow.right.to.line", title: current.auth?.signedIn == true ? "Sign in again" : "Sign in", subtitle: "Opens the app's sign-in page")
            }.buttonStyle(.plain)
          }
          if current.auth?.signedIn == true {
            Button { action.run { try await store.connectorSignOut(current.id) } } label: { MarketRow(symbol: "rectangle.portrait.and.arrow.right", title: "Sign out", subtitle: "Helpers stop using your account") }.buttonStyle(.plain)
          }
          Button { editor = ConnectorEditorTarget(existing: current, entry: nil) } label: { MarketRow(symbol: "pencil", title: "Edit settings", subtitle: "Name, values and how it starts") }.buttonStyle(.plain)
          Button { action.run { try await store.saveConnector(current.id, ["enabled": AnyEncodable(current.enabled == false)]) } } label: {
            MarketRow(symbol: "power", title: current.enabled == false ? "Turn on" : "Turn off", subtitle: current.enabled == false ? "On for the helpers above" : "Off for every helper")
          }.buttonStyle(.plain)
          Button { removing = true } label: { MarketRow(symbol: "trash", title: "Remove", subtitle: "Helpers will lose access to it.", danger: true) }.buttonStyle(.plain)
        }
      }
      InlineError(error: action.error)
    }
    .connectFlow($editor, chat: $chat)
    .navigationDestination(item: $chat) { ChannelView(channel: $0.channel, draft: $0.draft) }
    .onChange(of: scenePhase) { _, phase in if phase == .active { action.run { try await store.refreshConnectors() } } }
    .confirmationDialog("Remove \(current.name)? Helpers will lose access to it.", isPresented: $removing, titleVisibility: .visible) {
      Button("Remove", role: .destructive) { action.run { try await store.deleteConnector(current.id); dismiss() } }
    }
  }
}

/** An app's page: who stands behind it, what you're agreeing to, and how connecting works. */
struct ConnectorCatalogDetail: View {
  @Environment(Store.self) private var store
  var entry: AppConnector
  var trust: TrustLabel?
  var summary: ConnectSummary?
  /** values already known (an app found on a device keeps its non-secret settings) */
  var presetEnv: [String: String] = [:]
  @State private var editor: ConnectorEditorTarget?
  @State private var chat: ChatTarget?
  private var have: AppConnector? {
    store.connectors.first { $0.catalogId == entry.id || $0.name.lowercased() == entry.name.lowercased() }
  }

  private var howTo: String {
    let labels = (entry.fields ?? []).map(\.label)
    if entry.kind == "secret" || !labels.isEmpty {
      let them = labels.count > 1 ? "them" : "it"
      return "You enter \(labels.isEmpty ? "the key" : labels.joined(separator: ", ")) once. Wisp keeps \(them) and gives \(them) only to the helpers you pick."
    }
    if entry.kind == "mcp-stdio" { return "\(entry.name) runs as a program on each helper's own computer.\(entry.needs.map { " It needs \($0)." } ?? "") After that you choose which helpers can use it." }
    return "If \(entry.name) asks you to sign in, a page opens in your browser. Wisp never sees your password. After that you choose which helpers can use \(entry.name)."
  }

  var body: some View {
    let s = summary ?? MarketText.summary(builtIn: entry)
    MarketScreen(title: entry.name, screenId: "app-detail") {
      HStack(alignment: .center, spacing: 14) {
        MarketTile(symbol: "powerplug", size: 56)
        VStack(alignment: .leading, spacing: 6) {
          Text(entry.name).font(.system(size: 24, weight: .bold)).lineLimit(2)
          if let trust { TrustBadge(trust: trust) } else { MarketPill(text: "On Wisp's list", tone: .blue) }
        }
        Spacer(minLength: 0)
      }
      Text((entry.description ?? "").isEmpty ? "Lets your helpers use \(entry.name)." : entry.description!).font(.system(size: 15)).foregroundStyle(Palette.text.opacity(0.9)).padding(.horizontal, 4)
      if let trust { Text(trust.explanation).font(.system(size: 13)).foregroundStyle(Palette.faint).padding(.horizontal, 4) }
      MarketLabel("Before you connect")
      CardGroup {
        MarketRow(symbol: "powerplug", title: "What helpers can do", subtitle: s.can)
        MarketRow(symbol: "checkmark.shield", title: "Who runs it", subtitle: s.runBy)
        if let caution = s.caution { MarketRow(symbol: "exclamationmark.triangle", title: "Take care", subtitle: caution) }
      }
      MarketLabel("How to connect")
      MarketNote(text: howTo)
      if let docs = entry.docs, let url = URL(string: docs) { Link("Documentation", destination: url).font(.system(size: 15)).padding(.horizontal, 4) }
    }
    .bottomAction {
      if let have { NavigationLink { ConnectorDetail(connector: have) } label: { Text("Manage").frame(maxWidth: .infinity, minHeight: 28).font(.system(size: 16, weight: .semibold)) }.primaryButton() }
      else if store.canManage { MarketPrimaryButton(title: "Connect") { editor = ConnectorEditorTarget(entry: entry, presetEnv: presetEnv) } }
    }
    .connectFlow($editor, chat: $chat)
    .navigationDestination(item: $chat) { ChannelView(channel: $0.channel, draft: $0.draft) }
  }
}

struct MarketplaceDetail: View {
  var entry: MarketplaceEntry
  @State private var index = 0
  var body: some View {
    if entry.installs.indices.contains(index) {
      let install = entry.installs[index]
      ConnectorCatalogDetail(entry: AppConnector(id: "registry:\(entry.id)", name: entry.name, kind: install.kind, description: entry.description, command: install.command, args: install.args, url: install.url, headers: install.headers, fields: install.fields, needs: install.needs, docs: entry.website ?? entry.repository), trust: MarketText.trust(entry), summary: MarketText.summary(entry, install))
        .id(index)
        .safeAreaInset(edge: .top, spacing: 0) {
          if entry.installs.count > 1 {
            ChipRow(options: entry.installs.map(\.label), selection: entry.installs[index].label) { label in index = entry.installs.firstIndex { $0.label == label } ?? 0 }
              .padding(.horizontal, 18).padding(.vertical, 8).background(Palette.sheet)
          }
        }
    } else {
      MarketScreen(title: entry.name, screenId: "app-detail") { MarketNote(text: "No install options.") }
    }
  }
}
