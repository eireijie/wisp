import SwiftUI

/**
 * Computer (agent-Computer.dc.html): where the agent works (your own screen, its own computer,
 * another computer, none), the harness's sign-in, and Open computer. Choosing none asks first
 * (agent-Headless.dc.html). Below: which device runs it and where its harness runs.
 */
struct AgentComputerView: View {
  @Environment(Store.self) private var store
  var agent: Agent
  @State private var harness: HarnessState?
  @State private var harnessError: String?
  @State private var confirmingHeadless = false
  @State private var computerRoute: String?
  @State private var pickingOther = false
  @State private var busyKey: String?
  @State private var action = FormAction()

  private var current: Agent { store.agent(agent.id) ?? agent }
  private var computer: Computer? { store.computers.first { $0.id == current.computerId } }
  private var device: AgentNode? { store.nodes.first { $0.id == current.nodeId } }
  private var others: [Computer] { store.computers.filter { $0.id != current.computerId } }
  private var label: String { HarnessChoice.label(current.harness) }
  private var place: AgentLine.Place { AgentLine.place(agent: current, computer: computer) }

  var body: some View {
    AgentFrame(title: "Computer", subtitle: current.name) {
      CardCaption("Where it works")
      CardGroup {
        if let device, device.mine == true {
          let blocked = device.capabilities?.screen?.ok == false && place != .screen
          option("screen", "Your own screen", device.capabilities?.screen?.off == true ? "Off. Turn it on at \(device.name) with: wisp node screen on" : "\(device.name) · this computer",
                 icon: "lock.display", on: place == .screen, disabled: blocked || !store.canManage) {
            if let screen = store.computers.first(where: { $0.kind == "device" && $0.nodeId == device.id }) { try await assign(screen) } else { try await quickScreen(device) }
          }
        }
        option("own", "Its own computer", ownNote, icon: "macwindow", on: place == .own, disabled: (!(device?.capabilities?.vm?.ok == true) && place != .own) || !store.canManage) {
          if let device { try await quickVM(device) }
        }
        Button { pickingOther = true } label: {
          HStack(spacing: 12) {
            rowIcon("laptopcomputer")
            VStack(alignment: .leading, spacing: 2) {
              Text("Another computer…").font(.system(size: 15)).foregroundStyle(Palette.text)
              Text(place == .other ? (computer?.name ?? "Pick from your devices") : "Pick from your devices").font(.system(size: 13)).foregroundStyle(Palette.faint)
            }
            Spacer(minLength: 8)
            if place == .other { Radio(on: true) } else { Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.faint) }
          }
          .padding(.horizontal, 18).frame(minHeight: 60).contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(!store.canManage || action.busy).accessibilityIdentifier("computer-other")
        option("none", "No computer", "It can't answer @mentions until it has one", icon: "eye.slash", on: place == .none, disabled: !store.canManage) {
          confirmingHeadless = true
        }
      }
      .disabled(action.busy)
      if let computer, place == .other {
        let sharing = store.agents.filter { computer.id == $0.computerId && $0.id != current.id }
        if !sharing.isEmpty { CardCaption("Shared with " + sharing.map { "@\($0.handle)" }.joined(separator: ", ")) }
      }
      signIn
      if let computer, store.canViewComputers {
        PillButton(title: "Open computer", id: "computer-open") { computerRoute = computer.id }
      }
      runsOn
      runsWhere
      AgentError(text: action.error)
    }
    .navigationDestination(item: $computerRoute) { ComputerDetail(computerId: $0) }
    .navigationDestination(isPresented: $pickingOther) { otherPage }
    .sheet(isPresented: $confirmingHeadless) {
      AgentConfirm(agent: current, title: "Run @\(current.handle) headless?", message: "Without a computer it can still think and write, but it can't use apps or a screen.",
                   confirm: "Run headless", busy: action.busy, error: action.error) {
        action.run {
          try await store.updateAgent(current.id, ["computerId": .null, "settings": AnyEncodable(["headless": true])])
          await store.refreshComputers()
          confirmingHeadless = false
        }
      }
    }
    .task(id: "\(current.computerId ?? "")|\(current.settings?.runIn ?? "")|\(current.nodeId ?? "")") {
      await store.refreshComputers()
      await loadHarness()
    }
  }

  private var ownNote: String {
    if place == .own, let computer {
      let state = AgentLine.computer(agent: current, computer: computer)
      return "\(computer.name) · \(state == "Ready" ? "always ready" : state.lowercased())"
    }
    if let device { return device.capabilities?.vm?.ok == true ? "A new desktop on \(device.name), just for \(current.name)" : "Not available on \(device.name)" }
    return "Needs a device first"
  }

  private func option(_ key: String, _ title: String, _ body: String, icon: String, on: Bool, disabled: Bool, _ work: @escaping @MainActor () async throws -> Void) -> some View {
    ChoiceRow(title: title, subtitle: body, selected: on, action: {
      guard !on else { return }
      action.run {
        busyKey = key
        defer { busyKey = nil }
        try await work()
      }
    }, leading: { if busyKey == key { ProgressView().frame(width: 24) } else { rowIcon(icon) } })
    .disabled(disabled || action.busy)
    .opacity(disabled ? 0.5 : 1)
    .accessibilityIdentifier("computer-\(key)")
  }

  // MARK: sign-in

  @ViewBuilder private var signIn: some View {
    if harnessRunsOnDevice(current.harness), let harness, harness.inComputer {
      CardCaption("Sign-in")
      CardGroup {
        HStack(spacing: 12) {
          VStack(alignment: .leading, spacing: 2) {
            Text("\(label) account").font(.system(size: 15)).foregroundStyle(Palette.text)
            Text(harness.signedIn == true ? "Signed in on its computer" : harness.signedIn == false ? "Not signed in yet" : "Unknown").font(.system(size: 13)).foregroundStyle(Palette.faint)
          }
          Spacer(minLength: 8)
          Text(harness.signedIn == true ? "Signed in" : harness.signedIn == false ? "Not signed in" : "Unknown")
            .font(.system(size: 12, weight: .semibold)).foregroundStyle(harness.signedIn == true ? Palette.green : Palette.muted)
            .padding(.horizontal, 10).frame(height: 24).background(Capsule().fill((harness.signedIn == true ? Palette.green : Palette.muted).opacity(0.16)))
        }
        .padding(.horizontal, 18).frame(minHeight: 60)
        if store.canManage {
          Button { action.run { computerRoute = try await store.signInAgent(current.id) } } label: {
            RowLabel(title: harness.signedIn == true ? "Sign in again" : "Sign in to \(label)", leading: { rowIcon("key") })
          }.buttonStyle(.plain).disabled(action.busy).accessibilityIdentifier("computer-sign-in")
        }
      }
    }
  }

  // MARK: device and harness

  @ViewBuilder private var runsOn: some View {
    if store.canManage {
      CardCaption("Runs on device")
      CardGroup {
        ChoiceRow(title: "No device", subtitle: "It can't answer @mentions until it has one", selected: current.nodeId == nil) {
          guard current.nodeId != nil else { return }
          action.run { try await store.updateAgent(current.id, ["nodeId": .null]) }
        }
        ForEach(store.nodes.filter { $0.usable || $0.id == current.nodeId }) { node in
          ChoiceRow(title: node.name, subtitle: node.online ? "Online" : "Offline", selected: current.nodeId == node.id) {
            guard current.nodeId != node.id else { return }
            action.run { try await store.updateAgent(current.id, ["nodeId": AnyEncodable(node.id)]) }
          }
        }
      }.disabled(action.busy)
    }
  }

  @ViewBuilder private var runsWhere: some View {
    if harnessRunsOnDevice(current.harness), let device {
      CardCaption("Where \(label) runs")
      if harnessError != nil {
        AgentError(text: harnessError)
      } else if let harness {
        if !harness.possible {
          AgentCard {
            Text("Directly on \(device.name), where it can reach that device's files. " + (harnessRunsInVM(current.harness) ? "Give it a computer on \(device.name) to run it inside that instead." : "\(label) doesn't come with Wisp's VM yet, so it runs on the device."))
              .font(.system(size: 15)).foregroundStyle(Palette.muted)
          }
        } else {
          CardGroup {
            ChoiceRow(title: "Inside its computer", subtitle: "Recommended. Its shell, files and browser stay in the VM, so it can't touch the device, and anyone can ask it for things.", selected: harness.inComputer) {
              guard !harness.inComputer else { return }
              action.run { try await setRunIn("computer") }
            }
            ChoiceRow(title: "On \(device.name)", subtitle: "It can reach \(device.name)'s files and its own sign-in there. Only \(device.mine == true ? "you" : (device.ownerName ?? "the device's owner")) can ask it for things.", selected: !harness.inComputer) {
              guard harness.inComputer else { return }
              action.run { try await setRunIn("device") }
            }
          }.disabled(!store.canManage || action.busy)
        }
      } else {
        ProgressView().frame(maxWidth: .infinity)
      }
    }
  }

  // MARK: another computer

  private var otherPage: some View {
    AgentFrame(title: "Another computer", subtitle: current.name) {
      if others.isEmpty {
        AgentCard { Text("No other computers yet. Add one under Computers.").font(.system(size: 15)).foregroundStyle(Palette.muted) }
      } else {
        CardGroup {
          ForEach(others) { c in
            ChoiceRow(title: c.name, subtitle: otherNote(c), selected: false) {
              action.run { try await assign(c); pickingOther = false }
            }
          }
        }.disabled(action.busy)
      }
      AgentError(text: action.error)
    }
  }

  // MARK: actions

  private func quickVM(_ device: AgentNode) async throws {
    // its own desktop already? use it; otherwise make one for it
    if let own = store.computers.first(where: { $0.kind != "device" && $0.agents == [current.id] && $0.id != current.computerId }) { try await assign(own); return }
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
}
