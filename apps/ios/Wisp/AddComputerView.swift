import SwiftUI

/** Add a computer: a VM on one of your devices, your own screen, or an Orgo cloud computer. */
struct AddComputerView: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var onCreated: (Computer) -> Void

  @State private var kind: ComputerKind = .vm
  @State private var nodeId = ""
  @State private var name = ""
  @State private var size: ComputerSize = .medium
  @State private var existingOrgo = ""
  @State private var orgoConfigured: Bool?
  @State private var busy = false
  @State private var error: String?
  @State private var more = false

  private var usable: [AgentNode] { ComputerAdd.usable(store.nodes) }
  private var mine: [AgentNode] { store.nodes.filter { $0.mine == true } }
  private var choices: [AgentNode] { kind == .device ? mine : usable }
  private var device: AgentNode? { choices.first { $0.id == nodeId } }
  /** Simple mode keeps Orgo and the size under "More options". */
  private var showAll: Bool { !store.simple || more }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          kindRow(.vm, "macbook.and.iphone", "A VM on one of your devices", "A separate desktop with a web browser, a terminal and files. Your own computer stays untouched.", note: ComputerAdd.vmNote(usable))
          if !mine.isEmpty {
            kindRow(.device, "lock", "Your own screen", "Only you can see it. Agents on this device can use it for things you ask.")
          }
          if showAll { orgoRow }
        } header: {
          Text("What kind?")
        }

        if kind != .orgo {
          Section("Device") {
            if choices.isEmpty {
              Text("Connect a device first, in Devices.").foregroundStyle(.secondary)
            } else {
              Picker("Device", selection: $nodeId) {
                ForEach(choices) { d in Text("\(d.name) (\(d.capabilities?.osName ?? "computer"), \(d.online ? "online" : "offline"))").tag(d.id) }
              }
            }
            if let note = deviceNote { Text(note.0).font(.footnote).foregroundStyle(note.1 ? Color.secondary : Color.red) }
          }
        }

        Section("Name") {
          TextField(namePlaceholder, text: $name).autocorrectionDisabled()
        }

        if kind != .device, showAll {
          if kind == .orgo {
            Section {
              TextField("Optional", text: $existingOrgo).textInputAutocapitalization(.never).autocorrectionDisabled()
            } header: {
              Text("Or one you already have in Orgo")
            } footer: {
              Text("Its ID (a UUID) from the Orgo dashboard. Leave empty to make a new one.")
            }
          }
          if existingOrgo.trimmingCharacters(in: .whitespaces).isEmpty {
            Section("Size") {
              Picker("Size", selection: $size) {
                ForEach(ComputerSize.allCases) { Text($0.label(for: kind)).tag($0) }
              }
              .pickerStyle(.inline)
              .labelsHidden()
            }
          }
        }

        if store.simple, !more {
          Section {
            Button("More options (size, cloud computer)") { more = true }
          }
        }

        if kind == .vm {
          Section { Text("The first VM on a device builds its image, which takes a few minutes. Its home folder keeps sign-ins and files between restarts.").font(.footnote).foregroundStyle(.secondary) }
        }
        if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
      }
      .navigationTitle("Add a computer")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button { create() } label: { if busy { ProgressView() } else { Text("Add") } }
            .disabled(!canAdd)
        }
      }
      .task {
        if store.nodes.isEmpty { try? await store.refreshNodes() }
        pickDevice()
        if let s = try? await store.computerSettings() { orgoConfigured = s.orgo.configured } else { orgoConfigured = false }
      }
      .onChange(of: kind) { _, _ in pickDevice() }
    }
  }

  private var namePlaceholder: String {
    switch kind {
    case .device: device?.name ?? "My screen"
    case .vm: "Research desk"
    case .orgo: "Cloud desk"
    }
  }

  private var canAdd: Bool {
    if busy { return false }
    if kind == .orgo { return orgoConfigured == true }
    return !nodeId.isEmpty
  }

  /** What the picked device says about running a VM or sharing its screen; the Bool is whether it's fine. */
  private var deviceNote: (String, Bool)? {
    guard let caps = device?.capabilities else { return nil }
    if kind == .device {
      if caps.screen?.off == true { return ("\(device?.name ?? "That device")'s screen is off. Only you can turn it on, at that computer: wisp node screen on", false) }
      guard let s = caps.screen, let detail = s.detail, !detail.isEmpty else { return nil }
      return (detail, s.ok)
    }
    guard let v = caps.vm, let detail = v.detail, !detail.isEmpty else { return nil }
    return (detail, v.ok)
  }

  private func pickDevice() {
    if choices.contains(where: { $0.id == nodeId }) { return }
    nodeId = (choices.first { $0.online } ?? choices.first)?.id ?? ""
  }

  @ViewBuilder private var orgoRow: some View {
    kindRow(.orgo, "cloud", "An Orgo cloud computer", "A Linux desktop in the cloud from orgo.ai that keeps running when your devices are off.",
      note: orgoConfigured == nil ? "Checking your Orgo connection…" : orgoConfigured == false ? "Add your Orgo API key on Wisp on your computer (Settings → Computers) first." : nil,
      disabled: orgoConfigured != true)
  }

  private func kindRow(_ k: ComputerKind, _ symbol: String, _ title: String, _ body: String, note: String? = nil, disabled: Bool = false) -> some View {
    Button { kind = k } label: {
      HStack(alignment: .top, spacing: 12) {
        IconTile(symbol: symbol, color: .secondary, size: 36)
        VStack(alignment: .leading, spacing: 2) {
          Text(title).font(.body.weight(.medium)).foregroundStyle(.primary)
          Text(body).font(.footnote).foregroundStyle(.secondary)
          if let note { Text(note).font(.footnote).foregroundStyle(.orange) }
        }
        Spacer(minLength: 0)
        Image(systemName: kind == k ? "checkmark.circle.fill" : "circle").foregroundStyle(kind == k ? Color.accentColor : Color.secondary.opacity(0.5))
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(disabled)
    .opacity(disabled ? 0.6 : 1)
    .accessibilityAddTraits(kind == k ? .isSelected : [])
  }

  private func create() {
    busy = true
    error = nil
    let request = NewComputer.make(kind: kind, nodeId: nodeId, deviceName: device?.name, name: name, size: size, existingOrgo: existingOrgo)
    Task {
      defer { busy = false }
      do {
        let c = try await store.addComputer(request)
        await store.refreshComputers()
        dismiss()
        onCreated(c)
      } catch { self.error = error.localizedDescription }
    }
  }
}
