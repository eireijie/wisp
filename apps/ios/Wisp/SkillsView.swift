import SwiftUI

/** The skills list now lives in the Marketplace; this opens it on the Skills tab. */
struct SkillsView: View {
  var body: some View { MarketplaceView(start: .skills) }
}

struct SkillDetail: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var skill: HelperSkill
  var library = false
  @State private var editing = false
  @State private var deleting = false
  @State private var action = FormAction()
  private var installed: HelperSkill? { store.skills.first { library ? $0.catalogId == skill.id : $0.id == skill.id } }
  private var current: HelperSkill { installed ?? skill }
  var body: some View {
    List {
      Section { Text(current.name).font(.title2.bold()); Text(current.description ?? "") }
      if let plain = skill.plain {
        Section("What it does") { Text(plain.does) }
        Section("What it needs") { Text(plain.needs) }
        Section("Example") { Text(plain.example).textSelection(.enabled) }
      }
      if let installed { TryItSection(skill: installed) }
      Section { TechnicalDetails(title: "Full instructions") { NoteMarkdown(text: current.content ?? "") } }
      if store.canManage {
        Section("Agents with this skill") {
          ForEach(store.agents) { agent in
            Toggle(agent.name, isOn: Binding(get: { installed?.agentIds?.contains(agent.id) == true }, set: { on in
              action.run {
                if let installed { try await store.setSkillAgent(installed.id, agent: agent.id, on: on) }
                else if on { try await store.saveSkill(nil, ["catalogId": AnyEncodable(skill.id), "agentIds": AnyEncodable([agent.id])]) }
              }
            })).disabled(action.busy)
          }
          if store.agents.isEmpty { Text("Add a helper first.") }
        }
        if installed != nil {
          Button("Edit") { editing = true }
          Button("Delete skill", role: .destructive) { deleting = true }
        } else { Button("Install") { action.run { try await store.saveSkill(nil, ["catalogId": AnyEncodable(skill.id), "agentIds": AnyEncodable([String]())]) } }.disabled(action.busy) }
      }
      InlineError(error: action.error)
    }.sectionScreen(current.name, id: "skill")
      .sheet(isPresented: $editing) { SkillEditor(skill: current) }
      .confirmationDialog("Delete this skill? It will be removed from every helper that has it.", isPresented: $deleting, titleVisibility: .visible) {
        Button("Delete skill", role: .destructive) { if let installed { action.run { try await store.deleteSkill(installed.id); dismiss() } } }
      }
  }
}

struct SkillEditor: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var skill: HelperSkill?
  @State private var name = ""
  @State private var description = ""
  @State private var content = ""
  @State private var what = ""
  @State private var when = ""
  @State private var result = ""
  @State private var tags = ""
  @State private var agents: Set<String> = []
  @State private var action = FormAction()
  private var guided: Bool { false }
  var body: some View {
    EditorSheet(title: skill == nil ? "Create a skill" : "Edit skill", action: action, valid: !name.trimmed.isEmpty && name.count <= 60 && (guided ? !what.trimmed.isEmpty : !content.trimmed.isEmpty) && description.count <= 500 && content.count <= 100_000, save: {
      action.run {
        let guide = GuideText.skill(name: name, what: what, when: when, result: result)
        let instructions = guided ? guide.content : content
        let use = guided ? guide.description : description.trimmed
        try await store.saveSkill(skill?.id, ["name": AnyEncodable(name.trimmed), "description": AnyEncodable(use), "content": AnyEncodable(instructions), "tags": AnyEncodable(tags.split(separator: ",").map { String($0).trimmed }.filter { !$0.isEmpty }), "agentIds": AnyEncodable(Array(agents).sorted())]); dismiss()
      }
    }) {
      TextField("Name", text: $name)
      if guided {
        TextField("What should your helper do?", text: $what, axis: .vertical).lineLimit(3...8)
        TextField("When should it use this?", text: $when, axis: .vertical).lineLimit(2...5)
        TextField("What does a good result look like?", text: $result, axis: .vertical).lineLimit(3...8)
      } else {
        TextField("When to use it", text: $description, axis: .vertical)
        TextField("Instructions (markdown)", text: $content, axis: .vertical).lineLimit(8...25)
      }
      TechnicalDetails(title: "Tags") { TextField("Tags (comma-separated)", text: $tags) }
      AgentSelection(selected: $agents)
    }.onAppear { name = skill?.name ?? ""; description = skill?.description ?? ""; content = skill?.content ?? ""; tags = skill?.tags?.joined(separator: ", ") ?? ""; agents = Set(skill?.agentIds ?? []) }
  }
}
