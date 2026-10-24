import SwiftUI

/**
 * New agent, on one screen: its look, a name and a job, and where it runs (your defaults unless
 * you customize). Everything else waits under Advanced.
 */
struct AddAgent: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var onCreated: (Agent) -> Void

  // every new agent starts white with a face and outfit of its own, picked once (typing its name doesn't change it)
  @State private var look = GhostLook.newAgent()
  @State private var editingLook = false
  @State private var name = ""
  @State private var does = ""
  @State private var instructions = ""
  @State private var custom = false
  @State private var harness = "claude-code"
  @State private var model = ""
  @State private var computer = "none"
  @State private var computerDraft = AgentComputerDraft()
  @State private var advanced = false
  @State private var handle = ""
  @State private var respondTo = "me"
  @State private var respondPeople: Set<String> = []
  @State private var apps: Set<String> = []
  @State private var skills: Set<String> = []
  @State private var action = FormAction()

  private var finalHandle: String { handle.isEmpty ? ManagementText.handle(name) : handle }
  private var handleTaken: Bool { store.agents.contains { $0.handle == finalHandle } }
  private var valid: Bool {
    !name.trimmed.isEmpty && name.count <= 80 && does.count <= 200 &&
    finalHandle.range(of: "^[a-z][a-z0-9-]{0,31}$", options: .regularExpression) != nil && !handleTaken &&
    instructions.count <= 20000 && model.count <= 200
  }
  private var choices: [HarnessChoice] {
    let custom = Set(store.nodes.filter(\.usable).flatMap { $0.harnesses ?? [] }.map(\.id).filter { $0.hasPrefix("acp:") })
    return HarnessChoice.all.filter { $0.id != "custom" } + custom.sorted().map {
      HarnessChoice(id: $0, label: HarnessChoice.label($0), blurb: "Available on a connected device", account: "", protocolName: "acp")
    } + HarnessChoice.all.filter { $0.id == "custom" }
  }
  private var external: Bool { choices.first { $0.id == harness }?.protocolName == "mcp" }
  /** more than one person here: who the agent answers is a real choice */
  private var askWho: Bool { store.features.invite || store.otherPeople.count > 0 }

  var body: some View {
    NavigationStack {
      Form {
        lookSection
        Section("Name") {
          TextField("Nova", text: $name).textInputAutocapitalization(.words)
          if handleTaken {
            Text("@\(finalHandle) is taken. Pick another name, or change the handle under Advanced.").font(.caption).foregroundStyle(.red)
          }
        }
        Section {
          TextField("Builds and ships websites", text: $does)
        } header: {
          HStack(spacing: 4) { Text("What it does"); Text("· Optional").foregroundStyle(.tertiary) }
        }
        Section("Instructions") {
          TextField("What should it do, and how?", text: $instructions, axis: .vertical).lineLimit(4...12)
        }
        aiSection
        advancedSection
        Section { InlineError(error: action.error) }
      }
      .navigationTitle("New agent")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(action.busy) }
        ToolbarItem(placement: .confirmationAction) {
          Button("Create") { create() }.bold().disabled(!valid || action.busy)
        }
      }
      .task {
        await store.refreshAgentDefaults()
        do { try await store.refreshManagement() } catch { action.error = error.localizedDescription }
        try? await store.refreshSkills()
        try? await store.refreshConnectors()
        harness = store.agentDefaults?.harness ?? "claude-code"
        model = store.agentDefaults?.model ?? ""
        if store.agentDefaults?.computer != "none", let node = store.agentDefaults?.nodeId ?? firstNode { computer = "vm:\(node)" }
      }
      .onChange(of: handle) { _, value in handle = ManagementText.handle(value) }
      .sheet(isPresented: $editingLook) {
        LookEditor(look: $look, name: name, seed: finalHandle)
      }
      .interactiveDismissDisabled(action.busy)
    }
  }

  private var firstNode: String? {
    let usable = store.nodes.filter(\.usable)
    return usable.first { $0.online }?.id ?? usable.first?.id
  }

  // MARK: look

  private var lookSection: some View {
    Section {
      VStack(spacing: 14) {
        GhostView(look: look, seed: finalHandle, size: 96, interactive: true)
          .padding(.top, 8)
        VStack(spacing: 2) {
          Text(name.trimmed.isEmpty ? "New agent" : name.trimmed).font(.title3.weight(.semibold))
          Text("@\(finalHandle.isEmpty ? "handle" : finalHandle)").font(.caption).foregroundStyle(.secondary)
        }
        GhostColors(look: $look)
        HStack(spacing: 10) {
          Button("Shuffle", systemImage: "shuffle") {
            look = GhostLook.shuffled()
          }
          Button("Edit look", systemImage: "paintpalette") { editingLook = true }
        }
        .secondaryButton()
      }
      .frame(maxWidth: .infinity)
      .padding(.bottom, 6)
    } footer: {
      Text("Give it a name and a job. You can change everything later.")
    }
  }

  // MARK: AI and computer

  private var aiSection: some View {
    Section {
      Picker("AI and computer", selection: $custom) {
        Text("Use my defaults").tag(false)
        Text("Customize").tag(true)
      }
      .pickerStyle(.segmented)
      .listRowSeparator(.hidden)
      if custom {
        Picker("Runs on", selection: $harness) {
          ForEach(choices) { Text($0.label).tag($0.id) }
        }
        TextField("Model", text: $model, prompt: Text("Automatic"))
          .textInputAutocapitalization(.never).autocorrectionDisabled()
        if !external {
          Picker("Computer", selection: $computer) {
            ForEach(store.nodes.filter(\.usable)) { Text("New VM on \($0.name)").tag("vm:\($0.id)") }
            ForEach(store.computers) { c in Text("Share \(c.name)").tag("share:\(c.id)") }
            Text("No computer").tag("none")
          }
        } else {
          Text("Set up where it already runs. It connects to Wisp through the API or wisp-mcp.").font(.footnote).foregroundStyle(.secondary)
        }
      } else {
        let summary = store.defaultsSummary
        LabeledContent("AI", value: summary.ai)
        LabeledContent("Computer", value: summary.computer)
        if store.isOwner {
          NavigationLink("Change defaults") { AgentDefaultsView() }
        }
      }
    } header: {
      Text("AI and computer")
    }
  }

  // MARK: advanced

  private var advancedSection: some View {
    Section {
      DisclosureGroup(isExpanded: $advanced) {
        TextField("Handle", text: $handle, prompt: Text(ManagementText.handle(name).isEmpty ? "handle" : ManagementText.handle(name)))
          .textInputAutocapitalization(.never).autocorrectionDisabled()
        if askWho {
          Picker("Answers", selection: $respondTo) {
            Text("Only me").tag("me")
            Text("Anyone").tag("anyone")
            Text("Picked people").tag("people")
          }
          if respondTo == "people" {
            ForEach(store.otherPeople) { person in
              Toggle(person.preferredName ?? person.name, isOn: Binding(
                get: { respondPeople.contains(person.id) },
                set: { if $0 { respondPeople.insert(person.id) } else { respondPeople.remove(person.id) } }))
            }
            if store.otherPeople.isEmpty { Text("Nobody else is here yet.").font(.footnote).foregroundStyle(.secondary) }
          }
        }
        if !store.connectors.isEmpty {
          Menu {
            ForEach(store.connectors) { app in
              Toggle(app.name, isOn: member(app.id, of: $apps))
            }
          } label: {
            LabeledContent("Connected apps", value: summary(apps, names: store.connectors.map { ($0.id, $0.name) }))
          }
        }
        if !store.skills.isEmpty {
          Menu {
            ForEach(store.skills) { skill in
              Toggle(skill.name, isOn: member(skill.id, of: $skills))
            }
          } label: {
            LabeledContent("Skills", value: summary(skills, names: store.skills.map { ($0.id, $0.name) }))
          }
        }
      } label: {
        VStack(alignment: .leading, spacing: 2) {
          Text("Advanced")
          Text(askWho ? "Handle, who it answers, apps and skills" : "Handle, apps and skills").font(.caption).foregroundStyle(.secondary)
        }
      }
    }
  }

  private func member(_ id: String, of set: Binding<Set<String>>) -> Binding<Bool> {
    Binding(get: { set.wrappedValue.contains(id) }, set: { if $0 { set.wrappedValue.insert(id) } else { set.wrappedValue.remove(id) } })
  }

  private func summary(_ ids: Set<String>, names: [(String, String)]) -> String {
    let picked = names.filter { ids.contains($0.0) }.map(\.1)
    return picked.isEmpty ? "None" : picked.count <= 2 ? picked.joined(separator: ", ") : "\(picked.count)"
  }

  // MARK: create

  private func create() {
    action.run {
      var settings: Fields = ["appearance": AnyEncodable(look.resolved), "respondTo": AnyEncodable(askWho ? respondTo : "me")]
      if !does.trimmed.isEmpty { settings["description"] = AnyEncodable(does.trimmed) }
      if askWho && respondTo == "people" { settings["respondPeople"] = AnyEncodable(Array(respondPeople).sorted()) }
      var fields: Fields = [
        "name": AnyEncodable(name.trimmed), "handle": AnyEncodable(finalHandle), "instructions": AnyEncodable(instructions),
      ]
      if custom {
        fields["harness"] = AnyEncodable(harness)
        fields["model"] = .nullable(model.trimmed)
        if external {
          fields["nodeId"] = .null
        } else if computer.hasPrefix("vm:") {
          let node = String(computer.dropFirst(3))
          fields["nodeId"] = AnyEncodable(node)
          fields["computerId"] = AnyEncodable(try await computerDraft.resolveVM(node: node, name: name.trimmed, store: store))
          settings["runIn"] = AnyEncodable("computer")
        } else if computer.hasPrefix("share:"), let c = store.computers.first(where: { $0.id == String(computer.dropFirst(6)) }) {
          fields["computerId"] = AnyEncodable(c.id)
          let node = c.nodeId.flatMap { id in store.nodes.first { $0.id == id && $0.usable }?.id } ?? firstNode
          fields["nodeId"] = .nullable(node ?? "")
          if c.kind == "vm", c.nodeId == node, ["claude-code", "codex", "hermes", "kimi"].contains(harness) { settings["runIn"] = AnyEncodable("computer") }
        } else {
          fields["nodeId"] = .nullable(firstNode ?? "")
          settings["headless"] = AnyEncodable(true)
        }
      } else {
        fields["useDefaults"] = AnyEncodable(true)
        // hubs without agent defaults still need a harness and a device
        if store.agentDefaults == nil {
          fields["harness"] = AnyEncodable("claude-code")
          fields["nodeId"] = .nullable(firstNode ?? "")
        }
      }
      fields["settings"] = AnyEncodable(settings)
      let agent = try await store.createAgent(fields)
      // apps and skills are given to it afterwards; the agent exists either way
      for id in apps {
        guard let app = store.connectors.first(where: { $0.id == id }) else { continue }
        _ = try? await store.saveConnector(id, ["agentIds": AnyEncodable(Array(Set(app.agentIds ?? []).union([agent.id])).sorted())])
      }
      for id in skills {
        guard let skill = store.skills.first(where: { $0.id == id }) else { continue }
        _ = try? await store.saveSkill(id, ["agentIds": AnyEncodable(Array(Set(skill.agentIds ?? []).union([agent.id])).sorted())])
      }
      dismiss()
      onCreated(agent)
    }
  }
}

/** Keep a newly created VM when agent creation fails, so retrying doesn't create another. */
@MainActor
final class AgentComputerDraft {
  private var createdVMs: [String: String] = [:]

  func resolveVM(node: String, name: String, store: Store) async throws -> String {
    if let id = createdVMs[node] { return id }
    let computer: Computer = try await store.fetch {
      try await $0.post("/api/computers", ["kind": "vm", "nodeId": node, "name": "\(name)'s desk"])
    }
    createdVMs[node] = computer.id
    return computer.id
  }
}
