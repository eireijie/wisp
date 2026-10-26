import SwiftUI
import UIKit

/**
 * One device, opened from its group on the Computers tab: what it does for agents, the agents that
 * run on it, its own screen, how its owner reaches it from anywhere, its harnesses, and updating or
 * removing it (apps/web/src/views/DevicePage.tsx; comp-Device, comp-DeviceMore, comp-Offline,
 * comp-Updating). Only agents that run on a device can use its screen.
 */
struct DeviceDetail: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var nodeId: String
  private var fallback: AgentNode?
  @State private var removing = false
  @State private var action = FormAction()
  @State private var watching: WatchRoute?
  @State private var addingAgent = false

  init(nodeId: String) { self.nodeId = nodeId }
  init(node: AgentNode) { self.nodeId = node.id; self.fallback = node }

  private var current: AgentNode? { store.nodes.first { $0.id == nodeId } ?? fallback }
  private func mine(_ n: AgentNode) -> Bool { n.mine == true }

  var body: some View {
    VStack(spacing: 0) {
      TopBar {
        CircleButton(symbol: "chevron.left", label: "Back", id: "device-back") { dismiss() }
      } center: {
        if let n = current { NamePill(title: n.name) { EmptyView() } }
      } trailing: {
        if let n = current { moreMenu(n) } else { Color.clear.frame(width: 52, height: 52) }
      }
      if let n = current { content(n) } else {
        ContentUnavailableView {
          Label("That device is gone", systemImage: "desktopcomputer.trianglebadge.exclamationmark")
        } actions: { Button("Back to computers") { dismiss() }.secondaryButton() }
          .frame(maxHeight: .infinity)
      }
    }
    .background(Palette.sheet.ignoresSafeArea())
    .toolbar(.hidden, for: .navigationBar)
    .toolbar(.hidden, for: .tabBar)
    .tint(Palette.text)
    .accessibilityIdentifier("screen-device")
    .navigationDestination(item: $watching) { ComputerDetail(computerId: $0.id) }
    .sheet(isPresented: $addingAgent) { AddAgent(nodeId: nodeId) { _ in } }
    .task { await store.refreshComputers() }
    .task {
      // follow an update or a device coming back
      while !Task.isCancelled {
        do { try await Task.sleep(for: .seconds(5)) } catch { return }
        try? await store.refreshNodes()
      }
    }
    .confirmationDialog("Remove \(current?.name ?? "this device")? Its token stops working.", isPresented: $removing, titleVisibility: .visible) {
      Button("Remove device", role: .destructive) { if let n = current { action.run { try await store.deleteNode(n.id); dismiss() } } }
    }
  }

  @ViewBuilder private func moreMenu(_ n: AgentNode) -> some View {
    let canUpdate = store.isOwner && n.online && !n.isUpdating
    let canRemove = store.canManage && (mine(n) || store.isOwner)
    if canUpdate || canRemove {
      Menu {
        if canUpdate { Button("Update Wisp", systemImage: "arrow.down.circle") { update(n) } }
        if canRemove { Button("Remove device", systemImage: "trash", role: .destructive) { removing = true } }
      } label: { CircleLabel(symbol: "ellipsis") }
        .accessibilityLabel("More").accessibilityIdentifier("device-menu")
    } else {
      Color.clear.frame(width: 52, height: 52)
    }
  }

  private func update(_ n: AgentNode) { action.run { try await store.updateDeviceWisp(n.id) } }

  private func content(_ n: AgentNode) -> some View {
    List {
      header(n)
      if !n.online && (mine(n) || store.isOwner) { bringBack(n) }
      if n.update != nil, n.update?.state != "idle" { updating(n) }
      role(n)
      AgentsHere(node: n) { addingAgent = true }
      if mine(n) && store.canViewComputers { YourScreen(node: n) { watching = WatchRoute(id: $0) } }
      if mine(n) && store.features.remoteDesktop { RemoteDesktopSection(node: n) }
      HarnessesSection(node: n)
      manage(n)
      InlineError(error: action.error).listRowBackground(Color.clear)
    }
    .listStyle(.insetGrouped)
    .groundBackground(Palette.sheet)
    .accessibilityIdentifier("device-list")
    .refreshable { do { try await store.refreshNodes() } catch { action.error = error.localizedDescription }; await store.refreshComputers() }
  }

  // MARK: sections

  private func header(_ n: AgentNode) -> some View {
    Section {
      HStack(spacing: 12) {
        GroupIcon(symbol: "desktopcomputer", dim: !n.online)
        VStack(alignment: .leading, spacing: 2) {
          Text(n.name).font(.system(size: 17, weight: .semibold)).foregroundStyle(Palette.text)
          Text(subtitle(n)).font(.system(size: 13)).foregroundStyle(Palette.faint)
        }
        Spacer(minLength: 6)
        NodePill(node: n)
      }
      if n.paused == true { Text("Paused at the device. Resume it there with: wisp node resume").font(.footnote).foregroundStyle(Palette.muted) }
    }.listRowBackground(Palette.card)
  }

  private func subtitle(_ n: AgentNode) -> String {
    var parts: [String] = []
    if let owner = n.ownerName { parts.append(n.mine == true ? owner : "\(owner)'s") }
    if let caps = n.capabilities { parts.append(caps.osName) }
    return parts.isEmpty ? (n.online ? "Online" : "Offline") : parts.joined(separator: " · ")
  }

  /** Offline: when it was last seen, and how to bring it back. */
  private func bringBack(_ n: AgentNode) -> some View {
    Section {
      Text(n.lastSeen == nil ? "It hasn't connected yet. Agents on it will wait." : lastSeen(n) + " Agents on it are paused until it is back.").font(.system(size: 15)).foregroundStyle(Palette.muted)
      step(1, n.lastSeen == nil ? "Open Wisp on that computer and pick Join my Wisp" : "Turn it on and wake it up")
      step(2, "Make sure it is on the same Wi-Fi, or Away from home is on")
      if n.lastSeen != nil { step(3, "Open Wisp on it if it is not running") }
      Button { action.run { try await store.refreshNodes() } } label: { Label("Check again", systemImage: "arrow.clockwise").frame(maxWidth: .infinity) }
        .secondaryButton().controlSize(.large).disabled(action.busy).accessibilityIdentifier("device-check-again")
    } header: { Text("To bring it back") }.listRowBackground(Palette.card)
  }

  private func lastSeen(_ n: AgentNode) -> String {
    guard let d = n.lastSeen.flatMap({ Wire.date($0) }) else { return "" }
    return "Last seen \(d.formatted(date: .abbreviated, time: .shortened))."
  }

  private func step(_ n: Int, _ text: String) -> some View {
    HStack(spacing: 12) {
      Text("\(n)").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.muted).frame(width: 26, height: 26)
        .background(Circle().fill(Palette.control)).overlay(Circle().strokeBorder(Palette.hairline))
      Text(text).font(.system(size: 15)).foregroundStyle(Palette.text)
    }
  }

  /** An update in progress, or the one that failed. */
  private func updating(_ n: AgentNode) -> some View {
    Section {
      HStack(spacing: 12) {
        if n.isUpdating { ProgressView() } else { Image(systemName: "exclamationmark.triangle").foregroundStyle(Palette.red) }
        VStack(alignment: .leading, spacing: 2) {
          Text(n.isUpdating ? "Updating Wisp on \(n.name)" : "Update failed").font(.system(size: 16, weight: .semibold)).foregroundStyle(Palette.text)
          Text(n.update?.message.flatMap { $0.isEmpty ? nil : $0 } ?? "Getting the latest Wisp and restarting it. Agents on this device pause for a moment, then pick up where they left off.")
            .font(.system(size: 14)).foregroundStyle(Palette.muted)
        }
      }
    }.listRowBackground(Palette.card).accessibilityIdentifier("device-updating")
  }

  /** What it does for agents, and who else can put agents here. */
  @ViewBuilder private func role(_ n: AgentNode) -> some View {
    let editable = store.canManage && mine(n)
    Section {
      ForEach(Self.roles, id: \.0) { id, title, detail in
        Button {
          guard editable, n.role != id else { return }
          action.run { try await store.updateNode(n.id, ["role": .nullable(id)]) }
        } label: {
          HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
              Text(title).font(.system(size: 16)).foregroundStyle(Palette.text)
              Text(detail).font(.system(size: 13)).foregroundStyle(Palette.faint)
            }
            Spacer(minLength: 6)
            if n.role == id { Image(systemName: "checkmark").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.blue) }
          }.contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(!editable || action.busy).accessibilityIdentifier("device-role-\(id)")
      }
      Toggle(isOn: Binding(get: { n.shared == true }, set: { on in action.run { try await store.updateNode(n.id, ["shared": AnyEncodable(on)]) } })) {
        VStack(alignment: .leading, spacing: 2) {
          Text("Share with the organization").font(.system(size: 16)).foregroundStyle(Palette.text)
          Text("Let others in \(store.workspace?.name ?? "the organization") add agents and VMs here").font(.system(size: 13)).foregroundStyle(Palette.faint)
        }
      }.tint(Palette.blue).disabled(!editable || action.busy).accessibilityIdentifier("device-shared")
    } header: { Text("What this device does for agents") }
      .listRowBackground(Palette.card)
  }

  static let roles: [(String, String, String)] = [
    ("vms", "Runs VMs", "Agents get their own virtual computer here"),
    ("screen", "Lets agents use its screen", "Agents ask before they take over your screen"),
    ("headless", "Headless", "Agents work in the background only"),
  ]

  /** Update Wisp, and Remove device. */
  @ViewBuilder private func manage(_ n: AgentNode) -> some View {
    let canUpdate = store.isOwner && n.online
    let canRemove = store.canManage && (mine(n) || store.isOwner)
    if canUpdate || canRemove || mine(n) {
      Section {
        if canUpdate {
          Button { update(n) } label: {
            RowLabel(title: n.isUpdating ? "Updating…" : "Update Wisp", subtitle: "Get the latest Wisp on this device and restart it", chevron: false) {
              Image(systemName: "arrow.down.circle").foregroundStyle(Palette.text)
            }.padding(.horizontal, -18)
          }.buttonStyle(.plain).disabled(n.isUpdating || action.busy).accessibilityIdentifier("device-update")
        }
        if canRemove {
          Button { removing = true } label: {
            RowLabel(title: "Remove device", subtitle: "Its token stops working.", chevron: false, tint: Palette.red) {
              Image(systemName: "trash").foregroundStyle(Palette.red)
            }.padding(.horizontal, -18)
          }.buttonStyle(.plain).disabled(action.busy).accessibilityIdentifier("device-remove")
        }
      } footer: {
        if mine(n) { Text("At \(n.name): wisp node screen code picks a new screen code, and wisp node pause stops everything there until wisp node resume.") }
      }.listRowBackground(Palette.card)
    }
  }
}

private struct AgentLabel: View {
  var agent: Agent
  var body: some View {
    HStack(spacing: 10) {
      AgentAvatar(agent: agent, size: 28, showStatus: false)
      VStack(alignment: .leading, spacing: 1) {
        Text(agent.name).font(.system(size: 16)).foregroundStyle(Palette.text)
        if agent.status == .busy { Text("Working").font(.system(size: 12)).foregroundStyle(Palette.green) }
      }
    }
  }
}

/** The agents whose harness runs on this device, and what each one works on. */
private struct AgentsHere: View {
  @Environment(Store.self) private var store
  var node: AgentNode
  var onAdd: () -> Void
  @State private var action = FormAction()
  @State private var headless: Agent?
  private var agents: [Agent] { store.agents.filter { $0.nodeId == node.id } }

  var body: some View {
    Section {
      if agents.isEmpty { Text("No agents here yet.").foregroundStyle(Palette.muted) }
      ForEach(agents) { agent in
        if node.mine == true && store.canManage {
          Picker(selection: Binding(get: { worksOn(agent).tag }, set: { pick(WorksOn(tag: $0), agent) })) {
            ForEach(options(for: agent), id: \.0) { tag, label in Text(label).tag(tag) }
          } label: { AgentLabel(agent: agent) }
            .pickerStyle(.menu)
            .disabled(action.busy)
            .accessibilityIdentifier("works-on-\(agent.id)")
        } else {
          LabeledContent { Text(worksOnLabel(agent)).foregroundStyle(Palette.faint) } label: { AgentLabel(agent: agent) }
        }
      }
      if store.canManage && (node.mine == true || node.shared == true) {
        Button(action: onAdd) { Label("Add an agent here", systemImage: "plus").foregroundStyle(Palette.text) }.accessibilityIdentifier("device-add-agent")
      }
      InlineError(error: action.error)
    } header: { Text("Agents on this computer") } footer: {
      Text("Only agents that run here can use this computer\(node.mine == true ? ", and only for things you ask" : "").")
    }
    .listRowBackground(Palette.card)
    .confirmationDialog("Run \(headless?.name ?? "it") without a computer? It won't be able to use apps or websites.", isPresented: Binding(get: { headless != nil }, set: { if !$0 { headless = nil } }), titleVisibility: .visible, presenting: headless) { agent in
      Button("No computer") { set(.none, agent) }
    }
  }

  private func worksOn(_ agent: Agent) -> WorksOn {
    guard let c = store.computers.first(where: { $0.id == agent.computerId }) else { return .none }
    return c.kind == "device" ? .screen : .computer(c.id)
  }

  /** "This screen", the VMs here, a computer it already has somewhere else, a new VM, or none. */
  private func options(for agent: Agent) -> [(String, String)] {
    let caps = node.capabilities
    let current = worksOn(agent)
    var list: [(String, String)] = []
    if caps?.screen?.ok == true || current == .screen { list.append(("screen", "This screen")) }
    for vm in store.computers where vm.kind == "vm" && vm.nodeId == node.id { list.append((vm.id, vm.name)) }
    if case .computer(let id) = current, !list.contains(where: { $0.0 == id }), let c = store.computers.first(where: { $0.id == id }) { list.append((c.id, c.name)) }
    if caps?.vm?.ok == true { list.append(("new-vm", "New VM")) }
    list.append(("none", "No computer"))
    return list
  }

  private func worksOnLabel(_ agent: Agent) -> String {
    if let c = store.computers.first(where: { $0.id == agent.computerId }) { return c.kind == "device" ? "This screen" : c.name }
    return agent.computerId == nil ? "No computer" : "Its owner's screen"
  }

  private func pick(_ choice: WorksOn, _ agent: Agent) {
    guard choice != worksOn(agent) else { return }
    if choice == .none { headless = agent } else { set(choice, agent) }
  }

  private func set(_ choice: WorksOn, _ agent: Agent) {
    action.run { try await store.setWorksOn(choice, agent: agent, node: node) }
  }
}

/** The device's own screen: on or off, its code, who can use it, and a way to watch it. Its owner's alone. */
private struct YourScreen: View {
  @Environment(Store.self) private var store
  var node: AgentNode
  var onWatch: (String) -> Void
  @State private var action = FormAction()
  private var caps: DeviceCapabilities.Screen? { node.capabilities?.screen }
  private var screen: Computer? { store.computers.first { $0.kind == "device" && $0.nodeId == node.id } }
  private var users: [Agent] { screen.map { s in store.agents.filter { $0.computerId == s.id } } ?? [] }

  var body: some View {
    Section("Your screen") {
      HStack(spacing: 12) {
        Image(systemName: caps?.code != nil ? "lock" : "display").foregroundStyle(Palette.muted).frame(width: 28)
        VStack(alignment: .leading, spacing: 2) {
          Text(status).foregroundStyle(Palette.text)
          if let detail { Text(detail).font(.footnote).foregroundStyle(Palette.muted) }
          if caps?.off == true && node.online { Text("Turn it on at \(node.name): wisp node screen on").font(.footnote).foregroundStyle(Palette.muted).textSelection(.enabled) }
        }
      }
      if let code = caps?.code {
        VStack(alignment: .leading, spacing: 2) {
          Text("Screen code").foregroundStyle(Palette.text)
          Text("Checked on the device (\(code == "pin" ? "PIN" : "password")). To change it, run wisp node screen code at \(node.name).").font(.footnote).foregroundStyle(Palette.muted)
        }
      }
      if caps?.ok == true && node.online {
        Button("Watch", systemImage: "eye") {
          action.run { onWatch(try await store.deviceScreen(node.id).id) }
        }.disabled(action.busy).accessibilityIdentifier("device-watch")
      }
      InlineError(error: action.error)
    }.listRowBackground(Palette.card)
  }

  private var status: String {
    guard node.online else { return "Unknown until it connects" }
    guard let caps else { return "Not checked yet" }
    if caps.ok { return caps.code.map { "On · opens with your \($0 == "pin" ? "PIN" : "password")" } ?? "On" }
    return caps.off == true ? "Off" : "Can't be used"
  }

  private var detail: String? {
    guard node.online, let caps else { return nil }
    guard caps.ok else { return caps.off == true ? nil : caps.detail }
    let working = users.filter { $0.status == .busy }
    if !working.isEmpty { return "\(working.map(\.name).joined(separator: ", ")) \(working.count == 1 ? "is" : "are") using it now." }
    if !users.isEmpty { return "\(users.map(\.name).joined(separator: ", ")) can use it." }
    return "Only you can see it."
  }
}

/** The harnesses on the device, with Install for the ones it lacks. */
private struct HarnessesSection: View {
  @Environment(Store.self) private var store
  var node: AgentNode
  @State private var installing: String?
  @State private var output: String?
  @State private var action = FormAction()
  private let installable = ["claude-code", "codex", "gemini", "opencode", "kimi", "qwen", "openclaw"]

  var body: some View {
    let have = node.harnesses ?? []
    Section {
      ForEach(have, id: \.id) { h in
        HStack {
          Text(HarnessChoice.label(h.id)).foregroundStyle(Palette.text)
          Spacer()
          Text(h.version.map { "Installed · \($0)" } ?? "Installed").font(.system(size: 14)).foregroundStyle(Palette.faint)
        }
      }
      if have.isEmpty { Text("Nothing found yet. Refresh once the device is online.").foregroundStyle(Palette.muted) }
      if store.canManage && node.mine == true {
        ForEach(installable.filter { id in !have.contains { $0.id == id } }, id: \.self) { id in
          HStack {
            Text(HarnessChoice.label(id)).foregroundStyle(Palette.muted)
            Spacer()
            Text("Not installed").font(.system(size: 13)).foregroundStyle(Palette.faint)
            Button("Install") { installing = id }.buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.small)
              .disabled(!node.online || action.busy).accessibilityIdentifier("install-\(id)")
          }
        }
      }
      if store.canManage && node.usable { Button("Refresh", systemImage: "arrow.clockwise") { action.run { try await store.refreshDevice(node.id) } }.disabled(!node.online || action.busy).foregroundStyle(Palette.text) }
      if let output { Text(output).font(.caption).foregroundStyle(Palette.muted).textSelection(.enabled) }
      if action.busy { ProgressView("Working on the device…") }
      InlineError(error: action.error)
    } header: { Text("Agent harnesses") } footer: {
      if store.canManage && node.mine == true { Text("Other harnesses use their own installer on the computer.") }
    }
    .listRowBackground(Palette.card)
    .confirmationDialog("Install this harness on \(node.name)?", isPresented: Binding(get: { installing != nil }, set: { if !$0 { installing = nil } }), titleVisibility: .visible) {
      Button("Install") { if let harness = installing { action.run { output = try await store.installHarness(harness, node: node.id) } } }
    }
  }
}

private struct WatchRoute: Hashable, Identifiable { var id: String }

/**
 * The Remote desktop mod: how its owner reaches this device from anywhere. RustDesk (set up at the
 * device), or the app they already use, by its ID, address or link. Never a password. Its owner's alone.
 */
private struct RemoteDesktopSection: View {
  @Environment(Store.self) private var store
  var node: AgentNode
  @State private var editing = false
  @State private var showRustdesk = false
  @State private var forgetting = false
  @State private var action = FormAction()

  var body: some View {
    Section {
      if let id = node.capabilities?.rustdesk?.id {
        RemoteRow(label: "RustDesk", value: DeviceText.rustdeskID(id), copy: id, link: DeviceText.rustdeskLink(id), note: "Use the password you set in RustDesk. Wisp never sees it.")
      }
      if let own = node.remoteDesktop, !editing {
        RemoteRow(label: own.label, value: own.shown, copy: own.value, link: own.link, onChange: { editing = true }, onRemove: { forgetting = true })
      }
      if editing {
        OwnAppForm(node: node, current: node.remoteDesktop, onDone: { editing = false })
      } else if node.capabilities?.rustdesk == nil && node.remoteDesktop == nil {
        if showRustdesk {
          Text("Run this at \(node.name). It asks before installing RustDesk, then shows its ID here.").foregroundStyle(.secondary)
          CopyLine(text: "wisp node rustdesk")
          Button("Back") { showRustdesk = false }
        } else {
          Button { showRustdesk = true } label: { Choice(title: "Set up RustDesk", symbol: "arrow.down.circle", detail: "Free and open source. \(node.name) installs it after asking you there.") }
            .accessibilityIdentifier("remote-setup-rustdesk")
          Button { editing = true } label: { Choice(title: "I already use one", symbol: "link", detail: foundApps) }
            .accessibilityIdentifier("remote-own-app")
        }
      } else if node.remoteDesktop == nil {
        Button("Add another app you use") { editing = true }
      }
      InlineError(error: action.error)
    } header: { Text("Remote desktop") } footer: {
      if node.capabilities?.rustdesk == nil && node.remoteDesktop == nil && !editing && !showRustdesk { Text("Reach \(node.name) from anywhere.") }
    }
    .listRowBackground(Palette.card)
    .confirmationDialog("Stop showing \(node.remoteDesktop?.label ?? "this app") here? The app itself isn't changed.", isPresented: $forgetting, titleVisibility: .visible) {
      Button("Remove", role: .destructive) { action.run { try await store.setRemoteDesktop(node.id, nil) } }
    }
  }

  private var foundApps: String {
    let found = (node.capabilities?.remoteApps ?? []).compactMap(RemoteApp.init(rawValue:))
    guard !found.isEmpty else { return "TeamViewer, AnyDesk, Chrome Remote Desktop, Windows Remote Desktop, VNC…" }
    return "\(found.map(\.label).joined(separator: ", ")) \(found.count == 1 ? "is" : "are") on \(node.name)."
  }
}

private struct Choice: View {
  var title: String
  var symbol: String
  var detail: String
  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Label(title, systemImage: symbol).font(.body.weight(.medium))
      Text(detail).font(.footnote).foregroundStyle(.secondary)
    }.foregroundStyle(.primary)
  }
}

/** One way in: the app, the device's ID or address in it, Copy, and Open where the app has a link. */
private struct RemoteRow: View {
  var label: String
  var value: String
  var copy: String
  var link: URL?
  var note: String?
  var onChange: (() -> Void)?
  var onRemove: (() -> Void)?
  @State private var copied = false

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(label).font(.caption).foregroundStyle(.secondary)
      Text(value).font(.title3.monospacedDigit()).textSelection(.enabled)
      HStack {
        Button(copied ? "Copied" : "Copy") {
          UIPasteboard.general.string = copy
          copied = true
          Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
        }.buttonStyle(.bordered)
        if let link { Button("Open") { UIApplication.shared.open(link) }.primaryButton().controlSize(.regular) }
        Spacer()
        if onChange != nil || onRemove != nil {
          Menu {
            if let onChange { Button("Change", action: onChange) }
            if let onRemove { Button("Remove", role: .destructive, action: onRemove) }
          } label: { Image(systemName: "ellipsis").padding(8) }
            .accessibilityLabel("More for \(label)")
        }
      }
      if let note { Text(note).font(.footnote).foregroundStyle(.secondary) }
    }.padding(.vertical, 4)
  }
}

private struct CopyLine: View {
  var text: String
  @State private var copied = false
  var body: some View {
    HStack {
      Text(text).font(.callout.monospaced()).textSelection(.enabled)
      Spacer()
      Button(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc") {
        UIPasteboard.general.string = text
        copied = true
        Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
      }.labelStyle(.iconOnly).buttonStyle(.borderless)
    }
  }
}

/** Which app, and the device's ID, address or link in it. Apps found on the device come first. */
private struct OwnAppForm: View {
  @Environment(Store.self) private var store
  var node: AgentNode
  var current: OwnRemoteDesktop?
  var onDone: () -> Void
  @State private var app: RemoteApp = .teamviewer
  @State private var value = ""
  @State private var name = ""
  @State private var loaded = false
  @State private var action = FormAction()
  private var found: [RemoteApp] { (node.capabilities?.remoteApps ?? []).compactMap(RemoteApp.init(rawValue:)) }

  var body: some View {
    Group {
      Picker("App", selection: $app) {
        ForEach(RemoteApp.ordered(found: node.capabilities?.remoteApps)) { a in
          Text(found.contains(a) ? "\(a.label) (on \(node.name))" : a.label).tag(a)
        }
      }
      if app == .other { TextField("Its name", text: $name, prompt: Text("Parsec")) }
      TextField(fieldLabel, text: $value, prompt: Text(placeholder))
        .textInputAutocapitalization(.never).autocorrectionDisabled()
        .keyboardType(app.field == .link ? .URL : .asciiCapable)
        .onChange(of: value) { action.error = nil }
        .accessibilityIdentifier("remote-value")
      if app == .chrome { Text("From remotedesktop.google.com/access, or leave it at that page.").font(.footnote).foregroundStyle(.secondary) }
      Text("Only you see this. Keep the app's password in your password manager; Wisp never asks for it.").font(.footnote).foregroundStyle(.secondary)
      InlineError(error: action.error)
      HStack {
        Button("Save", action: save).primaryButton().controlSize(.regular).disabled(action.busy || value.trimmed.isEmpty)
        Button("Cancel", action: onDone).buttonStyle(.bordered).disabled(action.busy)
      }
    }.onAppear {
      guard !loaded else { return }
      loaded = true
      app = current?.app ?? RemoteApp.ordered(found: node.capabilities?.remoteApps)[0]
      value = current?.value ?? ""; name = current?.name ?? ""
    }
  }

  private var fieldLabel: String {
    switch app.field {
    case .id: "Its ID"
    case .address: "Computer name or address"
    case .link: "Link"
    }
  }

  private var placeholder: String {
    if app == .chrome { return "https://remotedesktop.google.com/access" }
    switch app.field {
    case .id: return "123 456 789"
    case .address: return "shop-pc.local or 192.168.1.20"
    case .link: return "https://…"
    }
  }

  private func save() {
    let remote = OwnRemoteDesktop(app: app, typed: value, name: name)
    if let problem = remote.problem { action.error = problem; return }
    action.run {
      try await store.setRemoteDesktop(node.id, remote)
      onDone()
    }
  }
}

