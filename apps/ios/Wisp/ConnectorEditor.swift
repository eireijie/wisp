import SwiftUI

struct ConnectorValue: Identifiable {
  var id = UUID()
  var key: String
  var value: String
  var saved: String?
  var field: ConnectorField?
}

/**
 * Add your own app ("Connect any MCP server": a URL, a command or a key), set one up from a catalog,
 * or edit one. Asks for the values it needs and which helpers get it; the caller goes on to the
 * sign-in and connected steps with the saved app.
 */
struct ConnectorEditor: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var existing: AppConnector?
  var entry: AppConnector?
  var presetEnv: [String: String] = [:]
  var summary: ConnectSummary?
  var onSaved: (AppConnector) -> Void = { _ in }
  @State private var kind = "mcp-http"
  @State private var name = ""
  @State private var command = ""
  @State private var args = ""
  @State private var url = ""
  @State private var headers = ""
  @State private var rows: [ConnectorValue] = []
  @State private var agents: Set<String> = []
  @State private var showStart = false
  @State private var action = FormAction()

  private var custom: Bool { existing == nil && entry == nil }
  private var nameTaken: Bool { store.connectors.contains { $0.id != existing?.id && $0.name.lowercased() == name.trimmed.lowercased() } }
  private var missing: Bool { rows.contains { $0.field != nil && $0.field?.optional != true && $0.value.trimmed.isEmpty && $0.saved == nil } }
  private var valid: Bool {
    !name.trimmed.isEmpty && name.count <= 60 && !nameTaken && !missing &&
      (kind != "mcp-stdio" || !command.trimmed.isEmpty) &&
      (kind != "mcp-http" || ["http", "https"].contains(URL(string: url)?.scheme ?? "")) &&
      (kind != "secret" || rows.contains { !$0.key.isEmpty && (!$0.value.isEmpty || $0.saved != nil) })
  }
  private func supported(_ agent: Agent) -> Bool { ConnectorSupport.allows(agent, kind: kind) }
  private var title: String { existing.map { "Edit \($0.name)" } ?? entry.map { "Connect \($0.name)" } ?? "Add your own app" }

  var body: some View {
    MarketSheet(title: title, subtitle: custom ? "Connect any MCP server" : nil, busy: action.busy) {
      if custom {
        SegPicker(options: [("mcp-http", "URL"), ("mcp-stdio", "Command"), ("secret", "Key")], selection: $kind)
      }
      MarketField(label: "Name", placeholder: "Release tracker", text: $name)
      if nameTaken { Text("You already have an app with this name.").font(.system(size: 13)).foregroundStyle(Palette.red).padding(.horizontal, 4) }

      if kind != "secret" {
        if custom || showStart {
          startFields
        } else {
          Button("Show how it starts") { showStart = true }.font(.system(size: 13)).foregroundStyle(Palette.muted).padding(.horizontal, 4)
        }
      }

      if !rows.isEmpty || kind == "secret" || custom {
        MarketLabel(kind == "secret" ? "Values" : (entry?.fields ?? []).isEmpty ? "Variables" : "What it needs")
        ForEach($rows) { $row in valueRow($row) }
        Button { rows.append(ConnectorValue(key: "", value: "")) } label: { Label("Add a value", systemImage: "plus").font(.system(size: 13)).foregroundStyle(Palette.muted) }
          .padding(.horizontal, 4)
        if kind != "secret" { Text("Secrets are masked once saved. Use {{NAME}} in the command, arguments, URL or headers to fill one in.").font(.system(size: 13)).foregroundStyle(Palette.faint).padding(.horizontal, 4) }
      }

      MarketLabel("Which helpers get it")
      CardGroup {
        ForEach(store.agents) { agent in
          MarketToggleRow(title: agent.name, subtitle: supported(agent) ? "@\(agent.handle)" : "@\(agent.handle) · not wired yet for this kind", isOn: Binding(get: { agents.contains(agent.id) }, set: { on in if on { agents.insert(agent.id) } else { agents.remove(agent.id) } }), disabled: !supported(agent) && !agents.contains(agent.id)) {
            AgentAvatar(agent: agent, size: 30, showStatus: false)
          }
        }
        if store.agents.isEmpty { MarketRow(title: "No helpers yet", subtitle: "Add one from the Agents tab first.") }
      }
      Text(kind == "mcp-http" ? "Works with Claude Code and Codex. Not wired yet for ACP agents (Gemini, OpenCode, Hermes…)." : "Runs on the agent's device or inside its VM.").font(.system(size: 13)).foregroundStyle(Palette.faint).padding(.horizontal, 4)

      if let summary {
        MarketLabel("Before you connect")
        CardGroup {
          MarketRow(symbol: "powerplug", title: "What helpers can do", subtitle: summary.can)
          MarketRow(symbol: "checkmark.shield", title: "Who runs it", subtitle: summary.runBy)
          if let caution = summary.caution { MarketRow(symbol: "exclamationmark.triangle", title: "Take care", subtitle: caution) }
        }
      }
      InlineError(error: action.error)
      HStack(spacing: 10) {
        Button { dismiss() } label: { Text("Cancel").frame(maxWidth: .infinity) }.secondaryButton().disabled(action.busy)
        Button { save() } label: { Text(existing != nil ? "Save" : custom ? "Save app" : "Connect").frame(maxWidth: .infinity) }.primaryButton().disabled(!valid || action.busy)
      }
    }
    .onAppear {
      let source = existing ?? entry
      kind = source?.kind ?? "mcp-http"; name = source?.name ?? ""; command = source?.command ?? ""
      args = source?.args?.joined(separator: "\n") ?? ""; url = source?.url ?? ""
      headers = (source?.headers ?? [:]).sorted { $0.key < $1.key }.map { "\($0.key): \($0.value)" }.joined(separator: "\n")
      rows = (entry?.fields ?? []).map { ConnectorValue(key: $0.key, value: "", saved: existing?.env?[$0.key], field: $0) }
      for (key, value) in existing?.env ?? [:] where !rows.contains(where: { $0.key == key }) { rows.append(ConnectorValue(key: key, value: "", saved: value)) }
      for (key, value) in presetEnv where !rows.contains(where: { $0.key == key }) { rows.append(ConnectorValue(key: key, value: value)) }
      if rows.isEmpty && custom { rows = [ConnectorValue(key: "", value: "")] }
      agents = Set(existing?.agentIds ?? [])
      if existing == nil, store.agents.count == 1, let agent = store.agents.first, supported(agent) { agents = [agent.id] }
    }
    .onChange(of: kind) { if existing == nil { agents = Set(store.agents.filter { agents.contains($0.id) && supported($0) }.map(\.id)) } }
  }

  @ViewBuilder private var startFields: some View {
    let locked = !custom && existing == nil
    if kind == "mcp-stdio" {
      MarketField(label: "Command", placeholder: "npx", text: $command, mono: true, plain: true)
      MarketField(label: "Arguments (one per line)", placeholder: "-y\n@scope/mcp-server", text: $args, mono: true, lines: 2...8, plain: true)
    } else {
      MarketField(label: "URL", placeholder: "https://example.com/mcp", text: $url, mono: true, keyboard: .URL, plain: true)
      MarketField(label: "Headers (Name: value, one per line)", placeholder: "Authorization: Bearer {{API_KEY}}", text: $headers, mono: true, lines: 2...8, plain: true)
      Text("If the app asks you to sign in, Wisp takes you to its sign-in page next.").font(.system(size: 13)).foregroundStyle(Palette.faint).padding(.horizontal, 4)
    }
    if locked { EmptyView() }
  }

  @ViewBuilder private func valueRow(_ row: Binding<ConnectorValue>) -> some View {
    if let field = row.wrappedValue.field {
      VStack(alignment: .leading, spacing: 6) {
        MarketField(label: field.label + (field.optional == true ? " (optional)" : ""), placeholder: row.wrappedValue.saved == nil ? (field.placeholder ?? "Value") : "Saved; type to replace", text: row.value, secure: field.secret != false, plain: true)
        if let hint = field.hint { Text(hint).font(.system(size: 13)).foregroundStyle(Palette.faint).padding(.horizontal, 4) }
        if let link = field.link, let url = URL(string: link) { Link("Get one", destination: url).font(.system(size: 13)).padding(.horizontal, 4) }
      }
    } else {
      HStack(alignment: .bottom, spacing: 8) {
        MarketField(label: nil, placeholder: "NAME", text: row.key, mono: true, plain: true).frame(maxWidth: 140)
        MarketField(label: nil, placeholder: row.wrappedValue.saved == nil ? "••••••••" : "Saved; type to replace", text: row.value, secure: true, mono: true, plain: true)
        Button { rows.removeAll { $0.id == row.wrappedValue.id } } label: { Image(systemName: "trash").foregroundStyle(Palette.muted).frame(width: 44, height: 50) }.buttonStyle(.plain).accessibilityLabel("Remove value")
      }
    }
  }

  private func save() {
    action.run {
      var env: [String: String] = [:]
      for row in rows where !row.key.trimmed.isEmpty {
        let value = row.value.isEmpty ? row.saved ?? "" : row.value
        if !value.isEmpty { env[row.key.trimmed] = value }
      }
      var body: Fields = ["name": AnyEncodable(name.trimmed), "env": AnyEncodable(env), "agentIds": AnyEncodable(Array(agents).sorted())]
      if existing == nil { body["kind"] = AnyEncodable(kind); body["catalogId"] = entry.map { AnyEncodable($0.id) } ?? .null }
      if kind == "mcp-stdio" { body["command"] = AnyEncodable(command.trimmed); body["args"] = AnyEncodable(args.split(separator: "\n").map { String($0).trimmed }.filter { !$0.isEmpty }) }
      if kind == "mcp-http" {
        var parsed: [String: String] = [:]
        for line in headers.split(separator: "\n") where !String(line).trimmed.isEmpty {
          let parts = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
          parsed[String(parts[0]).trimmed] = parts.count > 1 ? String(parts[1]).trimmed : ""
        }
        body["url"] = AnyEncodable(url.trimmed); body["headers"] = AnyEncodable(parsed)
      }
      let connector = try await store.saveConnector(existing?.id, body)
      dismiss()
      onSaved(connector)
    }
  }
}
