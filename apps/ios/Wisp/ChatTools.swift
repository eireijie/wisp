import SwiftUI

/** The things a chat's "..." menu opens for an agent: its model, what it may do, and how full its conversation is. */
enum ChatTool: Identifiable {
  case model(Agent), access(Agent), context(Agent)

  var id: String {
    switch self {
    case .model(let a): "model-\(a.id)"
    case .access(let a): "access-\(a.id)"
    case .context(let a): "context-\(a.id)"
    }
  }

  var agentId: String {
    switch self {
    case .model(let a), .access(let a), .context(let a): a.id
    }
  }
}

struct ChatToolSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var tool: ChatTool
  var channelId: String
  @State private var info: AgentContextInfo?
  @State private var models: AgentModels?
  @State private var other = ""
  @State private var customizing = false
  @State private var action = FormAction()

  private var agent: Agent? { store.agent(tool.agentId) }

  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: title) { dismiss() }
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          switch tool {
          case .model: modelBody
          case .access: accessBody
          case .context: contextBody
          }
          InlineError(error: action.error)
        }
        .padding(.horizontal, 18)
        .padding(.top, 8)
        .padding(.bottom, 24)
      }
    }
    .background(Palette.sheet.ignoresSafeArea())
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.hidden)
    .task { await load() }
  }

  private var title: String {
    switch tool {
    case .model: "Model"
    case .access: "What it can do"
    case .context: "Context window"
    }
  }

  private func load() async {
    info = try? await store.agentContext(tool.agentId, channel: channelId, thread: nil)
    if case .model = tool { models = try? await store.agentModels(tool.agentId) }
  }

  // MARK: model and effort

  @ViewBuilder private var modelBody: some View {
    if let agent {
      let catalog = models?.catalog
      let chosen = agent.model ?? ""
      CardCaption("Model for \(agent.name)")
      CardGroup {
        modelRow("Automatic", "Let \(agent.name) pick", selected: chosen.isEmpty) { setModel("") }
        ForEach(catalog?.models ?? []) { m in
          modelRow(m.label, m.description, selected: chosen == m.id) { setModel(m.id) }
        }
        if !chosen.isEmpty && !(catalog?.models.contains { $0.id == chosen } ?? false) {
          modelRow(chosen, "Custom model id", selected: true) {}
        }
        if customizing {
          HStack {
            TextField("Model id", text: $other).textInputAutocapitalization(.never).autocorrectionDisabled().padding(.horizontal, 18).frame(minHeight: 54)
            Button("Use") { setModel(other.trimmingCharacters(in: .whitespacesAndNewlines)); customizing = false }.disabled(other.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).padding(.trailing, 18)
          }
        } else {
          Button { customizing = true } label: { RowLabel(title: "Other model…") }.buttonStyle(.plain)
        }
      }
      .disabled(!store.canManage || action.busy)
      let selected = catalog?.models.first { $0.id == (chosen.isEmpty ? catalog?.defaultModel : chosen) }
      let efforts = selected?.efforts ?? catalog?.efforts ?? []
      if !efforts.isEmpty {
        CardCaption("Reasoning effort").padding(.top, 6)
        Picker("Reasoning effort", selection: Binding(get: { agent.settings?.effort ?? "" }, set: { setEffort($0) })) {
          Text("Default").tag("")
          ForEach(efforts, id: \.self) { Text($0.capitalized).tag($0) }
        }
        .pickerStyle(.segmented)
        .disabled(!store.canManage || action.busy)
      }
      if catalog == nil { CardCaption("Its device hasn't reported models yet. Start the device to see them.") }
      Button("Use the default model") { setModel("", effort: "") }
        .secondaryButton().frame(maxWidth: .infinity).padding(.top, 6)
        .disabled(!store.canManage || action.busy)
    }
  }

  private func modelRow(_ title: String, _ subtitle: String?, selected: Bool, _ pick: @escaping () -> Void) -> some View {
    Button(action: pick) {
      RowLabel(title: title, subtitle: subtitle, chevron: false) { EmptyView() }
        .overlay(alignment: .trailing) { if selected { Image(systemName: "checkmark").font(.system(size: 15, weight: .semibold)).padding(.trailing, 18) } }
    }.buttonStyle(.plain)
  }

  /** `effort` overrides the agent's current effort, so a reset can clear both in one update. */
  private func setModel(_ id: String, effort: String? = nil) {
    guard let agent else { return }
    action.run {
      let fields = AgentModels.modelFields(models, model: id, effort: effort ?? agent.settings?.effort ?? "", fast: agent.settings?.fast ?? false)
      try await store.updateAgent(agent.id, fields)
    }
  }

  private func setEffort(_ effort: String) {
    guard let agent else { return }
    action.run { try await store.updateAgent(agent.id, ["settings": AnyEncodable(["effort": AnyEncodable.nullable(effort)])]) }
  }

  // MARK: access

  @ViewBuilder private var accessBody: some View {
    if let agent {
      CardCaption("What \(agent.name) can do on its computer")
      CardGroup {
        ForEach(AccessLevel.allCases) { level in
          Button {
            guard level != info?.level else { return }
            action.run {
              try await store.setAccess(agent.id, level)
              info = try await store.agentContext(agent.id, channel: channelId, thread: nil)
            }
          } label: {
            RowLabel(title: level.label, subtitle: level.detail, chevron: false) {
              Image(systemName: level.symbol).foregroundStyle(Palette.muted).frame(width: 28)
            }
            .overlay(alignment: .trailing) { if info?.level == level { Image(systemName: "checkmark").font(.system(size: 15, weight: .semibold)).padding(.trailing, 18) } }
          }.buttonStyle(.plain)
        }
      }
      .disabled(!store.canManage || action.busy)
    }
  }

  // MARK: context

  @ViewBuilder private var contextBody: some View {
    VStack(alignment: .leading, spacing: 10) {
      if let f = info?.fraction {
        HStack {
          Text(ContextCard.words(f)).font(.system(size: 15, weight: .semibold))
          Spacer()
          Text("\(Int((f * 100).rounded()))%").font(.system(size: 15)).monospacedDigit().foregroundStyle(ContextRing.color(f))
        }
        ProgressView(value: f).tint(ContextRing.color(f))
      }
      Text(info?.summary ?? "Loading…").font(.system(size: 15)).foregroundStyle(Palette.muted)
      Text("Older messages are summarized as it fills up. Start a new chat to begin fresh; its memory carries over.").font(.system(size: 13)).foregroundStyle(Palette.faint)
    }
    .padding(16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
  }
}
