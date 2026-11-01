import SwiftUI

/** Bring an agent in (agent-Bring.dc.html): find one on a device, or invite one that runs somewhere else. */
struct AgentBring: View {
  var onDone: (Agent) -> Void

  var body: some View {
    AgentFrame(title: "Bring an agent in") {
      CardGroup {
        NavigationLink { ImportAgent(onImported: onDone) } label: {
          RowLabel(title: "Find on a connected device", leading: { rowIcon("magnifyingglass") })
        }.buttonStyle(.plain).accessibilityIdentifier("bring-find")
        NavigationLink { AgentInvite(onDone: onDone) } label: {
          RowLabel(title: "Invite an outside agent", leading: { rowIcon("person.badge.plus") })
        }.buttonStyle(.plain).accessibilityIdentifier("bring-invite")
      }
      CardCaption("Neither option copies skills. Once connected, it can save selected notes to memory itself.")
    }
  }
}

/**
 * Import an agent (agent-Import.dc.html): an agent that already lives on one of your devices (a
 * Hermes profile, an OpenClaw workspace, a Claude Code subagent). Scan for saved setups, pick
 * one, and it comes in with its personality, instructions and notes.
 */
struct ImportAgent: View {
  @Environment(Store.self) private var store
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

  private var anyOnline: Bool { devices.contains { $0.usable && $0.online } }
  private var usable: [ScannedDevice] { devices.filter(\.usable) }

  var body: some View {
    AgentFrame(title: "Import an agent") {
      if usable.allSatisfy({ ($0.discovered ?? []).isEmpty }) {
        AgentCard {
          Text(scanning ? "Looking…" : "No saved setups found yet").font(.system(size: 15)).foregroundStyle(Palette.text)
          if !anyOnline && !scanning { Text("Connect a device first to find its saved agent setups.").font(.system(size: 13)).foregroundStyle(Palette.faint) }
        }
      }
      ForEach(usable.filter { !($0.discovered ?? []).isEmpty }) { device in
        CardCaption("Found on \(device.name)")
        CardGroup {
          ForEach(device.discovered ?? []) { found in
            let here = AgentImportLogic.alreadyHere(found, on: device, agents: store.agents)
            HStack(spacing: 12) {
              VStack(alignment: .leading, spacing: 2) {
                Text(found.name).font(.system(size: 15)).foregroundStyle(Palette.text)
                Text(here ? "\(HarnessChoice.label(found.harness)) · already here" : [HarnessChoice.label(found.harness), found.summary].filter { !$0.isEmpty }.joined(separator: " · "))
                  .font(.system(size: 13)).foregroundStyle(Palette.faint).lineLimit(2)
              }
              Spacer(minLength: 8)
              if here {
                Text("Already here").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.muted)
                  .padding(.horizontal, 10).frame(height: 24).background(Capsule().fill(Palette.muted.opacity(0.16)))
              } else {
                Button { picked = Pick(device: device, found: found) } label: {
                  Text("Bring in").font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.text)
                    .padding(.horizontal, 14).frame(height: 32).background(Capsule().fill(Color(light: 0xE3E3EA, dark: 0x2E2E32)))
                }.buttonStyle(.plain).accessibilityIdentifier("import-bring")
              }
            }
            .padding(.horizontal, 18).padding(.vertical, 8).frame(minHeight: 64)
          }
        }
      }
      AgentError(text: loadError)
      CardCaption("Wisp keeps the agent's own files where they are and adds a handle to it. Imports personality, instructions and supported notes; skills stay on the original device.")
      PillButton(title: scanning ? "Looking…" : "Look again", kind: .secondary, id: "import-scan") { scan() }.disabled(scanning || !anyOnline)
    }
    .navigationDestination(item: $picked) { pick in ImportDetails(pick: pick, onDone: onImported) }
    .task {
      do { devices = try await store.scannedDevices(); try await store.refreshManagement() }
      catch { loadError = error.localizedDescription }
      if usable.allSatisfy({ ($0.discovered ?? []).isEmpty }), anyOnline { scan() }
    }
    .onDisappear { scanTask?.cancel() }
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
  private var finalHandle: String { ManagementText.handle(handle) }
  private var taken: Bool { store.agents.contains { $0.handle == finalHandle } }
  private var valid: Bool { finalHandle.range(of: "^[a-z][a-z0-9-]{0,31}$", options: .regularExpression) != nil && !taken }

  var body: some View {
    AgentFrame(title: "Bring in", subtitle: pick.found.name) {
      CardGroup {
        RowLabel(title: "Name", value: pick.found.name, chevron: false)
        RowLabel(title: "Runs on", value: HarnessChoice.label(pick.found.harness), chevron: false)
        RowLabel(title: "Found on", value: pick.device.name, chevron: false)
      }
      if !pick.found.summary.isEmpty { CardCaption(pick.found.summary) }
      FieldCard(label: "Handle", text: Binding(get: { handle.isEmpty ? "" : "@" + handle }, set: { handle = ManagementText.typingHandle($0.replacingOccurrences(of: "@", with: "")) }), prompt: "@handle", lowercase: true)
      if taken { AgentError(text: "@\(handle) is taken.") }
      CardCaption("Its personality, instructions and notes are copied into Wisp's memory. \(pick.found.path)")
      CardCaption("Computer")
      CardGroup {
        if node?.capabilities?.vm?.ok == true {
          ChoiceRow(title: "A new computer on \(node?.name ?? "the device")", selected: choice == .vm) { choice = .vm }
        }
        if node?.mine == true, node?.capabilities?.screen?.ok == true, !store.computers.contains(where: { $0.kind == "device" && $0.nodeId == node?.id }) {
          ChoiceRow(title: "Your own screen", selected: choice == .screen) { choice = .screen }
        }
        ForEach(store.computers) { c in ChoiceRow(title: c.name, selected: choice == .existing(c.id)) { choice = .existing(c.id) } }
        ChoiceRow(title: "Pick later", selected: choice == .later) { choice = .later }
        ChoiceRow(title: "Headless (no computer)", selected: choice == .headless) { choice = .headless }
      }
      if harnessRunsInVM(pick.found.harness) { CardCaption("Given a computer on \(pick.device.name), it runs inside it.") }
      AgentError(text: action.error)
      PillButton(title: "Bring in \(pick.found.name)", busy: action.busy, id: "import-confirm") { bringIn() }.disabled(!valid || action.busy)
    }
    .task {
      handle = AgentImportLogic.freeHandle(pick.found.name, taken: store.agents.map(\.handle))
      choice = ComputerChoice.initial(for: node, computers: store.computers)
    }
  }

  private func bringIn() {
    action.run {
      let computerId = try await choice.resolve(nodeId: pick.device.id, agentName: pick.found.name, store: store)
      var fields: Fields = [
        "nodeId": AnyEncodable(pick.device.id), "key": AnyEncodable(pick.found.key), "handle": AnyEncodable(finalHandle),
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

/**
 * Invite an outside agent (agent-Invite.dc.html): a name and the kind of session, then the setup to
 * paste into its MCP settings. It shows up as a normal agent.
 */
struct AgentInvite: View {
  @Environment(Store.self) private var store
  var onDone: (Agent) -> Void
  @State private var name = ""
  @State private var harness = "claude-code"
  @State private var made: (agent: Agent, token: String)?
  @State private var existing = false
  @State private var look = GhostLook.newAgent()
  @State private var action = FormAction()

  private var handle: String { AgentImportLogic.freeHandle(name, taken: store.agents.map(\.handle)) }
  private let kinds: [(id: String, label: String)] = [("claude-code", "Claude Code"), ("codex", "Codex"), ("grok", "Grok"), ("custom", "Other")]

  var body: some View {
    AgentFrame(title: "Invite an outside agent") {
      if let made {
        done(made.agent, made.token)
      } else {
        FieldCard(label: "Name", text: $name, prompt: "Outside agent").accessibilityIdentifier("invite-name")
        CardCaption("Connect any MCP-capable session with an invitation. It shows up here as a normal agent.")
        FlowLayout(spacing: 8) {
          ForEach(kinds, id: \.id) { kind in AgentChip(title: kind.label, on: harness == kind.id) { harness = kind.id } }
        }
        CardGroup {
          Button { existing.toggle() } label: {
            RowLabel(title: "Add to an existing session", chevron: false)
              .overlay(alignment: .trailing) { Image(systemName: existing ? "chevron.up" : "chevron.down").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.faint).padding(.trailing, 18) }
          }.buttonStyle(.plain)
        }
        AgentError(text: action.error)
        PillButton(title: "Create invitation", busy: action.busy, id: "invite-create") { create() }
          .disabled(name.trimmed.isEmpty || name.count > 80 || action.busy)
      }
    }
  }

  private func done(_ agent: Agent, _ token: String) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 14) {
        GhostView(look: look, seed: agent.handle, size: 56, animate: false).frame(width: 56, height: 56)
        VStack(alignment: .leading, spacing: 2) {
          Text("Invite \(agent.name) to Wisp").font(.system(size: 16, weight: .semibold)).foregroundStyle(Palette.text)
          Text("Add this connection to its existing session.").font(.system(size: 13)).foregroundStyle(Palette.faint)
        }
      }
      ConnectionInstructions(token: token, harness: agent.harness)
      CardCaption("Once connected, ask it to introduce itself in a team and save selected notes with memory_write. Its local profile and skills aren't imported automatically.")
      PillButton(title: "Open agent", id: "invite-open") { onDone(agent) }
    }
  }

  private func create() {
    action.run {
      let fields: Fields = [
        "name": AnyEncodable(name.trimmed), "handle": AnyEncodable(handle), "instructions": AnyEncodable(""),
        // an outside agent connects from wherever it already runs, so it has no device or computer
        "harness": AnyEncodable(harness), "nodeId": .null,
        "settings": AnyEncodable(["appearance": AnyEncodable(look.resolved), "respondTo": AnyEncodable("me")] as Fields),
      ]
      let agent = try await store.createAgent(fields)
      // (if the token can't be made, the agent still exists: its Connect screen makes one)
      if let token = try? await store.createAgentToken(agent.id) { made = (agent, token) } else { onDone(agent) }
    }
  }
}
