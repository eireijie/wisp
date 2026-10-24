import SwiftUI

struct ConnectorValue: Identifiable {
  var id = UUID()
  var key: String
  var value: String
  var saved: String?
  var field: ConnectorField?
}

struct ConnectorEditor: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  var existing: AppConnector?
  var entry: AppConnector?
  var onSignInError: (String) -> Void = { _ in }
  @State private var kind = "mcp-stdio"
  @State private var name = ""
  @State private var command = ""
  @State private var args = ""
  @State private var url = ""
  @State private var headers = ""
  @State private var rows: [ConnectorValue] = []
  @State private var agents: Set<String> = []
  @State private var action = FormAction()
  private var nameTaken: Bool { store.connectors.contains { $0.id != existing?.id && $0.name.lowercased() == name.trimmed.lowercased() } }
  private var missing: Bool { rows.contains { $0.field != nil && $0.field?.optional != true && $0.value.trimmed.isEmpty && $0.saved == nil } }
  private var valid: Bool {
    !name.trimmed.isEmpty && name.count <= 60 && !nameTaken && !missing &&
      (kind != "mcp-stdio" || !command.trimmed.isEmpty) &&
      (kind != "mcp-http" || ["http", "https"].contains(URL(string: url)?.scheme ?? "")) &&
      (kind != "secret" || rows.contains { !$0.key.isEmpty && (!$0.value.isEmpty || $0.saved != nil) })
  }
  private func supported(_ agent: Agent) -> Bool {
    let proto = HarnessChoice.all.first { $0.id == agent.harness }?.protocolName ?? (agent.harness.hasPrefix("acp:") ? "acp" : "mcp")
    return proto == "native" || proto == "acp" && kind != "mcp-http"
  }
  var body: some View {
    EditorSheet(title: existing.map { "Edit \($0.name)" } ?? entry.map { "Add \($0.name)" } ?? "Add your own connector", action: action, valid: valid, save: save) {
      if existing == nil && entry == nil {
        Picker("Kind", selection: $kind) { Text("Local MCP server").tag("mcp-stdio"); Text("Remote MCP server").tag("mcp-http"); Text("API key or secret").tag("secret") }
      }
      TextField("Name", text: $name)
      if nameTaken { Text("You already have a connector with this name.").foregroundStyle(.red) }
      if let entry { Text(entry.description ?? "").font(.footnote) }
      Section(kind == "secret" ? "Values" : "What it needs") {
        ForEach($rows) { $row in
          VStack(alignment: .leading) {
            if let field = row.field {
              Text(field.label + (field.optional == true ? " (optional)" : ""))
              if let hint = field.hint { Text(hint).font(.caption).foregroundStyle(.secondary) }
              if let link = field.link, let url = URL(string: link) { Link("Get one", destination: url) }
            } else { TextField("Variable name", text: $row.key).textInputAutocapitalization(.never).autocorrectionDisabled() }
            SecureField(row.saved == nil ? "Value" : "Saved; type to replace", text: $row.value)
            if row.field == nil { Button("Remove value", role: .destructive) { rows.removeAll { $0.id == row.id } } }
          }
        }
        Button("Add a value") { rows.append(ConnectorValue(key: "", value: "")) }
        Text("Secrets are masked once saved. Use {{NAME}} in the command, arguments, URL or headers to fill one in.").font(.caption).foregroundStyle(.secondary)
      }
      if kind != "secret" {
        TechnicalDetails(title: "Show how it starts") {
          if kind == "mcp-stdio" {
            TextField("Command", text: $command).textInputAutocapitalization(.never).autocorrectionDisabled()
            TextField("Arguments (one per line)", text: $args, axis: .vertical).lineLimit(3...8).textInputAutocapitalization(.never).autocorrectionDisabled()
          } else {
            TextField("URL", text: $url).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
            TextField("Headers (Name: value, one per line)", text: $headers, axis: .vertical).lineLimit(3...8).textInputAutocapitalization(.never).autocorrectionDisabled()
          }
        }
      }
      AgentSelection(selected: $agents, allowed: supported)
      Text(kind == "mcp-http" ? "Works with Claude Code and Codex. Not wired yet for ACP agents (Gemini, OpenCode, Hermes…)." : "Runs on the agent's device or inside its VM.").font(.footnote).foregroundStyle(.secondary)
    }
    .onAppear {
      let source = existing ?? entry
      kind = source?.kind ?? "mcp-stdio"; name = source?.name ?? ""; command = source?.command ?? ""
      args = source?.args?.joined(separator: "\n") ?? ""; url = source?.url ?? ""
      headers = (source?.headers ?? [:]).sorted { $0.key < $1.key }.map { "\($0.key): \($0.value)" }.joined(separator: "\n")
      rows = (entry?.fields ?? []).map { ConnectorValue(key: $0.key, value: "", saved: existing?.env?[$0.key], field: $0) }
      for (key, value) in existing?.env ?? [:] where !rows.contains(where: { $0.key == key }) { rows.append(ConnectorValue(key: key, value: "", saved: value)) }
      agents = Set(existing?.agentIds ?? [])
      if existing == nil, store.agents.count == 1, let agent = store.agents.first, supported(agent) { agents = [agent.id] }
    }
    .onChange(of: kind) { if existing == nil { agents = Set(store.agents.filter { agents.contains($0.id) && supported($0) }.map(\.id)) } }
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
      if connector.needsSignIn {
        do { if let authURL = try await store.connectorSignIn(connector.id) { openURL(authURL) } }
        catch { onSignInError("\(connector.name) was saved, but sign-in failed: \(error.localizedDescription)") }
      }
    }
  }
}
