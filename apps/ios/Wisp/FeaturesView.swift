import SwiftUI

/** Settings → Mods: the optional parts of Wisp; turn on only what you use. Owners change it; everyone sees what's on. */
struct FeaturesView: View {
  @Environment(Store.self) private var store
  @State private var action = FormAction()

  var body: some View {
    Form {
      Section {
        Picker("Quick start", selection: Binding(get: { store.features.preset }, set: { value in
          switch value {
          case "simple": save(.simple)
          case "everything": save(.everything)
          default: break
          }
        })) {
          Text("Simple").tag("simple")
          Text("Everything").tag("everything")
          Text("Custom").tag("custom")
        }
        .pickerStyle(.segmented)
        .disabled(!store.isOwner || action.busy)
      } header: {
        Text("Quick start")
      } footer: {
        Text("Turn on only what you use. Simple turns everything below off. Everything turns it all on. You can change it any time.")
      }
      ForEach(FeatureKey.Group.allCases, id: \.self) { group in
        Section(group.title) {
          ForEach(group.keys) { key in
            Toggle(isOn: Binding(get: { store.features[key] }, set: { on in
              var next = store.features
              next[key] = on
              save(next)
            })) {
              HStack(spacing: 12) {
                IconTile(symbol: key.symbol, color: key.tint, size: 32)
                VStack(alignment: .leading, spacing: 2) {
                  Text(key.name)
                  Text(key.detail).font(.caption).foregroundStyle(.secondary)
                }
              }.padding(.vertical, 2)
            }
            .disabled(!store.isOwner || action.busy)
            .accessibilityIdentifier("feature-\(key.rawValue)")
          }
        }
      }
      if !store.isOwner {
        Section { Text("Only owners can turn mods on or off.").font(.footnote).foregroundStyle(.secondary) }
      }
    }
    .sectionScreen("Mods", id: "mods")
    .task { await store.refreshFeatures() }
    .managementAlert(action)
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
    }
  }
}

/** Settings → Agent defaults: what "Use my defaults" gives a new agent. */
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

  var body: some View {
    Form {
      if loaded && store.agentDefaults == nil {
        Section {
          Text("This Wisp doesn't have agent defaults yet. Update Wisp on your computer to use them.").foregroundStyle(.secondary)
        }
      }
      Section {
        Picker("Runs on", selection: $harness) {
          ForEach(harnesses) { Text($0.label).tag($0.id) }
        }
        TextField("Model", text: $model, prompt: Text("Automatic"))
          .textInputAutocapitalization(.never).autocorrectionDisabled()
      } header: { Text("AI") } footer: { Text("Leave the model blank to let \(HarnessChoice.label(harness)) pick.") }
      Section("Computer") {
        Picker("Computer", selection: $computer) {
          Text("Its own VM").tag("own-vm")
          Text("No computer").tag("none")
        }
        if computer == "own-vm" {
          Picker("On", selection: $nodeId) {
            Text("Automatic").tag("")
            ForEach(store.nodes.filter(\.usable)) { Text($0.name).tag($0.id) }
          }
        }
      }
      if store.isOwner {
        Section {
          Button("Save") {
            action.run {
              try await store.saveAgentDefaults(AgentDefaults(harness: harness, model: model.trimmed.isEmpty ? nil : model.trimmed,
                computer: computer, nodeId: computer == "own-vm" && !nodeId.isEmpty ? nodeId : nil))
              saved = true
            }
          }.disabled(action.busy || model.count > 100 || (loaded && store.agentDefaults == nil))
          if saved { Text("Saved. New agents start with these.").foregroundStyle(.green) }
        }
      } else {
        Section { Text("Only owners can change agent defaults.").font(.footnote).foregroundStyle(.secondary) }
      }
      InlineError(error: action.error)
    }
    .disabled(!store.isOwner)
    .sectionScreen("Agent defaults", id: "agent-defaults")
    .task {
      await store.refreshAgentDefaults()
      try? await store.refreshNodes()
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
