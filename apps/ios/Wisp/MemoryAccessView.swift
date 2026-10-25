import SwiftUI

struct MemoryAccessView: View {
  @Environment(Store.self) private var store
  var path: String
  @State private var access: MemoryAccess?
  @State private var subject = "members"
  @State private var level = "read"
  @State private var startup = false
  @State private var deleting: MemoryRule?
  @State private var action = FormAction()
  private var agentSubject: Bool { ["agent", "team", "role", "all_agents"].contains(subject.components(separatedBy: ":").first ?? "") }
  private var guestSubject: Bool { subject == "guests" || store.members.contains { subject == "user:\($0.id)" && $0.role == "guest" } }
  private var levels: [String] { guestSubject ? ["none", "read"] : agentSubject ? ["none", "read", "edit"] : ["none", "read", "edit", "manage"] }
  var body: some View {
    Form {
      Text(path.isEmpty ? "Whole vault" : path).textSelection(.enabled)
      if let access { LabeledContent("Your access", value: access.level) }
      ForEach(access?.rules ?? []) { rule in
        HStack {
          VStack(alignment: .leading) { Text(rule.subject.name ?? rule.subject.id ?? rule.subject.kind); Text(rule.level).font(.caption) }
          Spacer()
          if access?.level == "manage" && rule.builtin != true {
            Button("Remove rule", systemImage: "trash", role: .destructive) { deleting = rule }.labelStyle(.iconOnly)
          }
        }
      }
      if access?.level == "manage" {
        Section("Add a memory rule") {
          Picker("Who", selection: $subject) {
            Text("Everyone (members)").tag("members"); Text("Guests").tag("guests"); Text("All agents").tag("all_agents")
            ForEach(store.members) { Text($0.name).tag("user:\($0.id)") }
            ForEach(store.agents) { Text($0.name).tag("agent:\($0.id)") }
            ForEach(store.teams) { Text("Team \($0.name)").tag("team:\($0.name)") }
          }
          Picker("Access", selection: $level) { ForEach(levels, id: \.self) { Text($0.capitalized).tag($0) } }
          if agentSubject { Toggle("Load at startup", isOn: $startup) }
          Button("Save") {
            action.run {
              let parts = subject.components(separatedBy: ":")
              let kind = parts[0], value = parts.dropFirst().joined(separator: ":")
              try await store.setMemoryAccess(path: path, subject: MemorySubject(kind: kind, id: ["user", "agent"].contains(kind) ? value : nil, name: kind == "team" ? value : nil), level: level, startup: agentSubject && startup)
              access = try await store.memoryAccess(path)
            }
          }.disabled(action.busy)
        }
      }
      InlineError(error: action.error)
    }.sectionScreen("Who can see and edit what", id: "memory-access")
      .onChange(of: subject) { if !levels.contains(level) { level = "read" } }
      .task { do { access = try await store.memoryAccess(path) } catch { action.error = error.localizedDescription } }
      .confirmationDialog("Remove this rule? Access will be inherited from its folder.", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
        Button("Remove rule", role: .destructive) { if let rule = deleting { action.run { try await store.connection().delete("/api/access/\(rule.id)"); access = try await store.memoryAccess(path) } } }
      }
  }
}
