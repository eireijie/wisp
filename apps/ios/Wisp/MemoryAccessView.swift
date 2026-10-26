import SwiftUI

/** Words for rules: who they're for and what they allow. */
enum RuleWords {
  @MainActor static func subject(_ s: MemorySubject, store: Store) -> String {
    switch s.kind {
    case "members": return "Everyone (members)"
    case "guests": return "Guests"
    case "all_agents": return "All agents"
    case "user": return store.members.first { $0.id == s.id }?.name ?? "Someone"
    case "agent": return store.agent(s.id ?? "")?.name ?? "An agent"
    case "team": return "Team “\(s.name ?? "")”"
    case "role": return "\(s.role ?? "") on “\(s.team ?? "")”"
    default: return s.name ?? s.kind
    }
  }
  static func level(_ value: String) -> String { ["none": "No access", "read": "Read", "edit": "Edit", "manage": "Full"][value] ?? value }
  static func levelHint(_ value: String) -> String {
    ["none": "Cannot see it", "read": "Can read, cannot change", "edit": "Can read and write", "manage": "Can read, write and share"][value] ?? ""
  }
  static func isAgent(_ kind: String) -> Bool { ["agent", "team", "role", "all_agents"].contains(kind) }
  /** a folder in words ("Shared / projects", "Ghosty's notes", "Everything") */
  @MainActor static func place(_ path: String, store: Store) -> String {
    let clean = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    if clean.isEmpty { return "Everything" }
    if clean == "shared" { return "Shared" }
    if let friendly = store.friendlyFolder(clean) { return friendly }
    let parts = clean.components(separatedBy: "/")
    return parts.enumerated().map { i, seg in i == parts.count - 1 && seg.hasSuffix(".md") ? String(seg.dropLast(3)) : store.folderLabel(seg, parent: i > 0 ? parts[i - 1] : "") }.joined(separator: " / ")
  }
}

/** The rules as cards: agents first, then people. Tapping a row edits it when you can manage. */
struct MemoryRuleCards: View {
  @Environment(Store.self) private var store
  var rules: [MemoryRule]
  var canEdit: Bool
  var onEdit: (MemoryRule) -> Void

  var body: some View {
    let agents = rules.filter { RuleWords.isAgent($0.subject.kind) }
    let people = rules.filter { !RuleWords.isAgent($0.subject.kind) }
    if !agents.isEmpty { SectionCaption("Agents"); CardGroup { ForEach(agents) { row($0) } } }
    if !people.isEmpty { SectionCaption("People"); CardGroup { ForEach(people) { row($0) } } }
    if rules.isEmpty { CardCaption("No rules yet. Agents only see Shared, their own folders and their teams' folders.") }
  }

  private func row(_ rule: MemoryRule) -> some View {
    let editable = canEdit && rule.builtin != true
    return Button { if editable { onEdit(rule) } } label: {
      RowLabel(title: RuleWords.subject(rule.subject, store: store), subtitle: RuleWords.place(rule.path, store: store) + (rule.startup == true ? " · loads at startup" : ""), value: RuleWords.level(rule.level), chevron: editable) {
        if rule.subject.kind == "agent", let agent = store.agent(rule.subject.id ?? "") { AgentAvatar(agent: agent, size: 40, showStatus: false) }
        else { Image(systemName: rule.subject.kind == "user" ? "person" : RuleWords.isAgent(rule.subject.kind) ? "person.3" : "person.2").font(.system(size: 18)).foregroundStyle(Palette.muted).frame(width: 40) }
      }
    }.buttonStyle(.plain).accessibilityIdentifier("memory-rule-row")
  }
}

/** Who can see and edit what, across all of memory: the rules, and a pill to add one. */
struct MemoryAccessRulesView: View {
  @Environment(Store.self) private var store
  @State private var rules: [MemoryRule] = []
  @State private var loaded = false
  @State private var editing: RuleDraft?
  @State private var action = FormAction()

  var body: some View {
    MemoryScreen(title: "Who can see and edit what", id: "memory-access-rules") {
      VStack(alignment: .leading, spacing: 6) {
        Text("How these rules work").font(.system(size: 15, weight: .bold)).foregroundStyle(Palette.text)
        Text("Everyone shares the Shared folder. Each helper has a private folder. A rule on a folder or note changes who can read or write it.").font(.system(size: 15)).foregroundStyle(Palette.muted)
      }.padding(18).frame(maxWidth: .infinity, alignment: .leading).background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
      InlineError(error: action.error)
      if !loaded && action.error == nil { ProgressView().frame(maxWidth: .infinity).padding(30) }
      MemoryRuleCards(rules: rules, canEdit: store.isOwner) { editing = RuleDraft(rule: $0) }
    }
    .safeAreaInset(edge: .bottom) {
      if store.isOwner { PillAction(title: "Add a memory rule", symbol: "plus", id: "add-memory-rule") { editing = RuleDraft(rule: nil) }.padding(.bottom, 12) }
    }
    .sheet(item: $editing, onDismiss: { Task { await load() } }) { MemoryRuleEditor(draft: $0) }
    .task { await load() }
  }

  private func load() async {
    do { rules = try await store.connection().get("/api/access/rules"); loaded = true } catch { action.error = error.localizedDescription; loaded = true }
  }
}

/** One note's or folder's own rules, plus how much access you have there. */
struct MemoryAccessView: View {
  @Environment(Store.self) private var store
  var path: String
  @State private var access: MemoryAccess?
  @State private var editing: RuleDraft?
  @State private var action = FormAction()
  private var canManage: Bool { access?.level == "manage" }

  var body: some View {
    MemoryScreen(title: "Who can see and edit what", id: "memory-access") {
      Text(RuleWords.place(path, store: store)).font(.system(size: 15)).foregroundStyle(Palette.faint).padding(.horizontal, 6).textSelection(.enabled)
      if let access {
        CardGroup { RowLabel(title: "Your access", value: RuleWords.level(access.level), chevron: false) { Image(systemName: "lock").font(.system(size: 18)).foregroundStyle(Palette.muted) } }
      }
      InlineError(error: action.error)
      if access == nil && action.error == nil { ProgressView().frame(maxWidth: .infinity).padding(30) }
      if let access { MemoryRuleCards(rules: access.rules ?? [], canEdit: canManage) { editing = RuleDraft(rule: $0) } }
    }
    .safeAreaInset(edge: .bottom) {
      if canManage { PillAction(title: "Add a memory rule", symbol: "plus", id: "add-memory-rule") { editing = RuleDraft(rule: nil, path: path) }.padding(.bottom, 12) }
    }
    .sheet(item: $editing, onDismiss: { Task { await load() } }) { MemoryRuleEditor(draft: $0, pathLocked: true) }
    .task { await load() }
  }
  private func load() async {
    do { access = try await store.memoryAccess(path) } catch { action.error = error.localizedDescription }
  }
}

/** What the rule editor starts from: an existing rule, or a blank one for a path. */
struct RuleDraft: Identifiable {
  var id = UUID()
  var rule: MemoryRule?
  var path = ""
}

/** "Rule for Ghosty": pick the folder or note, who it's for, what they can do, and whether the helper is always reminded. */
struct MemoryRuleEditor: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var draft: RuleDraft
  var pathLocked = false
  @State private var path = ""
  @State private var who = "all_agents"
  @State private var level = "read"
  @State private var startup = false
  @State private var removing = false
  @State private var action = FormAction()

  private var kind: String { who.components(separatedBy: ":").first ?? who }
  private var forAgents: Bool { RuleWords.isAgent(kind) }
  private var guest: Bool { who == "guests" || store.members.contains { who == "user:\($0.id)" && $0.role == "guest" } }
  private var levels: [String] { forAgents ? ["none", "read", "edit"] : guest ? ["none", "read"] : ["none", "read", "edit", "manage"] }
  private var roles: [(team: String, role: String)] {
    store.teams.flatMap { team in Set((team.members ?? []).compactMap(\.role).filter { !$0.isEmpty }).sorted().map { (team.name, $0) } }
  }
  private var title: String { draft.rule.map { "Rule for \(RuleWords.subject($0.subject, store: store))" } ?? "Add a memory rule" }

  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: title) { dismiss() }
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          SectionCaption("Folder or note")
          if draft.rule != nil || pathLocked {
            CardGroup { RowLabel(title: RuleWords.place(path, store: store), chevron: false) { Image(systemName: "folder").font(.system(size: 18)).foregroundStyle(Palette.muted) } }
          } else {
            MemoryFieldCard { TextField("Shared, or a folder or note", text: $path).textInputAutocapitalization(.never).autocorrectionDisabled().foregroundStyle(Palette.text) }
            CardCaption("A folder covers everything inside it. Leave empty for the whole vault.")
          }
          if draft.rule == nil {
            SectionCaption("Who")
            CardGroup {
              HStack {
                Text("Who").font(.system(size: 15)).foregroundStyle(Palette.text)
                Spacer()
                Picker("Who", selection: $who) {
                  Section("Agents") {
                    Text("All agents").tag("all_agents")
                    ForEach(store.teams) { Text("Team “\($0.name)”").tag("team:\($0.name)") }
                    ForEach(roles, id: \.role) { Text("\($0.role) on “\($0.team)”").tag("role:\($0.team)/\($0.role)") }
                    ForEach(store.agents) { Text("@\($0.handle)").tag("agent:\($0.id)") }
                  }
                  Section("People") {
                    Text("Everyone (members)").tag("members")
                    Text("Guests").tag("guests")
                    ForEach(store.members) { Text($0.name).tag("user:\($0.id)") }
                  }
                }.labelsHidden().tint(Palette.muted)
              }.padding(.horizontal, 18).frame(minHeight: 54)
            }
          }
          SectionCaption("Access")
          CardGroup {
            ForEach(levels, id: \.self) { value in
              Button { level = value } label: {
                HStack(spacing: 12) {
                  VStack(alignment: .leading, spacing: 2) {
                    Text(value == "manage" ? "Full" : RuleWords.level(value)).font(.system(size: 15)).foregroundStyle(Palette.text)
                    Text(RuleWords.levelHint(value)).font(.system(size: 13)).foregroundStyle(Palette.faint)
                  }
                  Spacer()
                  RadioMark(on: level == value)
                }.padding(.horizontal, 18).frame(minHeight: 62).contentShape(Rectangle())
              }.buttonStyle(.plain).accessibilityIdentifier("rule-level-\(value)")
            }
          }
          if forAgents {
            CardGroup {
              Toggle(isOn: $startup) {
                VStack(alignment: .leading, spacing: 2) {
                  Text("Always remind this helper of this note").font(.system(size: 15)).foregroundStyle(Palette.text)
                  Text("Loads at startup").font(.system(size: 13)).foregroundStyle(Palette.faint)
                }
              }.padding(.horizontal, 18).padding(.vertical, 10).tint(Palette.blue)
            }
          }
          InlineError(error: action.error)
          if draft.rule != nil, draft.rule?.builtin != true {
            Button { removing = true } label: { Text("Remove rule").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.red).frame(maxWidth: .infinity) }.buttonStyle(.plain).padding(.top, 8).accessibilityIdentifier("remove-rule")
            CardCaption("Removing it goes back to what the folder already allows.").multilineTextAlignment(.center)
          }
        }.padding(.horizontal, 18).padding(.top, 6)
      }
      PillAction(title: "Save", symbol: "checkmark", enabled: !action.busy, id: "save-rule") { save() }.padding(.vertical, 12)
    }
    .background(Palette.sheet.ignoresSafeArea()).presentationBackground(Palette.sheet).presentationCornerRadius(Corner.sheet)
    .onAppear {
      if let rule = draft.rule {
        path = rule.path; level = rule.level; startup = rule.startup == true
        who = Self.key(rule.subject)
      } else { path = draft.path }
    }
    .onChange(of: who) { if !levels.contains(level) { level = "read" } }
    .confirmationDialog("Remove this rule? Access will be inherited from its folder.", isPresented: $removing, titleVisibility: .visible) {
      Button("Remove rule", role: .destructive) { if let rule = draft.rule { action.run { try await store.connection().delete("/api/access/\(rule.id)"); store.memoryVersion += 1; dismiss() } } }
    }
  }

  static func key(_ s: MemorySubject) -> String {
    switch s.kind {
    case "user", "agent": return "\(s.kind):\(s.id ?? "")"
    case "team": return "team:\(s.name ?? "")"
    case "role": return "role:\(s.team ?? "")/\(s.role ?? "")"
    default: return s.kind
    }
  }

  private func save() {
    action.run {
      let parts = who.components(separatedBy: ":")
      let value = parts.dropFirst().joined(separator: ":")
      var subject = MemorySubject(kind: parts[0])
      switch parts[0] {
      case "user", "agent": subject.id = value
      case "team": subject.name = value
      case "role": subject.team = value.components(separatedBy: "/").first; subject.role = value.components(separatedBy: "/").dropFirst().joined(separator: "/")
      default: break
      }
      try await store.setMemoryAccess(path: path.trimmed, subject: subject, level: levels.contains(level) ? level : "read", startup: forAgents && startup)
      dismiss()
    }
  }
}
