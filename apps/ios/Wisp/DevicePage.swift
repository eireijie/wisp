import SwiftUI
import UIKit

/**
 * One device: the agents that run on it and what each works on, its own screen, how its owner
 * reaches it from anywhere, and the rest of its settings folded away (apps/web/src/views/DevicePage.tsx).
 * Only agents that run on a device can use its screen.
 */
struct DeviceDetail: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var node: AgentNode
  @State private var removing = false
  @State private var more = false
  @State private var action = FormAction()
  @State private var watching: WatchRoute?
  private var current: AgentNode { store.nodes.first { $0.id == node.id } ?? node }
  private var mine: Bool { current.mine == true }

  var body: some View {
    List {
      Section {
        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: 8) {
            Text(current.name).font(.headline)
            if current.paused == true { DeviceTag(text: "Paused") }
          }
          Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
          if current.paused == true { Text("Paused at the device. Resume it there with: wisp node resume").font(.footnote).foregroundStyle(.secondary) }
        }.accessibilityElement(children: .combine)
        if !current.online { Text("Open Wisp on this computer to bring it back.").font(.footnote).foregroundStyle(.secondary) }
      }
      AgentsHere(node: current)
      if mine && store.canViewComputers { YourScreen(node: current) { watching = WatchRoute(id: $0) } }
      if mine && store.features.remoteDesktop { RemoteDesktopSection(node: current) }
      Section {
        DisclosureGroup("More", isExpanded: $more) {
          Toggle("Let others in the organization add agents and VMs here", isOn: Binding(get: { current.shared == true }, set: { on in action.run { try await store.updateNode(current.id, ["shared": AnyEncodable(on)]) } })).disabled(!store.canManage || !mine || action.busy)
          Picker("What this device does for agents", selection: Binding(get: { current.role ?? "" }, set: { role in action.run { try await store.updateNode(current.id, ["role": .nullable(role)]) } })) {
            Text("Not chosen").tag(""); Text("Runs agents' VMs").tag("vms"); Text("Lets its agents use its screen").tag("screen"); Text("Runs agents headless").tag("headless")
          }.disabled(!store.canManage || !mine || action.busy)
          NavigationLink("Harnesses") { DeviceHarnesses(node: current) }
          if store.isOwner && current.online { Button("Update Wisp") { action.run { try await store.updateDeviceWisp(current.id) } }.disabled(action.busy) }
          if store.canManage && (mine || store.isOwner) { Button("Remove device", role: .destructive) { removing = true }.disabled(action.busy) }
          if mine { Text("At \(current.name): wisp node screen code picks a new screen code, and wisp node pause stops everything there until wisp node resume.").font(.footnote).foregroundStyle(.secondary) }
        }.accessibilityIdentifier("device-more")
      }
      InlineError(error: action.error)
    }.sectionScreen(current.name, id: "device")
      .navigationDestination(item: $watching) { ComputerDetail(computerId: $0.id) }
      .task { await store.refreshComputers() }
      .refreshable { do { try await store.refreshNodes() } catch { action.error = error.localizedDescription }; await store.refreshComputers() }
      .confirmationDialog("Remove \(current.name)? Its token stops working.", isPresented: $removing, titleVisibility: .visible) {
        Button("Remove device", role: .destructive) { action.run { try await store.deleteNode(current.id); dismiss() } }
      }
  }

  private var subtitle: String {
    var parts: [String] = []
    if let caps = current.capabilities { parts.append(caps.osName) }
    parts.append(current.online ? "Online" : "Offline")
    if !mine, let owner = current.ownerName { parts.append("\(owner)'s") }
    return parts.joined(separator: " · ")
  }
}

private struct DeviceTag: View {
  var text: String
  var body: some View {
    Text(text).font(.caption.weight(.medium)).padding(.horizontal, 7).padding(.vertical, 2)
      .background(Capsule().strokeBorder(Color.secondary.opacity(0.5)))
      .foregroundStyle(.secondary)
  }
}

/** The agents whose harness runs on this device, and what each one works on. */
private struct AgentsHere: View {
  @Environment(Store.self) private var store
  var node: AgentNode
  @State private var action = FormAction()
  @State private var headless: Agent?
  private var agents: [Agent] { store.agents.filter { $0.nodeId == node.id } }

  var body: some View {
    Section {
      if agents.isEmpty { Text("No agents here yet.").foregroundStyle(.secondary) }
      ForEach(agents) { agent in
        if node.mine == true && store.canManage {
          Picker(selection: Binding(get: { worksOn(agent).tag }, set: { pick(WorksOn(tag: $0), agent) })) {
            ForEach(options(for: agent), id: \.0) { tag, label in Text(label).tag(tag) }
          } label: { AgentLabel(agent: agent) }
            .pickerStyle(.menu)
            .disabled(action.busy)
            .accessibilityIdentifier("works-on-\(agent.id)")
        } else {
          LabeledContent { Text(worksOnLabel(agent)) } label: { AgentLabel(agent: agent) }
        }
      }
      InlineError(error: action.error)
    } header: { Text("Agents on this computer") } footer: {
      Text("Only agents that run here can use this computer\(node.mine == true ? ", and only for things you ask" : "").")
    }
    .confirmationDialog("Run \(headless?.name ?? "it") without a computer? It won't be able to use apps or websites.", isPresented: Binding(get: { headless != nil }, set: { if !$0 { headless = nil } }), titleVisibility: .visible, presenting: headless) { agent in
      Button("No computer") { set(.none, agent) }
    }
  }

  private var screen: Computer? { store.computers.first { $0.kind == "device" && $0.nodeId == node.id } }

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

private struct AgentLabel: View {
  var agent: Agent
  var body: some View {
    HStack(spacing: 8) {
      Text(agent.name)
      if agent.status == .busy { Text("Working").font(.caption).foregroundStyle(.secondary) }
    }
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
        Image(systemName: caps?.code != nil ? "lock" : "display").foregroundStyle(.secondary).frame(width: 28)
        VStack(alignment: .leading, spacing: 2) {
          Text(status)
          if let detail { Text(detail).font(.footnote).foregroundStyle(.secondary) }
          if caps?.off == true && node.online { Text("Turn it on at \(node.name): wisp node screen on").font(.footnote).foregroundStyle(.secondary).textSelection(.enabled) }
        }
      }
      if caps?.ok == true && node.online {
        Button("Watch", systemImage: "eye") {
          action.run { onWatch(try await store.deviceScreen(node.id).id) }
        }.disabled(action.busy).accessibilityIdentifier("device-watch")
      }
      InlineError(error: action.error)
    }
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
        if let link { Button("Open") { UIApplication.shared.open(link) }.buttonStyle(.borderedProminent) }
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
        Button("Save", action: save).buttonStyle(.borderedProminent).disabled(action.busy || value.trimmed.isEmpty)
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

/** The harnesses on the device, and installing more there. */
private struct DeviceHarnesses: View {
  @Environment(Store.self) private var store
  var node: AgentNode
  @State private var installing: String?
  @State private var output: String?
  @State private var action = FormAction()
  private var current: AgentNode { store.nodes.first { $0.id == node.id } ?? node }
  private let installable = ["claude-code", "codex", "gemini", "opencode", "kimi", "qwen", "openclaw"]

  var body: some View {
    List {
      Section("On this device") {
        ForEach(current.harnesses ?? [], id: \.id) { harness in LabeledContent(HarnessChoice.label(harness.id), value: harness.version ?? "Installed") }
        if store.canManage && current.usable { Button("Refresh") { action.run { try await store.refreshDevice(current.id) } }.disabled(!current.online || action.busy) }
      }
      if store.canManage && current.mine == true {
        Section("Install a harness") {
          ForEach(installable.filter { id in !(current.harnesses ?? []).contains { $0.id == id } }, id: \.self) { id in
            Button("Install \(HarnessChoice.label(id))") { installing = id }.disabled(!current.online || action.busy)
          }
          Text("Other harnesses use their own installer on the computer.").font(.footnote).foregroundStyle(.secondary)
        }
      }
      if let output { Text(output).font(.caption).textSelection(.enabled) }
      if action.busy { ProgressView("Working on the device…") }
      InlineError(error: action.error)
    }.sectionScreen("Harnesses", id: "device-harnesses")
      .confirmationDialog("Install this harness on \(current.name)?", isPresented: Binding(get: { installing != nil }, set: { if !$0 { installing = nil } }), titleVisibility: .visible) {
        Button("Install") { if let harness = installing { action.run { output = try await store.installHarness(harness, node: current.id) } } }
      }
  }
}
