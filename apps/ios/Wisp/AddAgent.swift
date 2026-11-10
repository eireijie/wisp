import SwiftUI

/** Everything a new agent is being given, shared by the create screen and the pages under More options. */
@MainActor @Observable
final class AgentDraft {
  // every new agent starts white with a face and outfit of its own, picked once (typing its name doesn't change it)
  var look = GhostLook.newAgent()
  var name = ""
  var does = ""
  var instructions = ""
  var custom = false
  var harness = "claude-code"
  var model = ""
  /** "vm:<device>", "share:<computer>", "later" (decide later) or "none" (headless) */
  var computer = "later"
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
                  instructions: "## What it owns\n- First drafts, edits and summaries\n\n## Ask before\n- Sending anything outside Wisp\n\n## Reply style\n- Plain words, short sentences."),
  ]
}

/**
 * New agent (agent-Create / CreateCustom / CreateMore .dc.html): one screen with a name, what it
 * does, and where it runs: your defaults, or Customize for the harness, model and computer. Rare
 * knobs (handle, apps, skills, instructions) are under More options. Bringing in an agent that
 * already exists is the row near the bottom.
 */
struct AddAgent: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  /** start on this device (from its page) */
  var nodeId: String? = nil
  var onCreated: (Agent) -> Void

  @State private var draft = AgentDraft()
  @State private var editingLook = false
  @State private var action = FormAction()

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
    return usable.first { $0.id == nodeId }?.id ?? usable.first { $0.online }?.id ?? usable.first?.id
  }

  var body: some View {
    NavigationStack {
      AgentFrame(title: "New agent", close: true) {
        VStack(spacing: 12) {
          GhostView(look: draft.look, seed: draft.finalHandle(), size: 96, interactive: true).frame(width: 96, height: 96).accessibilityHidden(true)
          HStack(spacing: 8) {
            AgentChip(title: "Shuffle its look", symbol: "shuffle") { draft.look = GhostLook.shuffled() }.accessibilityIdentifier("new-shuffle")
            AgentChip(title: "Edit look", symbol: "paintpalette") { editingLook = true }.accessibilityIdentifier("new-look")
          }
        }.frame(maxWidth: .infinity).padding(.vertical, 4)

        FieldCard(label: "Name", text: $draft.name, prompt: "Nova").accessibilityIdentifier("new-name")
        if handleTaken { AgentError(text: "@\(draft.finalHandle()) is taken. Pick another name, or change the handle under More options.") }
        FieldCard(label: "What it does", text: $draft.does, prompt: "Optional. e.g. reviews pull requests").accessibilityIdentifier("new-does")

        Segments(options: [(false, "Use defaults"), (true, "Customize")], selection: $draft.custom, id: "new-mode")
        if draft.custom { customize } else { defaults }
        // the AI it would run on isn't signed in on its device: say so, with Sign in, before it's made
        if !external, let harness = draft.custom ? draft.harness : (store.agentDefaults?.harness ?? AddAgent.preferredHarness(store, node: firstNode)) {
          HarnessSignInNotice(harness: harness, node: store.nodes.first { $0.id == (draft.custom ? (draft.computer.hasPrefix("vm:") ? String(draft.computer.dropFirst(3)) : firstNode) : (store.agentDefaults?.nodeId ?? firstNode)) })
        }

        if !AgentTemplate.all.isEmpty {
          CardCaption("Start from a template (optional)")
          FlowLayout(spacing: 8) {
            ForEach(AgentTemplate.all) { template in
              AgentChip(title: template.name, on: draft.template == template.name) { apply(template) }
            }
          }
        }

        if store.canManage {
          CardGroup {
            NavigationLink { AgentBring { agent in dismiss(); onCreated(agent) } } label: {
              RowLabel(title: "Already have an agent? Bring it in", leading: { rowIcon("square.and.arrow.down") })
            }.buttonStyle(.plain).accessibilityIdentifier("new-bring")
          }
        }
        AgentError(text: action.error)
        PillButton(title: "Create agent", busy: action.busy, id: "new-create") { create() }.disabled(!valid || action.busy)
      }
      .sheet(isPresented: $editingLook) { LookEditor(look: $draft.look, name: draft.name, seed: draft.finalHandle()) }
    }
    .agentSheet()
    .interactiveDismissDisabled(action.busy)
    .task {
      await store.refreshAgentDefaults()
      do { try await store.refreshManagement() } catch { action.error = error.localizedDescription }
      try? await store.refreshSkills()
      try? await store.refreshConnectors()
      draft.harness = store.agentDefaults?.harness ?? AddAgent.preferredHarness(store, node: firstNode) ?? "claude-code"
      draft.model = store.agentDefaults?.model ?? ""
      if store.agentDefaults?.computer != "none", let node = (nodeId != nil && firstNode == nodeId ? nodeId : nil) ?? store.agentDefaults?.nodeId ?? firstNode { draft.computer = "vm:\(node)" }
    }
  }

  // MARK: defaults and customize

  private var defaults: some View {
    let summary = store.defaultsSummary
    return CardGroup {
      Button { draft.custom = true } label: {
        RowLabel(title: "Harness it runs on", value: (store.agentDefaults?.harness ?? AddAgent.preferredHarness(store, node: firstNode)).map(HarnessChoice.label) ?? "Claude Code", leading: { rowIcon("cpu") })
      }.buttonStyle(.plain)
      Button { draft.custom = true } label: {
        RowLabel(title: "Model", value: store.agentDefaults?.model ?? "Harness default", leading: { rowIcon("dial.medium") })
      }.buttonStyle(.plain)
      RowLabel(title: "Computer", value: summary.computer, chevron: false, leading: { rowIcon("desktopcomputer") })
      if store.isOwner {
        NavigationLink { AgentDefaultsView() } label: { RowLabel(title: "Change defaults", leading: { rowIcon("gearshape") }) }.buttonStyle(.plain)
      }
    }
  }

  @ViewBuilder private var customize: some View {
    CardCaption("Harness it runs on")
    FlowLayout(spacing: 8) {
      ForEach(Self.choices(store)) { choice in
        AgentChip(title: choice.label, on: draft.harness == choice.id) { draft.harness = choice.id }
      }
    }
    if external {
      CardCaption("Set up where it already runs. It connects to Wisp through the API or wisp-mcp.")
    } else {
      CardGroup {
        NavigationLink { NewAgentModel(draft: draft) } label: {
          RowLabel(title: "Model", value: draft.model.isEmpty ? "Automatic" : draft.model, leading: { rowIcon("dial.medium") })
        }.buttonStyle(.plain)
        NavigationLink { NewAgentComputer(draft: draft) } label: {
          RowLabel(title: "Runs on", value: computerText, leading: { rowIcon("desktopcomputer") })
        }.buttonStyle(.plain)
        Button { draft.computer = "later" } label: {
          RowLabel(title: "Decide later", chevron: false, leading: { rowIcon("clock") })
            .overlay(alignment: .trailing) { if draft.computer == "later" { Radio(on: true).padding(.trailing, 18) } }
        }.buttonStyle(.plain)
      }
    }
    if askWho {
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
    CardGroup {
      NavigationLink { NewAgentMore(draft: draft, askWho: askWho) } label: {
        RowLabel(title: "More options")
      }.buttonStyle(.plain).accessibilityIdentifier("new-more")
    }
  }

  private var computerText: String {
    let c = draft.computer
    if c.hasPrefix("vm:") { return "New computer on " + (store.nodes.first { $0.id == String(c.dropFirst(3)) }?.name ?? "a device") }
    if c.hasPrefix("share:") { return store.computers.first { $0.id == String(c.dropFirst(6)) }?.name ?? "A computer" }
    return c == "none" ? "No computer" : "Decide later"
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

  private func create() {
    action.run {
      let d = draft
      let external = self.external
      var settings: Fields = ["appearance": AnyEncodable(d.look.resolved), "respondTo": AnyEncodable(askWho ? d.respondTo : "me")]
      if let role = d.roleText { settings["role"] = AnyEncodable(role) }
      if askWho && d.respondTo == "people" { settings["respondPeople"] = AnyEncodable(Array(d.respondPeople).sorted()) }
      var fields: Fields = [
        "name": AnyEncodable(d.name.trimmed), "handle": AnyEncodable(d.finalHandle()), "instructions": AnyEncodable(d.instructions),
      ]
      if d.custom {
        fields["harness"] = AnyEncodable(d.harness)
        fields["model"] = .nullable(d.model.trimmed)
        if external {
          fields["nodeId"] = .null
        } else if d.computer.hasPrefix("vm:") {
          let node = String(d.computer.dropFirst(3))
          fields["nodeId"] = AnyEncodable(node)
          fields["computerId"] = AnyEncodable(try await d.computerDraft.resolveVM(node: node, name: d.name.trimmed, store: store))
          settings["runIn"] = AnyEncodable("computer")
        } else if d.computer.hasPrefix("share:"), let c = store.computers.first(where: { $0.id == String(d.computer.dropFirst(6)) }) {
          fields["computerId"] = AnyEncodable(c.id)
          let node = c.nodeId.flatMap { id in store.nodes.first { $0.id == id && $0.usable }?.id } ?? firstNode
          fields["nodeId"] = .nullable(node ?? "")
          if c.kind == "vm", c.nodeId == node, harnessRunsInVM(d.harness) { settings["runIn"] = AnyEncodable("computer") }
        } else if d.computer == "none" {
          fields["nodeId"] = .nullable(firstNode ?? "")
          settings["headless"] = AnyEncodable(true)
        } else {
          // decide later: on a device, no computer yet
          fields["nodeId"] = .nullable(firstNode ?? "")
        }
      } else {
        fields["useDefaults"] = AnyEncodable(true)
        // started from a device's page: the agent goes there, not to the default device
        if let start = self.nodeId, firstNode == start { fields["nodeId"] = AnyEncodable(start) }
        // hubs without agent defaults still need a harness and a device
        if store.agentDefaults == nil {
          fields["harness"] = AnyEncodable(AddAgent.preferredHarness(store, node: firstNode) ?? "claude-code")
          fields["nodeId"] = .nullable(firstNode ?? "")
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

// MARK: pages under Customize

/** Model for a new agent: automatic, or an id you type. */
private struct NewAgentModel: View {
  @Bindable var draft: AgentDraft
  var body: some View {
    AgentFrame(title: "Model", subtitle: "New agent") {
      CardGroup { ChoiceRow(title: "Automatic", selected: draft.model.isEmpty) { draft.model = "" } }
      FieldCard(label: "Model id", text: $draft.model, prompt: "Leave empty for automatic", lowercase: true)
      CardCaption("Use the exact id your harness expects. Wisp passes it through unchanged. You can pick from its list once it's on a device.")
    }
  }
}

/** Where a new agent works: a new computer on a device, one that exists, or none. */
private struct NewAgentComputer: View {
  @Environment(Store.self) private var store
  @Bindable var draft: AgentDraft

  var body: some View {
    AgentFrame(title: "Runs on", subtitle: "New agent") {
      CardGroup {
        ForEach(store.nodes.filter(\.usable)) { node in
          ChoiceRow(title: "New computer on \(node.name)", subtitle: node.online ? "Online" : "Offline", selected: draft.computer == "vm:\(node.id)") { draft.computer = "vm:\(node.id)" }
        }
        ForEach(store.computers) { c in
          ChoiceRow(title: "Share \(c.name)", subtitle: "It uses the same files, browser and sign-ins", selected: draft.computer == "share:\(c.id)") { draft.computer = "share:\(c.id)" }
        }
        ChoiceRow(title: "No computer", subtitle: "It can think and write, but can't use apps or a screen", selected: draft.computer == "none") { draft.computer = "none" }
        ChoiceRow(title: "Decide later", selected: draft.computer == "later") { draft.computer = "later" }
      }
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
