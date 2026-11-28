import SwiftUI

/** Everything a new agent is being given, shared by the create screen and the pages under More options. */
@MainActor @Observable
final class AgentDraft {
  // a round bubble in one of the bubble colours, picked once: typing its name never changes it
  var look = GhostLook.newAgent()
  var name = ""
  var does = ""
  var instructions = ""
  var harness = "claude-code"
  var model = ""
  /** where it works (web: Runs on) */
  var place = AgentPlace.shared
  /** the device its AI runs on, and where its own computer or screen is */
  var nodeId: String?
  var handle = ""
  var respondTo = "me"
  var respondPeople: Set<String> = []
  var apps: Set<String> = []
  var skills: Set<String> = []
  var template: String?
  let computerDraft = AgentComputerDraft()

  /** the short job line the agent is created with (the hub keeps at most 60 characters) */
  var roleText: String? { does.trimmed.isEmpty ? nil : String(does.trimmed.prefix(60)) }

  func finalHandle() -> String { handle.isEmpty ? ManagementText.handle(name) : ManagementText.handle(handle) }
}

/** Where a new agent works, the web's four Runs on choices. */
enum AgentPlace: String, CaseIterable, Identifiable {
  case shared, own, screen, none
  var id: String { rawValue }

  var title: String {
    switch self {
    case .shared: "Shared computer"
    case .own: "Its own computer"
    case .screen: "My screen"
    case .none: "No computer"
    }
  }

  var symbol: String {
    switch self {
    case .shared: "person.2"
    case .own: "desktopcomputer"
    case .screen: "laptopcomputer"
    case .none: "bubble.left"
    }
  }

  /** The line under it on this device; why it can't be picked when it can't. */
  func line(node: AgentNode?) -> String {
    let name = node?.name ?? "your computer"
    switch self {
    case .shared: return "With your other agents"
    case .own: return node?.capabilities?.vm?.ok == true ? "A desktop on \(name)" : node?.vmProblem ?? "Connect a computer first"
    case .screen: return node?.mine == true ? (node?.capabilities?.screen?.ok == true ? "Works right on \(name)" : node?.capabilities?.screen?.detail ?? "Off on \(name)") : "Only on your own computer"
    case .none: return "Chat and files only"
    }
  }

  /** Can it be picked with this device? */
  func usable(node: AgentNode?, computers: [Computer]) -> Bool {
    switch self {
    case .shared, .none: return true
    case .own: return node?.capabilities?.vm?.ok == true
    case .screen: return node?.mine == true && (node?.capabilities?.screen?.ok == true || computers.contains { $0.kind == "device" && $0.nodeId == node?.id })
    }
  }

  /** Where a new agent goes unless someone picks: what the device does for agents, else the saved defaults, else shared. */
  static func initial(node: AgentNode?, defaults: AgentDefaults?, computers: [Computer]) -> AgentPlace {
    if node?.role == "headless" { return .none }
    if node?.role == "screen", AgentPlace.screen.usable(node: node, computers: computers) { return .screen }
    switch defaults?.computer {
    case "none": return .none
    case "own-vm" where AgentPlace.own.usable(node: node, computers: computers): return .own
    default: return .shared
    }
  }
}
/** Starting points for a new agent: a job in a few words, and the instructions that go with it. */
struct AgentTemplate: Identifiable, Hashable {
  var id: String { name }
  var name: String
  var does: String
  var instructions: String

  static let all = [
    AgentTemplate(name: "Researcher", does: "Finds answers and shows its sources",
                  instructions: "## What it owns\n- Finding and checking facts\n- Keeping a short list of sources\n\n## Ask before\n- Buying or signing up for anything\n\n## Reply style\n- Lead with the answer, then the sources."),
    AgentTemplate(name: "Code reviewer", does: "Reviews pull requests and comments on them",
                  instructions: "## What it owns\n- Reading a diff and saying what could break\n\n## You decide\n- Whether a change is safe to merge\n\n## Reply style\n- Short comments, the most important first."),
    AgentTemplate(name: "Planner", does: "Breaks work into steps and keeps track of them",
                  instructions: "## What it owns\n- Turning a goal into small steps\n- Keeping the list up to date\n\n## Handoffs\n- Give each step to the agent best suited to it."),
    AgentTemplate(name: "Writer", does: "Drafts and edits writing in your voice",
                  instructions: "## What it owns\n- First drafts, edits and summaries\n\n## Ask before\n- Sending anything outside Bubble AI\n\n## Reply style\n- Plain words, short sentences."),
  ]
}

/**
 * New agent: its bubble, a name and what it does, then where it works (Shared computer, Its own
 * computer, My screen, No computer: the web's Runs on) and what it thinks with. Rare knobs (handle,
 * apps, skills, instructions) are under More options. One Create, at the top; a problem shows as an alert.
 */
struct AddAgent: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  /** start on this device (from its page) */
  var nodeId: String? = nil
  /** start from a kind of agent (the Marketplace's Use, round 12): its name, colour, job and the apps it starts with */
  var start: AgentType? = nil
  var onCreated: (Agent) -> Void

  @State private var draft = AgentDraft()
  @State private var editingLook = false
  @State private var placement: ComputerSettings?
  @State private var loaded = false
  @State private var action = FormAction()
  /** the full form (where it runs, harness, model, templates, more): the one sheet is a bubble, a name and a colour */
  @State private var full = false
  @FocusState private var naming: Bool

  private var handleTaken: Bool { store.agents.contains { $0.handle == draft.finalHandle() } }
  private var valid: Bool {
    !draft.name.trimmed.isEmpty && draft.name.count <= 80 && draft.does.count <= 60 &&
    draft.finalHandle().range(of: "^[a-z][a-z0-9-]{0,31}$", options: .regularExpression) != nil && !handleTaken &&
    draft.instructions.count <= 20000 && draft.model.count <= 200
  }
  static func choices(_ store: Store) -> [HarnessChoice] {
    let custom = Set(store.nodes.filter(\.usable).flatMap { $0.harnesses ?? [] }.map(\.id).filter { $0.hasPrefix("acp:") })
    return HarnessChoice.all.filter { $0.id != "custom" } + custom.sorted().map {
      HarnessChoice(id: $0, label: HarnessChoice.label($0), blurb: "Available on a connected device", account: "", protocolName: "acp")
    } + HarnessChoice.all.filter { $0.id == "custom" }
  }
  /** A harness on the device that's signed in (else one nobody can tell about), for when the hub gives no default. */
  static func preferredHarness(_ store: Store, node: String?) -> String? {
    guard let n = store.nodes.first(where: { $0.id == node }) else { return nil }
    return HarnessPick.preferSignedIn((n.harnesses ?? []).map(\.id)) { n.harnessSignedIn($0) }
  }
  private var external: Bool { AddAgent.choices(store).first { $0.id == draft.harness }?.protocolName == "mcp" }
  /** more than one person here: who the agent answers is a real choice */
  private var askWho: Bool { store.features.invite || store.otherPeople.count > 0 }
  private var firstNode: String? {
    let usable = store.nodes.filter(\.usable)
    return usable.first { $0.id == nodeId }?.id ?? usable.first { $0.id == store.agentDefaults?.nodeId }?.id ?? usable.first { $0.online }?.id ?? usable.first?.id
  }
  private var node: AgentNode? { store.nodes.first { $0.id == (draft.nodeId ?? firstNode) } }

  var body: some View {
    NavigationStack {
      Group {
        if full { fullForm } else { oneSheet }
      }
      .sheet(isPresented: $editingLook) { LookEditor(look: $draft.look, name: draft.name, seed: draft.look.color) }
      .alert("Couldn't create it", isPresented: Binding(get: { action.error != nil }, set: { if !$0 { action.error = nil } })) {
        Button("OK") { action.error = nil }
      } message: { Text(action.error ?? "") }
    }
    .agentSheet()
    .interactiveDismissDisabled(action.busy)
    .task {
      guard !loaded else { return }
      await store.refreshAgentDefaults()
      try? await store.refreshManagement()
      await store.refreshComputers()
      try? await store.refreshSkills()
      try? await store.refreshConnectors()
      placement = try? await store.computerSettings()
      draft.nodeId = firstNode
      draft.harness = store.agentDefaults?.harness ?? AddAgent.preferredHarness(store, node: firstNode) ?? "claude-code"
      draft.model = store.agentDefaults?.model ?? ""
      draft.place = AgentPlace.initial(node: node, defaults: store.agentDefaults, computers: store.computers)
      if let start { fill(from: start) }
      loaded = true
    }
  }

  /**
   * Round 11 (board 12): making an agent takes five seconds. Its bubble, a name, one of twelve
   * colours, Create; it says hello and does the rest of the setup in chat. Everything else is under
   * More options, the full form.
   */
  private var oneSheet: some View {
    AgentFrame(title: "New agent", close: true, scrolls: false) {
      ScrollView {
        VStack(spacing: 20) {
          GhostView(look: draft.look, seed: draft.look.color, size: 118, interactive: true)
            .frame(width: 118, height: 118).padding(.top, 22).accessibilityHidden(true)
          TextField("Name your agent", text: $draft.name)
            .focused($naming)
            .font(.system(size: 17)).foregroundStyle(Palette.text).multilineTextAlignment(.center)
            .textInputAutocapitalization(.words).autocorrectionDisabled().submitLabel(.done)
            .onSubmit { if valid { create() } }
            .padding(.horizontal, 16).frame(height: 50)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Palette.card))
            .accessibilityLabel("Name").accessibilityIdentifier("new-name")
          if handleTaken { AgentError(text: "@\(draft.finalHandle()) is taken. Pick another name.") }
          LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 6), spacing: 10) {
            ForEach(BubbleLookPage.swatches, id: \.hex) { c in
              let on = c.hex.lowercased() == draft.look.color.lowercased()
              Button { draft.look.color = c.hex; draft.look.color2 = nil } label: {
                Circle().fill(Color(hex: c.hex)).frame(width: 32, height: 32)
                  .overlay { if on { Circle().stroke(Palette.text, lineWidth: 2).padding(-4) } }
                  .frame(width: 44, height: 44).contentShape(Circle())
              }
              .buttonStyle(.plain)
              .accessibilityLabel(c.name)
              .accessibilityAddTraits(on ? .isSelected : [])
              .accessibilityIdentifier("new-colour-\(c.name.lowercased())")
            }
          }
          // where it runs, on every New agent (board 16c), not only under more options
          CardGroup { RunsOnRow(selection: runsOn, id: "new-runs-on") { pickRunsOn($0) } }
          HStack(spacing: 5) {
            Text("Or").foregroundStyle(Palette.faint)
            Button { editingLook = true } label: { Text("change its shape").underline() }.accessibilityIdentifier("new-look")
            Text("·").foregroundStyle(Palette.faint)
            Button { naming = false; full = true } label: { Text("more options").underline() }.accessibilityIdentifier("new-full")
          }
          .font(.system(size: 14)).foregroundStyle(Palette.muted).buttonStyle(.plain)
        }
        .padding(.horizontal, 30)
      }
      .scrollDismissesKeyboard(.interactively)
      Button { create() } label: {
        Text(action.busy ? "Creating…" : "Create").font(.system(size: 17, weight: .semibold)).foregroundStyle(Palette.sheet)
          .frame(maxWidth: .infinity).frame(height: 52).background(Capsule().fill(Palette.text))
      }
      .buttonStyle(.press).disabled(!valid || action.busy).opacity(!valid || action.busy ? 0.4 : 1)
      .padding(.horizontal, 30).padding(.bottom, 14)
      .accessibilityLabel("Create agent").accessibilityIdentifier("new-create")
    }
  }

  /** Everything: where it runs, what it thinks with, templates, who can ask it, More options. */
  private var fullForm: some View {
      AgentFrame(title: "New agent", close: true, trailing: {
        Button { create() } label: {
          Text(action.busy ? "Creating" : "Create").font(.system(size: 16, weight: .semibold)).foregroundStyle(Palette.text)
            .padding(.horizontal, 16).frame(height: 44).glassPill()
        }
        .buttonStyle(.press).disabled(!valid || action.busy).opacity(!valid || action.busy ? 0.4 : 1)
        .accessibilityLabel("Create agent").accessibilityIdentifier("new-create")
      }) {
        VStack(spacing: 12) {
          GhostView(look: draft.look, seed: draft.look.color, size: 96, interactive: true).frame(width: 96, height: 96).accessibilityHidden(true)
          HStack(spacing: 8) {
            AgentChip(title: "Shuffle", symbol: "shuffle") { draft.look = GhostLook.shuffled() }.accessibilityIdentifier("new-shuffle")
            AgentChip(title: "Edit look", symbol: "paintpalette") { editingLook = true }.accessibilityIdentifier("new-look")
          }
        }.frame(maxWidth: .infinity).padding(.vertical, 4)

        FieldCard(label: "Name", text: $draft.name, prompt: "Nova").accessibilityIdentifier("new-name")
        if handleTaken { AgentError(text: "@\(draft.finalHandle()) is taken. Pick another name, or change the handle under More options.") }
        FieldCard(label: "What it does", text: $draft.does, prompt: "Optional. e.g. reviews pull requests").accessibilityIdentifier("new-does")

        if !external {
          CardCaption("Runs on")
          places
          if store.nodes.filter(\.usable).count > 1 { deviceRow }
        }
        CardGroup {
          NavigationLink { NewAgentHarness(draft: draft, node: node) } label: {
            RowLabel(title: "Harness", value: HarnessChoice.label(draft.harness), leading: { BrandLogo(id: draft.harness, symbol: "cpu", size: 26) })
          }.buttonStyle(.plain).accessibilityIdentifier("new-harness")
          if !external {
            NavigationLink { NewAgentModel(draft: draft) } label: {
              RowLabel(title: "Model", value: draft.model.isEmpty ? "Automatic" : draft.model, leading: { rowIcon("dial.medium") })
            }.buttonStyle(.plain).accessibilityIdentifier("new-model")
          }
        }
        if external {
          CardCaption("Set it up where it already runs. It connects to Bubble AI through the API or wisp-mcp.")
        } else {
          // the AI it would run on isn't signed in on its device: say so, with Sign in, before it's made
          HarnessSignInNotice(harness: draft.harness, node: node)
        }

        if !AgentTemplate.all.isEmpty {
          CardCaption("Start from")
          FlowLayout(spacing: 8) {
            ForEach(AgentTemplate.all) { template in
              AgentChip(title: template.name, on: draft.template == template.name) { apply(template) }
            }
          }
        }
        if askWho { who }
        CardGroup {
          NavigationLink { NewAgentMore(draft: draft, askWho: askWho) } label: {
            RowLabel(title: "More options", leading: { rowIcon("slider.horizontal.3") })
          }.buttonStyle(.plain).accessibilityIdentifier("new-more")
          if store.canManage {
            NavigationLink { AgentBring { agent in dismiss(); onCreated(agent) } } label: {
              RowLabel(title: "Bring in an agent you have", leading: { rowIcon("square.and.arrow.down") })
            }.buttonStyle(.plain).accessibilityIdentifier("new-bring")
          }
        }
      }
  }

  // MARK: where it runs

  /** The four Runs on tiles, two by two; one this device can't do says why and can't be picked. */
  private var places: some View {
    LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
      ForEach(AgentPlace.allCases) { p in
        let on = draft.place == p
        let ok = p.usable(node: node, computers: store.computers)
        Button { withAnimation(.snappy) { draft.place = p } } label: {
          VStack(alignment: .leading, spacing: 4) {
            Image(systemName: p.symbol).font(.system(size: 15)).foregroundStyle(on ? Palette.accent : Palette.muted)
            Text(p.title).font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.text).lineLimit(1)
            Text(p.line(node: node)).font(.system(size: 12)).foregroundStyle(Palette.faint).lineLimit(2).fixedSize(horizontal: false, vertical: true)
          }
          .frame(maxWidth: .infinity, minHeight: 78, alignment: .topLeading)
          .padding(12)
          .background(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).fill(Palette.card))
          .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(on ? Palette.accent : Palette.cardBorder, lineWidth: on ? 2 : 1))
          .contentShape(RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
          .opacity(ok ? 1 : 0.45)
        }
        .buttonStyle(.pressRow)
        .disabled(!ok)
        .accessibilityLabel("\(p.title). \(p.line(node: node))")
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("new-place-\(p.rawValue)")
      }
    }
  }

  /** Which device, when there's more than one: its AI runs there, and its own computer or screen is there. */
  private var deviceRow: some View {
    CardGroup {
      Menu {
        ForEach(store.nodes.filter(\.usable)) { n in
          Button { pickDevice(n.id) } label: { Label(n.name, systemImage: n.id == node?.id ? "checkmark" : "laptopcomputer") }
        }
      } label: {
        RowLabel(title: "Device", value: node?.name ?? "None", leading: { rowIcon("laptopcomputer") })
      }
      .accessibilityIdentifier("new-device")
    }
  }

  /** the quick sheet's Runs on: the shared computer, or the device it works right on */
  private var runsOn: RunsOn? {
    if draft.place == .shared { return .shared }
    return (draft.nodeId ?? firstNode).map { .device($0) }
  }

  private func pickRunsOn(_ choice: RunsOn) {
    switch choice {
    case .shared: draft.place = .shared
    case .device(let id):
      pickDevice(id)
      // on its own screen when that device can lend one, else right on the device without a computer
      draft.place = AgentPlace.screen.usable(node: node, computers: store.computers) ? .screen : .none
    }
  }

  private func pickDevice(_ id: String) {
    draft.nodeId = id
    // a choice the new device can't do goes back to the shared computer
    if !draft.place.usable(node: node, computers: store.computers) { draft.place = .shared }
    if let n = node, !(n.harnesses ?? []).contains(where: { $0.id == draft.harness }), let h = AddAgent.preferredHarness(store, node: id) { draft.harness = h }
  }

  @ViewBuilder private var who: some View {
    CardCaption("Who can ask it")
    Segments(options: [("me", "Only me"), ("anyone", "Anyone"), ("people", "Picked")], selection: $draft.respondTo, id: "new-who")
    if draft.respondTo == "people" {
      if store.otherPeople.isEmpty {
        CardCaption("Nobody else is here yet.")
      } else {
        CardGroup {
          ForEach(store.otherPeople) { person in
            ChoiceRow(title: person.preferredName ?? person.name, subtitle: person.role.capitalized, selected: draft.respondPeople.contains(person.id)) {
              if draft.respondPeople.contains(person.id) { draft.respondPeople.remove(person.id) } else { draft.respondPeople.insert(person.id) }
            }
          }
        }
      }
    }
  }

  /** New agent, already filled in from a kind of agent: a free name, its colour, its job and the apps here it starts with. */
  private func fill(from type: AgentType) {
    if draft.name.isEmpty { draft.name = MarketTemplates.freeName(type.name, taken: store.agents.map(\.name)) }
    draft.look = MarketTemplates.look(type)
    if draft.does.isEmpty { draft.does = String(type.role.prefix(60)) }
    draft.apps.formUnion(MarketTemplates.connectorIds(type, connectors: store.connectors))
    draft.template = type.name
  }

  private func apply(_ template: AgentTemplate) {
    if draft.template == template.name {
      draft.template = nil
      if draft.does == template.does { draft.does = "" }
      if draft.instructions == template.instructions { draft.instructions = "" }
      return
    }
    draft.template = template.name
    draft.does = template.does
    draft.instructions = template.instructions
  }

  // MARK: create

  /** The shared computer: the one there is, else made now (owners); nil when no device can run one yet. */
  private func sharedComputer() async -> String? {
    if let id = placement?.sharedComputerId { return id }
    guard store.isOwner else { return nil }
    let made: Computer? = try? await store.fetch { try await $0.post("/api/computers/shared", Empty()) }
    if made != nil { await store.refreshComputers() }
    return made?.id
  }

  private func create() {
    action.run {
      let d = draft
      let external = self.external
      var settings: Fields = ["appearance": AnyEncodable(d.look.resolved), "respondTo": AnyEncodable(askWho ? d.respondTo : "me")]
      if let role = d.roleText { settings["role"] = AnyEncodable(role) }
      if askWho && d.respondTo == "people" { settings["respondPeople"] = AnyEncodable(Array(d.respondPeople).sorted()) }
      var fields: Fields = [
        "name": AnyEncodable(d.name.trimmed), "handle": AnyEncodable(d.finalHandle()), "instructions": AnyEncodable(d.instructions),
        "harness": AnyEncodable(d.harness),
      ]
      if !external { fields["model"] = .nullable(d.model.trimmed) }
      let device = d.nodeId ?? firstNode
      if external {
        fields["nodeId"] = .null
      } else {
        fields["nodeId"] = .nullable(device ?? "")
        switch d.place {
        case .shared:
          if let shared = await sharedComputer() {
            // its AI stays on its device beside its sign-in; it works on the shared computer
            fields["computerId"] = AnyEncodable(shared)
          } else if placement?.advanced != true && store.isOwner {
            // no device can run the shared computer yet: Bubble AI gives it one as soon as one can
            fields["useDefaults"] = AnyEncodable(true)
          }
        case .own:
          guard let device else { throw API.Failure(status: 0, message: "Connect a computer first.") }
          fields["computerId"] = AnyEncodable(try await d.computerDraft.resolveVM(node: device, name: d.name.trimmed, store: store))
          if harnessRunsInVM(d.harness) { settings["runIn"] = AnyEncodable("computer") }
        case .screen:
          guard let device else { throw API.Failure(status: 0, message: "Connect a computer first.") }
          var id = store.computers.first { $0.kind == "device" && $0.nodeId == device }?.id
          if id == nil { id = try await ComputerChoice.screen.resolve(nodeId: device, agentName: d.name.trimmed, store: store) }
          if let id { fields["computerId"] = AnyEncodable(id) }
        case .none:
          settings["headless"] = AnyEncodable(true)
        }
      }
      fields["settings"] = AnyEncodable(settings)
      let agent = try await store.createAgent(fields)
      await AddAgent.giveAppsAndSkills(to: agent, apps: d.apps, skills: d.skills, store: store)
      dismiss()
      onCreated(agent)
    }
  }

  /** Apps and skills are given to it afterwards; the agent exists either way. */
  @MainActor static func giveAppsAndSkills(to agent: Agent, apps: Set<String>, skills: Set<String>, store: Store) async {
    for id in apps {
      guard let app = store.connectors.first(where: { $0.id == id }), !app.forAll else { continue }
      _ = try? await store.saveConnector(id, ["agentIds": AnyEncodable(Array(Set(app.agentIds ?? []).union([agent.id])).sorted())])
    }
    for id in skills {
      guard let skill = store.skills.first(where: { $0.id == id }), !skill.forAll else { continue }
      _ = try? await store.saveSkill(id, ["agentIds": AnyEncodable(Array(Set(skill.agentIds ?? []).union([agent.id])).sorted())])
    }
  }
}

// MARK: pages under New agent

/** What a new agent thinks with: the harnesses it can run on here, each with its mark. */
private struct NewAgentHarness: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @Bindable var draft: AgentDraft
  var node: AgentNode?

  private var installed: Set<String> { Set((node?.harnesses ?? []).map(\.id)) }
  /** the ones it can really run on: installed on the device, or in its own computer (which comes with them), or set up elsewhere */
  private var runnable: [HarnessChoice] {
    AddAgent.choices(store).filter { h in
      h.protocolName == "mcp" || installed.contains(h.id) || (draft.place == .own && harnessRunsInVM(h.id)) || h.id == draft.harness
    }
  }
  private var missing: [HarnessChoice] { AddAgent.choices(store).filter { h in !runnable.contains { $0.id == h.id } } }

  var body: some View {
    AgentFrame(title: "Harness", subtitle: "New agent") {
      CardGroup {
        ForEach(runnable) { h in
          PickRow(logo: h.id, title: h.label, subtitle: sub(h), selected: draft.harness == h.id, id: "new-harness-\(h.id)") {
            draft.harness = h.id
            draft.model = ""
            dismiss()
          }
        }
      }
      if !missing.isEmpty, let node {
        CardCaption("Not on \(node.name) yet")
        CardGroup {
          ForEach(missing) { h in
            NavigationLink { DeviceDetail(nodeId: node.id) } label: {
              RowLabel(title: h.label, value: "Install", leading: { BrandLogo(id: h.id, symbol: "cpu", size: 26) })
            }.buttonStyle(.plain)
          }
        }
      }
    }
  }

  private func sub(_ h: HarnessChoice) -> String? {
    if h.protocolName == "mcp" { return "Set up where it runs" }
    guard let node else { return nil }
    if !installed.contains(h.id) { return draft.place == .own ? "In its own computer" : nil }
    return node.harnessSignedIn(h.id) == false ? "Not signed in on \(node.name)" : "On \(node.name)"
  }
}

/** Model for a new agent: automatic, or an id you type. */
private struct NewAgentModel: View {
  @Bindable var draft: AgentDraft
  var body: some View {
    AgentFrame(title: "Model", subtitle: "New agent") {
      CardGroup { ChoiceRow(title: "Automatic", selected: draft.model.isEmpty) { draft.model = "" } }
      FieldCard(label: "Model id", text: $draft.model, prompt: "Leave empty for automatic", lowercase: true)
      CardCaption("Use the exact id your harness expects. Bubble AI passes it through unchanged. You can pick from its list once it's on a device.")
    }
  }
}

/** More options (agent-CreateMore.dc.html): handle, connected apps, skills, instructions, change defaults. */
private struct NewAgentMore: View {
  @Environment(Store.self) private var store
  @Bindable var draft: AgentDraft
  var askWho: Bool

  var body: some View {
    AgentFrame(title: "More options", subtitle: "New agent") {
      FieldCard(label: "Handle", text: Binding(get: { draft.handle.isEmpty ? "" : "@" + draft.handle }, set: { draft.handle = ManagementText.typingHandle($0.replacingOccurrences(of: "@", with: "")) }),
                prompt: "@" + (ManagementText.handle(draft.name).isEmpty ? "handle" : ManagementText.handle(draft.name)), lowercase: true)
      CardCaption("Letters a to z. Teammates type this to mention it.")
      CardGroup {
        NavigationLink { NewAgentPicks(title: "Connected apps", items: store.connectors.map { ($0.id, $0.name, $0.description ?? $0.category) }, locked: Set(store.connectors.filter(\.forAll).map(\.id)), picked: $draft.apps) } label: {
          RowLabel(title: "Connected apps", value: summary(draft.apps, all: store.connectors.filter(\.forAll).count), leading: { rowIcon("square.grid.2x2") })
        }.buttonStyle(.plain)
        NavigationLink { NewAgentPicks(title: "Skills", items: store.skills.map { ($0.id, $0.name, $0.plain?.does ?? $0.description) }, locked: Set(store.skills.filter(\.forAll).map(\.id)), picked: $draft.skills) } label: {
          RowLabel(title: "Skills", value: summary(draft.skills, all: store.skills.filter(\.forAll).count), leading: { rowIcon("bolt") })
        }.buttonStyle(.plain)
        NavigationLink { NewAgentInstructions(draft: draft) } label: {
          RowLabel(title: "Instructions", subtitle: draft.instructions.trimmed.isEmpty ? "Write how it should work" : AgentEditText.firstLine(draft.instructions), leading: { rowIcon("text.alignleft") })
        }.buttonStyle(.plain)
        if store.isOwner {
          NavigationLink { AgentDefaultsView() } label: { RowLabel(title: "Change defaults", subtitle: "Settings", leading: { rowIcon("gearshape") }) }.buttonStyle(.plain)
        }
      }
    }
  }

  /** what's picked plus what every agent gets anyway */
  private func summary(_ ids: Set<String>, all: Int) -> String { ids.count + all == 0 ? "None" : "\(ids.count + all)" }
}

private struct NewAgentPicks: View {
  var title: String
  var items: [(String, String, String?)]
  /** on for every agent already: shown on, and can't be turned off here */
  var locked: Set<String> = []
  @Binding var picked: Set<String>
  var body: some View {
    AgentFrame(title: title, subtitle: "New agent") {
      if items.isEmpty {
        AgentCard { Text("Nothing here yet.").font(.system(size: 15)).foregroundStyle(Palette.muted) }
      } else {
        CardGroup {
          ForEach(items, id: \.0) { item in
            if locked.contains(item.0) {
              SwitchRow(title: item.1, subtitle: "All agents", isOn: .constant(true)).disabled(true)
            } else {
              SwitchRow(title: item.1, subtitle: item.2, isOn: Binding(get: { picked.contains(item.0) }, set: { if $0 { picked.insert(item.0) } else { picked.remove(item.0) } }))
            }
          }
        }
      }
    }
  }
}

private struct NewAgentInstructions: View {
  @Bindable var draft: AgentDraft
  var body: some View {
    AgentFrame(title: "Instructions", subtitle: "New agent") {
      FlowLayout(spacing: 8) {
        ForEach(AgentEditText.snippets, id: \.self) { snippet in
          AgentChip(title: snippet, symbol: "plus") { draft.instructions = AgentEditText.insert(snippet, into: draft.instructions) }
        }
      }
      FieldCard(label: "Instructions", text: $draft.instructions, prompt: "What should it do, and how?", lines: 6...30)
      CardCaption("What it's responsible for, how it should work, and who to hand things to. Sent with every request.")
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
