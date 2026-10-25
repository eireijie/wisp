import SwiftUI

/**
 * What an agent may do: files and commands on its device (read only, edit files, full access),
 * and, read-only, which memory folders it can use, who its own folder is shared with, and
 * whether it may refine its own personality.
 */
struct AgentPermissions: View {
  @Environment(Store.self) private var store
  var agent: Agent
  @State private var access = AgentAccess.edit
  @State private var loaded = false
  @State private var memory: AgentMemoryAccess?
  @State private var memoryError: String?
  @State private var action = FormAction()

  private var current: Agent { store.agent(agent.id) ?? agent }
  private var saved: AgentAccess { AgentAccess.from(current.settings?.access) }
  private var device: AgentNode? { store.nodes.first { $0.id == current.nodeId } }

  var body: some View {
    Form {
      Section {
        ForEach(AgentAccess.allCases) { level in
          Button { access = level } label: {
            HStack(alignment: .top, spacing: 12) {
              Image(systemName: access == level ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(access == level ? Color.accentColor : .secondary)
              VStack(alignment: .leading, spacing: 3) {
                Text(level.label).foregroundStyle(level == .full ? Color.red : Color.primary)
                Text(level.body).font(.caption).foregroundStyle(.secondary)
              }
              Spacer(minLength: 0)
            }.contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityAddTraits(access == level ? .isSelected : [])
        }
      } header: { Text("On its device") } footer: {
        Text(access.scope(name: current.name, handle: current.handle, device: device?.name))
      }
      .disabled(!store.canManage || action.busy)

      if access == .full {
        Section {
          Label("The agent can run any command as the device's user. The device must opt in with wisp node start --allow-full-access; otherwise it runs with edit access.", systemImage: "exclamationmark.shield")
            .font(.footnote).foregroundStyle(.red)
        }
      }

      if store.canManage {
        Section {
          InlineError(error: action.error)
          Button(action.busy ? "Saving…" : "Save") { save() }
            .disabled(access == saved || action.busy)
        } footer: { Text("Applies from the next message.") }
      }

      Section {
        if let memory {
          let rules = memory.rules.sorted { $0.path.lowercased() < $1.path.lowercased() }
          ForEach(rules, id: \.rowId) { rule in ruleRow(rule) }
          LabeledContent("Its folder is shared with", value: sharedWith(memory))
        } else if let memoryError {
          Text(memoryError).font(.footnote).foregroundStyle(.red)
          Button("Try again") { Task { await loadMemory() } }
        } else {
          ProgressView()
        }
        LabeledContent("Personality", value: current.settings?.soulLocked == true ? "Locked: only people can edit it" : "It can refine its own personality")
        LabeledContent("Instructions", value: "Only people can edit them")
      } header: { Text("In memory") } footer: {
        Text("Which folders and notes @\(current.handle) can use, and why. Change them with the share button on a folder or note in Memory.")
      }
    }
    .navigationTitle("Permissions")
    .navigationBarTitleDisplayMode(.inline)
    .task { if !loaded { access = saved; loaded = true }; await loadMemory() }
    .onChange(of: current.settings?.access) { old, new in
      // follow a change made elsewhere, unless this screen has its own edit pending
      if access == AgentAccess.from(old) { access = AgentAccess.from(new) }
    }
  }

  private func ruleRow(_ rule: AgentMemoryRule) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(AccessText.path(rule.path, agents: store.agents, members: store.members))
      HStack(spacing: 6) {
        Text(AccessText.level(rule.level)).foregroundStyle(rule.level == "none" ? .secondary : .primary)
        if let via = via(rule) { Text(via).foregroundStyle(.secondary) }
        if rule.startup == true { Label("loads at startup", systemImage: "pin").labelStyle(.titleAndIcon).foregroundStyle(.secondary) }
      }.font(.caption)
    }
  }

  private func via(_ rule: AgentMemoryRule) -> String? {
    var text = rule.subject.kind == "agent" ? "" : "via " + AccessText.subject(rule.subject, agents: store.agents, members: store.members)
    if rule.builtin == true { text += (text.isEmpty ? "" : " · ") + "default" }
    else if rule.createdBy?.kind == "agent", let id = rule.createdBy?.id {
      text += (text.isEmpty ? "" : " · ") + "shared by " + AccessText.subject(MemorySubject(kind: "agent", id: id), agents: store.agents, members: store.members)
    }
    return text.isEmpty ? nil : text
  }

  private func sharedWith(_ memory: AgentMemoryAccess) -> String {
    if memory.sharedOut.isEmpty { return "No one else" }
    return memory.sharedOut.map { rule in
      let who = AccessText.subject(rule.subject, agents: store.agents, members: store.members)
      let extra = rule.path == "agents/\(current.id)" ? "" : " " + AccessText.path(rule.path, agents: store.agents, members: store.members)
      return "\(who) (\(AccessText.level(rule.level).lowercased())\(extra))"
    }.joined(separator: ", ")
  }

  private func loadMemory() async {
    do { memory = try await store.agentMemoryAccess(agent.id); memoryError = nil }
    catch { memoryError = error.localizedDescription }
  }

  private func save() {
    action.run {
      try await store.updateAgent(current.id, ["settings": AnyEncodable(["access": access.rawValue])])
    }
  }
}
