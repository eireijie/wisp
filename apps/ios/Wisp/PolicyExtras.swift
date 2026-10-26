import SwiftUI

/** Who takes tasks nobody assigned: pick an agent, or leave it to Wisp (a channel team's lead, else the first agent). */
struct LeadSection: View {
  @Environment(Store.self) private var store
  @State private var action = FormAction()
  private var automatic: Agent? { store.agent(store.taskLead ?? "") }

  var body: some View {
    if !store.agents.isEmpty {
      Section {
        Picker("Lead agent", selection: Binding(get: { store.taskLeadOverride ?? "" }, set: { new in action.run { try await store.saveLead(new.isEmpty ? nil : new) } })) {
          Text(automatic.map { "Automatic (\($0.name))" } ?? "Automatic").tag("")
          ForEach(store.agents) { Text("@\($0.handle) (\($0.name))").tag($0.id) }
        }.disabled(!store.isOwner || action.busy)
        InlineError(error: action.error)
      } header: { Text("Lead") } footer: { Text("Takes every task nobody assigned, splits it up and hands the pieces to agents by role.") }
        .task { try? await store.refreshTaskLead() }
    }
  }
}

/** Settings → Memory's rules half: who can see and edit which folder or note, with add and remove. */
struct MemoryRulesView: View {
  @Environment(Store.self) private var store
  @State private var rules: [MemoryRule] = []
  @State private var adding = false
  @State private var removing: MemoryRule?
  @State private var action = FormAction()

  private func subject(_ s: MemorySubject) -> String {
    switch s.kind {
    case "members": return "Everyone (members)"
    case "guests": return "Guests"
    case "all_agents": return "All agents"
    case "user": return store.members.first { $0.id == s.id }?.name ?? "Someone"
    case "agent": return store.agent(s.id ?? "")?.name ?? "An agent"
    case "team": return "Team “\(s.name ?? "")”"
    case "role": return "\(s.role ?? "") on “\(s.team ?? "")”"
    default: return s.name ?? s.kind
    }
  }
  static func level(_ value: String) -> String { ["none": "No access", "read": "Can read", "edit": "Can edit", "manage": "Can manage"][value] ?? value }

  var body: some View {
    List {
      Section {
        Text("By default every agent reads and writes Shared, its own folder, its teams' folders and what it learns about people. Rules here change that for a folder or note and everything inside it.").font(.footnote)
      }
      Section("Rules") {
        if rules.isEmpty { Text("No rules yet. Agents only see Shared, their own folders and their teams' folders.").foregroundStyle(.secondary) }
        ForEach(rules) { rule in
          NavigationLink { MemoryAccessView(path: rule.path) } label: {
            VStack(alignment: .leading, spacing: 3) {
              Text("\(subject(rule.subject)): \(Self.level(rule.level).lowercased())")
              Text(rule.path.isEmpty ? "the whole vault" : rule.path).font(.caption).foregroundStyle(.secondary)
              if rule.startup == true { Label("Loads at startup", systemImage: "pin").font(.caption).foregroundStyle(.secondary) }
            }
          }.swipeActions { if store.isOwner && rule.builtin != true { Button("Remove", role: .destructive) { removing = rule } } }
        }
      }
      InlineError(error: action.error)
    }.navigationTitle("Who can see and edit what")
      .toolbar { if store.isOwner { Button("Add rule", systemImage: "plus") { adding = true } } }
      .sheet(isPresented: $adding, onDismiss: { Task { await load() } }) { AddMemoryRuleView() }
      .task { await load() }
      .confirmationDialog("Remove this rule? Access will be inherited from its folder.", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
        Button("Remove rule", role: .destructive) { if let rule = removing { action.run { try await store.connection().delete("/api/access/\(rule.id)"); await load() } } }
      }
  }

  private func load() async {
    do { rules = try await store.connection().get("/api/access/rules") } catch { action.error = error.localizedDescription }
  }
}

struct AddMemoryRuleView: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var path = ""
  @State private var who = "all_agents"
  @State private var level = "read"
  @State private var startup = false
  @State private var action = FormAction()

  private var kind: String { who.components(separatedBy: ":").first ?? who }
  private var forAgents: Bool { ["agent", "team", "role", "all_agents"].contains(kind) }
  private var guest: Bool { who == "guests" || store.members.contains { who == "user:\($0.id)" && $0.role == "guest" } }
  private var levels: [String] { forAgents ? ["none", "read", "edit"] : guest ? ["none", "read"] : ["none", "read", "edit", "manage"] }
  private var roles: [(team: String, role: String)] {
    store.teams.flatMap { team in Set((team.members ?? []).compactMap(\.role).filter { !$0.isEmpty }).sorted().map { (team.name, $0) } }
  }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("Folder or note", text: $path).textInputAutocapitalization(.never).autocorrectionDisabled()
        } footer: { Text("A folder covers everything inside it. Leave empty for the whole vault.") }
        Picker("Who", selection: $who) {
          Section("Agents") {
            Text("All agents").tag("all_agents")
            ForEach(store.teams) { Text("Team “\($0.name)”").tag("team:\($0.name)") }
            ForEach(roles, id: \.role) { Text("\($0.role) on “\($0.team)”").tag("role:\($0.team)/\($0.role)") }
            ForEach(store.agents) { Text("@\($0.handle)").tag("agent:\($0.id)") }
          }
          Section("People") {
            Text("Everyone (members)").tag("members")
            Text("Guests").tag("guests")
            ForEach(store.members) { Text($0.name).tag("user:\($0.id)") }
          }
        }
        Picker("Access", selection: $level) { ForEach(levels, id: \.self) { Text(MemoryRulesView.level($0)).tag($0) } }
        if forAgents { Toggle("Load at startup", isOn: $startup) }
        InlineError(error: action.error)
      }.navigationTitle("Add a memory rule").navigationBarTitleDisplayMode(.inline)
        .onChange(of: who) { if !levels.contains(level) { level = "read" } }
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
          ToolbarItem(placement: .confirmationAction) { Button("Add rule") { save() }.disabled(action.busy) }
        }
    }
  }

  private func save() {
    action.run {
      let parts = who.components(separatedBy: ":")
      let value = parts.dropFirst().joined(separator: ":")
      var subject = MemorySubject(kind: parts[0])
      switch parts[0] {
      case "user", "agent": subject.id = value
      case "team": subject.name = value
      case "role": subject.team = value.components(separatedBy: "/").first; subject.role = value.components(separatedBy: "/").dropFirst().joined(separator: "/")
      default: break
      }
      try await store.setMemoryAccess(path: path.trimmed, subject: subject, level: levels.contains(level) ? level : "read", startup: forAgents && startup)
      dismiss()
    }
  }
}
