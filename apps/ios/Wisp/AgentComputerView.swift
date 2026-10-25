import SwiftUI

/** The computer a new or imported agent gets: a new VM or screen on its device, one that exists, or none. */
enum ComputerChoice: Hashable {
  case vm, screen, existing(String), later, headless

  /** Follow what the device does for agents; otherwise reuse a shared computer first. Your own screen is only the default on your own device set to let agents use it. */
  static func initial(for node: AgentNode?, computers: [Computer]) -> ComputerChoice {
    if node?.role == "headless" { return .headless }
    if node?.role == "screen", node?.mine == true {
      if let screen = computers.first(where: { $0.kind == "device" && $0.nodeId == node?.id }) { return .existing(screen.id) }
      if node?.capabilities?.screen?.ok == true { return .screen }
    }
    if let shared = computers.first(where: { $0.kind == "vm" && $0.nodeId == node?.id }) ?? computers.first(where: { $0.kind == "orgo" }) { return .existing(shared.id) }
    if node?.capabilities?.vm?.ok == true { return .vm }
    return .later
  }

  /** Make the chosen computer if it's new, and return its id; nil for none. */
  @MainActor func resolve(nodeId: String, agentName: String, store: Store) async throws -> String? {
    switch self {
    case .existing(let id): return id
    case .vm: return try await store.createComputer(["kind": AnyEncodable("vm"), "nodeId": AnyEncodable(nodeId), "name": AnyEncodable("\(agentName)'s desk")]).id
    case .screen: return try await store.createComputer(["kind": AnyEncodable("device"), "nodeId": AnyEncodable(nodeId)]).id
    case .later, .headless: return nil
    }
  }

  /** Whether the agent will live inside a VM on its device. */
  func vmOnDevice(_ nodeId: String, computers: [Computer]) -> Bool {
    switch self {
    case .vm: return true
    case .existing(let id): return computers.contains { $0.id == id && $0.kind == "vm" && $0.nodeId == nodeId }
    default: return false
    }
  }
}

/** A short list of ways to give an agent a computer on a device, for choosing before it exists. */
struct ComputerChoicePicker: View {
  @Environment(Store.self) private var store
  @Binding var choice: ComputerChoice
  var node: AgentNode?

  var body: some View {
    Picker("Computer", selection: $choice) {
      if node?.capabilities?.vm?.ok == true { Text("A new VM on \(node?.name ?? "the device")").tag(ComputerChoice.vm) }
      if node?.mine == true, node?.capabilities?.screen?.ok == true, !store.computers.contains(where: { $0.kind == "device" && $0.nodeId == node?.id }) {
        Text("Your own screen").tag(ComputerChoice.screen)
      }
      ForEach(store.computers) { Text($0.name).tag(ComputerChoice.existing($0.id)) }
      Text("Pick later").tag(ComputerChoice.later)
      Text("Headless (no computer)").tag(ComputerChoice.headless)
    }
  }
}

/**
 * Which computer an agent sees and uses: switch to another, make a quick VM, use your own screen
 * or go headless; and where its harness runs (inside the VM, or directly on the device).
 */
struct AgentComputerView: View {
  @Environment(Store.self) private var store
  var agent: Agent
  @State private var harness: HarnessState?
  @State private var harnessError: String?
  @State private var confirmingHeadless = false
  @State private var computerRoute: String?
  @State private var busyKey: String?
  @State private var action = FormAction()

  private var current: Agent { store.agent(agent.id) ?? agent }
  private var computer: Computer? { store.computers.first { $0.id == current.computerId } }
  private var device: AgentNode? { store.nodes.first { $0.id == current.nodeId } }
  private var headless: Bool { computer == nil && current.settings?.headless == true }
  private var others: [Computer] { store.computers.filter { $0.id != current.computerId } }
  private var label: String { HarnessChoice.label(current.harness) }

  var body: some View {
    Form {
      Section {
        if let computer {
          NavigationLink { ComputerDetail(computerId: computer.id) } label: {
            VStack(alignment: .leading, spacing: 3) {
              Text(computer.name).font(.headline)
              Text(kindText(computer)).font(.caption).foregroundStyle(.secondary)
            }
          }
          let sharing = store.agents.filter { computer.id == $0.computerId && $0.id != current.id }
          if !sharing.isEmpty { Text("Shared with " + sharing.map { "@\($0.handle)" }.joined(separator: ", ")).font(.footnote).foregroundStyle(.secondary) }
        } else {
          Text(status).font(.subheadline).foregroundStyle(current.computerId != nil || headless ? Color.secondary : Color.orange)
        }
      } header: { Text("Computer") } footer: {
        Text("The computer @\(current.handle) works on: it opens apps and websites, signs in once and stays signed in, and keeps its files there. Agents that share one share its files, browser and sign-ins.")
      }

      if device != nil { runsWhere }

      if store.canManage {
        Section(computer == nil ? "Give it" : "Switch to") {
          if let device, device.capabilities?.vm?.ok == true {
            option("vm", "A new VM on \(device.name)", "Its own desktop with Google Chrome. Doesn't touch your screen.", icon: "macwindow") { try await quickVM(device) }
          }
          if let device, device.mine == true {
            let blocked = device.capabilities?.screen?.ok == false || others.contains { $0.kind == "device" && $0.nodeId == device.id } || computer?.kind == "device"
            option("screen", "Your own screen", screenNote(device), icon: "lock.display", disabled: blocked) { try await quickScreen(device) }
          }
          ForEach(others) { c in
            option(c.id, c.name, otherNote(c), icon: c.kind == "orgo" ? "cloud" : c.kind == "vm" ? "macwindow" : "laptopcomputer") { try await assign(c) }
          }
          if !headless {
            Button("Run it headless instead", systemImage: "eye.slash", role: .destructive) { confirmingHeadless = true }
              .disabled(action.busy)
          }
        }
        if device == nil { Section { Text("Give it a device first (under Device) to put a VM or your screen on.").font(.footnote).foregroundStyle(.secondary) } }
        Section { InlineError(error: action.error) }
      }
    }
    .navigationTitle("Computer")
    .navigationBarTitleDisplayMode(.inline)
    .task(id: "\(current.computerId ?? "")|\(current.settings?.runIn ?? "")|\(current.nodeId ?? "")") {
      await store.refreshComputers()
      await loadHarness()
    }
    .navigationDestination(item: $computerRoute) { ComputerDetail(computerId: $0) }
    .confirmationDialog("Run @\(current.handle) headless?", isPresented: $confirmingHeadless, titleVisibility: .visible) {
      Button("Run headless", role: .destructive) {
        action.run { try await store.updateAgent(current.id, ["computerId": .null, "settings": AnyEncodable(["headless": true])]); await store.refreshComputers() }
      }
    } message: { Text("It won't be able to see or use a screen: no websites, no apps, only its harness's own tools.") }
  }

  // MARK: where the harness runs

  @ViewBuilder private var runsWhere: some View {
    if harnessRunsOnDevice(current.harness), let device {
      Section {
        if harnessError != nil {
          InlineError(error: harnessError)
        } else if let harness {
          if !harness.possible {
            Text("Directly on \(device.name), where it can reach that device's files. " + (harnessRunsInVM(current.harness) ? "Give it a VM on \(device.name) to run it inside that instead." : "\(label) doesn't come with Wisp's VM yet, so it runs on the device."))
              .font(.subheadline).foregroundStyle(.secondary)
          } else {
            place("Inside its computer", "Recommended. Its shell, files and browser all stay in the VM, so it can't touch the device, and anyone can ask it for things.", icon: "macwindow", on: harness.inComputer) { try await setRunIn("computer") }
            place("On \(device.name)", "It can reach \(device.name)'s files and its own sign-in there. Only \(device.mine == true ? "you" : (device.ownerName ?? "the device's owner")) can ask it for things.", icon: "laptopcomputer", on: !harness.inComputer) { try await setRunIn("device") }
            if harness.inComputer, harness.signedIn == false {
              Text("\(label) isn't signed in on its computer yet. Sign in once: a terminal opens on its screen and you finish there.").font(.footnote)
              if store.canManage {
                Button("Sign in to \(label)", systemImage: "key") {
                  action.run { computerRoute = try await store.signInAgent(current.id) }
                }.disabled(action.busy)
              }
            } else if harness.inComputer, harness.signedIn == true {
              Label("\(label) is signed in on its computer.", systemImage: "checkmark.circle").font(.footnote).foregroundStyle(.green)
            }
          }
        } else {
          ProgressView()
        }
      } header: { Text("Where \(label) runs") }
    }
  }

  private func place(_ title: String, _ body: String, icon: String, on: Bool, _ work: @escaping @MainActor () async throws -> Void) -> some View {
    Button {
      guard !on, store.canManage else { return }
      action.run { try await work() }
    } label: {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: on ? "checkmark.circle.fill" : icon).foregroundStyle(on ? Color.accentColor : .secondary).frame(width: 24)
        VStack(alignment: .leading, spacing: 3) {
          Text(title).foregroundStyle(.primary)
          Text(body).font(.caption).foregroundStyle(.secondary)
        }
        Spacer(minLength: 0)
      }.contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(action.busy || !store.canManage)
    .accessibilityAddTraits(on ? .isSelected : [])
  }

  // MARK: options

  private func option(_ key: String, _ title: String, _ body: String, icon: String, disabled: Bool = false, _ work: @escaping @MainActor () async throws -> Void) -> some View {
    Button {
      action.run {
        busyKey = key
        defer { busyKey = nil }
        try await work()
      }
    } label: {
      HStack(alignment: .top, spacing: 12) {
        if busyKey == key { ProgressView().frame(width: 24) } else { Image(systemName: icon).foregroundStyle(.secondary).frame(width: 24) }
        VStack(alignment: .leading, spacing: 3) {
          Text(title).foregroundStyle(.primary)
          Text(body).font(.caption).foregroundStyle(.secondary)
        }
        Spacer(minLength: 0)
      }.contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(disabled || action.busy)
  }

  private func quickVM(_ device: AgentNode) async throws {
    let made = try await store.createComputer(["kind": AnyEncodable("vm"), "nodeId": AnyEncodable(device.id), "name": AnyEncodable("\(current.name)'s desk"), "cpus": AnyEncodable(2), "memoryGb": AnyEncodable(4)])
    // a harness that comes with the VM moves in with it, unless someone already chose where it runs
    var fields: Fields = ["computerId": AnyEncodable(made.id)]
    if harnessRunsInVM(current.harness), current.settings?.runIn == nil { fields["settings"] = AnyEncodable(["runIn": "computer"]) }
    try await store.updateAgent(current.id, fields)
  }

  private func quickScreen(_ device: AgentNode) async throws {
    let made = try await store.createComputer(["kind": AnyEncodable("device"), "nodeId": AnyEncodable(device.id)])
    try await assign(made)
  }

  private func assign(_ computer: Computer) async throws {
    try await store.updateAgent(current.id, ["computerId": AnyEncodable(computer.id)])
    await store.refreshComputers()
  }

  private func setRunIn(_ runIn: String) async throws {
    try await store.updateAgent(current.id, ["settings": AnyEncodable(["runIn": runIn])])
    await loadHarness()
  }

  private func loadHarness() async {
    guard harnessRunsOnDevice(current.harness), current.nodeId != nil else { harness = nil; return }
    do { harness = try await store.harnessState(current.id); harnessError = nil }
    catch { harnessError = error.localizedDescription }
  }

  // MARK: words

  private var status: String {
    if current.computerId != nil { return "@\(current.handle) uses \(device?.ownerName ?? "someone")'s own screen, which only they can see." }
    if headless { return "@\(current.handle) runs headless: it can't see or use a screen. Give it a computer below to change that." }
    return "@\(current.handle) doesn't have a computer yet, so it can't use apps or websites. Pick one below."
  }

  private func kindText(_ c: Computer) -> String {
    let name = store.nodes.first { $0.id == c.nodeId }?.name ?? "a device"
    switch c.kind {
    case "vm": return "VM on \(name)"
    case "device": return "Your own screen on \(name)"
    default: return "Cloud computer"
    }
  }

  private func otherNote(_ c: Computer) -> String {
    let users = store.agents.filter { $0.computerId == c.id }.map { "@\($0.handle)" }
    return kindText(c) + (users.isEmpty ? "" : " · used by " + users.joined(separator: ", "))
  }

  private func screenNote(_ device: AgentNode) -> String {
    if device.capabilities?.screen?.off == true { return "Off. Turn it on at \(device.name) with: wisp node screen on" }
    if device.capabilities?.screen?.ok == false { return device.capabilities?.screen?.detail ?? "Not available on this device." }
    return "It runs on this computer and only does things you ask. For apps that only live on your computer."
  }
}
