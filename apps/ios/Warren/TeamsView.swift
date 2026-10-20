import SwiftUI

struct TeamsView: View {
  @Environment(Store.self) private var store
  @State private var creating = false
  @State private var action = FormAction()
  var body: some View {
    List {
      if !store.agents.isEmpty {
        Section("Lead") {
          Text("Takes every task nobody assigned, splits it up and hands the pieces to agents by role.").font(.footnote)
          if store.isOwner {
            HelperPicker(title: "Lead agent", selection: Binding(get: { store.taskLeadOverride ?? "" }, set: { id in action.run { try await store.saveTaskLead(id) } }), none: "Automatic").disabled(action.busy)
          } else { Text(store.agent(store.taskLead ?? "")?.name ?? "Automatic") }
        }
      }
      InlineError(error: action.error)
      if store.teams.isEmpty { Text("No teams yet.").foregroundStyle(.secondary) }
      ForEach(store.teams) { team in NavigationLink("\(team.emoji ?? "") \(team.name)") { TeamDetail(team: team) } }
    }.sectionScreen("Teams", id: "teams")
      .toolbar { if store.canManage { Button("New team", systemImage: "plus") { creating = true } } }
      .sheet(isPresented: $creating) { TeamEditor() }
      .task { do { try await store.refreshTeams(); try await store.refreshTaskLead() } catch { action.error = error.localizedDescription } }
      .refreshable { do { try await store.refreshTeams(); try await store.refreshTaskLead() } catch { action.error = error.localizedDescription } }
  }
}

struct TeamDetail: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var team: WorkspaceTeam
  @State private var editing = false
  @State private var adding = false
  @State private var removing = false
  @State private var member: TeamAgent?
  @State private var action = FormAction()
  private var current: WorkspaceTeam { store.teams.first { $0.id == team.id } ?? team }
  var body: some View {
    List {
      Section {
        Text(current.description ?? "")
        LabeledContent("Lead", value: store.agent(current.leadId ?? "")?.name ?? "None")
        LabeledContent("Reports to", value: store.agent(current.reportsTo ?? "")?.name ?? "Nobody")
        if let channel = store.channels.first(where: { $0.id == current.channelId }) {
          NavigationLink("#\(channel.name)") { ChannelView(channel: channel) }
          NavigationLink("People in the team channel") { ChannelDetails(channel: channel) }
        }
        if let folder = current.folder { NavigationLink("Team memory") { MemoryView(folder: folder) } }
      }
      Section("Members") {
        ForEach(current.members ?? []) { agent in
          VStack(alignment: .leading, spacing: 5) {
            Text(store.agent(agent.agentId)?.name ?? "Removed agent").font(.headline)
            Text(agent.role ?? "").font(.caption)
            if let notes = agent.roleNotes, !notes.isEmpty { Text(notes).font(.subheadline) }
            if store.canManage { Button("Edit member") { member = agent } }
          }
        }
        if store.canManage { Button("Add member") { adding = true } }
      }
      if store.canManage { Button("Edit team") { editing = true }; Button("Delete team", role: .destructive) { removing = true } }
      InlineError(error: action.error)
    }.sectionScreen(current.name, id: "team")
      .sheet(isPresented: $editing) { TeamEditor(team: current) }
      .sheet(isPresented: $adding) { TeamMemberEditor(team: current) }
      .sheet(item: $member) { TeamMemberEditor(team: current, member: $0) }
      .confirmationDialog("Delete this team? Its channel and memory stay.", isPresented: $removing, titleVisibility: .visible) {
        Button("Delete team", role: .destructive) { action.run { try await store.deleteTeam(current.id); dismiss() } }
      }
  }
}

struct TeamEditor: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var team: WorkspaceTeam?
  @State private var name = ""
  @State private var emoji = ""
  @State private var description = ""
  @State private var lead = ""
  @State private var boss = ""
  @State private var repo = ""
  @State private var branch = "main"
  @State private var agents: Set<String> = []
  @State private var action = FormAction()
  var body: some View {
    EditorSheet(title: team == nil ? "New team" : "Edit team", action: action, valid: !name.trimmed.isEmpty && name.count <= 40 && description.count <= 4000 && (lead.isEmpty || lead != boss) && branch.range(of: "^[\\w./-]{1,100}$", options: .regularExpression) != nil, save: {
      action.run {
        var body: Fields = ["emoji": AnyEncodable(emoji), "description": AnyEncodable(description), "leadId": .nullable(lead), "reportsTo": .nullable(boss), "repo": .nullable(repo), "baseBranch": AnyEncodable(branch)]
        if team == nil { body["name"] = AnyEncodable(name.trimmed); body["members"] = AnyEncodable(agents.sorted().map { TeamAgent(agentId: $0) }) }
        try await store.saveTeam(team?.id, body); dismiss()
      }
    }) {
      TextField("Name", text: $name).disabled(team != nil)
      if team != nil { Text("Team names are fixed after creation.").font(.footnote).foregroundStyle(.secondary) }
      TextField("Emoji", text: $emoji)
      TextField("Description", text: $description, axis: .vertical).lineLimit(3...8)
      HelperPicker(title: "Lead", selection: $lead)
      HelperPicker(title: "Reports to", selection: $boss, none: "Nobody")
      TechnicalDetails(title: "Repository") {
        TextField("Repository", text: $repo).textInputAutocapitalization(.never).autocorrectionDisabled()
        TextField("Base branch", text: $branch).textInputAutocapitalization(.never).autocorrectionDisabled()
      }
      if team == nil { AgentSelection(selected: $agents) }
    }.onAppear { name = team?.name ?? ""; emoji = team?.emoji ?? ""; description = team?.description ?? ""; lead = team?.leadId ?? ""; boss = team?.reportsTo ?? ""; repo = team?.repo ?? ""; branch = team?.baseBranch ?? "main" }
  }
}

struct TeamMemberEditor: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var team: WorkspaceTeam
  var member: TeamAgent?
  @State private var agent = ""
  @State private var role = ""
  @State private var notes = ""
  @State private var manager = ""
  @State private var removing = false
  @State private var action = FormAction()
  var body: some View {
    EditorSheet(title: member == nil ? "Add member" : "Edit member", action: action, valid: !agent.isEmpty && role.count <= 60 && notes.count <= 4000 && manager != agent, save: {
      action.run { try await store.setTeamAgent(team.id, agent: agent, fields: ["role": AnyEncodable(role.trimmed), "roleNotes": AnyEncodable(notes), "managerId": .nullable(manager)]); dismiss() }
    }) {
      HelperPicker(title: "Agent", selection: $agent).disabled(member != nil)
      TextField("Role", text: $role)
      TextField("Role notes", text: $notes, axis: .vertical).lineLimit(3...8)
      Picker("Reports to", selection: $manager) {
        Text("Nobody").tag("")
        ForEach((team.members ?? []).filter { $0.agentId != agent }) { member in Text(store.agent(member.agentId)?.name ?? member.agentId).tag(member.agentId) }
      }
      if member != nil { Button("Remove member", role: .destructive) { removing = true } }
    }.onAppear { agent = member?.agentId ?? ""; role = member?.role ?? ""; notes = member?.roleNotes ?? ""; manager = member.map { $0.managerId ?? "" } ?? (team.leadId ?? "") }
      .confirmationDialog("Remove this agent from the team?", isPresented: $removing, titleVisibility: .visible) {
        Button("Remove member", role: .destructive) { action.run { try await store.setTeamAgent(team.id, agent: agent, fields: nil); dismiss() } }
      }
  }
}
