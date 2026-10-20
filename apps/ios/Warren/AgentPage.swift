import SwiftUI

struct AgentPage: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var agent: Agent
  @State private var editingLook = false
  @State private var removing = false
  @State private var chat: Channel?
  @State private var runs: [AgentRun] = []
  @State private var runError: String?
  @State private var action = FormAction()

  private var current: Agent { store.agent(agent.id) ?? agent }
  private var device: AgentNode? { store.nodes.first { $0.id == current.nodeId } }

  var body: some View {
    List {
      Section {
        VStack(spacing: 12) {
          AgentAvatar(agent: current, size: 128, showStatus: false, interactive: true)
            .simultaneousGesture(TapGesture().onEnded { if store.canManage { editingLook = true } })
            .accessibilityLabel("Edit \(current.name)'s look")
            .accessibilityAction { if store.canManage { editingLook = true } }
          Text(current.name).font(.title.bold())
          Text("@\(current.handle)").foregroundStyle(.secondary)
          Text("\(HarnessChoice.label(current.harness)) · \(current.model ?? "Harness default")").font(.subheadline).foregroundStyle(.secondary)
          Label(store.activity[current.id] ?? (current.status == .busy ? "Working" : current.status == .online ? "Online" : "Offline"), systemImage: "circle.fill")
            .font(.caption).foregroundStyle(current.status == .busy ? .blue : current.status == .online ? .green : .secondary)
          if let description = current.settings?.description ?? current.settings?.roleNotes, !description.isEmpty {
            Text(description).font(.subheadline)
          }
          Button("Message", systemImage: "bubble.left") {
            action.run { chat = try await store.dm(with: current) }
          }.primaryButton().disabled(action.busy)
        }.frame(maxWidth: .infinity).padding(.vertical, 12)
      }
      Section {
        if store.canManage {
          NavigationLink("Display name") { AgentEditor(agent: current, panel: .identity) }
        }
        NavigationLink("Personality") { AgentEditor(agent: current, panel: .personality) }
        NavigationLink("Instructions") { AgentEditor(agent: current, panel: .instructions) }
        if store.features.routines { NavigationLink("Routines") { RoutinesView(agent: current) }.accessibilityIdentifier("agent-routines") }
        if store.features.background { NavigationLink("Background") { BackgroundView(agent: current) }.accessibilityIdentifier("agent-background") }
        if store.canManage && (store.features.invite || store.members.count > 1) {
          Picker("Answers", selection: Binding(get: { current.settings?.respondTo ?? "anyone" }, set: { value in
            action.run { try await store.updateAgent(current.id, ["settings": AnyEncodable(["respondTo": value])]) }
          })) {
            Text("Only me").tag("me")
            Text("Anyone").tag("anyone")
            Text("Picked people").tag("people")
          }.disabled(action.busy)
        }
        NavigationLink("Model") { AgentEditor(agent: current, panel: .model) }
        NavigationLink("Device") { AgentEditor(agent: current, panel: .device) }
        if device != nil && store.harnessOnDevice(current) {
          NavigationLink("Who can ask it") { AgentEditor(agent: current, panel: .who) }
        }
      }
      Section("Recent activity") {
        if runs.isEmpty && runError == nil { Text("No activity yet.").foregroundStyle(.secondary) }
        ForEach(runs) { run in
          VStack(alignment: .leading, spacing: 6) {
            HStack {
              Text(run.status.capitalized).font(.caption.bold())
              Spacer()
              if let date = run.createdAt.flatMap(Wire.date) { Text(date, style: .relative).font(.caption).foregroundStyle(.secondary) }
            }
            if let channel = run.channelName { Text("#\(channel)").font(.caption).foregroundStyle(.secondary) }
            if let trigger = run.trigger { Text(trigger).font(.subheadline) }
            if let error = run.hint ?? run.error, !error.isEmpty { Text(error).font(.footnote).foregroundStyle(.red) }
          }
        }
        InlineError(error: runError)
        if runError != nil { Button("Try again") { Task { await loadRuns() } } }
      }
      if store.canManage {
        Section {
          Button("Remove agent", role: .destructive) { removing = true }.disabled(action.busy)
        } footer: { Text("Its memory notes and personality stay in the vault.") }
      }
    }
    .navigationTitle(current.name)
    .navigationBarTitleDisplayMode(.inline)
    .navigationDestination(item: $chat) { ChannelView(channel: $0) }
    .sheet(isPresented: $editingLook) { LookEditor(agent: current) }
    .confirmationDialog("Remove \(current.name) (@\(current.handle))?", isPresented: $removing, titleVisibility: .visible) {
      Button("Remove \(current.name)", role: .destructive) {
        action.run { try await store.deleteAgent(current.id); dismiss() }
      }
    } message: { Text("Its memory notes and personality stay in the vault.") }
    .managementAlert(action)
    .task(id: current.status) { await loadRuns() }
    .task {
      do { try await store.refreshManagement() } catch { action.error = error.localizedDescription }
    }
    .refreshable {
      do { try await store.refreshAgents(); try await store.refreshManagement() } catch { action.error = error.localizedDescription }
      await loadRuns()
    }
    .onChange(of: store.agents.contains { $0.id == agent.id }) { _, exists in if !exists { dismiss() } }
  }

  private func loadRuns() async {
    do { runs = try await store.agentRuns(agent.id); runError = nil }
    catch { runError = error.localizedDescription }
  }
}

enum AgentPanel: String {
  case identity = "Display name", personality = "Personality", instructions = "Instructions", model = "Model", device = "Device", who = "Who can ask it"
}

struct AgentEditor: View {
  @Environment(Store.self) private var store
  var agent: Agent
  var panel: AgentPanel
  @State private var name = ""
  @State private var text = ""
  @State private var savedText = ""
  @State private var role = ""
  @State private var roleNotes = ""
  @State private var savedRole = ""
  @State private var savedRoleNotes = ""
  @State private var model = ""
  @State private var effort = ""
  @State private var fast = false
  @State private var nodeId = ""
  @State private var models: AgentModels?
  @State private var harness: HarnessState?
  @State private var computer: ComputerRoute?
  @State private var loaded = false
  @State private var loadError: String?
  @State private var saved = false
  @State private var action = FormAction()

  private var current: Agent { store.agent(agent.id) ?? agent }
  private var device: AgentNode? { store.nodes.first { $0.id == current.nodeId } }
  private var selectedModel: ModelOption? {
    models?.catalog?.models.first { $0.id == (model.isEmpty ? models?.catalog?.defaultModel : model) }
  }
  private var efforts: [String] { selectedModel?.efforts ?? models?.catalog?.efforts ?? [] }

  var body: some View {
    Form {
      switch panel {
      case .identity: identityFields
      case .personality: personalityFields
      case .instructions: instructionFields
      case .model: modelFields
      case .device: deviceFields
      case .who: whoFields
      }
      Section {
        InlineError(error: loadError)
        if loadError != nil { Button("Try again") { Task { loaded = false; await load() } } }
        InlineError(error: action.error)
        if saved { Text("Saved").foregroundStyle(.secondary) }
        if store.canManage && panel != .who {
          Button(action.busy ? "Saving…" : "Save") { save() }
            .disabled(!loaded || action.busy || name.count > 80 || (panel == .identity && name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) || (panel == .instructions && text.count > 20000) || model.count > 100)
        }
      }
    }
    .navigationTitle(panel.rawValue)
    .navigationBarTitleDisplayMode(.inline)
    .task { await load() }
    .task(id: store.memoryVersion) {
      guard panel == .personality, loaded, text == savedText else { return }
      do { text = try await store.personality(agent.id); savedText = text }
      catch { loadError = error.localizedDescription }
    }
    .onChange(of: current) { old, updated in
      if name == old.name { name = updated.name }
      if panel == .instructions && text == (old.instructions ?? "") { text = updated.instructions ?? "" }
      if role == (old.settings?.role ?? "") { role = updated.settings?.role ?? ""; savedRole = role }
      if roleNotes == (old.settings?.roleNotes ?? "") { roleNotes = updated.settings?.roleNotes ?? ""; savedRoleNotes = roleNotes }
      if model == (old.model ?? "") { model = updated.model ?? "" }
      if effort == (old.settings?.effort ?? "") { effort = updated.settings?.effort ?? "" }
      if fast == (old.settings?.fast ?? false) { fast = updated.settings?.fast ?? false }
      if nodeId == (old.nodeId ?? "") { nodeId = updated.nodeId ?? "" }
    }
    .navigationDestination(item: $computer) { ComputerDetail(computerId: $0.id) }
  }

  private var identityFields: some View {
    Section {
      TextField("Display name", text: $name)
    } footer: { Text("Mentions stay @\(current.handle).") }
      .disabled(!store.canManage || action.busy)
  }

  private var personalityFields: some View {
    Group {
      Section {
        TextField("Personality, voice, values and boundaries", text: $text, axis: .vertical).lineLimit(12...30)
      } footer: { Text("Read at the start of every conversation. Keep it short; every line should change how the agent behaves.") }
      Section {
        Toggle("Let @\(current.handle) refine its own personality", isOn: Binding(get: { current.settings?.soulLocked != true }, set: { value in
          action.run { try await store.updateAgent(current.id, ["settings": AnyEncodable(["soulLocked": !value])]) }
        }))
      }
    }.disabled(!store.canManage || !loaded || action.busy)
  }

  private var instructionFields: some View {
    Group {
      Section {
        TextField("Instructions", text: $text, axis: .vertical).lineLimit(12...30)
      } footer: { Text("@\(current.handle)'s job: what it's responsible for, how it should work, and who to hand things to. Sent with every request.") }
      Section {
        TechnicalDetails(title: "More options") {
          TextField("Role", text: $role)
          TextField("What the role means", text: $roleNotes, axis: .vertical).lineLimit(3...8)
        }
      }
    }.disabled(!store.canManage || action.busy)
  }

  private var modelFields: some View {
    Section {
      if store.simple {
        Text(model.isEmpty && effort.isEmpty && !fast ? "Automatic (recommended)" : "Custom: \(model.isEmpty ? "your own settings" : model)").font(.headline)
        Text("Warren lets \(HarnessChoice.label(current.harness)) pick the model and effort. That's right for most people.").font(.footnote).foregroundStyle(.secondary)
      }
      TechnicalDetails {
        Picker("Model", selection: $model) {
          Text("Harness default").tag("")
          ForEach(models?.catalog?.models ?? []) { Text($0.label).tag($0.id) }
          if !model.isEmpty && !(models?.catalog?.models.contains { $0.id == model } ?? false) { Text(model).tag(model) }
        }
        TextField("Model id", text: $model).textInputAutocapitalization(.never).autocorrectionDisabled()
        if !efforts.isEmpty {
          Picker("Reasoning effort", selection: $effort) {
            Text("Default").tag("")
            ForEach(efforts, id: \.self) { Text($0.capitalized).tag($0) }
            if !effort.isEmpty && !efforts.contains(effort) { Text("\(effort) (unsupported)").tag(effort) }
          }
          Text("More effort thinks deeper but replies slower.").font(.caption).foregroundStyle(.secondary)
        }
        if let tier = selectedModel?.fast {
          Toggle("Fast mode", isOn: $fast)
          if let description = tier.description { Text(description).font(.caption).foregroundStyle(.secondary) }
        }
        Button("Reset to default") { model = ""; effort = ""; fast = false }
      }
      if models?.catalog == nil {
        Text(current.nodeId == nil ? "This agent isn't assigned to a device yet. Pick one under Device to see its models." : "No models reported by this device yet.").font(.footnote).foregroundStyle(.secondary)
      }
    }.disabled(!store.canManage || action.busy)
  }

  private var deviceFields: some View {
    Group {
      Section {
        Picker("Device", selection: $nodeId) {
          Text("No device").tag("")
          ForEach(store.nodes.filter { $0.usable || $0.id == current.nodeId }) {
            Text("\($0.name) · \($0.online ? "online" : "offline")").tag($0.id)
          }
        }.disabled(!store.canManage || action.busy)
        if nodeId.isEmpty { Text("It can't answer @mentions until it has one.").font(.footnote).foregroundStyle(.secondary) }
      }
      if let harness, harness.inComputer, let computerId = harness.computerId {
        Section {
          LabeledContent("Sign-in", value: harness.signedIn == true ? "Signed in" : harness.signedIn == false ? "Not signed in" : "Unknown")
          NavigationLink("Open computer") { ComputerDetail(computerId: computerId) }
          if store.canManage {
            Button("Sign in") {
              action.run { computer = ComputerRoute(id: try await store.signInAgent(current.id)) }
            }.disabled(action.busy)
          }
        }
      }
    }
  }

  private var whoFields: some View {
    Section {
      if let device {
        Text("@\(current.handle) runs directly on \(device.mine == true ? "your" : "\(device.ownerName ?? "someone")'s") device \"\(device.name)\", where it can reach files.")
        if device.mine == true && device.shared != true && store.canManage {
          Picker("Who can ask it", selection: Binding(get: { current.settings?.anyoneCanAsk ?? false }, set: { value in
            action.run { try await store.updateAgent(current.id, ["settings": AnyEncodable(["anyoneCanAsk": value])]) }
          })) {
            Text("Only me").tag(false)
            Text("Anyone in the organization").tag(true)
          }.disabled(action.busy)
        } else {
          Text(device.shared == true || current.settings?.anyoneCanAsk == true ? "Anyone in the organization can ask it." : "Only \(device.ownerName ?? "its owner") can ask it.").foregroundStyle(.secondary)
        }
      }
    }
  }

  private func load() async {
    guard !loaded else { return }
    name = current.name; text = current.instructions ?? ""
    role = current.settings?.role ?? ""; roleNotes = current.settings?.roleNotes ?? ""
    savedRole = role; savedRoleNotes = roleNotes
    model = current.model ?? ""; effort = current.settings?.effort ?? ""; fast = current.settings?.fast ?? false
    nodeId = current.nodeId ?? ""
    do {
      if panel == .personality { text = try await store.personality(current.id); savedText = text }
      if panel == .model { models = try await store.agentModels(current.id) }
      if panel == .device { try await store.refreshManagement(); harness = try await store.harnessState(current.id) }
      loadError = nil
      loaded = true
    } catch { loadError = error.localizedDescription }
  }

  private func save() {
    action.run {
      saved = false
      switch panel {
      case .identity:
        try await store.updateAgent(current.id, ["name": AnyEncodable(name.trimmingCharacters(in: .whitespacesAndNewlines))])
      case .personality:
        try await store.savePersonality(current, content: text)
        savedText = text
      case .instructions:
        var fields: Fields = ["instructions": AnyEncodable(text)]
        var settings: Fields = [:]
        if role != savedRole { settings["role"] = AnyEncodable(role.trimmingCharacters(in: .whitespacesAndNewlines)) }
        if roleNotes != savedRoleNotes { settings["roleNotes"] = AnyEncodable(roleNotes) }
        if !settings.isEmpty { fields["settings"] = AnyEncodable(settings) }
        try await store.updateAgent(current.id, fields)
        savedRole = role; savedRoleNotes = roleNotes
      case .model:
        let validEffort = efforts.contains(effort) ? effort : ""
        try await store.updateAgent(current.id, ["model": .nullable(model), "settings": AnyEncodable(["effort": AnyEncodable.nullable(validEffort), "fast": AnyEncodable(fast && selectedModel?.fast != nil)])])
        effort = validEffort; fast = current.settings?.fast ?? false
      case .device:
        try await store.updateAgent(current.id, ["nodeId": .nullable(nodeId)])
        saved = true
        do { harness = try await store.harnessState(current.id) }
        catch { loadError = error.localizedDescription }
      case .who: break
      }
      saved = true
    }
  }
}

private struct ComputerRoute: Hashable { var id: String }
