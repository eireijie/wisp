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
          if store.isOwner { Section { NavigationLink("Another computer running Wisp") { JoinInviteView() } } footer: { Text("Make a join link to paste on a computer that already has Wisp.") } }
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
