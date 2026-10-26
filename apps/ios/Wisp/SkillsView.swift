import SwiftUI

/** The skills list now lives in the Marketplace; this opens it on the Skills tab. */
struct SkillsView: View {
  var body: some View { MarketplaceView(start: .skills) }
}

/** A skill's page: what it does and needs, an example, its full instructions, Try it and Install (or, once added, who has it). */
struct SkillDetail: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var skill: HelperSkill
  var library = false
  @State private var editing = false
  @State private var deleting = false
  @State private var installing = false
  @State private var trying = false
  @State private var sharing = false
  @State private var chat: ChatTarget?
  @State private var showInstructions = false
  @State private var action = FormAction()
  private var installed: HelperSkill? { store.skills.first { library ? $0.catalogId == skill.id : $0.id == skill.id } }
  private var current: HelperSkill { installed ?? skill }
  private var does: String { skill.plain?.does ?? MarketText.whatItsFor(current.description ?? "", max: 400) }

  var body: some View {
    MarketScreen(title: "", screenId: "skill", trailing: {
      if installed != nil && store.canManage { CircleButton(symbol: "square.and.arrow.up", label: "Share") { sharing = true } }
    }) {
      HStack(alignment: .center, spacing: 14) {
        MarketTile(symbol: MarketText.skillSymbol((current.slug ?? "") + " " + current.name), size: 56)
        VStack(alignment: .leading, spacing: 6) {
          Text(current.name).font(.system(size: 22, weight: .semibold)).lineLimit(3)
          if let installed { MarketPill(text: MarketText.origin(installed), tone: installed.source == "catalog" ? .green : .grey) }
          else { MarketPill(text: "Made by Wisp", tone: .green, symbol: "checkmark.seal") }
        }
        Spacer(minLength: 0)
      }
      if !does.isEmpty {
        MarketLabel("What it does")
        Text(does).font(.system(size: 15)).foregroundStyle(Palette.text.opacity(0.9)).padding(.horizontal, 4)
      }
      if let plain = skill.plain {
        MarketLabel("What it needs")
        CardGroup { MarketRow(symbol: "wand.and.stars", title: plain.needs) }
        MarketLabel("Example")
        Text(plain.example).font(.system(size: 15)).textSelection(.enabled).padding(16).frame(maxWidth: .infinity, alignment: .leading)
          .background(Palette.control, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.hairline))
      }
      if store.canManage, installed != nil {
        MarketLabel("Helpers with this skill")
        CardGroup {
          ForEach(store.agents) { agent in
            MarketToggleRow(title: agent.name, subtitle: "@\(agent.handle)", isOn: Binding(get: { installed?.agentIds?.contains(agent.id) == true }, set: { on in
              action.run { if let installed { try await store.setSkillAgent(installed.id, agent: agent.id, on: on) } }
            }), disabled: action.busy) { AgentAvatar(agent: agent, size: 30, showStatus: false) }
          }
          if store.agents.isEmpty { MarketRow(title: "No helpers yet", subtitle: "Add one from the Agents tab.") }
        }
        CardGroup {
          Button { editing = true } label: { MarketRow(symbol: "pencil", title: "Edit", subtitle: "Name, instructions and tags") }.buttonStyle(.plain)
          Button { deleting = true } label: { MarketRow(symbol: "trash", title: "Delete skill", subtitle: "Removed from every helper that has it", danger: true) }.buttonStyle(.plain)
        }
      }
      Button { withAnimation { showInstructions.toggle() } } label: {
        Label("Read the full instructions", systemImage: showInstructions ? "chevron.down" : "chevron.right").font(.system(size: 13)).foregroundStyle(Palette.muted)
      }.padding(.horizontal, 4)
      if showInstructions { NoteMarkdown(text: current.content ?? "").padding(16).background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder)) }
      InlineError(error: action.error)
    }
    .bottomAction {
      HStack(spacing: 10) {
        Button { trying = true } label: { Label("Try it", systemImage: "paperplane").frame(maxWidth: .infinity, minHeight: 28) }.secondaryButton().controlSize(.large)
        if installed == nil && store.canManage { Button { installing = true } label: { Text("Install").font(.system(size: 15, weight: .semibold)).frame(maxWidth: .infinity, minHeight: 28) }.primaryButton() }
      }
    }
    .sheet(isPresented: $editing) { SkillEditor(skill: current, onShare: { sharing = true }) }
    .sheet(isPresented: $installing) { SkillInstallSheet(title: "Add \(skill.name)", request: ["catalogId": AnyEncodable(skill.id)]) }
    .sheet(isPresented: $trying) { TryItSheet(name: current.name, description: current.description ?? "", agentIds: installed?.agentIds ?? [], onOpenChat: { chat = $0 }) }
    .sheet(isPresented: $sharing) { if let installed { SkillShareSheet(skill: installed, onBrought: { _ in }, onDevices: nil) } }
    .navigationDestination(item: $chat) { ChannelView(channel: $0.channel, draft: $0.draft) }
    .confirmationDialog("Delete this skill? It will be removed from every helper that has it.", isPresented: $deleting, titleVisibility: .visible) {
      Button("Delete skill", role: .destructive) { if let installed { action.run { try await store.deleteSkill(installed.id); dismiss() } } }
    }
  }
}

/** A public skill before it's added: who made it, its license, its instructions, and its source. */
struct StoreSkillDetail: View {
  @Environment(Store.self) private var store
  var skill: StoreSkill
  @State private var content: String?
  @State private var loaded = false
  @State private var adding = false
  @State private var trying = false
  @State private var chat: ChatTarget?
  @State private var showInstructions = false
  private var instructions: String? {
    content.map { $0.replacingOccurrences(of: #"^---\r?\n[\s\S]*?\r?\n---\r?\n?"#, with: "", options: .regularExpression) }
  }

  var body: some View {
    MarketScreen(title: "", screenId: "store-skill") {
      HStack(alignment: .center, spacing: 14) {
        MarketTile(symbol: MarketText.skillSymbol(skill.id + " " + skill.name), size: 56)
        VStack(alignment: .leading, spacing: 6) {
          Text(skill.name).font(.system(size: 22, weight: .semibold)).lineLimit(3)
          HStack(spacing: 6) {
            MarketPill(text: "From \(skill.source.label)")
            MarketPill(text: skill.license.label, tone: skill.license.open ? .grey : .warn)
          }
        }
        Spacer(minLength: 0)
      }
      MarketLabel("What it does")
      Text(skill.description).font(.system(size: 15)).foregroundStyle(Palette.text.opacity(0.9)).padding(.horizontal, 4)
      if let url = URL(string: skill.url) { Link(destination: url) { Label("Source", systemImage: "arrow.up.right.square").font(.system(size: 13)) }.padding(.horizontal, 4) }
      if !skill.license.open { MarketNote(text: "Its license doesn't allow copying it, so read it where it lives: \(skill.source.label)'s repo.") }
      if let instructions, !instructions.isEmpty {
        Button { withAnimation { showInstructions.toggle() } } label: {
          Label("Read the full instructions", systemImage: showInstructions ? "chevron.down" : "chevron.right").font(.system(size: 13)).foregroundStyle(Palette.muted)
        }.padding(.horizontal, 4)
        if showInstructions { NoteMarkdown(text: instructions).padding(16).background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder)) }
      } else if !loaded && skill.license.open {
        ProgressView().frame(maxWidth: .infinity)
      }
    }
    .bottomAction {
      HStack(spacing: 10) {
        Button { trying = true } label: { Label("Try it", systemImage: "paperplane").frame(maxWidth: .infinity, minHeight: 28) }.secondaryButton().controlSize(.large)
        if store.canManage && skill.license.open { Button { adding = true } label: { Text("Install").font(.system(size: 15, weight: .semibold)).frame(maxWidth: .infinity, minHeight: 28) }.primaryButton() }
      }
    }
    .sheet(isPresented: $adding) { SkillInstallSheet(title: "Add \(skill.name)", request: ["storeId": AnyEncodable(skill.id)]) }
    .sheet(isPresented: $trying) { TryItSheet(name: skill.name, description: skill.description, agentIds: [], onOpenChat: { chat = $0 }) }
    .navigationDestination(item: $chat) { ChannelView(channel: $0.channel, draft: $0.draft) }
    .task { content = try? await store.skillStoreContent(skill.id); loaded = true }
  }
}

/** Tags as chips, with a "+ Add" that turns into a small field. */
private struct TagsField: View {
  @Binding var tags: [String]
  @State private var adding = false
  @State private var text = ""
  @FocusState private var focused: Bool

  private func commit() {
    let t = text.trimmed.lowercased().replacingOccurrences(of: ",", with: "")
    if !t.isEmpty, !tags.contains(t), tags.count < 10 { tags.append(t) }
    text = ""; adding = false
  }

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(tags, id: \.self) { tag in
          HStack(spacing: 6) {
            Text(tag).font(.system(size: 13, weight: .medium))
            Button { tags.removeAll { $0 == tag } } label: { Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(Palette.muted) }.buttonStyle(.plain).accessibilityLabel("Remove \(tag)")
          }
          .padding(.leading, 16).padding(.trailing, 12).frame(height: 36)
          .background(Capsule().fill(Palette.control)).overlay(Capsule().strokeBorder(Palette.hairline))
        }
        if adding {
          TextField("New tag", text: $text).font(.system(size: 13)).textInputAutocapitalization(.never).autocorrectionDisabled().focused($focused).onSubmit(commit)
            .padding(.horizontal, 14).frame(width: 130, height: 36).background(Capsule().fill(Palette.control)).overlay(Capsule().strokeBorder(Palette.hairline))
            .onAppear { focused = true }
        } else {
          Button { adding = true } label: {
            Label("Add", systemImage: "plus").font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.text.opacity(0.8))
              .padding(.horizontal, 16).frame(height: 36).background(Capsule().fill(Palette.control)).overlay(Capsule().strokeBorder(Palette.hairline))
          }.buttonStyle(.plain)
        }
      }.padding(.horizontal, 18)
    }.padding(.horizontal, -18)
  }
}

/** Make a skill (answer three questions) or edit one (its instructions as written). */
struct SkillEditor: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var skill: HelperSkill?
  var onSaved: (HelperSkill) -> Void = { _ in }
  var onShare: (() -> Void)?
  @State private var name = ""
  @State private var description = ""
  @State private var content = ""
  @State private var what = ""
  @State private var when = ""
  @State private var result = ""
  @State private var tags: [String] = []
  @State private var agents: Set<String> = []
  /** guided mode: the instructions come from the answers until the person edits them directly */
  @State private var raw: String?
  @State private var direct = false
  @State private var preview = false
  @State private var action = FormAction()
  private var guided: Bool { skill == nil }
  private var generated: (description: String, content: String) { GuideText.skill(name: name, what: what, when: when, result: result) }
  private var finalContent: String { guided ? (raw ?? generated.content) : content }
  private var valid: Bool {
    !name.trimmed.isEmpty && name.count <= 60 && (guided ? (!what.trimmed.isEmpty || !(raw ?? "").trimmed.isEmpty) : !content.trimmed.isEmpty) && description.count <= 500 && finalContent.count <= 100_000
  }

  var body: some View {
    MarketSheet(title: skill == nil ? "New skill" : "Edit \(skill?.name ?? "skill")", busy: action.busy) {
      MarketField(label: "Name", placeholder: guided ? "Summarize a meeting" : "Deploy the web app", text: $name)
      if guided {
        MarketField(label: "What should your helper do?", placeholder: "Read what the team did this week and write a short update.", text: $what, lines: 3...8)
        MarketField(label: "When should it use this?", placeholder: "Every Friday, or when I ask for an update", text: $when, lines: 2...5)
        MarketField(label: "What does a good result look like?", placeholder: "Five lines or fewer, plain words", text: $result, lines: 2...8)
      } else {
        MarketField(label: "When to use it", placeholder: "Use when asked to deploy or roll back the web app.", text: $description, lines: 1...4)
      }
      MarketLabel("Tags")
      TagsField(tags: $tags)
      if guided && !direct {
        Button { direct = true } label: { Label("Edit the instructions directly", systemImage: "chevron.right").font(.system(size: 13)).foregroundStyle(Palette.muted) }.padding(.horizontal, 4)
      } else {
        HStack {
          MarketLabel("Full instructions")
          SegPicker(options: [(false, "Write"), (true, "Preview")], selection: $preview).frame(width: 190)
        }
        if preview {
          NoteMarkdown(text: finalContent).padding(16).frame(maxWidth: .infinity, minHeight: 160, alignment: .topLeading).background(Palette.control, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        } else {
          MarketField(label: nil, placeholder: "# What this skill does", text: guided ? Binding(get: { finalContent }, set: { raw = $0 }) : $content, mono: true, lines: 8...25)
          if guided { Text(raw == nil ? "Made from your answers above. If you change this text, this text is what gets saved." : "You edited this text, so the answers above no longer change it.").font(.system(size: 13)).foregroundStyle(Palette.faint).padding(.horizontal, 4) }
          if guided, raw != nil { Button("Use my answers again") { raw = nil }.font(.system(size: 13)).padding(.horizontal, 4) }
        }
      }
      MarketLabel("Which helpers have it")
      CardGroup {
        ForEach(store.agents) { agent in
          MarketToggleRow(title: agent.name, subtitle: "@\(agent.handle)", isOn: Binding(get: { agents.contains(agent.id) }, set: { if $0 { agents.insert(agent.id) } else { agents.remove(agent.id) } })) { AgentAvatar(agent: agent, size: 30, showStatus: false) }
        }
        if store.agents.isEmpty { MarketRow(title: "No helpers yet", subtitle: "Add one from the Agents tab first.") }
      }
      InlineError(error: action.error)
      HStack(spacing: 10) {
        if skill != nil, let onShare { Button { dismiss(); onShare() } label: { Label("Share", systemImage: "square.and.arrow.up").frame(maxWidth: .infinity) }.secondaryButton() }
        Button { save() } label: { Text("Save skill").frame(maxWidth: .infinity) }.primaryButton().disabled(!valid || action.busy)
      }
    }
    .onAppear {
      name = skill?.name ?? ""; description = skill?.description ?? ""; content = skill?.content ?? ""
      tags = skill?.tags ?? []; agents = Set(skill?.agentIds ?? [])
    }
  }

  private func save() {
    action.run {
      let use = guided ? generated.description : description.trimmed
      let made = try await store.saveSkill(skill?.id, ["name": AnyEncodable(name.trimmed), "description": AnyEncodable(use), "content": AnyEncodable(finalContent), "tags": AnyEncodable(tags), "agentIds": AnyEncodable(Array(agents).sorted())])
      dismiss(); onSaved(made)
    }
  }
}
