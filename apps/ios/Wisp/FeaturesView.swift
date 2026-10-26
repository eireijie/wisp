import SwiftUI

/** Settings → Mods (set-Mods.dc.html): the optional parts of Wisp; turn on only what you use. Owners change it; everyone sees what's on. */
struct FeaturesView: View {
  @Environment(Store.self) private var store
  @State private var action = FormAction()

  private var on: [FeatureKey] { FeatureKey.allCases.filter { store.features[$0] } }
  private var off: [FeatureKey] { FeatureKey.allCases.filter { !store.features[$0] } }

  var body: some View {
    SettingsPage("Mods", subtitle: "Feature switches for the whole organization. Only owners can change them.", id: "mods") {
      SegmentedPicker(options: [("simple", "Simple"), ("everything", "Everything"), ("custom", "Custom")],
                      selection: Binding(get: { store.features.preset }, set: { value in
                        switch value {
                        case "simple": save(.simple)
                        case "everything": save(.everything)
                        default: break
                        }
                      }), label: "Quick start", id: "mods-preset")
        .disabled(!store.isOwner || action.busy)
      CardHint("Turn on only what you use. Simple turns everything off. Everything turns it all on. You can change it any time.")
      if !on.isEmpty {
        CardLabel("On")
        CardGroup { ForEach(on) { row($0) } }
      }
      if !off.isEmpty {
        CardLabel(on.isEmpty ? "Mods" : "More mods")
        CardGroup { ForEach(off) { row($0) } }
      }
      if !store.isOwner { OwnersOnlyNote() }
      StatusLine(error: action.error)
    }
    .task { await store.refreshFeatures() }
  }

  private func row(_ key: FeatureKey) -> some View {
    ToggleRow(title: key.name, subtitle: key.detail, isOn: Binding(get: { store.features[key] }, set: { on in
      var next = store.features
      next[key] = on
      save(next)
    }), id: "feature-\(key.rawValue)")
    .disabled(!store.isOwner || action.busy)
  }

  private func save(_ next: Features) {
    action.run { try await store.setFeatures(next) }
  }
}

extension FeatureKey {
  var tint: Color {
    switch self {
    case .background: .purple
    case .routines: .blue
    case .teach: .green
    case .tasks: .pink
    case .voice: .teal
    case .buddy: .indigo
    case .invite: .gray
    case .remoteDesktop: .orange
    }
  }
}

/** Settings → Agent defaults (set-AgentDefaults.dc.html): what "Use my defaults" gives a new agent. */
struct AgentDefaultsView: View {
  @Environment(Store.self) private var store
  @State private var harness = "claude-code"
  @State private var model = ""
  @State private var computer = "own-vm"
  @State private var nodeId = ""
  @State private var loaded = false
  @State private var saved = false
  @State private var action = FormAction()

  private var harnesses: [HarnessChoice] { HarnessChoice.all.filter { $0.protocolName != "mcp" } }
  @State private var rules = 0

  var body: some View {
    SettingsPage("Agent defaults", subtitle: "What a new agent starts with when you pick Use my defaults.", id: "agent-defaults") {
      if loaded && store.agentDefaults == nil {
        CardHint("This Wisp doesn't have agent defaults yet. Update Wisp on your computer to use them.")
      }
      if !store.isOwner { OwnersOnlyNote() }
      CardLabel("New agents start with")
      CardGroup {
        PickerRow(title: "AI tool", subtitle: "The program that does the work", options: harnesses.map { ($0.id, $0.label) }, selection: $harness, id: "defaults-harness")
        FieldRow(title: "Model", text: $model, prompt: "Automatic", id: "defaults-model")
        NavigationLink { DefaultModelsView() } label: { RowLabel(title: "Default model per tool", value: "\(harnesses.count) tools") }.accessibilityIdentifier("defaults-models")
      }.disabled(!store.isOwner)
      CardHint("Leave the model blank to let \(HarnessChoice.label(harness)) pick.")
      CardLabel("Computer")
      CardGroup {
        PickerRow(title: "New agents get", subtitle: computer == "own-vm" ? "Open apps and browse the web" : "Chat and their tools only", options: [("own-vm", "Their own computer"), ("none", "No computer")], selection: $computer, id: "defaults-computer")
        if computer == "own-vm" {
          PickerRow(title: "Device", options: [("", "Pick one automatically")] + store.nodes.filter(\.usable).map { ($0.id, $0.name) }, selection: $nodeId, id: "defaults-device")
        }
      }.disabled(!store.isOwner)
      CardLabel("Memory")
      CardGroup {
        NavigationLink { MemoryRulesView() } label: { RowLabel(title: "Memory rules", subtitle: "Who can see and edit what", value: rules > 0 ? "\(rules) \(rules == 1 ? "rule" : "rules")" : nil) }.accessibilityIdentifier("defaults-memory-rules")
      }
      StatusLine(error: action.error, saved: saved ? "Saved. New agents start with these." : nil)
      if store.isOwner {
        Button("Save") {
          action.run {
            try await store.saveAgentDefaults(AgentDefaults(harness: harness, model: model.trimmed.isEmpty ? nil : model.trimmed,
              computer: computer, nodeId: computer == "own-vm" && !nodeId.isEmpty ? nodeId : nil, models: store.agentDefaults?.models))
            saved = true
          }
        }.buttonStyle(.pill(.primary)).disabled(action.busy || model.count > 100 || (loaded && store.agentDefaults == nil)).accessibilityIdentifier("defaults-save")
      }
    }
    .task {
      await store.refreshAgentDefaults()
      try? await store.refreshNodes()
      rules = ((try? await store.connection().get("/api/access/rules")) as [MemoryRule]?)?.count ?? 0
      let d = store.agentDefaults
      harness = d?.harness ?? "claude-code"
      model = d?.model ?? ""
      computer = d?.computer ?? "own-vm"
      nodeId = d?.nodeId ?? ""
      loaded = true
    }
    .onChange(of: harness) { saved = false }
    .onChange(of: model) { saved = false }
    .onChange(of: computer) { saved = false }
    .onChange(of: nodeId) { saved = false }
  }
}

/** One default model for each AI tool (set-DefaultModels.dc.html). */
struct DefaultModelsView: View {
  @Environment(Store.self) private var store
  @State private var models: [String: String] = [:]
  @State private var editing: HarnessChoice?
  @State private var action = FormAction()

  private var harnesses: [HarnessChoice] { HarnessChoice.all.filter { $0.protocolName != "mcp" } }

  var body: some View {
    SettingsPage("Default model", subtitle: "One default per AI tool.", id: "default-models") {
      if !store.isOwner { OwnersOnlyNote() }
      CardGroup {
        ForEach(harnesses) { h in
          FieldRow(title: h.label, text: Binding(get: { models[h.id] ?? "" }, set: { models[h.id] = $0 }), prompt: "Automatic", id: "model-\(h.id)")
        }
      }
      CardHint("Leave a tool on Automatic to use its own default. You can still pick a model per agent.")
      StatusLine(error: action.error)
      if store.isOwner {
        Button("Save") {
          action.run {
            var next = store.agentDefaults ?? AgentDefaults(harness: nil, model: nil, computer: nil, nodeId: nil, models: nil)
            next.models = models.mapValues { $0.trimmed }.filter { !$0.value.isEmpty }
            // a tool whose box was emptied is sent as an empty name so the hub forgets it
            for h in harnesses where (models[h.id] ?? "").trimmed.isEmpty && store.agentDefaults?.models?[h.id] != nil { next.models?[h.id] = "" }
            try await store.saveAgentDefaults(next)
            models = store.agentDefaults?.models ?? [:]
          }
        }.buttonStyle(.pill(.primary)).disabled(action.busy).accessibilityIdentifier("models-save")
      }
    }
    .task { await store.refreshAgentDefaults(); models = store.agentDefaults?.models ?? [:] }
  }
}
