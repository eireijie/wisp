import SwiftUI

struct AddAgent: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var onCreated: (Agent) -> Void
  @State private var step = 0
  @State private var name = ""
  @State private var handle = ""
  @State private var harness = "claude-code"
  @State private var template: String = ""
  @State private var instructions = ""
  @State private var nodeId = ""
  @State private var computerId = ""
  @State private var headless = false
  @State private var model = ""
  @State private var action = FormAction()

  private var finalHandle: String { handle.isEmpty ? ManagementText.handle(name) : handle }
  private var valid: Bool {
    !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && name.count <= 80 &&
    finalHandle.range(of: "^[a-z][a-z0-9-]{0,31}$", options: .regularExpression) != nil &&
    !store.agents.contains { $0.handle == finalHandle }
  }
  private var choices: [HarnessChoice] {
    let custom = Set(store.nodes.filter(\.usable).flatMap { $0.harnesses ?? [] }.map(\.id).filter { $0.hasPrefix("acp:") })
    return HarnessChoice.all.filter { $0.id != "custom" } + custom.sorted().map {
      HarnessChoice(id: $0, label: HarnessChoice.label($0), blurb: "Available on a connected device", account: "", protocolName: "acp")
    } + HarnessChoice.all.filter { $0.id == "custom" }
  }
  private var selectedHarness: HarnessChoice? { choices.first { $0.id == harness } }
  private var external: Bool { selectedHarness?.protocolName == "mcp" }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Text("\(["Name", "Harness", "Configure"][step]) · \(step + 1) of 3").font(.caption).foregroundStyle(.secondary)
        }
        if step == 0 { nameStep }
        if step == 1 { harnessStep }
        if step == 2 { configureStep }
        Section { InlineError(error: action.error) }
      }
      .navigationTitle("Add agent")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(step == 0 ? "Cancel" : "Back") { if step == 0 { dismiss() } else { step -= 1 } }.disabled(action.busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(step == 2 ? "Add agent" : "Next") {
            if step < 2 { step += 1 } else { create() }
          }.disabled(!valid || action.busy || instructions.count > 20000 || model.count > 100)
        }
      }
      .task {
        do {
          try await store.refreshManagement()
          let usable = store.nodes.filter(\.usable)
          nodeId = usable.first { $0.online }?.id ?? usable.first?.id ?? ""
          headless = store.nodes.first { $0.id == nodeId }?.role == "headless"
        } catch { action.error = error.localizedDescription }
      }
      .onChange(of: handle) { _, value in handle = ManagementText.handle(value) }
      .interactiveDismissDisabled(action.busy)
    }
  }

  private var nameStep: some View {
    Group {
      Section {
        GhostView(look: nil, seed: finalHandle.isEmpty ? "new-agent" : finalHandle, size: 96).frame(maxWidth: .infinity)
        Text(store.simple ? "Name your helper" : "Who’s joining?").font(.title2.bold())
        Text("A name first. Their setup comes next.").foregroundStyle(.secondary)
        TextField("Agent name (e.g. Darnold)", text: $name)
        Text("@\(finalHandle.isEmpty ? "your-agent" : finalHandle)").font(.caption).foregroundStyle(.secondary)
        TechnicalDetails(title: "More options") {
          TextField("Handle", text: $handle).textInputAutocapitalization(.never).autocorrectionDisabled()
          Text("@\(finalHandle)").font(.caption).foregroundStyle(.secondary)
        }
        if store.agents.contains(where: { $0.handle == finalHandle }) {
          Text("@\(finalHandle) is already taken. Choose another name or use an available handle.").font(.caption).foregroundStyle(.red)
          Button("Use an available handle") {
            let base = ManagementText.handle(name)
            var number = 2
            var candidate = String(base.prefix(28)) + "-\(number)"
            while store.agents.contains(where: { $0.handle == candidate }) {
              number += 1
              candidate = String(base.prefix(28)) + "-\(number)"
            }
            handle = candidate
          }
        }
        if !name.isEmpty && finalHandle.isEmpty { Text("Choose a handle starting with a lowercase letter under More options.").font(.caption).foregroundStyle(.red) }
      }
      Section("Give it a job") {
        Button("Start from scratch") { template = ""; instructions = "" }
        ForEach(AgentTemplate.all.filter { !store.simple || ["chief", "inbox", "research", template].contains($0.id) }) { templateChoice($0) }
        if store.simple {
          DisclosureGroup("More jobs") {
            ForEach(AgentTemplate.all.filter { !["chief", "inbox", "research", template].contains($0.id) }) { templateChoice($0) }
          }
        }
      }
    }
  }

  private func templateChoice(_ item: AgentTemplate) -> some View {
    Button {
      template = item.id
      instructions = item.instructions
    } label: {
      HStack {
        VStack(alignment: .leading, spacing: 4) {
          Text("\(item.emoji) \(item.name)").foregroundStyle(.primary)
          Text(item.blurb).font(.caption).foregroundStyle(.secondary)
        }
        Spacer()
        if template == item.id { Image(systemName: "checkmark") }
      }
    }
  }

  private var harnessStep: some View {
    Group {
      Section {
        Text(store.simple ? "Which AI do you use?" : "Choose a harness").font(.title2.bold())
        Text("A harness is the AI program that does the work. You need an account with it; it may charge separately.").foregroundStyle(.secondary)
        ForEach(choices.filter { !store.simple || ["claude-code", "codex", "gemini", harness].contains($0.id) }) { harnessChoice($0) }
      }
      if store.simple {
        Section {
          DisclosureGroup("More harnesses") {
            ForEach(choices.filter { !["claude-code", "codex", "gemini", harness].contains($0.id) }) { harnessChoice($0) }
          }
        }
      }
    }
  }

  private func harnessChoice(_ choice: HarnessChoice) -> some View {
    Button { harness = choice.id } label: {
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 6) {
          Text(choice.label).font(.headline).foregroundStyle(.primary)
          Text(choice.blurb)
          Text(choice.account)
          Text(choice.protocolName == "acp" ? "Can't use connected apps like Gmail yet" : "Can use connected apps like Gmail")
        }.font(.caption).foregroundStyle(.secondary)
        Spacer()
        if harness == choice.id { Image(systemName: "checkmark.circle.fill") }
      }.padding(.vertical, 6)
    }
  }

  private var configureStep: some View {
    Group {
      Section("Device") {
        Picker("Device", selection: $nodeId) {
          Text("No device").tag("")
          ForEach(store.nodes.filter(\.usable)) { Text("\($0.name) · \($0.online ? "online" : "offline")").tag($0.id) }
        }.disabled(external)
        if external {
          Text("Set up where it already runs. It connects to Warren through the API or warren-mcp.").font(.footnote).foregroundStyle(.secondary)
        } else if nodeId.isEmpty {
          Text("It can't answer @mentions until it has a device.").font(.footnote).foregroundStyle(.secondary)
        } else if let node = store.nodes.first(where: { $0.id == nodeId }), !(node.harnesses ?? []).contains(where: { $0.id == harness }) {
          Text("\(HarnessChoice.label(harness)) isn't installed on \(node.name). Install it and sign in on that device.").font(.footnote).foregroundStyle(.secondary)
        }
      }
      if !external {
        Section("Where should it work?") {
          Picker("Computer", selection: $computerId) {
            Text("Decide later").tag("")
            ForEach(store.computers) { Text($0.name).tag($0.id) }
          }
          TechnicalDetails(title: "More options") {
            Toggle("No desktop (answers only)", isOn: $headless).disabled(!computerId.isEmpty)
          }
        }
      }
      Section("Model") {
        TextField("Harness default", text: $model).textInputAutocapitalization(.never).autocorrectionDisabled()
        Text("Leave blank to let the harness pick. You can choose from the device's models on the agent's page.").font(.caption).foregroundStyle(.secondary)
      }
      Section("Instructions") { TextField("What should it do?", text: $instructions, axis: .vertical).lineLimit(4...12) }
      Section {
        TechnicalDetails(title: "More options") {
          TextField("Handle", text: $handle).textInputAutocapitalization(.never).autocorrectionDisabled()
          Text("Mentions use @\(finalHandle).").font(.caption).foregroundStyle(.secondary)
        }
      }
    }
    .onChange(of: computerId) { _, id in
      if !id.isEmpty { headless = false }
      if let computer = store.computers.first(where: { $0.id == id }), computer.kind == "vm", let node = computer.nodeId,
         store.nodes.contains(where: { $0.id == node && $0.usable }) { nodeId = node }
    }
  }

  private func create() {
    action.run {
      var settings: Fields = [:]
      if !external && headless { settings["headless"] = AnyEncodable(true) }
      if !external, let computer = store.computers.first(where: { $0.id == computerId }), computer.kind == "vm", computer.nodeId == nodeId,
         ["claude-code", "codex", "hermes", "kimi"].contains(harness) { settings["runIn"] = AnyEncodable("computer") }
      var fields: Fields = [
        "name": AnyEncodable(name.trimmingCharacters(in: .whitespacesAndNewlines)), "handle": AnyEncodable(finalHandle),
        "harness": AnyEncodable(harness), "nodeId": .nullable(external ? "" : nodeId), "model": .nullable(model),
        "computerId": .nullable(external ? "" : computerId), "instructions": AnyEncodable(instructions), "settings": AnyEncodable(settings)
      ]
      if let template = AgentTemplate.all.first(where: { $0.id == template }) {
        fields["soul"] = AnyEncodable(agentSoul(name: name, handle: finalHandle, voice: template.voice))
      }
      let agent = try await store.createAgent(fields)
      dismiss()
      onCreated(agent)
    }
  }
}

func agentSoul(name: String, handle: String, voice: String) -> String {
  """
  # \(name)

  Who @\(handle) is. Read at the start of every conversation. Keep it short: every line should change how you behave.

  ## Personality
  - Curious, direct, and kind.
  - Has opinions and shares them, then defers to the person who decides.

  ## Voice
  - \(voice)

  ## Values
  - Tell the truth, including "I don't know" and "I was wrong".
  - Leave things better documented than you found them: write what you learn to memory.

  ## Boundaries
  - Ask before doing anything that's hard to undo.
  - Never pretend a task is done when it isn't.

  """
}
