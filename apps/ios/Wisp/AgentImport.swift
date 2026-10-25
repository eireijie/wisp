import SwiftUI

/**
 * Bring in an agent that already lives on one of your devices (a Hermes profile, an OpenClaw
 * workspace, a Claude Code subagent): scan for saved setups, pick one, and it comes in with its
 * personality, instructions and notes.
 */
struct ImportAgent: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var onImported: (Agent) -> Void
  @State private var devices: [ScannedDevice] = []
  @State private var scanning = false
  @State private var picked: Pick?
  @State private var loadError: String?
  @State private var scanTask: Task<Void, Never>?

  struct Pick: Identifiable, Hashable {
    var device: ScannedDevice
    var found: DiscoveredAgent
    var id: String { "\(device.id):\(found.key)" }
  }

  private var found: [Pick] {
    devices.filter(\.usable).flatMap { device in (device.discovered ?? []).map { Pick(device: device, found: $0) } }
  }
  private var anyOnline: Bool { devices.contains { $0.usable && $0.online } }

  var body: some View {
    NavigationStack {
      List {
        Section {
          if found.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
              Text(scanning ? "Looking…" : "No saved setups found yet").font(.headline)
              Text("Wisp checks known configuration folders on your connected devices. Custom locations may not appear; it doesn't search for running processes.")
                .font(.footnote).foregroundStyle(.secondary)
              if !anyOnline && !scanning { Text("Connect a device first to find its saved agent setups.").font(.footnote).foregroundStyle(.secondary) }
            }
          }
          ForEach(found) { pick in
            let here = AgentImportLogic.alreadyHere(pick.found, on: pick.device, agents: store.agents)
            Button { picked = pick } label: {
              HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                  Text(pick.found.name).foregroundStyle(.primary)
                  Text("\(HarnessChoice.label(pick.found.harness)) on \(pick.device.name)").font(.caption).foregroundStyle(.secondary)
                  if !pick.found.summary.isEmpty { Text(pick.found.summary).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                }
                Spacer()
                if here { Text("already here").font(.caption).foregroundStyle(.secondary) } else { Image(systemName: "chevron.right").font(.footnote).foregroundStyle(.tertiary) }
              }
            }.disabled(here)
          }
          InlineError(error: loadError)
        } footer: {
          Text("Imports personality, instructions and supported notes. Skills stay on the original device.")
        }
        Section {
          Button(scanning ? "Looking…" : found.isEmpty ? "Look again" : "Look again", systemImage: "magnifyingglass") { scan() }
            .disabled(scanning || !anyOnline)
        }
      }
      .navigationTitle("Find an existing agent")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
      .navigationDestination(item: $picked) { pick in
        ImportDetails(pick: pick) { agent in dismiss(); onImported(agent) }
      }
      .task {
        do { devices = try await store.scannedDevices(); try await store.refreshManagement() }
        catch { loadError = error.localizedDescription }
        if found.isEmpty, anyOnline { scan() }
      }
      .onDisappear { scanTask?.cancel() }
    }
  }

  /** Devices answer a moment after they're asked, so look at what they found a few times. */
  private func scan() {
    scanning = true
    loadError = nil
    scanTask = Task {
      defer { scanning = false }
      do {
        try await store.scanDevicesForAgents()
        for _ in 0..<4 {
          try await Task.sleep(for: .seconds(1))
          devices = try await store.scannedDevices()
        }
      } catch is CancellationError {
      } catch { loadError = error.localizedDescription }
    }
  }
}

private struct ImportDetails: View {
  @Environment(Store.self) private var store
  var pick: ImportAgent.Pick
  var onDone: (Agent) -> Void
  @State private var handle = ""
  @State private var choice = ComputerChoice.later
  @State private var action = FormAction()

  private var node: AgentNode? { store.nodes.first { $0.id == pick.device.id } }
  private var taken: Bool { store.agents.contains { $0.handle == handle } }
  private var valid: Bool { handle.range(of: "^[a-z][a-z0-9-]{0,31}$", options: .regularExpression) != nil && !taken }

  var body: some View {
    Form {
      Section {
        LabeledContent("Name", value: pick.found.name)
        LabeledContent("Runs on", value: HarnessChoice.label(pick.found.harness))
        LabeledContent("Found on", value: pick.device.name)
        if !pick.found.summary.isEmpty { Text(pick.found.summary).font(.footnote).foregroundStyle(.secondary) }
      }
      Section {
        TextField("Handle", text: $handle).textInputAutocapitalization(.never).autocorrectionDisabled()
        if taken { Text("@\(handle) is taken.").font(.footnote).foregroundStyle(.red) }
      } footer: { Text("Its soul, instructions and notes are copied into Wisp's memory.\n\(pick.found.path)") }
      Section {
        ComputerChoicePicker(choice: $choice, node: node)
      } footer: {
        Text(harnessRunsInVM(pick.found.harness) ? "Given a VM on \(pick.device.name), it runs inside it." : "")
      }
      Section {
        InlineError(error: action.error)
        Button(action.busy ? "Bringing in…" : "Bring in \(pick.found.name)", systemImage: "square.and.arrow.down") { bringIn() }
          .disabled(!valid || action.busy)
      }
    }
    .navigationTitle("Bring in")
    .navigationBarTitleDisplayMode(.inline)
    .task {
      handle = AgentImportLogic.freeHandle(pick.found.name, taken: store.agents.map(\.handle))
      choice = ComputerChoice.initial(for: node, computers: store.computers)
    }
  }

  private func bringIn() {
    action.run {
      let computerId = try await choice.resolve(nodeId: pick.device.id, agentName: pick.found.name, store: store)
      var fields: Fields = [
        "nodeId": AnyEncodable(pick.device.id), "key": AnyEncodable(pick.found.key), "handle": AnyEncodable(handle),
        "computerId": computerId.map { AnyEncodable($0) } ?? .null, "headless": AnyEncodable(choice == .headless),
      ]
      if choice.vmOnDevice(pick.device.id, computers: store.computers) || computerId.map({ id in store.computers.contains { $0.id == id && $0.kind == "vm" && $0.nodeId == pick.device.id } }) == true,
         harnessRunsInVM(pick.found.harness) {
        fields["runIn"] = AnyEncodable("computer")
      }
      let agent = try await store.importAgent(fields)
      onDone(agent)
    }
  }
}
