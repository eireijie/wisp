import SwiftUI

struct DevicesView: View {
  @Environment(Store.self) private var store
  @State private var adding = false
  @State private var action = FormAction()
  var body: some View {
    List {
      InlineError(error: action.error)
      if store.nodes.isEmpty { Text("Connect a device").font(.headline); Text("A device is a computer running Wisp. Agents run on it.").foregroundStyle(.secondary) }
      ForEach(store.nodes) { node in
        NavigationLink { DeviceDetail(node: node) } label: {
          HStack { Image(systemName: "desktopcomputer"); VStack(alignment: .leading) { Text(node.name); Text(node.online ? "Connected" : node.lastSeen == nil ? "Never connected" : "Offline").font(.caption).foregroundStyle(node.online ? .green : .secondary) } }
        }
      }
    }.sectionScreen("Devices", id: "devices")
      .toolbar { if store.canManage { Button("Add a device", systemImage: "plus") { adding = true } } }
      .sheet(isPresented: $adding) { AddDeviceView() }
      .task {
        var backoff = DevicePollingBackoff()
        while !Task.isCancelled {
          do {
            try await store.refreshNodes()
            action.error = nil
            backoff.succeeded()
          } catch {
            if Task.isCancelled { return }
            action.error = error.localizedDescription
            backoff.failed()
          }
          do { try await Task.sleep(for: .seconds(backoff.interval)) } catch { return }
        }
      }
      .refreshable { do { try await store.refreshNodes() } catch { action.error = error.localizedDescription } }
  }
}

struct DeviceDetail: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var node: AgentNode
  @State private var removing = false
  @State private var installing: String?
  @State private var output: String?
  @State private var action = FormAction()
  private var current: AgentNode { store.nodes.first { $0.id == node.id } ?? node }
  private let installable = ["claude-code", "codex", "gemini", "opencode", "kimi", "qwen", "openclaw"]
  var body: some View {
    List {
      Section {
        LabeledContent("Name", value: current.name)
        Text("The hub doesn't support renaming an existing device.").font(.footnote).foregroundStyle(.secondary)
        LabeledContent("Status", value: current.online ? "Connected" : "Offline")
        LabeledContent("Connected by", value: current.ownerName ?? "Nobody")
        if current.paused == true { Text("Paused") }
        if !current.online { Text("Open Wisp on this computer to bring it back.") }
        Toggle("Let others in the organization add agents and VMs here", isOn: Binding(get: { current.shared == true }, set: { on in action.run { try await store.updateNode(current.id, ["shared": AnyEncodable(on)]) } })).disabled(!store.canManage || current.mine != true || action.busy)
        Picker("What this device does for agents", selection: Binding(get: { current.role ?? "" }, set: { role in action.run { try await store.updateNode(current.id, ["role": .nullable(role)]) } })) {
          Text("Not chosen").tag(""); Text("Runs agents' VMs").tag("vms"); Text("Lets its agents use its screen").tag("screen"); Text("Runs agents headless").tag("headless")
        }.disabled(!store.canManage || current.mine != true || action.busy)
      }
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
      if store.canManage && (current.mine == true || store.isOwner) { Button("Remove device", role: .destructive) { removing = true }.disabled(action.busy) }
    }.sectionScreen(current.name, id: "device")
      .confirmationDialog("Remove this device and its computers? It will need a new token to reconnect.", isPresented: $removing, titleVisibility: .visible) {
        Button("Remove device", role: .destructive) { action.run { try await store.deleteNode(current.id); dismiss() } }
      }
      .confirmationDialog("Install this harness on \(current.name)?", isPresented: Binding(get: { installing != nil }, set: { if !$0 { installing = nil } }), titleVisibility: .visible) {
        Button("Install") { if let harness = installing { action.run { output = try await store.installHarness(harness, node: current.id) } } }
      }
  }
}

struct AddDeviceView: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var name = ""
  @State private var token: String?
  @State private var action = FormAction()
  private var commands: [(String, String)] {
    guard let token, let hub = store.api?.base.absoluteString else { return [] }
    let origin = hub.hasSuffix("/") ? String(hub.dropLast()) : hub
    let shName = "'" + name.replacingOccurrences(of: "'", with: "'\\''") + "'"
    let psName = "'" + name.replacingOccurrences(of: "'", with: "''") + "'"
    return [("Mac / Linux", "curl -fsSL \(origin)/install.sh | bash -s -- --hub \(origin) --token \(token) --name \(shName)"), ("Windows", "& ([scriptblock]::Create((irm \(origin)/install.ps1))) -Hub \(origin) -Token \(token) -Name \(psName)"), ("Already installed", "wisp node start --hub \(origin) --token \(token) --name \(shName)")]
  }
  var body: some View {
    NavigationStack {
      Form {
        if token == nil {
          TextField("Device name", text: $name)
          Button("Add a device") { action.run { token = try await store.addDevice(name.trimmed) } }.disabled(action.busy || name.trimmed.isEmpty || name.count > 80)
        } else {
          Text("On \(name), run this once. It installs Wisp if it isn't there yet and keeps the device connected.")
          ForEach(commands, id: \.0) { title, command in Section(title) { Text(command).font(.caption.monospaced()).textSelection(.enabled); ShareLink("Share instructions", item: command) } }
        }
        InlineError(error: action.error)
      }.navigationTitle(token == nil ? "Add a device" : "Start the device")
        .toolbar { Button("Done") { dismiss() }.disabled(action.busy) }
        .interactiveDismissDisabled(action.busy)
    }
  }
}

struct DevicePollingBackoff {
  private(set) var interval = 5
  mutating func succeeded() { interval = 5 }
  mutating func failed() { interval = min(interval * 2, 30) }
}
