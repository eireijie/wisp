import PhotosUI
import SwiftUI

/**
 * A team's info page: About, Agents, Members, Pins, notifications, context and access, and leaving,
 * archiving or deleting it. "How the team works" opens the team editor; name, section, privacy and
 * notes for agents are under More options.
 */
struct TeamInfoPage: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var channel: Channel
  @State private var people: [ChannelMember] = []
  @State private var pins: [ChannelPin] = []
  @State private var editingTopic = false
  @State private var topic = ""
  @State private var notify = false
  @State private var context = false
  @State private var adding = false
  @State private var choosingIcon = false
  @State private var confirm: String?
  @State private var action = FormAction()

  private var current: Channel { store.channels.first { $0.id == channel.id } ?? channel }
  private var team: ChannelTeam? { current.team(agents: store.agents) }
  private var agentMembers: [ChannelMember] { people.filter { $0.kind == .agent } }
  private var humans: [ChannelMember] { people.filter { $0.kind == .user } }
  private var editable: Bool { store.canManage && current.archivedAt == nil }

  private var count: String {
    let a = agentMembers.count, p = humans.count
    return [a > 0 ? "\(a) \(a == 1 ? "agent" : "agents")" : nil, p > 0 ? "\(p) \(p == 1 ? "person" : "people")" : nil].compactMap { $0 }.joined(separator: ", ")
  }

  private var notifyLabel: String {
    switch current.notify ?? "default" {
    case "all": "Every message"
    case "mute": "Mute"
    default: "Just what's for me"
    }
  }

  private var works: String {
    guard let team, !team.nodes.isEmpty else {
      let n = agentMembers.count
      return n == 0 ? "No agents here yet" : "No steps yet. \(n == 1 ? "Its agent answers" : "Its \(n) agents answer") when someone @mentions them."
    }
    let leads = team.leads.compactMap { store.agent($0)?.name }
    let others = team.nodes.filter { !$0.lead }.compactMap { store.agent($0.agentId)?.name }
    return [leads.isEmpty ? nil : "\(ChannelTeam.list(leads)) \(leads.count > 1 ? "lead" : "leads").", others.isEmpty ? nil : "\(others.joined(separator: ", ")) \(team.hasSteps ? "do the steps" : "help")."].compactMap { $0 }.joined(separator: " ")
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        Button { choosingIcon = true } label: {
          TeamGhosts(agents: current.iconAgents(store.agents), seed: current.name, size: 40, iconFileId: current.settings?.iconFileId)
            .frame(minHeight: 44)
            .allowsHitTesting(false)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!editable)
        .accessibilityLabel("Change team icon")
        VStack(alignment: .leading, spacing: 0) {
          Text(current.name).font(.system(size: 19, weight: .semibold)).lineLimit(1)
          Text(count).font(.system(size: 13)).foregroundStyle(Palette.muted)
        }
        Spacer()
        CircleButton(symbol: "xmark", label: "Close", size: 44) { dismiss() }
      }
      .padding(.horizontal, 18).padding(.vertical, 10)
      ScrollViewReader { scroll in
      ScrollView {
        VStack(alignment: .leading, spacing: 22) {
          HStack(spacing: 10) {
            quick("bell", "Notify") { notify = true }
            quick("pin", "Pins") { withAnimation { scroll.scrollTo("team-pins", anchor: .top) } }
            quick("gauge.with.dots.needle.33percent", "Context") { context = true }
          }
          about
          agentsSection
          membersSection
          pinsSection.id("team-pins")
          teamSection
          InlineError(error: action.error)
        }
        .padding(.horizontal, 18)
        .padding(.bottom, 30)
      }
      }
    }
    .toolbar(.hidden, for: .navigationBar)
    .toolbar(.hidden, for: .tabBar)
    .background(Palette.ground.ignoresSafeArea())
    .task { await load() }
    .task(id: store.channelVersion) { await load() }
    .onChange(of: current.memberCount) { Task { await load() } }
    .onChange(of: current.pinnedIds) { Task { await load() } }
    .sheet(isPresented: $notify) { NotifySheet(channel: current) }
    .sheet(isPresented: $choosingIcon) { TeamIconSheet(channel: current, agents: current.iconAgents(store.agents)) }
    .sheet(isPresented: $context) {
      NavigationStack { ContextAccessSheet(channel: current, agents: agentMembers).toolbar(.hidden, for: .navigationBar) }
    }
    .sheet(isPresented: $adding, onDismiss: { Task { await load() } }) { AddChannelMembers(channel: channel, existing: Set(people.map(\.actor))) }
    .confirmationDialog(confirmTitle, isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }), titleVisibility: .visible) {
      Button(confirm == "delete" ? "Delete team" : confirm == "archive" ? "Archive team" : "Leave team", role: confirm == "archive" ? nil : .destructive) {
        let choice = confirm
        action.run {
          if choice == "delete" { try await store.deleteChannel(channel.id); dismiss() }
          else if choice == "archive" { try await store.archiveChannel(channel.id, archived: true) }
          else { try await store.leaveChannel(channel.id); dismiss() }
        }
      }
    } message: {
      Text(confirm == "delete" ? "The messages and threads are deleted for everyone. Notes agents saved in memory stay."
        : confirm == "archive" ? "Nobody can post while it is archived. Its messages and notes stay, and you can unarchive any time."
        : "You will stop getting its messages. You can join again from Browse teams.")
    }
  }

  private var confirmTitle: String {
    "\(confirm == "delete" ? "Delete" : confirm == "archive" ? "Archive" : "Leave") \(current.name)?"
  }

  private func quick(_ symbol: String, _ label: String, _ run: @escaping () -> Void) -> some View {
    Button(action: run) {
      VStack(spacing: 3) {
        Image(systemName: symbol).font(.system(size: 18)).foregroundStyle(Palette.muted)
        Text(label).font(.system(size: 13, weight: .medium))
      }
      .frame(maxWidth: .infinity).frame(height: 62)
      .background(Palette.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.cardBorder))
    }.buttonStyle(.plain)
  }

  private var about: some View {
    VStack(alignment: .leading, spacing: 8) {
      CardCaption("About")
      CardGroup {
        if editingTopic {
          HStack {
            TextField("What's this team for?", text: $topic).padding(.horizontal, 18).frame(minHeight: 54)
            Button("Save") {
              action.run { try await store.updateChannel(channel.id, ["topic": AnyEncodable(topic)]); editingTopic = false }
            }.disabled(action.busy || topic.count > 250).padding(.trailing, 18)
          }
        } else {
          Button { topic = current.topic; editingTopic = true } label: {
            RowLabel(title: "Topic", subtitle: current.topic.isEmpty ? (editable ? "Add a topic" : "No topic") : current.topic, chevron: editable)
          }.buttonStyle(.plain).disabled(!editable)
        }
        NavigationLink { ChannelTeamScreen(channel: current) } label: {
          RowLabel(title: "How the team works", subtitle: works) { Image(systemName: "point.3.connected.trianglepath.dotted").foregroundStyle(Palette.muted).frame(width: 26) }
        }.buttonStyle(.plain)
        Button { notify = true } label: { RowLabel(title: "Notifications", subtitle: notifyLabel) }.buttonStyle(.plain)
        RowLabel(title: "Answers without an @mention", subtitle: team == nil ? (store.agent(current.settings?.defaultAgentId ?? "")?.name ?? "Nobody (@mention an agent)") : ChannelTeam.list(team!.leads.compactMap { store.agent($0)?.name }), chevron: false)
      }
      NavigationLink { ChannelDetails(channel: current) } label: {
        Label("More options", systemImage: "slider.horizontal.3").font(.system(size: 15)).foregroundStyle(Palette.muted).padding(.horizontal, 18).frame(minHeight: 44)
      }.buttonStyle(.plain)
    }
  }

  private var agentsSection: some View {
    VStack(alignment: .leading, spacing: 8) {
      CardCaption("Agents")
      CardGroup {
        ForEach(agentMembers) { m in
          let agent = store.agent(m.id)
          let node = team?.nodes.first { $0.agentId == m.id }
          NavigationLink { if let agent { AgentPage(agent: agent) } } label: {
            RowLabel(title: m.name, subtitle: node?.role ?? (agent?.status == .offline ? "Offline" : "Works here"), value: node?.lead == true ? "Leads" : nil) {
              AgentAvatar(agent: agent, size: 34, showStatus: false)
            }
          }.buttonStyle(.plain)
        }
        if editable {
          NavigationLink { ChannelTeamScreen(channel: current) } label: {
            RowLabel(title: "Add agent") { Image(systemName: "plus").foregroundStyle(Palette.muted).frame(width: 34) }
          }.buttonStyle(.plain)
        }
      }
    }
  }

  private var membersSection: some View {
    VStack(alignment: .leading, spacing: 8) {
      CardCaption("Members")
      CardGroup {
        ForEach(humans, id: \.actor) { p in
          HStack(spacing: 12) {
            PersonAvatar(name: p.name, size: 34)
            VStack(alignment: .leading, spacing: 0) {
              Text(p.id == store.me?.id ? "\(p.name) (you)" : p.name).font(.system(size: 15))
              Text(p.role?.capitalized ?? "").font(.system(size: 13)).foregroundStyle(Palette.faint)
            }
            Spacer()
            if store.canManage && !(current.name == "general" && p.id == store.me?.id) && p.id != store.me?.id {
              Button("Remove", role: .destructive) { action.run { try await store.removeMember(p.actor, from: channel.id); await load() } }.font(.system(size: 13)).disabled(action.busy)
            }
          }
          .padding(.horizontal, 18).frame(minHeight: 56)
        }
        if store.canManage {
          Button { adding = true } label: {
            RowLabel(title: "Add people or agents") { Image(systemName: "person.badge.plus").foregroundStyle(Palette.muted).frame(width: 34) }
          }.buttonStyle(.plain)
        }
      }
    }
  }

  private var pinsSection: some View {
    VStack(alignment: .leading, spacing: 8) {
      CardCaption("Pinned messages")
      if pins.isEmpty {
        CardGroup { RowLabel(title: "Nothing pinned yet", subtitle: "Press and hold a message to pin it.", chevron: false) }
      } else {
        ForEach(pins) { pin in
          VStack(alignment: .leading, spacing: 8) {
            Text("\(store.name(of: pin.message.author)) · \(pin.message.date.formatted(date: .abbreviated, time: .shortened))").font(.system(size: 13)).foregroundStyle(Palette.muted)
            Text(pin.message.body.isEmpty ? "Attachment" : pin.message.body).font(.system(size: 15)).lineLimit(4)
            HStack(spacing: 10) {
              NavigationLink(value: ThreadRef(channelId: channel.id, rootId: pin.message.threadId ?? pin.message.id)) {
                Text("Open thread").font(.system(size: 13, weight: .semibold)).padding(.horizontal, 14).frame(height: 36).background(Capsule().fill(Palette.control))
              }.buttonStyle(.plain)
              if editable {
                Button { action.run { try await store.unpin(pin.id); await load() } } label: {
                  Text("Unpin").font(.system(size: 13, weight: .semibold)).padding(.horizontal, 14).frame(height: 36).background(Capsule().fill(Palette.control))
                }.buttonStyle(.plain).disabled(action.busy)
              }
            }
          }
          .padding(16).frame(maxWidth: .infinity, alignment: .leading)
          .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
        }
      }
    }
  }

  private var teamSection: some View {
    VStack(alignment: .leading, spacing: 8) {
      CardCaption("Team")
      CardGroup {
        Button { context = true } label: { RowLabel(title: "Context and access") { Image(systemName: "gauge.with.dots.needle.33percent").foregroundStyle(Palette.muted).frame(width: 26) } }.buttonStyle(.plain)
        if current.name != "general" && current.joined == true {
          Button { confirm = "leave" } label: { RowLabel(title: "Leave team", chevron: false) { Image(systemName: "rectangle.portrait.and.arrow.right").foregroundStyle(Palette.muted).frame(width: 26) } }.buttonStyle(.plain)
        }
        if store.canManage {
          Button {
            if current.archivedAt == nil { confirm = "archive" } else { action.run { try await store.archiveChannel(channel.id, archived: false) } }
          } label: { RowLabel(title: current.archivedAt == nil ? "Archive team" : "Unarchive team", chevron: false) { Image(systemName: "archivebox").foregroundStyle(Palette.muted).frame(width: 26) } }.buttonStyle(.plain)
        }
        if store.role == "owner" {
          Button { confirm = "delete" } label: { RowLabel(title: "Delete team", chevron: false, tint: Palette.red) { Image(systemName: "trash").foregroundStyle(Palette.red).frame(width: 26) } }.buttonStyle(.plain)
        }
      }
      if !store.canManage { CardCaption("Guests can't change teams.") }
    }
    .disabled(action.busy)
  }

  private func load() async {
    async let members = try? store.channelMembers(channel.id)
    async let pinned = try? store.channelPins(channel.id)
    if let m = await members { people = m }
    if let p = await pinned { pins = p }
  }
}

/** Notify me: Every message, Just what's for me, Mute. */
struct NotifySheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var channel: Channel
  @State private var action = FormAction()

  private var current: String { store.channels.first { $0.id == channel.id }?.notify ?? "default" }

  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: "Notify me") { dismiss() }
      CardGroup {
        option("all", "Every message", "Notify me about all of it")
        option("default", "Just what's for me", "Replies, @mentions and approvals")
        option("mute", "Mute", "No notifications from this team")
      }
      .padding(.horizontal, 18).padding(.top, 8)
      InlineError(error: action.error).padding(.horizontal, 18)
      Spacer()
    }
    .background(Palette.sheet.ignoresSafeArea())
    .presentationDetents([.height(360)])
    .presentationDragIndicator(.hidden)
  }

  private func option(_ value: String, _ title: String, _ subtitle: String) -> some View {
    Button {
      action.run { try await store.setChannelPrefs(channel.id, ["notify": AnyEncodable(value)]); dismiss() }
    } label: {
      RowLabel(title: title, subtitle: subtitle, chevron: false)
        .overlay(alignment: .trailing) { if current == value { Image(systemName: "checkmark").font(.system(size: 15, weight: .semibold)).padding(.trailing, 18) } }
    }.buttonStyle(.plain)
  }
}

/** How full the conversation is, and what each agent can do here. */
struct ContextAccessSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var channel: Channel
  var agents: [ChannelMember]
  @State private var info: [String: AgentContextInfo] = [:]

  private var fraction: Double? { info.values.compactMap(\.fraction).max() }

  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: "Context and access") { dismiss() }
      ScrollView {
        VStack(alignment: .leading, spacing: 10) {
          CardCaption("How full is the conversation")
          VStack(alignment: .leading, spacing: 8) {
            HStack {
              Text("Context window").font(.system(size: 15, weight: .semibold))
              Spacer()
              Text(fraction.map { "\(Int(($0 * 100).rounded()))%" } ?? "–").font(.system(size: 15, weight: .semibold)).monospacedDigit().foregroundStyle(fraction.map(ContextRing.color) ?? Palette.faint)
            }
            if let fraction { ProgressView(value: fraction).tint(ContextRing.color(fraction)) }
            Text("Older messages are summarized as it fills up. Shows after each agent's first reply here.").font(.system(size: 13)).foregroundStyle(Palette.muted)
          }
          .padding(16).frame(maxWidth: .infinity, alignment: .leading)
          .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
          CardCaption("What each agent can do here").padding(.top, 8)
          CardGroup {
            ForEach(agents) { m in
              NavigationLink { if let a = store.agent(m.id) { AgentPage(agent: a) } } label: {
                RowLabel(title: m.name, subtitle: sub(info[m.id]), value: info[m.id].map { $0.level.label }) { AgentAvatar(agent: store.agent(m.id), size: 34, showStatus: false) }
              }.buttonStyle(.plain)
            }
          }
          CardCaption("Access is for its computer: Read only, Can edit files, or Full access. Tap an agent to change its model too.")
        }
        .padding(.horizontal, 18).padding(.bottom, 24)
      }
    }
    .background(Palette.sheet.ignoresSafeArea())
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.hidden)
    .task {
      for m in agents { if let c = try? await store.agentContext(m.id, channel: channel.id, thread: nil) { info[m.id] = c } }
    }
  }

  private func sub(_ c: AgentContextInfo?) -> String {
    guard let c else { return "…" }
    return [c.model ?? "Automatic", c.effort?.capitalized].compactMap { $0 }.joined(separator: " · ")
  }
}

/** Pick what a team's icon shows: its first two agents, or an image. */
private struct TeamIconSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var channel: Channel
  var agents: [Agent]
  @State private var photo: PhotosPickerItem?
  @State private var busy = false
  @State private var failure: String?

  private var chosen: String? { channel.settings?.iconFileId }

  var body: some View {
    VStack(spacing: 6) {
      Text("Team icon").font(.system(size: 16, weight: .semibold)).padding(.bottom, 8)
      Button { run("Couldn't change the icon. Try again.") { try await save(.null) } } label: {
        TeamIconRow(selected: chosen == nil, title: "First two agents") { TeamGhosts(agents: agents, seed: channel.name, size: 44) }
      }
      .buttonStyle(.plain)
      PhotosPicker(selection: $photo, matching: .images) {
        TeamIconRow(selected: chosen != nil, title: busy ? "Uploading…" : chosen == nil ? "Choose image" : "Choose another image") {
          if chosen != nil { TeamGhosts(agents: agents, seed: channel.name, size: 44, iconFileId: chosen) }
          else {
            Image(systemName: "photo").font(.system(size: 18)).frame(width: 44, height: 44).background(Palette.faint.opacity(0.2), in: Circle()).frame(width: 44 * 1.14, alignment: .leading)
          }
        }
      }
      .buttonStyle(.plain)
      if let failure { Text(failure).font(.system(size: 13)).foregroundStyle(Palette.red) }
      Spacer(minLength: 0)
    }
    .disabled(busy)
    .padding(16)
    .presentationDetents([.height(240)])
    .background(Palette.sheet.ignoresSafeArea())
    .onChange(of: photo) { _, item in
      guard let item else { return }
      photo = nil
      run("Couldn't use that image. Try another one.") {
        guard let data = try await item.loadTransferable(type: Data.self), let png = Self.squareIcon(data) else { throw API.Failure(status: 0, message: "Couldn't read that photo.") }
        let file = try await store.uploadFile(png, name: "team-icon.png", mime: "image/png", channelId: channel.id)
        try await save(AnyEncodable(file.id))
      }
    }
  }

  private func save(_ icon: AnyEncodable) async throws {
    try await store.updateChannel(channel.id, ["settings": AnyEncodable(["iconFileId": icon])])
    dismiss()
  }

  private func run(_ failed: String, _ work: @escaping () async throws -> Void) {
    busy = true
    failure = nil
    Task {
      do { try await work() } catch { failure = failed }
      busy = false
    }
  }

  /** The middle square of a picture, small enough to load quickly in every chat row. */
  private static func squareIcon(_ data: Data) -> Data? {
    guard let image = UIImage(data: data) else { return nil }
    let side = min(image.size.width, image.size.height), out = min(side, 512)
    guard side > 0 else { return nil }
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let scale = out / side
    return UIGraphicsImageRenderer(size: CGSize(width: out, height: out), format: format).pngData { _ in
      image.draw(in: CGRect(x: (out - image.size.width * scale) / 2, y: (out - image.size.height * scale) / 2, width: image.size.width * scale, height: image.size.height * scale))
    }
  }
}

private struct TeamIconRow<Art: View>: View {
  var selected: Bool
  var title: String
  @ViewBuilder var art: Art

  var body: some View {
    HStack(spacing: 12) {
      art
      Text(title).font(.system(size: 15, weight: .medium)).frame(maxWidth: .infinity, alignment: .leading)
      if selected { Image(systemName: "checkmark").font(.system(size: 15, weight: .semibold)).accessibilityLabel("Selected") }
    }
    .padding(.horizontal, 10).padding(.vertical, 8)
    .frame(minHeight: 64)
    .background(selected ? Palette.faint.opacity(0.14) : .clear, in: RoundedRectangle(cornerRadius: 10))
    .contentShape(Rectangle())
  }
}
