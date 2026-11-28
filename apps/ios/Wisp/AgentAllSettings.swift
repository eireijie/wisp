import SwiftUI

/**
 * All settings (board 16c): every setting an agent has in one list, from its profile's one "All
 * settings" row. What was split between Edit and the profile's ⋯ menu, plus the ones the phone was
 * missing: what it does (its role line), whether it may refine its own personality, whether it may
 * use the device owner's own plugins, and which of your computers it may use.
 */
struct AgentAllSettings: View {
  @Environment(Store.self) private var store
  var agent: Agent
  @State private var role = ""
  @State private var loaded = false
  @State private var voiceSheet = false
  @State private var catalog: AgentModels.Catalog?
  @State private var run = RunInfo()
  @State private var action = FormAction()

  private var current: Agent { store.agent(agent.id) ?? agent }
  private var device: AgentNode? { store.nodes.first { $0.id == current.nodeId } }
  private var computer: Computer? { store.computers.first { $0.id == current.computerId } }
  private var dmChannel: Channel? { store.channels.first { $0.isDM && store.dmAgent($0)?.id == current.id } }
  private var manage: Bool { store.canManage }
  private var myDevices: [AgentNode] { store.nodes.filter { $0.mine == true } }
  private var canAsk: Bool {
    ((store.isOwner || current.settings?.createdBy == store.me?.id) && (store.features.invite || store.members.count > 1)) ||
    (device != nil && store.harnessOnDevice(current))
  }

  var body: some View {
    AgentFrame(title: "All settings", subtitle: current.name) {
      caption("About")
      CardGroup {
        if manage {
          NavigationLink { AgentEditPage(agent: current) } label: { RowLabel(title: "Name", value: "\(current.name) · @\(current.handle)") }
            .buttonStyle(.plain).accessibilityIdentifier("all-name")
        }
        HStack(spacing: 12) {
          Text("What it does").font(.system(size: 15)).foregroundStyle(Palette.text)
          TextField("Optional", text: $role)
            .multilineTextAlignment(.trailing).font(.system(size: 15)).foregroundStyle(Palette.muted)
            .submitLabel(.done).onSubmit(saveRole)
            .onChange(of: role) { _, v in if v.count > 60 { role = String(v.prefix(60)) } }
            .accessibilityLabel("What it does").accessibilityIdentifier("all-role")
        }
        .padding(.horizontal, 14).frame(minHeight: 48)
        .disabled(!manage || !loaded)
        link("Personality", id: "all-personality") { AgentPersonalityPage(agent: current) }
        SwitchRow(title: "It can refine its own personality", isOn: Binding(get: { current.settings?.soulLocked != true }, set: { on in
          save(["soulLocked": AnyEncodable(!on)])
        }), id: "all-soul").disabled(!manage || action.busy)
        link("Instructions", id: "all-instructions") { AgentInstructionsPage(agent: current) }
      }

      caption("Look and voice")
      CardGroup {
        link("Bubble", id: "all-bubble") { BubbleLookPage(agent: current) }
        link("Chat background", id: "all-background") { AgentFrame(title: "Chat background", subtitle: current.name) { AgentBackgroundTab(agent: current) } }
        Button { voiceSheet = true } label: { RowLabel(title: "Voice") }.buttonStyle(.plain).accessibilityIdentifier("all-voice")
      }

      caption("Brain and computer")
      CardGroup {
        link("Model", id: "all-model", value: AgentLine.model(agent: current, catalog: catalog)) { AgentModelPage(agent: current) }
        NavigationLink { HarnessPicker(agent: current, info: run).task { if let dm = dmChannel { await run.load(store, agent: current, channel: dm.id, thread: nil) } } } label: {
          RowLabel(title: "Harness", value: HarnessChoice.label(current.harness))
        }.buttonStyle(.plain).accessibilityIdentifier("all-harness")
        if manage { AgentRunsOnRow(agent: current, action: action, icon: false) }
        if store.canViewComputers {
          link("Computer", id: "all-computer", value: AgentLine.computer(agent: current, computer: computer, device: device)) { AgentComputerView(agent: current) }
        }
      }

      caption("What it may do")
      CardGroup {
        link("Permissions", id: "all-permissions") { AgentPermissions(agent: current) }
        if canAsk { link("Who can message it", id: "all-who") { AgentWhoPage(agent: current) } }
        if store.features.background { link("Background checks", id: "all-background-checks") { BackgroundView(agent: current) } }
        link("Connections", id: "all-connections") { AgentConnect(agent: current) }
        if device?.mine == true {
          SwitchRow(title: "Use my own plugins", subtitle: "Plugins and helpers from your own install on \(device?.name ?? "this device")", isOn: Binding(get: { current.settings?.ownPlugins == true }, set: { on in
            save(["ownPlugins": AnyEncodable(on)])
          }), id: "all-own-plugins").disabled(action.busy)
        }
      }
      if !myDevices.isEmpty {
        caption("Use my computers")
        CardGroup {
          ForEach(myDevices) { n in useRow(n) }
        }
        CardCaption("Only you decide for your own computers.")
      }

      caption("History")
      CardGroup { link("Recent runs", id: "all-runs") { AgentActivityPage(agent: current) } }
      AgentError(text: action.error)
    }
    .sheet(isPresented: $voiceSheet) { AgentVoiceSheet(agent: current) }
    .task {
      guard !loaded else { return }
      role = current.settings?.role ?? ""
      loaded = true
      catalog = try? await store.agentModels(current.id).catalog
    }
    .onDisappear(perform: saveRole)
  }

  /** Off, Ask first or Tell me after, for one of your own computers. */
  private func useRow(_ n: AgentNode) -> some View {
    let now = current.settings?.useDevices?[n.id]
    let label = now == "ask" ? "Ask first" : now == "tell" ? "Tell me after" : "Off"
    return Menu {
      ForEach([(nil, "Off"), ("ask", "Ask first"), ("tell", "Tell me after")] as [(String?, String)], id: \.1) { mode, title in
        Button { setUse(n.id, mode) } label: {
          if now == mode { Label(title, systemImage: "checkmark") } else { Text(title) }
        }
      }
    } label: {
      RowLabel(title: n.name, value: label)
    }
    .disabled(action.busy)
    .accessibilityIdentifier("all-use-\(n.id)")
  }

  private func setUse(_ nodeId: String, _ mode: String?) {
    var next = current.settings?.useDevices ?? [:]
    next[nodeId] = mode
    save(["useDevices": AnyEncodable(next)])
  }

  private func saveRole() {
    let line = role.trimmed
    guard loaded, manage, line != (current.settings?.role ?? "").trimmed else { return }
    save(["role": AnyEncodable(line)])
  }

  private func save(_ settings: Fields) {
    action.run { _ = try await store.updateAgent(current.id, ["settings": AnyEncodable(settings)]) }
  }

  private func caption(_ text: String) -> some View {
    Text(text).font(.system(size: 13)).foregroundStyle(Palette.faint).padding(.horizontal, 14).padding(.bottom, -6)
  }

  private func link<D: View>(_ title: String, id: String, value: String? = nil, @ViewBuilder _ destination: () -> D) -> some View {
    NavigationLink { destination() } label: { RowLabel(title: title, value: value) }
      .buttonStyle(.plain).accessibilityIdentifier(id)
  }
}
