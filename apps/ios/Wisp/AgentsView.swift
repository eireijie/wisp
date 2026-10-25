import SwiftUI

/** Everyone you work with: each agent's ghost, what it's doing now, and a tap to open its page. */
struct AgentsView: View {
  @Environment(Store.self) private var store
  @State private var path = NavigationPath()
  @State private var adding = false

  private var sorted: [Agent] {
    store.agents.sorted { a, b in
      let rank: (Agent.Status) -> Int = { $0 == .busy ? 0 : $0 == .online ? 1 : 2 }
      return rank(a.status) != rank(b.status) ? rank(a.status) < rank(b.status) : a.name < b.name
    }
  }

  var body: some View {
    NavigationStack(path: $path) {
      ScrollView {
        if store.agents.isEmpty {
          ContentUnavailableView {
            Label("Add your first agent", systemImage: "sparkles")
          } description: {
            Text("Give it a job and a computer.")
          } actions: {
            if store.canManage { Button("Add agent") { adding = true }.primaryButton() }
          }.padding(.top, 80)
        }
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 160), spacing: 12)], spacing: 12) {
          ForEach(sorted) { a in
            AgentTile(agent: a, doing: store.activity[a.id], openSettings: { path.append(a) }, openChat: { path.append($0) })
          }
        }
        .padding(16)
      }
      .navigationTitle("Agents")
      .refreshable { await store.load() }
      .toolbar {
        if store.canManage {
          ToolbarItem(placement: .topBarTrailing) { Button("Add agent", systemImage: "plus") { adding = true } }
        }
      }
      .sheet(isPresented: $adding) { AddAgent { path.append($0) } }
      .navigationDestination(for: Agent.self) { AgentPage(agent: $0) }
      .navigationDestination(for: Channel.self) { ChannelView(channel: $0) }
      .navigationDestination(for: ThreadRef.self) { ThreadView(ref: $0) }
    }
  }

}

struct AgentTile: View {
  @Environment(Store.self) private var store
  @State private var editingLook = false
  var agent: Agent
  var doing: String?
  var openSettings: () -> Void
  var openChat: (Channel) -> Void
  @State private var removing = false
  @State private var action = FormAction()

  var body: some View {
    Button(action: openSettings) {
      VStack(spacing: 10) {
        GhostView(look: agent.settings?.appearance, seed: agent.handle, size: 64, mood: store.mood(for: agent))
          .padding(.top, 6)
        VStack(spacing: 3) {
          Text(agent.name).font(.headline).lineLimit(1)
          Text(harnessLabel).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        HStack(spacing: 5) {
          GlowDot(color: statusColor)
          Text(doing ?? statusWord).font(.caption).foregroundStyle(agent.status == .busy ? .blue : .secondary).lineLimit(1)
        }
      }
      .frame(maxWidth: .infinity)
      .padding(14)
      .background(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).fill(Color(.secondarySystemBackground)))
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("agent-tile")
    .contextMenu {
      Button("Message", systemImage: "bubble.left") { action.run { openChat(try await store.dm(with: agent)) } }
      if store.canManage { Button("Edit look", systemImage: "paintpalette") { editingLook = true } }
      Button("Settings", systemImage: "gearshape", action: openSettings)
      if store.canManage { Button("Remove", systemImage: "trash", role: .destructive) { removing = true } }
    }
    .confirmationDialog("Remove \(agent.name) (@\(agent.handle))?", isPresented: $removing, titleVisibility: .visible) {
      Button("Remove \(agent.name)", role: .destructive) { action.run { try await store.deleteAgent(agent.id) } }
    } message: { Text("Its memory notes and personality stay in the vault.") }
    .managementAlert(action)
    .sheet(isPresented: $editingLook) { LookEditor(agent: store.agent(agent.id) ?? agent) }
  }

  private var statusWord: String { agent.status == .busy ? "Working" : agent.status == .online ? "Online" : "Offline" }
  private var statusColor: Color { agent.status == .busy ? .blue : agent.status == .online ? .green : .gray }
  private var harnessLabel: String {
    HarnessChoice.label(agent.harness)
  }
}
