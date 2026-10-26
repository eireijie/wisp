import SwiftUI

/**
 * Permissions (agent-Permissions.dc.html): what an agent may do with files and commands on its
 * device (Read, Edit, Full access), what it asks you before doing (the organization's list), and,
 * read-only, which memory folders it can use and who its own folder is shared with.
 */
struct AgentPermissions: View {
  @Environment(Store.self) private var store
  var agent: Agent
  @State private var access = AgentAccess.edit
  @State private var loaded = false
  @State private var memory: AgentMemoryAccess?
  @State private var memoryError: String?
  @State private var action = FormAction()

  static let askBefore: [(key: String, title: String)] = [
    ("send", "Sending email or messages outside Wisp"), ("spend", "Buying or paying for anything"), ("delete", "Deleting files, data or accounts"),
    ("post", "Posting publicly"), ("signup", "Signing up for new accounts or services"), ("share", "Sharing files or private information outside Wisp"),
  ]

  private var current: Agent { store.agent(agent.id) ?? agent }
  private var saved: AgentAccess { AgentAccess.from(current.settings?.access) }
  private var device: AgentNode? { store.nodes.first { $0.id == current.nodeId } }

  var body: some View {
    AgentFrame(title: "Permissions", subtitle: current.name) {
      CardCaption("On its device")
      Segments(options: AgentAccess.allCases.map { ($0, AgentLine.accessChip($0)) }, selection: Binding(get: { access }, set: { choose($0) }), id: "permissions-access")
        .disabled(!store.canManage || action.busy)
      CardCaption(access == .full ? "Full access lets it change anything on the computer." : "\(access.label). \(access.body)")
      CardCaption(access.scope(name: current.name, handle: current.handle, device: device?.name))
      if access == .full {
        AgentCard {
          Label("The agent can run any command as the device's user. The device must opt in with wisp node start --allow-full-access; otherwise it runs with edit access.", systemImage: "exclamationmark.shield")
            .font(.system(size: 13)).foregroundStyle(Palette.red)
        }
      }
      AgentError(text: action.error)

      CardCaption("Ask me before")
      if let policy = store.agentPolicy {
        CardGroup {
          ForEach(Self.askBefore, id: \.key) { item in
            SwitchRow(title: item.title, isOn: Binding(get: { policy.askBefore.contains(item.key) }, set: { setAsk(item.key, $0) }), id: "ask-\(item.key)")
          }
        }.disabled(!store.isOwner || action.busy)
        CardCaption(store.isOwner ? "These apply to every agent here. Asks show up in your Inbox and as a card in chat." : "Only owners can change these. Asks show up in your Inbox and as a card in chat.")
      } else {
        AgentCard { Text("Asks show up in your Inbox and as a card in chat.").font(.system(size: 15)).foregroundStyle(Palette.muted) }
      }

      CardCaption("In memory")
      if let memory {
        let rules = memory.rules.sorted { $0.path.lowercased() < $1.path.lowercased() }
        CardGroup {
          ForEach(rules, id: \.rowId) { rule in ruleRow(rule) }
          RowLabel(title: "Its folder is shared with", subtitle: sharedWith(memory), chevron: false)
          RowLabel(title: "Personality", subtitle: current.settings?.soulLocked == true ? "Locked: only people can edit it" : "It can refine its own personality", chevron: false)
          RowLabel(title: "Instructions", subtitle: "Only people can edit them", chevron: false)
        }
        CardCaption("Which folders and notes @\(current.handle) can use, and why. Change them with the share button on a folder or note in Memory.")
      } else if let memoryError {
        AgentError(text: memoryError)
        PillButton(title: "Try again", kind: .secondary) { Task { await loadMemory() } }
      } else {
        ProgressView().frame(maxWidth: .infinity)
      }
    }
    .task {
      if !loaded { access = saved; loaded = true }
      try? await store.refreshAgentPolicy()
      await loadMemory()
    }
    .onChange(of: current.settings?.access) { old, new in
      // follow a change made elsewhere, unless this screen has its own edit pending
      if access == AgentAccess.from(old) { access = AgentAccess.from(new) }
    }
  }

  private func choose(_ level: AgentAccess) {
    guard level != access else { return }
    let before = access
    access = level
    action.run {
      do { _ = try await store.updateAgent(current.id, ["settings": AnyEncodable(["access": level.rawValue])]) }
      catch { access = before; throw error }
    }
  }

  private func setAsk(_ key: String, _ on: Bool) {
    guard var policy = store.agentPolicy else { return }
    policy.askBefore.removeAll { $0 == key }
    if on { policy.askBefore.append(key) }
    let next = policy
    action.run { try await store.saveAgentPolicy(next) }
  }

  private func ruleRow(_ rule: AgentMemoryRule) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(AccessText.path(rule.path, agents: store.agents, members: store.members)).font(.system(size: 15)).foregroundStyle(Palette.text)
      HStack(spacing: 6) {
        Text(AccessText.level(rule.level)).foregroundStyle(rule.level == "none" ? Palette.faint : Palette.muted)
        if let via = via(rule) { Text(via).foregroundStyle(Palette.faint) }
        if rule.startup == true { Label("loads at startup", systemImage: "pin").foregroundStyle(Palette.faint) }
      }.font(.system(size: 13))
    }
    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 18).padding(.vertical, 10)
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
}
