import SwiftUI

/**
 * An agent's profile (Profile.dc.html): its ghost, name and handle, an Edit pill, grouped rows that
 * open each part (model, computer, routines, memory, skills, then who can ask, background, apps,
 * permissions, connect, activity, look, remove) and a notifications switch.
 */
struct AgentPage: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var agent: Agent
  @State private var editing = false
  @State private var editingLook = false
  @State private var removing = false
  @State private var chat: Channel?
  @State private var catalog: AgentModels.Catalog?
  @State private var action = FormAction()

  private var current: Agent { store.agent(agent.id) ?? agent }
  private var device: AgentNode? { store.nodes.first { $0.id == current.nodeId } }
  private var computer: Computer? { store.computers.first { $0.id == current.computerId } }
  private var routines: [Routine] { store.routines.filter { $0.agentId == current.id } }
  private var skillCount: Int { store.skills.filter { $0.agentIds?.contains(current.id) == true }.count }
  private var appCount: Int { store.connectors.filter { $0.agentIds?.contains(current.id) == true && $0.enabled != false }.count }
  private var canAsk: Bool {
    ((store.isOwner || current.settings?.createdBy == store.me?.id) && (store.features.invite || store.members.count > 1)) ||
    (device != nil && store.harnessOnDevice(current))
  }
  private var dmChannel: Channel? { store.channels.first { $0.isDM && store.dmAgent($0)?.id == current.id } }

  var body: some View {
    VStack(spacing: 0) {
      TopBar {
        CircleButton(symbol: "chevron.left", label: "Back", id: "agent-back") { dismiss() }
      } center: {
        EmptyView()
      } trailing: {
        moreMenu
      }
      ScrollView {
        VStack(spacing: 14) {
          header
          CardGroup {
            link("Model", id: "agent-model", icon: "dial.medium", value: AgentLine.model(agent: current, catalog: catalog)) { AgentModelPage(agent: current) }
            if store.canViewComputers {
              link("Computer", id: "agent-computer", icon: "desktopcomputer", value: AgentLine.computer(agent: current, computer: computer)) { AgentComputerView(agent: current) }
            }
            if store.features.routines {
              link("Routines", id: "agent-routines", icon: "clock", value: AgentLine.routines(routines)) { RoutinesView(agent: current) }
            }
            link("Memory", id: "agent-memory", icon: "folder") { AgentMemoryPage(agent: current) }
            link("Skills", id: "agent-skills", icon: "bolt", value: AgentLine.count(skillCount)) { AgentSkillsPage(agent: current) }
          }
          CardGroup {
            if canAsk {
              link("Who can ask it", id: "agent-who", icon: "person.2", value: AgentLine.respond(current)) { AgentWhoPage(agent: current) }
            }
            if store.features.background {
              link("Background", id: "agent-background", icon: "moon", value: backgroundValue) { BackgroundView(agent: current) }
            }
            link("Connected apps", id: "agent-apps", icon: "square.grid.2x2", value: AgentLine.count(appCount)) { AgentAppsPage(agent: current) }
            link("Permissions", id: "agent-permissions", icon: "lock") { AgentPermissions(agent: current) }
            link("Connect via MCP", id: "agent-connect", icon: "link") { AgentConnect(agent: current) }
            link("Activity", id: "agent-activity", icon: "list.bullet", value: activityValue) { AgentActivityPage(agent: current) }
            if store.canManage {
              Button { editingLook = true } label: { RowLabel(title: "Look", value: nil, leading: { rowIcon("paintpalette") }) }
                .buttonStyle(.plain).accessibilityIdentifier("agent-look")
              Button { removing = true } label: { RowLabel(title: "Remove \(current.name)", chevron: false, tint: Palette.red, leading: { rowIcon("trash").foregroundStyle(Palette.red) }) }
                .buttonStyle(.plain).accessibilityIdentifier("agent-remove")
            }
          }
          notifications
          AgentError(text: action.error)
        }
        .padding(.horizontal, 18).padding(.bottom, 34)
      }
      .refreshable { await reload() }
    }
    .background(Palette.sheet.ignoresSafeArea())
    .toolbar(.hidden, for: .navigationBar)
    .navigationBarBackButtonHidden(true)
    .navigationDestination(item: $chat) { ChannelView(channel: $0) }
    .sheet(isPresented: $editing) { AgentEditSheet(agent: current) }
    .sheet(isPresented: $editingLook) { LookEditor(agent: current) }
    .sheet(isPresented: $removing) {
      AgentConfirm(agent: current, title: "Remove \(current.name)?", message: "Its memory notes and personality stay in the vault. Its routines and chats with you stop.",
                   confirm: "Remove \(current.name)", destructive: true, busy: action.busy, error: action.error) {
        action.run { try await store.deleteAgent(current.id); removing = false; dismiss() }
      }
    }
    .task { await reload() }
    .onChange(of: store.agents.contains { $0.id == agent.id }) { _, exists in if !exists { dismiss() } }
  }

  // MARK: top

  private var moreMenu: some View {
    Menu {
      Button("Message", systemImage: "bubble.left") { action.run { chat = try await store.dm(with: current) } }
      if store.canManage {
        Button("Edit", systemImage: "pencil") { editing = true }
        Button("Edit look", systemImage: "paintpalette") { editingLook = true }
        Button("Remove", systemImage: "trash", role: .destructive) { removing = true }
      }
    } label: {
      CircleLabel(symbol: "ellipsis")
    }
    .accessibilityLabel("More")
    .accessibilityIdentifier("agent-more")
  }

  private var header: some View {
    VStack(spacing: 8) {
      AgentAvatar(agent: current, size: 104, showStatus: false, interactive: true)
        .simultaneousGesture(TapGesture().onEnded { if store.canManage { editingLook = true } })
        .accessibilityLabel("Edit \(current.name)'s look")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { if store.canManage { editingLook = true } }
      Text(current.name).font(.system(size: 26, weight: .bold)).foregroundStyle(Palette.text).accessibilityAddTraits(.isHeader)
      Text("@\(current.handle) · \(HarnessChoice.label(current.harness))").font(.system(size: 15)).foregroundStyle(Palette.faint)
      if let description = current.settings?.description ?? current.settings?.roleNotes, !description.isEmpty {
        Text(description).font(.system(size: 15)).foregroundStyle(Palette.muted).multilineTextAlignment(.center).lineLimit(3).padding(.horizontal, 18)
      }
      HStack(spacing: 10) {
        if store.canManage { SmallPill(title: "Edit", id: "agent-edit") { editing = true } }
        SmallPill(title: "Message", symbol: "bubble.left", id: "agent-message") { action.run { chat = try await store.dm(with: current) } }
          .disabled(action.busy)
      }.padding(.top, 2)
    }
    .frame(maxWidth: .infinity)
    .padding(.top, 2).padding(.bottom, 10)
  }

  private var notifications: some View {
    VStack(alignment: .leading, spacing: 8) {
      Toggle(isOn: Binding(get: { dmChannel?.isMuted != true }, set: { on in
        action.run {
          let channel: Channel
          if let existing = dmChannel { channel = existing } else { channel = try await store.dm(with: current) }
          try await store.setChannelPrefs(channel.id, ["notify": AnyEncodable(on ? "default" : "mute")])
        }
      })) {
        Text("Notifications").font(.system(size: 17)).foregroundStyle(Palette.text)
      }
      .tint(Palette.blue)
      .padding(.horizontal, 18).frame(minHeight: 60)
      .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
      .disabled(action.busy)
      .accessibilityIdentifier("agent-notifications")
      CardCaption("Get told when \(current.name) finishes or needs you")
    }
  }

  // MARK: rows

  private func link<Destination: View>(_ title: String, id: String, icon: String, value: String? = nil, @ViewBuilder _ destination: () -> Destination) -> some View {
    NavigationLink { destination() } label: {
      RowLabel(title: title, value: value?.isEmpty == true ? nil : value, leading: { rowIcon(icon) })
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier(id)
  }

  private var backgroundValue: String? {
    guard let work = store.backgrounds[current.id]?.background else { return nil }
    return work.enabled == true ? "On" : "Off"
  }

  private var activityValue: String? {
    if let doing = store.activity[current.id], doing != "started" { return doing }
    return current.status == .busy ? "Working" : nil
  }

  private func reload() async {
    do { try await store.refreshManagement() } catch { action.error = error.localizedDescription }
    try? await store.refreshRoutines()
    try? await store.refreshSkills()
    try? await store.refreshConnectors()
    try? await store.refreshBackground(current.id)
    catalog = try? await store.agentModels(current.id).catalog
  }
}
