import SwiftUI

/**
 * Model (agent-Model.dc.html): Harness default or one of the models its device reports, the
 * reasoning effort, and Fast mode. Choices save as they are made. "More options" holds a model
 * id of your own and a reset (agent-ModelCustom.dc.html).
 */
struct AgentModelPage: View {
  @Environment(Store.self) private var store
  var agent: Agent
  @State private var models: AgentModels?
  @State private var loadError: String?
  @State private var action = FormAction()

  private var current: Agent { store.agent(agent.id) ?? agent }
  private var catalog: AgentModels.Catalog? { models?.catalog }
  private var model: String { current.model ?? "" }
  private var selected: ModelOption? { catalog?.models.first { $0.id == (model.isEmpty ? catalog?.defaultModel : model) } }
  private var efforts: [String] { selected?.efforts ?? catalog?.efforts ?? [] }
  private var effort: String { current.settings?.effort ?? "" }
  private var label: String { HarnessChoice.label(current.harness) }

  var body: some View {
    AgentFrame(title: "Model", subtitle: current.name) {
      if let catalog {
        CardCaption("Model")
        CardGroup {
          ChoiceRow(title: "Harness default", selected: model.isEmpty) { pick("") }
          ForEach(catalog.models) { option in
            ChoiceRow(title: option.label, subtitle: option.description, selected: model == option.id) { pick(option.id) }
          }
          if !model.isEmpty, !catalog.models.contains(where: { $0.id == model }) {
            ChoiceRow(title: model, selected: true) {}
          }
        }
        .disabled(!store.canManage || action.busy)
        if !efforts.isEmpty {
          CardCaption("Reasoning effort")
          Segments(options: efforts.map { ($0, AgentLine.effort($0)) }, selection: Binding(get: { effort }, set: { setEffort($0) }), allowsNone: "", id: "model-effort")
            .disabled(!store.canManage || action.busy)
          CardCaption("More effort thinks longer before answering.")
        }
        if let tier = selected?.fast {
          CardGroup {
            SwitchRow(title: "Fast mode", subtitle: tier.description ?? "Quicker replies, uses your allowance faster",
                      isOn: Binding(get: { current.settings?.fast ?? false }, set: { setFast($0) }), id: "model-fast")
          }.disabled(!store.canManage || action.busy)
        }
      } else if let loadError {
        AgentError(text: loadError)
        PillButton(title: "Try again", kind: .secondary) { Task { await load() } }
      } else if models != nil {
        AgentCard {
          Text(current.nodeId == nil ? "This agent isn't on a device yet. Pick one under Computer to see its models." : "No models reported by this device yet.")
            .font(.system(size: 15)).foregroundStyle(Palette.muted)
        }
      } else {
        ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
      }
      if store.canManage {
        CardGroup {
          NavigationLink { AgentModelMore(agent: current, models: models) } label: {
            RowLabel(title: "More options")
          }.buttonStyle(.plain).accessibilityIdentifier("model-more")
        }
      }
      AgentError(text: action.error)
    }
    .task { await load() }
  }

  private func load() async {
    do { models = try await store.agentModels(current.id); loadError = nil }
    catch { loadError = error.localizedDescription }
  }

  private func pick(_ id: String) {
    guard id != model else { return }
    action.run { try await AgentModelPage.save(current, model: id, effort: effort, fast: current.settings?.fast ?? false, models: models, store: store) }
  }

  private func setEffort(_ value: String) {
    action.run { try await AgentModelPage.save(current, model: model, effort: value, fast: current.settings?.fast ?? false, models: models, store: store) }
  }

  private func setFast(_ on: Bool) {
    action.run { try await AgentModelPage.save(current, model: model, effort: effort, fast: on, models: models, store: store) }
  }

  /** Saves the model, and the effort and fast mode it supports (the others are dropped). */
  @MainActor static func save(_ agent: Agent, model: String, effort: String, fast: Bool, models: AgentModels?, store: Store) async throws {
    _ = try await store.updateAgent(agent.id, AgentModels.modelFields(models, model: model, effort: effort, fast: fast))
  }
}

/** More options on Model: a model id you type yourself, and putting everything back to the harness's own. */
struct AgentModelMore: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var agent: Agent
  var models: AgentModels?
  @State private var id = ""
  @State private var loaded = false
  @State private var other = false
  @State private var action = FormAction()

  private var current: Agent { store.agent(agent.id) ?? agent }
  private var catalog: AgentModels.Catalog? { models?.catalog }
  private var known: Bool { !other && (id.isEmpty || (catalog?.models.contains { $0.id == id } ?? false)) }

  var body: some View {
    AgentFrame(title: "Model", subtitle: "More options") {
      CardCaption("Model")
      CardGroup {
        ChoiceRow(title: "Harness default", selected: known && id.isEmpty) { id = ""; other = false }
        ForEach(catalog?.models ?? []) { option in
          ChoiceRow(title: option.label, subtitle: option.description, selected: known && id == option.id) { id = option.id; other = false }
        }
        ChoiceRow(title: "Other model…", selected: !known) { other = true }
      }
      if !known {
        FieldCard(label: "Model id", text: $id, prompt: "sol-6.1-preview", lowercase: true)
          .accessibilityIdentifier("model-id")
        CardCaption("Use the exact id your harness expects. Wisp passes it through unchanged.")
      }
      PillButton(title: "Save", busy: action.busy, id: "model-save") {
        action.run {
          let value = id.trimmingCharacters(in: .whitespaces)
          try await AgentModelPage.save(current, model: value, effort: current.settings?.effort ?? "", fast: current.settings?.fast ?? false, models: models, store: store)
          dismiss()
        }
      }
      .disabled(action.busy || id.count > 200)
      CardGroup {
        Button {
          action.run {
            try await AgentModelPage.save(current, model: "", effort: "", fast: false, models: models, store: store)
            id = ""
          }
        } label: { RowLabel(title: "Reset to default", chevron: false) }
          .buttonStyle(.plain).accessibilityIdentifier("model-reset")
      }
      AgentError(text: action.error)
    }
    .onAppear {
      guard !loaded else { return }
      id = current.model ?? ""; loaded = true
      other = !id.isEmpty && !(catalog?.models.contains { $0.id == id } ?? false)
    }
  }
}
