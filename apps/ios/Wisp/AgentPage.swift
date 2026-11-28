import QuickLook
import SwiftUI
import PhotosUI

/**
 * An agent's profile (round 11, board 12): its bubble, name and what it does, Edit and Message, then
 * one short list (Library, Computer; Apps and skills, Routines, Memory; Notifications). Edit holds the
 * name, look, background, voice and brain; the rarer pages (recent runs, who can message, background
 * checks, connections, permissions, remove) are under ⋯.
 */
struct AgentPage: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var agent: Agent
  @State private var removing = false
  @State private var chat: Channel?
  @State private var editing = false
  @State private var page: AgentMorePage?
  @State private var action = FormAction()

  private var current: Agent { store.agent(agent.id) ?? agent }
  private var device: AgentNode? { store.nodes.first { $0.id == current.nodeId } }
  private var canAsk: Bool {
    ((store.isOwner || current.settings?.createdBy == store.me?.id) && (store.features.invite || store.members.count > 1)) ||
    (device != nil && store.harnessOnDevice(current))
  }

  var body: some View {
    VStack(spacing: 0) {
      TopBar {
        CircleButton(symbol: "chevron.left", label: "Back", id: "agent-back") { dismiss() }
      } center: {
        EmptyView()
      } trailing: {
        moreMenu
      }
      ScrollView {
        VStack(spacing: 14) {
          header
          AgentShortList(agent: current)
          AgentError(text: action.error)
        }
        .padding(.horizontal, 18).padding(.bottom, 60)
      }
      .bubbleRefresh { await AgentShortList.reload(store, current) }
    }
    .background(Palette.sheet.ignoresSafeArea())
    .toolbar(.hidden, for: .navigationBar)
    .navigationBarBackButtonHidden(true)
    .navigationDestination(item: $chat) { ChannelView(channel: $0) }
    .navigationDestination(isPresented: $editing) { AgentEditPage(agent: current) }
    .navigationDestination(item: $page) { p in
      switch p {
      case .runs: AgentActivityPage(agent: current)
      case .who: AgentWhoPage(agent: current)
      case .background: BackgroundView(agent: current)
      case .connections: AgentConnect(agent: current)
      case .permissions: AgentPermissions(agent: current)
      }
    }
    .sheet(isPresented: $removing) {
      AgentConfirm(agent: current, title: "Remove \(current.name)?", message: "Its memory notes and personality stay in the vault. Its routines and chats with you stop.",
                   confirm: "Remove \(current.name)", destructive: true, busy: action.busy, error: action.error) {
        action.run { try await store.deleteAgent(current.id); removing = false; dismiss() }
      }
    }
    .task { await AgentShortList.reload(store, current) }
    .onChange(of: store.agents.contains { $0.id == agent.id }) { _, exists in if !exists { dismiss() } }
  }

  private var moreMenu: some View {
    Menu {
      Button("Recent runs", systemImage: "list.bullet") { page = .runs }.accessibilityIdentifier("agent-activity")
      if canAsk { Button("Who can message", systemImage: "person.2") { page = .who }.accessibilityIdentifier("agent-who") }
      if store.features.background { Button("Background checks", systemImage: "moon") { page = .background }.accessibilityIdentifier("agent-background") }
      Button("Connections", systemImage: "link") { page = .connections }.accessibilityIdentifier("agent-connect")
      Button("Permissions", systemImage: "lock") { page = .permissions }.accessibilityIdentifier("agent-permissions")
      if store.canManage {
        Divider()
        Button("Remove \(current.name)", systemImage: "trash", role: .destructive) { removing = true }.accessibilityIdentifier("agent-remove")
      }
    } label: { CircleLabel(symbol: "ellipsis") }
    .accessibilityLabel("More").accessibilityIdentifier("agent-more")
  }

  private var header: some View {
    VStack(spacing: 6) {
      AgentAvatar(agent: current, size: 104, showStatus: false, interactive: true)
      Text(current.name).font(.system(size: 24, weight: .bold)).foregroundStyle(Palette.text).accessibilityAddTraits(.isHeader)
      if let description = AgentShortList.does(current) {
        Text(description).font(.system(size: 15)).foregroundStyle(Palette.muted).multilineTextAlignment(.center).lineLimit(2).padding(.horizontal, 18)
      }
      HStack(spacing: 10) {
        if store.canManage { SmallPill(title: "Edit", id: "agent-edit") { editing = true } }
        SmallPill(title: "Message", symbol: "bubble.left", id: "agent-message") { action.run { chat = try await store.dm(with: current) } }
          .disabled(action.busy)
      }.padding(.top, 4)
    }
    .frame(maxWidth: .infinity)
    .padding(.top, 2).padding(.bottom, 6)
  }
}

/** The pages under the profile's ⋯. */
enum AgentMorePage: Hashable, Identifiable { case runs, who, background, connections, permissions; var id: Self { self } }

/**
 * The agent's one short list (boards 10 and 12), the same in the chat's swipe-in panel and on its
 * profile: Library and Computer; under Set up, Apps and skills, Routines and Memory; then Notifications.
 */
struct AgentShortList: View {
  @Environment(Store.self) private var store
  var agent: Agent
  /** the panel says less under the switch */
  var compact = false
  @State private var action = FormAction()

  private var current: Agent { store.agent(agent.id) ?? agent }
  private var device: AgentNode? { store.nodes.first { $0.id == current.nodeId } }
  private var computer: Computer? { store.computers.first { $0.id == current.computerId } }
  private var routines: [Routine] { store.routines.filter { $0.agentId == current.id } }
  private var skillCount: Int { store.skills.filter { $0.has(current.id) }.count }
  private var appCount: Int { store.connectors.filter { $0.has(current.id) && $0.enabled != false }.count }
  private var noteCount: Int { store.notes.filter { $0.path.hasPrefix("agents/\(current.id)/") && $0.path != SoulText.path(current.id) }.count }
  private var dmChannel: Channel? { store.channels.first { $0.isDM && store.dmAgent($0)?.id == current.id } }

  /** what it does, in a line ("Health and sleep") */
  static func does(_ a: Agent) -> String? {
    let line = (a.settings?.role ?? a.settings?.roleNotes ?? a.settings?.description ?? "").trimmed
    return line.isEmpty ? nil : line
  }

  var body: some View {
    VStack(spacing: 14) {
      CardGroup {
        link("Library", id: "agent-library", icon: "books.vertical") { AgentLibraryPage(agent: current) }
        if store.canViewComputers {
          link("Computer", id: "agent-computer", icon: "desktopcomputer", value: computerValue) { AgentComputerView(agent: current) }
        }
      }
      VStack(alignment: .leading, spacing: 6) {
        Text("Set up").font(.system(size: 13)).foregroundStyle(Palette.faint).padding(.horizontal, 14)
        CardGroup {
          if store.canManage && !compact { AgentRunsOnRow(agent: current, action: action) }
          link("Apps and skills", id: "agent-apps", icon: "powerplug", value: AgentLine.count(appCount + skillCount)) { AgentAppsPage(agent: current) }
          if store.features.routines {
            link("Routines", id: "agent-routines", icon: "clock", value: routinesValue) { RoutinesView(agent: current) }
          }
          link("Memory", id: "agent-memory", icon: "book", value: noteCount > 0 ? (compact ? "\(noteCount)" : "\(noteCount) \(noteCount == 1 ? "note" : "notes")") : nil) { AgentMemoryPage(agent: current) }
          // everything else, in one list (board 16c)
          link("All settings", id: "agent-all-settings", icon: "slider.horizontal.3") { AgentAllSettings(agent: current) }
        }
      }
      VStack(alignment: .leading, spacing: 8) {
        CardGroup {
          Toggle(isOn: Binding(get: { dmChannel?.isMuted != true }, set: { on in
            action.run {
              let channel: Channel
              if let existing = dmChannel { channel = existing } else { channel = try await store.dm(with: current) }
              try await store.setChannelPrefs(channel.id, ["notify": AnyEncodable(on ? "default" : "mute")])
            }
          })) {
            Label { Text("Notifications").font(.system(size: 15)).foregroundStyle(Palette.text) } icon: { rowIcon("bell") }
          }
          .tint(Palette.statusOnline)
          .padding(.horizontal, 14).frame(minHeight: 50)
          .disabled(action.busy)
          .accessibilityIdentifier("agent-notifications")
        }
        if !compact { CardCaption("Tells you when \(current.name) finishes or needs you.") }
      }
      AgentError(text: action.error)
    }
  }

  private var computerValue: String? {
    guard let computer else { return AgentLine.computer(agent: current, computer: nil, device: device) }
    let s = store.state(of: computer)
    return s.working ? "Working" : computer.isOnline ? "Idle" : s.label
  }

  private var routinesValue: String? {
    let on = routines.filter { $0.enabled != false }.count
    return routines.isEmpty ? nil : "\(on) on"
  }

  private func link<Destination: View>(_ title: String, id: String, icon: String, value: String? = nil, @ViewBuilder _ destination: () -> Destination) -> some View {
    NavigationLink { destination() } label: {
      RowLabel(title: title, value: value?.isEmpty == true ? nil : value, leading: { rowIcon(icon) })
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier(id)
  }

  /** Everything the list counts, fetched again. */
  static func reload(_ store: Store, _ agent: Agent) async {
    try? await store.refreshManagement()
    try? await store.refreshRoutines()
    try? await store.refreshSkills()
    try? await store.refreshConnectors()
    try? await store.refreshNotes()
  }
}

/**
 * Edit (board 12): everything you'd change in one place. The bubble (tap for Bubble look), Name and
 * handle, Personality and Instructions; Look (Bubble, Chat background); Voice; Brain (Model, Harness,
 * Computer). Done saves the name and handle.
 */
struct AgentEditPage: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var agent: Agent
  @State private var name = ""
  @State private var handle = ""
  @State private var loaded = false
  @State private var voiceSheet = false
  @State private var catalog: AgentModels.Catalog?
  @State private var run = RunInfo()
  @State private var action = FormAction()

  private var current: Agent { store.agent(agent.id) ?? agent }
  private var device: AgentNode? { store.nodes.first { $0.id == current.nodeId } }
  private var computer: Computer? { store.computers.first { $0.id == current.computerId } }
  private var finalHandle: String { ManagementText.handle(handle) }
  private var handleTaken: Bool { store.agents.contains { $0.handle == finalHandle && $0.id != current.id } }
  private var handleValid: Bool { finalHandle.range(of: "^[a-z][a-z0-9-]{0,31}$", options: .regularExpression) != nil }
  private var valid: Bool { !name.trimmed.isEmpty && name.count <= 80 && handleValid && !handleTaken }
  private var dmChannel: Channel? { store.channels.first { $0.isDM && store.dmAgent($0)?.id == current.id } }

  var body: some View {
    AgentFrame(title: "Edit \(current.name)", trailing: {
      Button { save() } label: {
        Text(action.busy ? "Saving" : "Done").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.sheet)
          .padding(.horizontal, 16).frame(height: 36).background(Capsule().fill(Palette.text))
      }
      .buttonStyle(.press).disabled(!valid || action.busy).opacity(valid ? 1 : 0.4)
      .accessibilityIdentifier("edit-save")
    }) {
      NavigationLink { BubbleLookPage(agent: current) } label: {
        AgentAvatar(agent: current, size: 96, showStatus: false)
          .overlay(alignment: .bottomTrailing) {
            Image(systemName: "pencil").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.text)
              .frame(width: 28, height: 28).background(Circle().fill(Palette.card)).overlay(Circle().strokeBorder(Palette.cardBorder))
          }
      }
      .buttonStyle(.press).frame(maxWidth: .infinity).padding(.vertical, 4)
      .accessibilityLabel("Bubble look").accessibilityIdentifier("edit-look")

      caption("Name")
      NameField(placeholder: current.name, text: $name, id: "edit-name")
      CardGroup {
        HStack(spacing: 2) {
          Text("@").foregroundStyle(Palette.faint)
          TextField("handle", text: Binding(get: { handle }, set: { handle = ManagementText.typingHandle($0.replacingOccurrences(of: "@", with: "")) }))
            .textInputAutocapitalization(.never).autocorrectionDisabled().foregroundStyle(Palette.muted)
        }
        .font(.system(size: 15)).padding(.horizontal, 14).frame(height: 44).accessibilityIdentifier("edit-handle")
      }
      if handleTaken { AgentError(text: "@\(finalHandle) is taken. Pick another.") }
      else if !handle.isEmpty && !handleValid { AgentError(text: "Start with a letter a to z. Use letters, numbers and dashes.") }
      CardGroup {
        NavigationLink { AgentPersonalityPage(agent: current) } label: { RowLabel(title: "Personality") }
          .buttonStyle(.plain).accessibilityIdentifier("edit-personality")
        NavigationLink { AgentInstructionsPage(agent: current) } label: { RowLabel(title: "Instructions", value: AgentShortList.does(current)) }
          .buttonStyle(.plain).accessibilityIdentifier("edit-instructions")
      }

      caption("Look")
      CardGroup {
        NavigationLink { BubbleLookPage(agent: current) } label: { RowLabel(title: "Bubble") }
          .buttonStyle(.plain).accessibilityIdentifier("edit-bubble")
        NavigationLink {
          AgentFrame(title: "Chat background", subtitle: current.name) { AgentBackgroundTab(agent: current) }
        } label: { RowLabel(title: "Chat background", value: backgroundValue) }
          .buttonStyle(.plain).accessibilityIdentifier("edit-background")
      }

      caption("Voice calls")
      CardGroup {
        Button { voiceSheet = true } label: { RowLabel(title: "Voice", value: voiceValue) }
          .buttonStyle(.plain).accessibilityIdentifier("edit-voice")
      }

      caption("Brain")
      CardGroup {
        NavigationLink { AgentModelPage(agent: current) } label: { RowLabel(title: "Model", value: AgentLine.model(agent: current, catalog: catalog)) }
          .buttonStyle(.plain).accessibilityIdentifier("agent-model")
        NavigationLink { HarnessPicker(agent: current, info: run).task { if let dm = dmChannel { await run.load(store, agent: current, channel: dm.id, thread: nil) } } } label: {
          RowLabel(title: "Harness", value: HarnessChoice.label(current.harness))
        }.buttonStyle(.plain).accessibilityIdentifier("agent-harness")
        if store.canViewComputers {
          NavigationLink { AgentComputerView(agent: current) } label: {
            RowLabel(title: "Computer", value: AgentLine.computer(agent: current, computer: computer, device: device))
          }.buttonStyle(.plain).accessibilityIdentifier("agent-computer-settings")
        }
      }
      AgentError(text: action.error)
    }
    .sheet(isPresented: $voiceSheet) { AgentVoiceSheet(agent: current) }
    .task {
      guard !loaded else { return }
      name = current.name; handle = current.handle; loaded = true
      catalog = try? await store.agentModels(current.id).catalog
    }
  }

  private func caption(_ text: String) -> some View {
    Text(text).font(.system(size: 13)).foregroundStyle(Palette.faint).padding(.horizontal, 14).padding(.bottom, -6)
  }

  private var backgroundValue: String {
    switch current.settings?.background?.value {
    case .none: "Default"
    case .some(.none): "None"
    case .some(.color): "Colour"
    case .some(.photo): "Photo"
    }
  }

  private var voiceValue: String {
    let voice = current.settings?.voice
    if let id = voice?.openai, !id.isEmpty { return id.prefix(1).uppercased() + id.dropFirst() }
    if voice?.elevenlabs?.isEmpty == false { return "ElevenLabs" }
    if voice?.device?.isEmpty == false { return "On device" }
    return "Automatic"
  }

  private func save() {
    action.run {
      var fields: Fields = [:]
      if name.trimmed != current.name { fields["name"] = AnyEncodable(name.trimmed) }
      if finalHandle != current.handle { fields["handle"] = AnyEncodable(finalHandle) }
      if !fields.isEmpty { _ = try await store.updateAgent(current.id, fields) }
      dismiss()
    }
  }
}

/**
 * Bubble look (board 12): the bubble big, then Colour (twelve, your own, or back to its default) or
 * Shape. Done saves it.
 */
struct BubbleLookPage: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var agent: Agent
  @State private var look: GhostLook
  @State private var tab = "colour"
  @State private var action = FormAction()
  @State private var words = ""
  @State private var photoItem: PhotosPickerItem?
  @State private var uploading = false
  private let original: GhostLook
  private let seed: String

  /** the six bubble colours, then six more (board 12's second row) */
  static let swatches: [(name: String, hex: String)] = BubbleColors.all + [
    ("Red", "#ff6b6b"), ("Sand", "#c9a27e"), ("Teal", "#5fd3e6"), ("Purple", "#d38cf5"), ("Lime", "#9ad86b"), ("Rose", "#f7a8d8"),
  ]

  init(agent: Agent) {
    self.agent = agent
    seed = agent.handle
    original = (agent.settings?.appearance ?? GhostLook.defaultAppearance(agent.handle)).resolved
    _look = State(initialValue: original)
    _tab = State(initialValue: original.photo == nil ? "colour" : "photo")
  }

  private var color: String { BubbleColors.color(look, seed: seed).lowercased() }

  var body: some View {
    AgentFrame(title: "Bubble", trailing: {
      Button { save() } label: {
        Text(action.busy ? "Saving" : "Done").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.sheet)
          .padding(.horizontal, 16).frame(height: 36).background(Capsule().fill(Palette.text))
      }
      .buttonStyle(.press).disabled(action.busy || !store.canManage)
      .accessibilityIdentifier("look-save")
    }) {
      Segments(options: [("colour", "Colour"), ("shape", "Shape"), ("describe", "Describe"), ("photo", "Photo")], selection: $tab, id: "look-tab")
      GhostView(look: look, seed: seed, size: 120, interactive: true)
        .frame(width: 120, height: 120).frame(maxWidth: .infinity).padding(.vertical, 8)
        .accessibilityLabel("\(agent.name)'s bubble")
      switch tab {
      case "shape": shapes
      case "describe": describe
      case "photo": photo
      default: colours
      }
      AgentError(text: action.error)
    }
  }

  private var colours: some View {
    VStack(alignment: .leading, spacing: 14) {
      LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 6), spacing: 12) {
        ForEach(Self.swatches, id: \.hex) { c in
          let on = c.hex == color
          Button { look.color = c.hex; look.color2 = nil; look.photo = nil } label: {
            Circle().fill(Color(hex: c.hex)).frame(width: 34, height: 34)
              .overlay { if on { Circle().stroke(Palette.text, lineWidth: 2).padding(-4) } }
              .frame(width: 44, height: 44).contentShape(Circle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel(c.name)
          .accessibilityAddTraits(on ? .isSelected : [])
        }
      }
      HStack(spacing: 14) {
        ColorPicker("Your own colour", selection: Binding(get: { Color(hex: color) }, set: { look.color = $0.hexString; look.color2 = nil; look.photo = nil }), supportsOpacity: false)
          .font(.system(size: 15)).foregroundStyle(Palette.text)
      }
      Button("Reset to default") { look = GhostLook.defaultAppearance(agent.handle).resolved }
        .font(.system(size: 15, weight: .medium)).foregroundStyle(ChatDot.blue).buttonStyle(.plain)
        .accessibilityIdentifier("look-reset")
    }
    .padding(16)
    .background(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).fill(Palette.card))
  }

  private var shapes: some View {
    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 8) {
      ForEach(BubbleForm.allCases) { s in
        let on = s == BubbleForm(look)
        Button { look.bubble = s.rawValue; look.photo = nil } label: {
          VStack(spacing: 6) {
            GhostView(look: { var l = look; l.bubble = s.rawValue; l.photo = nil; return l }(), seed: seed, size: 40, animate: false).frame(width: 40, height: 40)
            Text(s.name).font(.system(size: 12, weight: on ? .semibold : .regular)).foregroundStyle(on ? Palette.text : Palette.muted)
          }
          .frame(maxWidth: .infinity).frame(height: 84)
          .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(on ? Palette.hairline : .clear))
          .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Shape: \(s.name)")
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("look-shape-\(s.rawValue)")
      }
    }
  }

  /** a few words, four bubbles to pick from (LookWords) */
  private var describe: some View {
    VStack(alignment: .leading, spacing: 14) {
      TextField("A calm green bubble with freckles", text: $words)
        .font(.system(size: 15)).foregroundStyle(Palette.text)
        .padding(.horizontal, 14).frame(height: 44)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.hairline))
        .submitLabel(.done)
        .accessibilityLabel("Describe its look")
        .accessibilityIdentifier("look-words")
      let options = LookWords.looks(words, palette: Self.swatches.map(\.hex))
      HStack(spacing: 8) {
        ForEach(Array(options.enumerated()), id: \.offset) { i, option in
          let on = look.photo == nil && option.color == look.color && option.bubble == look.bubble && option.hat == look.hat
            && option.eyes == look.eyes && option.mouth == look.mouth && option.accessory == look.accessory
          Button { look = option } label: {
            GhostView(look: option, seed: seed, size: 52, animate: false).frame(width: 52, height: 52)
              .frame(maxWidth: .infinity).frame(height: 84)
              .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(on ? Palette.hairline : .clear))
              .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Look \(i + 1)")
          .accessibilityAddTraits(on ? .isSelected : [])
          .accessibilityIdentifier("look-option-\(i)")
        }
      }
      Text(words.isEmpty ? "Try a colour, a hat, glasses or a smile." : "Tap one to use it.")
        .font(.system(size: 13)).foregroundStyle(Palette.muted)
    }
    .padding(16)
    .background(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).fill(Palette.card))
  }

  /** a photo from the phone instead of the bubble */
  private var photo: some View {
    VStack(spacing: 10) {
      PhotosPicker(selection: $photoItem, matching: .images) {
        Label(uploading ? "Uploading…" : look.photo == nil ? "Choose a photo" : "Choose another photo", systemImage: "photo")
          .font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text)
          .frame(maxWidth: .infinity).frame(height: 44)
          .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.hairline))
      }
      .buttonStyle(.plain).disabled(uploading)
      .accessibilityIdentifier("look-photo-pick")
      if look.photo != nil {
        Button("Use the bubble instead") { look.photo = nil }
          .font(.system(size: 15, weight: .medium)).foregroundStyle(ChatDot.blue).buttonStyle(.plain)
          .accessibilityIdentifier("look-photo-remove")
      }
    }
    .padding(16)
    .background(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).fill(Palette.card))
    .onChange(of: photoItem) { _, item in if let item { upload(item) } }
  }

  private func upload(_ item: PhotosPickerItem) {
    uploading = true
    action.error = nil
    Task {
      defer { uploading = false; photoItem = nil }
      do {
        guard let data = try await item.loadTransferable(type: Data.self), let jpeg = LookPhoto.jpeg(data) else {
          action.error = "That photo couldn't be read."
          return
        }
        let up = try await store.uploadFile(jpeg, name: "face.jpg", mime: "image/jpeg")
        look.photo = "/api/files/\(up.id)"
      } catch {
        action.error = "That photo didn't upload."
      }
    }
  }

  private func save() {
    action.run {
      if look != original { try await store.saveLook(look, for: agent) }
      dismiss()
    }
  }
}

/** Library (board 12): the files an agent made, newest first, and the notes it keeps. */
struct AgentLibraryPage: View {
  @Environment(Store.self) private var store
  var agent: Agent
  @State private var files: [LibraryFile]?
  @State private var preview: URL?
  @State private var action = FormAction()

  struct LibraryFile: Decodable, Identifiable {
    struct Who: Decodable { var kind: String; var id: String }
    var id: String
    var name: String
    var size: Int?
    var createdAt: String?
    var uploader: Who?
  }

  var body: some View {
    AgentFrame(title: "Library", subtitle: agent.name) {
      CardGroup {
        NavigationLink { MemoryFolderView(folder: "agents/\(agent.id)") } label: {
          RowLabel(title: "Pages \(agent.name) wrote", leading: { rowIcon("doc.text") })
        }.buttonStyle(.plain).accessibilityIdentifier("library-pages")
      }
      CardCaption("Files")
      if let files {
        if files.isEmpty {
          AgentCard { Text("No files yet. What \(agent.name) makes for you shows here.").font(.system(size: 15)).foregroundStyle(Palette.muted) }
        } else {
          CardGroup {
            ForEach(files) { f in
              Button { open(f) } label: {
                RowLabel(title: f.name, subtitle: f.createdAt.flatMap(Wire.date).map { $0.formatted(.relative(presentation: .named)) }, chevron: false, leading: { rowIcon("doc") })
              }.buttonStyle(.plain)
            }
          }
        }
      } else {
        ProgressView().frame(maxWidth: .infinity).padding(20)
      }
      AgentError(text: action.error)
    }
    .quickLookPreview($preview)
    .task { await load() }
  }

  private func load() async {
    do {
      let all: [LibraryFile] = try await store.fetch { try await $0.get("/api/files") }
      files = all.filter { $0.uploader?.kind == "agent" && $0.uploader?.id == agent.id }.sorted { ($0.createdAt ?? "") > ($1.createdAt ?? "") }
    } catch { action.error = error.localizedDescription; files = [] }
  }

  private func open(_ f: LibraryFile) {
    action.run { preview = try await store.localFile(f.id, name: f.name) }
  }
}

/**
 * A name you can tell is editable (board 16, "Rename"): a field with a hairline border and a pencil
 * on the right. While typing, the border darkens and the pencil hides.
 */
struct NameField: View {
  var placeholder: String
  @Binding var text: String
  var id: String? = nil
  @FocusState private var focused: Bool

  var body: some View {
    HStack(spacing: 8) {
      TextField(placeholder, text: $text)
        .accessibilityIdentifier(id ?? "")
        .font(.system(size: 16)).foregroundStyle(Palette.text)
        .focused($focused)
        .submitLabel(.done)
        .accessibilityLabel("Name")
      if !focused {
        Image(systemName: "pencil").font(.system(size: 14)).foregroundStyle(Palette.faint)
          .accessibilityHidden(true)
      }
    }
    .padding(.horizontal, 14).frame(height: 48)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(focused ? Palette.text.opacity(0.55) : Palette.hairline, lineWidth: focused ? 1.5 : 1))
    .contentShape(Rectangle())
    .onTapGesture { focused = true }
  }
}
