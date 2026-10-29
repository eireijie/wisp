import SwiftUI

/**
 * What an agent runs on, in a chat with it (h-PhoneChat / h-PhoneRun): one quiet line over the
 * message box, "Hermes · Opus 5.5 · High ⌄", and a short sheet behind it with the harness, the
 * model (with its provider), the effort, how full the context is and how much of the plan is left.
 */
@MainActor @Observable
final class RunInfo {
  var context: AgentContextInfo?
  var models: AgentModels?
  private var modelsFor: String?
  private var place: (channel: String, thread: String?)?

  /** The context changes with every reply; the model list only when the agent or its connections do. */
  func load(_ store: Store, agent: Agent, channel: String, thread: String?, models reload: Bool = false) async {
    place = (channel, thread)
    if let fresh = try? await store.agentContext(agent.id, channel: channel, thread: thread) { context = fresh }
    let key = "\(agent.id)/\(agent.harness)/\(agent.settings?.connectionId ?? "")/\(store.modelsVersion)"
    if reload || modelsFor != key, let fresh = try? await store.agentModels(agent.id) {
      models = fresh; modelsFor = key
    }
  }

  /** After a change from the sheet: read it all again for the chat it was last loaded for. */
  func reload(_ store: Store, agentId: String) async {
    guard let place, let agent = store.agent(agentId) else { return }
    await load(store, agent: agent, channel: place.channel, thread: place.thread, models: true)
  }

  /** The model's name as people read it ("Opus 5.5"), from the connection's list or the computer's. */
  func modelLabel(_ id: String?) -> String? {
    guard let id, !id.isEmpty else { return nil }
    let lists: [[(id: String, label: String)]] = [
      (models?.models ?? []).map { ($0.id, $0.label) },
      (models?.catalog?.models ?? []).map { ($0.id, $0.label) },
    ]
    return ModelWords.modelLabel(id, in: lists)
  }

  func line(_ agent: Agent) -> String {
    ModelWords.runLine(harness: agent.harness, model: modelLabel(context?.model ?? agent.model), effort: context?.effort ?? agent.settings?.effort)
  }

  /** "Claude" for a connection, else the company behind the harness's own sign-in. */
  var providerLabel: String? {
    if let c = context?.connection ?? models?.connection { return ModelWords.provider(c.provider) }
    switch context?.harness {
    case "claude-code": return "Claude"
    case "codex": return "ChatGPT"
    default: return nil
    }
  }
}

/** The quiet line: muted small text, no chip, no background. */
struct RunSummaryLine: View {
  var agent: Agent
  var info: RunInfo
  var open: () -> Void
  @ReduceMotion private var reduceMotion

  var body: some View {
    let text = info.line(agent)
    Button(action: open) {
      HStack(spacing: 3) {
        Text(text).lineLimit(1).truncationMode(.middle)
        Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold))
      }
      .font(.system(size: 12))
      .foregroundStyle(Palette.faint)
      .contentShape(Rectangle())
      .padding(.vertical, 2)
    }
    .buttonStyle(.press)
    .contentTransition(.opacity)
    .animation(Motion.pick(Motion.fade, reduceMotion), value: text)
    .accessibilityLabel("\(text). Change harness, model or effort")
    .accessibilityIdentifier("run-line")
  }
}

/** The ring in a chat's header: how full the conversation is, with no circle behind it. */
struct HeaderContextRing: View {
  var fraction: Double?
  var open: () -> Void

  var body: some View {
    Button(action: open) { ContextRing(fraction: fraction).frame(width: 30, height: 44).contentShape(Rectangle()) }
      .buttonStyle(.press)
      .accessibilityLabel(fraction.map { "Context: \(Int(($0 * 100).rounded()))% used" } ?? "Context")
      .accessibilityIdentifier("chat-context")
  }
}

// MARK: - The sheet

enum RunRoute: Hashable { case harness, model, connect, provider(String) }

struct RunSheet: View {
  @Environment(Store.self) private var store
  var agentId: String
  var channelId: String
  var info: RunInfo
  @State private var path: [RunRoute] = []
  @State private var detent: PresentationDetent = .height(300)

  var body: some View {
    NavigationStack(path: $path) {
      RunSheetRoot(agentId: agentId, channelId: channelId, info: info, path: $path)
        .navigationDestination(for: RunRoute.self) { route in
          if let agent = store.agent(agentId) {
            switch route {
            case .harness: HarnessPicker(agent: agent, info: info)
            case .model: ModelPicker(agent: agent, info: info, connect: { path.append(.connect) })
            case .connect: ConnectModelList { path.append(.provider($0)) }
            case .provider(let p): ConnectProviderView(provider: p) { _ in path.removeAll { if case .model = $0 { false } else { true } } }
            }
          }
        }
    }
    .presentationDetents([.height(300), .large], selection: $detent)
    .presentationDragIndicator(.visible)
    .presentationCornerRadius(Corner.sheet)
    .presentationBackground(Palette.sheet)
    .onChange(of: path) { _, new in detent = new.isEmpty ? .height(300) : .large }
  }
}

private struct RunSheetRoot: View {
  @Environment(Store.self) private var store
  var agentId: String
  var channelId: String
  var info: RunInfo
  @Binding var path: [RunRoute]
  @State private var action = FormAction()

  private var agent: Agent? { store.agent(agentId) }
  private var canEdit: Bool { store.canManage }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if let agent {
        CardGroup {
          row("Harness", value: HarnessChoice.label(agent.harness), sub: nil, id: "run-harness") { path.append(.harness) }
          row("Model", value: info.modelLabel(info.context?.model ?? agent.model) ?? "Default", sub: info.providerLabel, id: "run-model") { path.append(.model) }
        }
        let efforts = info.context?.efforts ?? []
        if !efforts.isEmpty {
          EffortSegments(options: efforts, selection: info.context?.effort ?? agent.settings?.effort ?? "") { setEffort($0) }
            .disabled(!canEdit || action.busy)
        }
        meters
        InlineError(error: action.error)
      }
    }
    .padding(.horizontal, 16).padding(.top, 22)
    .frame(maxHeight: .infinity, alignment: .top)
    .background(Palette.sheet.ignoresSafeArea())
    .toolbar(.hidden, for: .navigationBar)
  }

  private func row(_ title: String, value: String, sub: String?, id: String, _ go: @escaping () -> Void) -> some View {
    Button(action: go) {
      HStack(spacing: 6) {
        Text(title).font(.system(size: 15)).foregroundStyle(Palette.text)
        Spacer(minLength: 8)
        VStack(alignment: .trailing, spacing: 1) {
          Text(value).font(.system(size: 15)).foregroundStyle(Palette.muted).lineLimit(1)
          if let sub { Text(sub).font(.system(size: 12)).foregroundStyle(Palette.faint) }
        }
        Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.faint)
      }
      .padding(.horizontal, 14).frame(minHeight: 46).contentShape(Rectangle())
    }
    .buttonStyle(.pressRow)
    .disabled(!canEdit)
    .accessibilityIdentifier(id)
  }

  @ViewBuilder private var meters: some View {
    VStack(alignment: .leading, spacing: 6) {
      let f = info.context?.fraction
      HStack {
        Text(f.map { "Context \(Int(($0 * 100).rounded()))%" } ?? "Context")
        Spacer()
        Text(ModelWords.contextLine(used: info.context?.contextUsed, window: info.context?.contextWindow) ?? "After the first reply").monospacedDigit()
      }
      ThinBar(fraction: f ?? 0, color: f.map(ContextRing.color) ?? Palette.faint)
      if let plan = info.context?.plan {
        HStack {
          Text("\(info.providerLabel ?? "Your") plan")
          Spacer()
          Text(ModelWords.planLine(plan)).monospacedDigit()
        }.padding(.top, 4)
      }
    }
    .font(.system(size: 12))
    .foregroundStyle(Palette.faint)
    .padding(.horizontal, 4).padding(.top, 2)
  }

  private func setEffort(_ value: String) {
    guard let agent else { return }
    action.run {
      _ = try await store.updateAgent(agent.id, ["settings": AnyEncodable(["effort": AnyEncodable.nullable(value)])])
      await info.reload(store, agentId: agent.id)
    }
  }
}

/** A thin progress line (4pt), for context and plan. */
struct ThinBar: View {
  var fraction: Double
  var color: Color
  @ReduceMotion private var reduceMotion

  var body: some View {
    GeometryReader { g in
      ZStack(alignment: .leading) {
        Capsule().fill(Palette.field)
        Capsule().fill(color).frame(width: max(0, min(1, fraction)) * g.size.width)
      }
    }
    .frame(height: 4)
    .animation(Motion.pick(Motion.settle, reduceMotion), value: fraction)
    .accessibilityHidden(true)
  }
}

/** The effort levels the model offers, as a tight segmented control. Tapping the picked one goes back to the default. */
struct EffortSegments: View {
  var options: [String]
  var selection: String
  var pick: (String) -> Void
  @ReduceMotion private var reduceMotion
  @Namespace private var ns

  var body: some View {
    HStack(spacing: 2) {
      ForEach(options, id: \.self) { option in
        let on = option == selection
        Button { pick(on ? "" : option) } label: {
          Text(AgentLine.effort(option))
            .font(.system(size: 13, weight: .medium)).lineLimit(1).minimumScaleFactor(0.8)
            .foregroundStyle(on ? Palette.text : Palette.muted)
            .frame(maxWidth: .infinity, minHeight: 32)
            .background {
              if on { RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Palette.selected).matchedGeometryEffect(id: "on", in: ns) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("effort-\(option)")
      }
    }
    .padding(2)
    .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Palette.control))
    .animation(Motion.pick(Motion.soft, reduceMotion), value: selection)
    .accessibilityElement(children: .contain).accessibilityLabel("Effort")
  }
}

// MARK: - A pushed page inside the sheet or settings

/** A page with the back circle and a centered title (h-PhoneHarness, h-PhoneModel, h-PhoneSignIn). */
struct PickerPage<Content: View>: View {
  @Environment(\.dismiss) private var dismiss
  var title: String
  var id: String
  @ViewBuilder var content: Content

  var body: some View {
    VStack(spacing: 0) {
      ZStack {
        Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text).lineLimit(1).padding(.horizontal, 60)
        HStack { CircleButton(symbol: "chevron.left", label: "Back") { dismiss() }; Spacer() }
      }
      .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 6)
      ScrollView {
        VStack(alignment: .leading, spacing: 10) { content }
          .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 40)
      }
      .scrollDismissesKeyboard(.interactively)
    }
    .background(Palette.sheet.ignoresSafeArea())
    .toolbar(.hidden, for: .navigationBar)
    .accessibilityIdentifier("screen-\(id)")
  }
}

/** A small uppercase caption over a group, with an optional grey note on the right ("CLAUDE    Signed in · Max"). */
struct GroupCaption: View {
  var title: String
  var note: String? = nil
  var body: some View {
    HStack {
      Text(title.uppercased()).font(.system(size: 12, weight: .medium)).tracking(0.5)
      Spacer()
      if let note { Text(note).font(.system(size: 12)) }
    }
    .foregroundStyle(Palette.faint)
    .padding(.horizontal, 6).padding(.top, 6)
  }
}

/** A row with a title (and a grey line), and a check on the picked one. */
struct PickRow: View {
  var symbol: String? = nil
  var title: String
  var subtitle: String? = nil
  var selected: Bool
  var id: String? = nil
  var action: () -> Void
  @ReduceMotion private var reduceMotion

  var body: some View {
    Button(action: action) {
      HStack(spacing: 12) {
        if let symbol { Image(systemName: symbol).font(.system(size: 13)).foregroundStyle(Palette.muted).frame(width: 18) }
        VStack(alignment: .leading, spacing: 1) {
          Text(title).font(.system(size: 15)).foregroundStyle(Palette.text).lineLimit(1)
          if let subtitle { Text(subtitle).font(.system(size: 12)).foregroundStyle(Palette.faint).lineLimit(1) }
        }
        Spacer(minLength: 8)
        if selected {
          Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.blue)
            .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
        }
      }
      .padding(.horizontal, 14).frame(minHeight: subtitle == nil ? 46 : 52).contentShape(Rectangle())
    }
    .buttonStyle(.pressRow)
    .animation(Motion.pick(Motion.pop, reduceMotion), value: selected)
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier(id ?? "")
  }
}

/** A blue "+ Add …" row in its own card. */
struct AddRow: View {
  var title: String
  var id: String? = nil
  var action: () -> Void
  var body: some View {
    CardGroup {
      Button(action: action) {
        HStack(spacing: 12) {
          Image(systemName: "plus").font(.system(size: 15, weight: .regular)).frame(width: 18)
          Text(title).font(.system(size: 15))
          Spacer()
        }
        .foregroundStyle(Palette.blue)
        .padding(.horizontal, 14).frame(minHeight: 46).contentShape(Rectangle())
      }
      .buttonStyle(.pressRow)
      .accessibilityIdentifier(id ?? "")
    }
  }
}

/** A footnote under a page's cards. */
struct Footnote: View {
  var text: String
  init(_ text: String) { self.text = text }
  var body: some View {
    Text(text).font(.system(size: 12)).foregroundStyle(Palette.faint).padding(.horizontal, 6).fixedSize(horizontal: false, vertical: true)
  }
}

// MARK: - Harness

/** The harnesses on the agent's computer; switching keeps its model, memory, skills and chats. */
struct HarnessPicker: View {
  @Environment(Store.self) private var store
  var agent: Agent
  var info: RunInfo
  @State private var computers: [HarnessComputer]?
  @State private var connections: [ModelConnection] = []
  @State private var support: [CredentialSupport] = []
  @State private var installing = false
  @State private var action = FormAction()

  private var current: Agent { store.agent(agent.id) ?? agent }
  private var computer: HarnessComputer? { computers.flatMap { HarnessPlace.computer(of: current, in: $0) } }

  var body: some View {
    PickerPage(title: "Harness", id: "harness-picker") {
      if let computers {
        if let computer {
          GroupCaption(title: "On \(computer.name)")
          if computer.harnesses.isEmpty {
            Footnote(computer.reported ? "No harnesses on \(computer.name) yet." : "\(computer.name) hasn't said which harnesses it has yet. Start it to see them.")
          } else {
            CardGroup {
              ForEach(computer.harnesses) { h in
                PickRow(symbol: ModelWords.harnessSymbol(h.id), title: h.label, selected: h.id == current.harness, id: "harness-\(h.id)") { pick(h.id) }
              }
            }
            .disabled(action.busy)
          }
          if !computer.isVM && store.canManage { AddRow(title: "Add a harness", id: "harness-add") { installing = true } }
        } else if computers.isEmpty || current.nodeId == nil {
          Footnote("\(current.name) isn't on a computer yet.")
        }
        InlineError(error: action.error)
        Footnote("\(current.name) keeps its model, memory, skills and chats when you switch.")
      } else {
        ProgressView().frame(maxWidth: .infinity).padding(.top, 30)
      }
    }
    .sheet(isPresented: $installing) { if let id = computer?.nodeId { InstallHarnessSheet(nodeId: id) } }
    .task {
      async let list = try? store.harnessComputers()
      async let mine = try? store.modelConnections()
      async let table = try? store.modelProviders()
      computers = await list ?? []
      connections = await mine ?? []
      support = (await table)?.support ?? []
    }
  }

  /** The connection it runs on: one of the person's, else someone else's as /models and /context report it. */
  private var connection: ModelConnection? {
    guard let id = current.settings?.connectionId, !id.isEmpty else { return nil }
    if let mine = connections.first(where: { $0.id == id }) { return mine }
    guard let theirs = [info.models?.connection, info.context?.connection].compactMap({ $0 }).first(where: { $0.id == id }) else {
      // not loaded: still a connection, so it isn't mistaken for the computer's own sign-in
      return ModelConnection(id: id, provider: "", kind: "", label: "", harnesses: [])
    }
    return ModelConnection(id: theirs.id, provider: theirs.provider, kind: theirs.kind, label: theirs.label ?? "", mine: false)
  }

  private func pick(_ harness: String) {
    guard harness != current.harness else { return }
    let conn = connection
    let agent = current
    action.run {
      // on a connection the new harness can use, ask which models it runs there (as the model picker does)
      var list: ConnectionModels?
      if let conn, ModelWords.supports(harness, conn, support: support) {
        list = try? await store.connectionModels(conn.id, harness: harness, agent: agent.id)
      }
      let fields = HarnessPlace.switchFields(to: harness, from: agent.harness, model: agent.model, effort: agent.settings?.effort, connection: conn, support: support, models: list)
      _ = try await store.updateAgent(agent.id, fields)
      await info.reload(store, agentId: current.id)
    }
  }
}

/** Where an agent runs, and what a harness switch changes. Pure, so it's tested. */
enum HarnessPlace {
  /** The VM it runs in when it's in one, else its device. */
  static func computer(of agent: Agent, in computers: [HarnessComputer]) -> HarnessComputer? {
    if let vm = agent.computerId, let hit = computers.first(where: { $0.isVM && $0.id == vm }) { return hit }
    return computers.first { !$0.isVM && $0.id == agent.nodeId }
  }

  /**
   * Switching harness: the connection stays when the new harness can use it (someone else's too,
   * by the support table), and the model with it when the new harness lists it there (`models`);
   * an effort stays when that model (or the harness, for the default model) offers it. Otherwise
   * the connection is dropped (the hub would refuse it) and with it the model and effort; off a
   * connection, a model id and effort belong to the old harness, so they go back to the default.
   */
  static func switchFields(to harness: String, from old: String, model: String?, effort: String?, connection: ModelConnection?, support: [CredentialSupport], models: ConnectionModels?) -> Fields {
    var fields: Fields = ["harness": AnyEncodable(harness)]
    let effort = effort.flatMap { $0.isEmpty ? nil : $0 }
    let model = model.flatMap { $0.isEmpty ? nil : $0 }
    var settings: [String: AnyEncodable] = [:]
    if let connection {
      if !ModelWords.supports(harness, connection, support: support) {
        fields["model"] = .null
        settings["connectionId"] = .null
        if effort != nil { settings["effort"] = .null }
      } else if let models {
        let m = model.flatMap { id in models.models.first { $0.id == id } }
        if model != nil && m == nil { fields["model"] = .null }
        if effort != nil && ModelWords.keptEffort(effort, offered: m?.efforts ?? models.efforts ?? []) == nil { settings["effort"] = .null }
      }
    } else if harness != old {
      fields["model"] = .null
      if effort != nil { settings["effort"] = .null }
    }
    if !settings.isEmpty { fields["settings"] = AnyEncodable(settings) }
    return fields
  }
}

// MARK: - Model

/** Models grouped by connection, only those the agent's harness can run, then "Connect a model". */
struct ModelPicker: View {
  @Environment(Store.self) private var store
  var agent: Agent
  var info: RunInfo
  var connect: () -> Void
  @State private var groups: [ModelGroup]?
  @State private var device: AgentModels?
  @State private var expanded: Set<String> = []
  @State private var action = FormAction()

  struct ModelGroup: Identifiable {
    var connection: ModelConnection
    var models: [ConnectionModel]
    var efforts: [String]
    var error: String?
    var id: String { connection.id }
  }

  private var current: Agent { store.agent(agent.id) ?? agent }
  private var onConnection: String? { current.settings?.connectionId }
  private let shown = 5

  var body: some View {
    PickerPage(title: "Model", id: "model-picker") {
      if let groups {
        ForEach(groups) { g in
          GroupCaption(title: g.connection.label == "\(ModelWords.provider(g.connection.provider)) key" ? ModelWords.provider(g.connection.provider) : g.connection.label,
                       note: ModelWords.connectionCaption(kind: g.connection.kind, plan: g.connection.plan, keyHint: g.connection.keyHint))
          if let error = g.error {
            Footnote(error)
          } else if g.models.isEmpty {
            Footnote("No models \(HarnessChoice.label(current.harness)) can run here yet.")
          } else {
            let all = expanded.contains(g.id) ? g.models : Array(g.models.prefix(shown))
            CardGroup {
              ForEach(all) { m in
                PickRow(title: m.label, selected: onConnection == g.id && current.model == m.id, id: "model-\(m.id)") {
                  pick(m.id, connection: g.id, efforts: m.efforts ?? g.efforts)
                }
              }
              if g.models.count > shown && !expanded.contains(g.id) {
                PickRow(title: "More…", selected: false) { expanded.insert(g.id) }
              }
            }
          }
        }
        let own = device?.catalog?.models ?? []
        if !own.isEmpty || groups.isEmpty {
          GroupCaption(title: "Its computer's sign-in", note: HarnessChoice.label(current.harness))
          CardGroup {
            PickRow(title: "Default", selected: onConnection == nil && (current.model ?? "").isEmpty, id: "model-default") {
              pick("", connection: nil, efforts: device?.catalog?.efforts ?? [])
            }
            ForEach(own) { m in
              PickRow(title: m.label, selected: onConnection == nil && current.model == m.id, id: "model-own-\(m.id)") {
                pick(m.id, connection: nil, efforts: m.efforts ?? device?.catalog?.efforts ?? [])
              }
            }
          }
        }
        if store.canManage { AddRow(title: "Connect a model", id: "model-connect", action: connect) }
        InlineError(error: action.error)
      } else {
        ProgressView().frame(maxWidth: .infinity).padding(.top, 30)
      }
    }
    .disabled(action.busy)
    .task(id: store.modelsVersion) { await load() }
  }

  private func load() async {
    async let own = try? store.agentModels(current.id)
    let mine = ((try? await store.modelConnections()) ?? []).filter { ($0.harnesses ?? []).contains(current.harness) }
    var out: [ModelGroup] = []
    // a person has a handful of connections at most; each answer is cached on the hub
    for c in mine {
      do {
        let r = try await store.connectionModels(c.id, harness: current.harness, agent: current.id)
        out.append(ModelGroup(connection: c, models: r.models, efforts: r.efforts ?? []))
      } catch { out.append(ModelGroup(connection: c, models: [], efforts: [], error: error.localizedDescription)) }
    }
    device = await own
    groups = out
  }

  private func pick(_ model: String, connection: String?, efforts: [String]) {
    let effort = ModelWords.keptEffort(current.settings?.effort, offered: efforts)
    let fields: Fields = [
      "model": .nullable(model),
      "settings": AnyEncodable(["connectionId": connection.map { AnyEncodable($0) } ?? .null, "effort": effort.map { AnyEncodable($0) } ?? .null]),
    ]
    action.run {
      _ = try await store.updateAgent(current.id, fields)
      await info.reload(store, agentId: current.id)
    }
  }
}
