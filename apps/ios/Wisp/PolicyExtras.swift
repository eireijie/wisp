import SwiftUI

/** Memory rules (set-MemoryRules.dc.html): who can see and edit which folder or note, with add and remove. */
struct MemoryRulesView: View {
  @Environment(Store.self) private var store
  @State private var rules: [MemoryRule] = []
  @State private var loaded = false
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
    SettingsPage("Memory rules", id: "memory-rules") {
      if rules.isEmpty && loaded {
        CardHint("No rules yet. Agents only see Shared, their own folders and their teams' folders.")
      }
      ForEach(rules) { rule in
        VStack(alignment: .leading, spacing: 8) {
          CardLabel(rule.path.isEmpty ? "The whole vault" : rule.path)
          CardGroup {
            NavigationLink { MemoryAccessView(path: rule.path) } label: {
              RowLabel(title: subject(rule.subject), subtitle: rule.startup == true ? "Loads at startup" : nil, value: Self.level(rule.level))
            }
            if store.isOwner && rule.builtin != true {
              Button { removing = rule } label: { RowLabel(title: "Remove rule", chevron: false, tint: Palette.red) }.buttonStyle(.plain)
            }
          }
        }
      }
      StatusLine(error: action.error)
      if store.isOwner {
        NavigationLink { AddMemoryRuleView(onAdded: { Task { await load() } }) } label: { Text("Add a memory rule").frame(maxWidth: .infinity) }
          .buttonStyle(.pill(.primary)).accessibilityIdentifier("memory-rule-add")
      }
    }
    .task { await load() }
    .confirmCard(Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), title: "Remove this rule?", message: "Access will be inherited from its folder.", confirm: "Remove rule") {
      if let rule = removing { action.run { try await store.connection().delete("/api/access/\(rule.id)"); await load() } }
    }
  }

  private func load() async {
    do { rules = try await store.connection().get("/api/access/rules") } catch { action.error = error.localizedDescription }
    loaded = true
  }
}

struct AddMemoryRuleView: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var onAdded: () -> Void = {}
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
    SettingsPage("Add a memory rule", id: "add-memory-rule") {
      CardGroup { FieldRow(title: "Folder or note", text: $path, prompt: "The whole vault", id: "rule-path") }
      CardHint("A folder covers everything inside it. Leave empty for the whole vault.")
      CardGroup {
        HStack {
          Text("Who").font(.system(size: 15)).foregroundStyle(Palette.text)
          Spacer(minLength: 8)
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
          }.pickerStyle(.menu).tint(Palette.faint).labelsHidden().accessibilityLabel("Who")
        }.padding(.horizontal, 18).frame(minHeight: 54)
        PickerRow(title: "Access", options: levels.map { ($0, MemoryRulesView.level($0)) }, selection: $level, id: "rule-level")
        if forAgents { ToggleRow(title: "Load at startup", isOn: $startup) }
      }
      StatusLine(error: action.error)
      Button("Add rule") { save() }.buttonStyle(.pill(.primary)).disabled(action.busy).accessibilityIdentifier("rule-save")
    }
    .onChange(of: who) { if !levels.contains(level) { level = "read" } }
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
      onAdded()
      dismiss()
    }
  }
}
