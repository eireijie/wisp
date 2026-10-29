import SwiftUI

/** The words the skills screens show: who has a skill, where it came from, how often it's used. */
enum SkillText {
  static func day(_ iso: String?) -> String? {
    guard let iso, let date = Wire.date(iso) else { return nil }
    return date.formatted(.dateTime.month(.abbreviated).day())
  }

  static func used(_ n: Int?) -> String? {
    guard let n, n > 0 else { return nil }
    return n == 1 ? "used once" : "used \(n) times"
  }

  /** right side of a row: "All agents", "Ghosty", "3 agents", "No one" */
  static func whoHas(_ skill: HelperSkill, name: (String) -> String?) -> String {
    if skill.forAll { return "All agents" }
    let ids = skill.agentIds ?? []
    if ids.isEmpty { return "No one" }
    if ids.count == 1 { return name(ids[0]) ?? "1 agent" }
    return "\(ids.count) agents"
  }

  /** where an added skill came from: "Anthropic", "Imported from your Mac", "Yours" */
  static func origin(_ skill: HelperSkill, device: (String) -> String?) -> String {
    let id = skill.catalogId ?? ""
    if id.hasPrefix("device:") {
      let node = id.split(separator: ":", omittingEmptySubsequences: false).dropFirst().first.map(String.init) ?? ""
      return "Imported from \(device(node) ?? "a device")"
    }
    if skill.source == "catalog" {
      if let prefix = id.split(separator: ":").first, id.contains(":") { return prefix == "anthropic" ? "Anthropic" : prefix == "openai" ? "OpenAI" : prefix.capitalized }
      return "Wisp"
    }
    return "Yours"
  }

  /** the muted line under a row: "Ghosty · Oct 29" for a learned one, else where it came from */
  static func byline(_ skill: HelperSkill, name: (String) -> String?, device: (String) -> String?) -> String {
    if skill.isLearned {
      return [skill.learnedBy.flatMap(name) ?? "An agent", day(skill.createdAt)].compactMap { $0 }.joined(separator: " · ")
    }
    return origin(skill, device: device)
  }

  /** the line under a skill's name: "Learned by Ghosty · Oct 29 · used 3 times" */
  static func meta(_ skill: HelperSkill, name: (String) -> String?, device: (String) -> String?) -> String {
    let first = skill.isLearned ? "Learned by \(skill.learnedBy.flatMap(name) ?? "an agent")" : origin(skill, device: device)
    return [first, skill.isLearned ? day(skill.createdAt) : nil, used(skill.uses)].compactMap { $0 }.joined(separator: " · ")
  }

  enum Tab: String, CaseIterable { case all = "All", learned = "Learned", builtIn = "Built in", added = "Added" }
}

/** Settings → Skills: what agents learned, what their harnesses ship with, and what was added, plus the learning switch. */
struct SkillsView: View {
  @Environment(Store.self) private var store
  @ReduceMotion private var reduceMotion
  @State private var tab = SkillText.Tab.all
  @State private var builtIn: [BuiltInSkill] = []
  @State private var loaded = false
  @State private var importing = false
  @State private var action = FormAction()

  private func name(_ id: String) -> String? { store.agent(id)?.name }
  private func device(_ id: String) -> String? { store.nodes.first { $0.id == id }.map { $0.mine == true ? "your \($0.name)" : $0.name } }
  private var learned: [HelperSkill] { store.skills.filter(\.isLearned).sorted { ($0.createdAt ?? "") > ($1.createdAt ?? "") } }
  private var added: [HelperSkill] { store.skills.filter { !$0.isLearned } }
  private var learnOn: Binding<Bool> {
    Binding(get: { store.agentPolicy?.learnSkills ?? true }, set: { on in action.run { try await store.setLearnSkills(on) } })
  }

  var body: some View {
    SettingsPage("Skills", id: "skills") {
      HStack(spacing: 8) {
        NavigationLink { MarketplaceView(start: .skills) } label: { smallPill("Browse the shop", symbol: "bag") }
          .buttonStyle(.press).accessibilityIdentifier("skills-shop")
        if store.canManage {
          Button { importing = true } label: { smallPill("Import", symbol: "square.and.arrow.down") }
            .buttonStyle(.press).accessibilityIdentifier("skills-import")
        }
        Spacer(minLength: 0)
      }
      SegPicker(options: SkillText.Tab.allCases.map { ($0, $0.rawValue) }, selection: Binding(get: { tab }, set: { t in withAnimation(Motion.pick(Motion.settle, reduceMotion)) { tab = t } }))
      if tab == .all || tab == .learned {
        VStack(spacing: 6) {
          CardGroup { ToggleRow(title: "Learn skills on their own", isOn: learnOn, id: "skills-learn").disabled(!store.isOwner || action.busy) }
          Text("When an agent finishes something it could do again, it saves how.")
            .font(.system(size: 12)).foregroundStyle(Palette.faint).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 6)
        }
      }
      StatusLine(error: action.error)
      if tab == .all || tab == .learned { section("Learned", empty: "Nothing learned yet.", count: learned.count) { ForEach(learned) { row($0) } } }
      if tab == .all || tab == .builtIn { section("Built in", empty: loaded ? "Your agents' harnesses haven't listed any yet." : "Loading…", count: builtIn.count) { ForEach(builtIn) { builtInRow($0) } } }
      if tab == .all || tab == .added { section("Added", empty: "No skills added yet.", count: added.count) { ForEach(added) { row($0) } } }
    }
    .sheet(isPresented: $importing) { SkillShareSheet(skill: nil, onBrought: { _ in }, onDevices: nil) }
    .task {
      async let policy: Void? = try? store.refreshAgentPolicy()
      async let skills: Void? = try? store.refreshSkills()
      builtIn = (try? await store.builtInSkills()) ?? []
      _ = await (policy, skills)
      loaded = true
    }
  }

  private func smallPill(_ title: String, symbol: String) -> some View {
    Label(title, systemImage: symbol)
      .font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.text)
      .padding(.horizontal, 12).frame(height: 32)
      .background(Capsule().fill(Palette.control)).overlay(Capsule().strokeBorder(Palette.hairline))
  }

  @ViewBuilder private func section<Rows: View>(_ title: String, empty: String, count: Int, @ViewBuilder rows: () -> Rows) -> some View {
    VStack(spacing: 6) {
      Text(title.uppercased()).font(.system(size: 12, weight: .medium)).tracking(0.5).foregroundStyle(Palette.faint)
        .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 6).accessibilityAddTraits(.isHeader)
      if count == 0 {
        Text(empty).font(.system(size: 13)).foregroundStyle(Palette.muted).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 6)
      } else {
        CardGroup { rows() }
      }
    }
    .transition(.opacity)
  }

  private func row(_ s: HelperSkill) -> some View {
    NavigationLink { SkillDetail(skill: s) } label: {
      SkillRowLabel(name: s.name, description: s.plain?.does ?? s.description, byline: SkillText.byline(s, name: name, device: device), who: SkillText.whoHas(s, name: name))
    }.buttonStyle(.pressRow).accessibilityIdentifier("skill-row-\(s.slug ?? s.id)")
  }

  private func builtInRow(_ s: BuiltInSkill) -> some View {
    NavigationLink { BuiltInSkillDetail(skill: s) } label: {
      SkillRowLabel(name: s.name, description: s.description, byline: s.harnessLabel, who: "\(s.harnessLabel) agents")
    }.buttonStyle(.pressRow)
  }
}

/** A skill row: name, what it does, a muted "who · when", and who has it on the right. */
struct SkillRowLabel: View {
  var name: String
  var description: String?
  var byline: String
  var who: String

  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text(name).font(.system(size: 15, weight: .medium)).foregroundStyle(Palette.text).lineLimit(1)
        if let description, !description.isEmpty { Text(description).font(.system(size: 13)).foregroundStyle(Palette.muted).lineLimit(1) }
        Text(byline).font(.system(size: 12)).foregroundStyle(Palette.faint).lineLimit(1)
      }
      Spacer(minLength: 8)
      Text(who).font(.system(size: 13)).foregroundStyle(Palette.faint).lineLimit(1)
      Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.faint)
    }
    .padding(.horizontal, 14).padding(.vertical, 10)
    .frame(minHeight: 56)
    .contentShape(Rectangle())
  }
}

/** The quiet line under an agent's reply: "Learned: order-pizza" or "Using order-pizza"; it opens the skill. */
struct SkillPartLine: View {
  var action: String
  var skillId: String
  var slug: String

  var body: some View {
    NavigationLink { SkillLoader(skillId: skillId, slug: slug) } label: {
      HStack(spacing: 5) {
        Image(systemName: "book.closed").font(.system(size: 11))
        Text(action == "learned" ? "Learned: \(slug)" : "Using \(slug)").lineLimit(1)
      }
      .font(.system(size: 12)).foregroundStyle(Palette.faint)
      .padding(.horizontal, 4).padding(.vertical, 2)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityHint("Opens the skill")
  }
}

/** A skill opened by id (from a chat line): the one in the list, fetched if it isn't there yet. */
struct SkillLoader: View {
  @Environment(Store.self) private var store
  var skillId: String
  var slug: String
  @State private var tried = false
  private var skill: HelperSkill? { store.skills.first { $0.id == skillId } ?? store.skills.first { $0.slug == slug } }

  var body: some View {
    if let skill {
      SkillDetail(skill: skill)
    } else {
      MarketScreen(title: slug, screenId: "skill") {
        if tried { MarketNote(text: "This skill was forgotten.") } else { ProgressView().frame(maxWidth: .infinity) }
      }
      .task { try? await store.refreshSkills(); tried = true }
    }
  }
}

/** A harness's own skill: read-only, with the harness and which agents run it. */
struct BuiltInSkillDetail: View {
  @Environment(Store.self) private var store
  var skill: BuiltInSkill
  private var agents: [String] { skill.agentIds.compactMap { store.agent($0)?.name } }

  var body: some View {
    MarketScreen(title: "", screenId: "builtin-skill") {
      SkillHeader(name: skill.name, meta: "\(skill.harnessLabel) · built in")
      if let d = skill.description, !d.isEmpty {
        Text(d).font(.system(size: 14)).foregroundStyle(Palette.text).padding(.horizontal, 14).padding(.vertical, 12)
          .frame(maxWidth: .infinity, alignment: .leading).skillCard()
      }
      SkillCaption("Who can use it")
      CardGroup { RowLabel(title: "\(skill.harnessLabel) agents", subtitle: agents.isEmpty ? nil : ShelfLogic.sentence(agents), chevron: false) { EmptyView() } }
      Text("It comes with \(skill.harnessLabel), so it can't be edited here.").font(.system(size: 12)).foregroundStyle(Palette.faint).padding(.horizontal, 6)
    }
  }
}

struct SkillHeader: View {
  var name: String
  var meta: String
  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(name).font(.system(size: 17, weight: .semibold)).foregroundStyle(Palette.text).lineLimit(3)
      if !meta.isEmpty { Text(meta).font(.system(size: 13)).foregroundStyle(Palette.faint) }
    }
    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4)
  }
}

struct SkillCaption: View {
  var text: String
  init(_ text: String) { self.text = text }
  var body: some View {
    Text(text.uppercased()).font(.system(size: 12, weight: .medium)).tracking(0.5).foregroundStyle(Palette.faint)
      .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 6).accessibilityAddTraits(.isHeader)
  }
}

extension View {
  func skillCard() -> some View {
    background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
  }
}

/** A skill's page. One you have: what it does, its steps, who can use it, Edit and Forget. One from the library: what it does and Install. */
struct SkillDetail: View {
  @Environment(Store.self) private var store
  var skill: HelperSkill
  var library = false
  private var installed: HelperSkill? { store.skills.first { library ? $0.catalogId == skill.id : $0.id == skill.id } }

  var body: some View {
    if let installed { SkillPage(skill: installed) } else { LibrarySkillPage(skill: skill) }
  }
}

/** A skill in the workspace (h-PhoneSkill): name, who learned it and how often it's used, its steps, who can use it. */
private struct SkillPage: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @ReduceMotion private var reduceMotion
  var skill: HelperSkill
  @State private var editing = false
  @State private var forgetting = false
  @State private var trying = false
  @State private var sharing = false
  @State private var chat: ChatTarget?
  /** the choice just made, shown until the hub answers */
  @State private var pendingAll: Bool?
  @State private var action = FormAction()

  private var current: HelperSkill { store.skills.first { $0.id == skill.id } ?? skill }
  private var allAgents: Bool { pendingAll ?? current.forAll }
  private var owner: String? { current.learnedBy.flatMap { store.agent($0)?.name } }
  private var meta: String {
    SkillText.meta(current, name: { store.agent($0)?.name }, device: { id in store.nodes.first { $0.id == id }.map { $0.mine == true ? "your \($0.name)" : $0.name } })
  }

  var body: some View {
    MarketScreen(title: "", screenId: "skill", trailing: {
      if store.canManage { CircleButton(symbol: "square.and.arrow.up", label: "Share") { sharing = true } }
    }) {
      SkillHeader(name: current.name, meta: meta)
      VStack(alignment: .leading, spacing: 8) {
        if let d = current.description, !d.isEmpty { Text(d).font(.system(size: 14, weight: .medium)).foregroundStyle(Palette.text) }
        if let content = current.content, !content.trimmed.isEmpty { NoteMarkdown(text: content) }
      }
      .padding(.horizontal, 14).padding(.vertical, 12).frame(maxWidth: .infinity, alignment: .leading).skillCard()
      if store.canManage {
        SkillCaption("Who can use it")
        SegPicker(options: [(false, current.isLearned ? "Just \(owner ?? "its agent")" : "Some agents"), (true, "All agents")],
                  selection: Binding(get: { allAgents }, set: setAll), disabled: action.busy)
        if !allAgents && !current.isLearned {
          CardGroup {
            ForEach(store.agents) { agent in
              MarketToggleRow(title: agent.name, subtitle: "@\(agent.handle)", isOn: Binding(get: { current.agentIds?.contains(agent.id) == true }, set: { on in
                action.run { try await store.setSkillAgent(current.id, agent: agent.id, on: on) }
              }), disabled: action.busy) { AgentAvatar(agent: agent, size: 30, showStatus: false) }
            }
            if store.agents.isEmpty { MarketRow(title: "No agents yet", subtitle: "Add one from the Agents tab.") }
          }
          .transition(.opacity)
        }
        CardGroup {
          Button { trying = true } label: { RowLabel(title: "Try it in a chat") { EmptyView() } }.buttonStyle(.pressRow)
          Button { editing = true } label: { RowLabel(title: "Edit") { EmptyView() } }.buttonStyle(.pressRow).accessibilityIdentifier("skill-edit")
          Button { forgetting = true } label: { RowLabel(title: "Forget this skill", chevron: false, tint: Palette.red) { EmptyView() } }
            .buttonStyle(.pressRow).accessibilityIdentifier("skill-forget")
        }
      } else {
        SkillCaption("Who can use it")
        CardGroup { RowLabel(title: SkillText.whoHas(current, name: { store.agent($0)?.name }), chevron: false) { EmptyView() } }
      }
      InlineError(error: action.error)
    }
    .sheet(isPresented: $editing) { SkillEditor(skill: current, onShare: { sharing = true }) }
    .sheet(isPresented: $trying) { TryItSheet(name: current.name, description: current.description ?? "", agentIds: current.forAll ? store.agents.map(\.id) : current.agentIds ?? [], onOpenChat: { chat = $0 }) }
    .sheet(isPresented: $sharing) { SkillShareSheet(skill: current, onBrought: { _ in }, onDevices: nil) }
    .navigationDestination(item: $chat) { ChannelView(channel: $0.channel, draft: $0.draft) }
    .confirmationDialog("Forget \(current.name)? No agent will use it again.", isPresented: $forgetting, titleVisibility: .visible) {
      Button("Forget this skill", role: .destructive) { action.run { try await store.deleteSkill(current.id); dismiss() } }
    }
  }

  private func setAll(_ on: Bool) {
    guard on != allAgents else { return }
    withAnimation(Motion.pick(Motion.settle, reduceMotion)) { pendingAll = on }
    let learnedBy = current.learnedBy
    action.run {
      defer { pendingAll = nil }
      try await store.setSkillAccess(current.id, allAgents: on, agentIds: !on && current.isLearned ? learnedBy.map { [$0] } : nil)
    }
  }
}

/** A library skill before it's added (or one you're looking at in the shop): what it does and needs, an example, Try it and Install. */
private struct LibrarySkillPage: View {
  @Environment(Store.self) private var store
  var skill: HelperSkill
  @State private var installing = false
  @State private var trying = false
  @State private var chat: ChatTarget?
  @State private var showInstructions = false
  private var does: String { skill.plain?.does ?? MarketText.whatItsFor(skill.description ?? "", max: 400) }

  var body: some View {
    MarketScreen(title: "", screenId: "skill") {
      HStack(alignment: .center, spacing: 14) {
        MarketTile(symbol: MarketText.skillSymbol((skill.slug ?? "") + " " + skill.name), size: 56)
        VStack(alignment: .leading, spacing: 6) {
          Text(skill.name).font(.system(size: 22, weight: .semibold)).lineLimit(3)
          MarketPill(text: "Made by Wisp", tone: .green, symbol: "checkmark.seal")
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
      Button { withAnimation { showInstructions.toggle() } } label: {
        Label("Read the full instructions", systemImage: showInstructions ? "chevron.down" : "chevron.right").font(.system(size: 13)).foregroundStyle(Palette.muted)
      }.padding(.horizontal, 4)
      if showInstructions { NoteMarkdown(text: skill.content ?? "").padding(16).skillCard() }
    }
    .bottomAction {
      HStack(spacing: 10) {
        Button { trying = true } label: { Label("Try it", systemImage: "paperplane").frame(maxWidth: .infinity, minHeight: 28) }.secondaryButton().controlSize(.large)
        if store.canManage { Button { installing = true } label: { Text("Install").font(.system(size: 15, weight: .semibold)).frame(maxWidth: .infinity, minHeight: 28) }.primaryButton() }
      }
    }
    .sheet(isPresented: $installing) { SkillInstallSheet(title: "Add \(skill.name)", request: ["catalogId": AnyEncodable(skill.id)]) }
    .sheet(isPresented: $trying) { TryItSheet(name: skill.name, description: skill.description ?? "", agentIds: [], onOpenChat: { chat = $0 }) }
    .navigationDestination(item: $chat) { ChannelView(channel: $0.channel, draft: $0.draft) }
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
  @State private var allAgents = false
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
      MarketLabel("Who can use it")
      AgentAccessPicker(allAgents: $allAgents, isOn: { agent in Binding(get: { agents.contains(agent.id) }, set: { if $0 { agents.insert(agent.id) } else { agents.remove(agent.id) } }) })
      InlineError(error: action.error)
      HStack(spacing: 10) {
        if skill != nil, let onShare { Button { dismiss(); onShare() } label: { Label("Share", systemImage: "square.and.arrow.up").frame(maxWidth: .infinity) }.secondaryButton() }
        Button { save() } label: { Text("Save skill").frame(maxWidth: .infinity) }.primaryButton().disabled(!valid || action.busy)
      }
    }
    .onAppear {
      name = skill?.name ?? ""; description = skill?.description ?? ""; content = skill?.content ?? ""
      tags = skill?.tags ?? []; agents = Set(skill?.agentIds ?? []); allAgents = skill?.forAll ?? false
    }
  }

  private func save() {
    action.run {
      let use = guided ? generated.description : description.trimmed
      let made = try await store.saveSkill(skill?.id, ["name": AnyEncodable(name.trimmed), "description": AnyEncodable(use), "content": AnyEncodable(finalContent), "tags": AnyEncodable(tags), "agentIds": AnyEncodable(Array(agents).sorted()), "allAgents": AnyEncodable(allAgents)])
      dismiss(); onSaved(made)
    }
  }
}
