import SwiftUI

struct NewChannel: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var onCreated: (Channel) -> Void
  @State private var name = ""
  @State private var topic = ""
  @State private var section = ""
  @State private var isPrivate = false
  @State private var answerer = ""
  @State private var selected: Set<Actor> = []
  @State private var action = FormAction()

  private var slug: String { ManagementText.channelName(name) }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("Name", text: $name).textInputAutocapitalization(.never).autocorrectionDisabled()
          if !slug.isEmpty { Text("#\(slug)").foregroundStyle(.secondary) }
          TextField("Topic", text: $topic, axis: .vertical)
          SectionPicker(selection: $section)
        }
        MemberChoices(selected: $selected)
        Section {
          AnswerPicker(selection: $answerer)
        } footer: { Text("Pick an agent to make this its channel: it answers anything nobody @mentions.") }
        Section {
          Toggle("Private", isOn: $isPrivate)
        } footer: { Text("Only people and agents you add can see it.") }
        InlineError(error: action.error)
      }
      .navigationTitle("New channel")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Create") {
            action.run {
              let channel = try await store.createChannel([
                "name": AnyEncodable(slug), "topic": AnyEncodable(topic), "sectionId": .nullable(section),
                "private": AnyEncodable(isPrivate), "members": AnyEncodable(Array(selected)),
                "settings": AnyEncodable(["defaultAgentId": AnyEncodable.nullable(answerer)])
              ])
              dismiss()
              onCreated(channel)
            }
          }.disabled(action.busy || slug.range(of: "^[a-z0-9][a-z0-9_-]{0,79}$", options: .regularExpression) == nil || topic.count > 250)
        }
      }
      .onChange(of: answerer) { _, id in if !id.isEmpty { selected.insert(Actor(kind: .agent, id: id)) } }
      .onChange(of: selected) { _, people in
        if !answerer.isEmpty && !people.contains(Actor(kind: .agent, id: answerer)) { answerer = "" }
      }
      .interactiveDismissDisabled(action.busy)
    }
  }
}

struct BrowseChannels: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var onOpen: (Channel) -> Void
  @State private var search = ""
  @State private var filter = "all"
  @State private var action = FormAction()

  private var list: [Channel] {
    store.channels.filter { ch in
      !ch.isDM && (filter == "archived" ? ch.archivedAt != nil : ch.archivedAt == nil && (filter != "joined" || ch.joined == true)) &&
        (search.isEmpty || ch.name.localizedCaseInsensitiveContains(search) || ch.topic.localizedCaseInsensitiveContains(search))
    }.sorted { a, b in
      (a.memberCount ?? 0) == (b.memberCount ?? 0) ? a.name < b.name : (a.memberCount ?? 0) > (b.memberCount ?? 0)
    }
  }

  var body: some View {
    NavigationStack {
      List {
        Picker("Channels", selection: $filter) {
          Text("All channels").tag("all")
          Text("Joined").tag("joined")
          Text("Archived").tag("archived")
        }.pickerStyle(.segmented)
        InlineError(error: action.error)
        ForEach(list) { channel in
          Button {
            action.run {
              if channel.joined != true && channel.archivedAt == nil { try await store.joinChannel(channel.id) }
              dismiss()
              onOpen(store.channels.first { $0.id == channel.id } ?? channel)
            }
          } label: {
            HStack {
              VStack(alignment: .leading, spacing: 4) {
                Label(channel.name, systemImage: channel.private == true ? "lock" : "number").foregroundStyle(.primary)
                Text("\(channel.memberCount ?? 0) members\(channel.topic.isEmpty ? "" : " · \(channel.topic)")").font(.caption).foregroundStyle(.secondary)
              }
              Spacer()
              Text(channel.archivedAt != nil ? "Read only" : channel.joined == true ? "Joined" : "Join").font(.caption)
            }
          }.disabled(action.busy)
        }
        if list.isEmpty { Text("No channels match.").foregroundStyle(.secondary) }
      }
      .searchable(text: $search, prompt: "Search channels")
      .navigationTitle("Browse channels")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
      .refreshable { await store.refreshChannels() }
    }
  }
}

struct ChannelDetails: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var channel: Channel
  @State private var name = ""
  @State private var topic = ""
  @State private var section = ""
  @State private var isPrivate = false
  @State private var answerer = ""
  @State private var replyInThread = false
  @State private var instructions = ""
  @State private var people: [ChannelMember] = []
  @State private var pins: [ChannelPin] = []
  @State private var adding = false
  @State private var confirm: String?
  @State private var action = FormAction()
  @State private var loadError: String?
  @State private var loaded = false

  private var current: Channel { store.channels.first { $0.id == channel.id } ?? channel }
  private var changed: Bool {
    name != current.name || topic != current.topic || section != (current.sectionId ?? "") || isPrivate != (current.private ?? false) ||
      answerer != (current.settings?.defaultAgentId ?? "") || replyInThread != (current.settings?.replyInThread ?? false) || instructions != (current.settings?.instructions ?? "")
  }

  var body: some View {
    Form {
      Section("About") {
        TextField("Name", text: $name).textInputAutocapitalization(.never).autocorrectionDisabled().disabled(current.name == "general")
        TextField("Topic", text: $topic, axis: .vertical)
        SectionPicker(selection: $section)
        Toggle("Private", isOn: $isPrivate).disabled(store.isProtected(current))
      }.disabled(!store.canManage || action.busy)
      Section("Agents") {
        AnswerPicker(selection: $answerer)
        Toggle("Answer in a thread", isOn: $replyInThread)
        TechnicalDetails {
          TextField("Notes for agents here", text: $instructions, axis: .vertical).lineLimit(4...12)
        }
      }.disabled(!store.canManage || current.archivedAt != nil || action.busy)
      if store.canManage {
        Section {
          Button(action.busy ? "Saving…" : "Save") { save() }
            .disabled(!changed || action.busy || name.isEmpty || topic.count > 250 || instructions.count > 4000)
        }
      }
      Section("Members · \(people.count)") {
        ForEach(people, id: \.actor) { person in
          HStack {
            VStack(alignment: .leading) {
              Text(person.name)
              Text(person.handle.map { "@\($0)" } ?? person.role?.capitalized ?? "").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if store.canManage && !(current.name == "general" && person.kind == .user && person.id == store.me?.id) {
              Button("Remove", role: .destructive) {
                action.run {
                  try await store.removeMember(person.actor, from: channel.id)
                  await load()
                }
              }.font(.caption).disabled(action.busy)
            }
          }
        }
        if store.canManage { Button("Add people or agents", systemImage: "person.badge.plus") { adding = true } }
      }
      Section("Pins") {
        if pins.isEmpty { Text("No pinned messages yet.").foregroundStyle(.secondary) }
        ForEach(pins) { pin in
          VStack(alignment: .leading, spacing: 8) {
            Text(store.name(of: pin.message.author)).font(.caption.bold())
            Text(pin.message.body)
            NavigationLink("Open thread", value: ThreadRef(channelId: channel.id, rootId: pin.message.threadId ?? pin.message.id))
            if store.canManage && current.archivedAt == nil {
              Button("Unpin", role: .destructive) {
                action.run { try await store.unpin(pin.id); await load() }
              }.disabled(action.busy)
            }
          }
        }
      }
      Section("Notifications") {
        Picker("Notify me", selection: Binding(get: { current.notify ?? "default" }, set: { value in
          action.run { try await store.setChannelPrefs(channel.id, ["notify": AnyEncodable(value)]) }
        })) {
          Text("Every message").tag("all")
          Text("Just what's for me").tag("default")
          Text("Mute").tag("mute")
        }
        Toggle("Star", isOn: Binding(get: { current.starred ?? false }, set: { value in
          action.run { try await store.setChannelPrefs(channel.id, ["starred": AnyEncodable(value)]) }
        }))
      }.disabled(action.busy)
      Section {
        if store.canManage && !store.isProtected(current) {
          Button(current.archivedAt == nil ? "Archive channel" : "Unarchive channel") {
            if current.archivedAt == nil { confirm = "archive" }
            else { action.run { try await store.archiveChannel(channel.id, archived: false) } }
          }
        }
        if current.name != "general" && current.joined == true {
          Button("Leave channel", role: .destructive) { confirm = "leave" }
        }
        if store.role == "owner" && !store.isProtected(current) {
          Button("Delete channel", role: .destructive) { confirm = "delete" }
        }
        InlineError(error: action.error)
        InlineError(error: loadError)
        if loadError != nil { Button("Try again") { Task { await load() } } }
      }.disabled(action.busy)
    }
    .navigationTitle("#\(current.name)")
    .navigationBarTitleDisplayMode(.inline)
    .task { if !loaded { reset(); loaded = true }; await load() }
    .task(id: store.channelVersion) { await load() }
    .onChange(of: current.memberCount) { Task { await load() } }
    .onChange(of: current.pinnedIds) { Task { await load() } }
    .onChange(of: current) { old, _ in
      // Preserve a draft while another device changes this channel.
      if name == old.name { name = current.name }
      if topic == old.topic { topic = current.topic }
      if section == (old.sectionId ?? "") { section = current.sectionId ?? "" }
      if isPrivate == (old.private ?? false) { isPrivate = current.private ?? false }
      if answerer == (old.settings?.defaultAgentId ?? "") { answerer = current.settings?.defaultAgentId ?? "" }
      if instructions == (old.settings?.instructions ?? "") { instructions = current.settings?.instructions ?? "" }
      if replyInThread == (old.settings?.replyInThread ?? false) { replyInThread = current.settings?.replyInThread ?? false }
    }
    .sheet(isPresented: $adding, onDismiss: { Task { await load() } }) {
      AddChannelMembers(channel: channel, existing: Set(people.map(\.actor)))
    }
    .confirmationDialog("\(confirm == "delete" ? "Delete" : confirm == "archive" ? "Archive" : "Leave") #\(current.name)?", isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }), titleVisibility: .visible) {
      Button(confirm == "delete" ? "Delete channel" : confirm == "archive" ? "Archive channel" : "Leave channel", role: .destructive) {
        let choice = confirm
        action.run {
          if choice == "delete" { try await store.deleteChannel(channel.id); dismiss() }
          else if choice == "archive" { try await store.archiveChannel(channel.id, archived: true) }
          else { try await store.leaveChannel(channel.id); dismiss() }
        }
      }
    } message: {
      Text(confirm == "delete" ? "Every message and thread is deleted for everyone. This can't be undone." : confirm == "archive" ? "It leaves everyone's sidebar and becomes read-only. Agents working here are stopped." : "You can find public channels again in Browse channels.")
    }
  }

  private func reset() {
    name = current.name; topic = current.topic; section = current.sectionId ?? ""
    isPrivate = current.private ?? false; answerer = current.settings?.defaultAgentId ?? ""
    replyInThread = current.settings?.replyInThread ?? false; instructions = current.settings?.instructions ?? ""
  }

  private func save() {
    action.run {
      var fields: Fields = [:]
      if name != current.name { fields["name"] = AnyEncodable(ManagementText.channelName(name)) }
      if topic != current.topic { fields["topic"] = AnyEncodable(topic) }
      if section != (current.sectionId ?? "") { fields["sectionId"] = .nullable(section) }
      if isPrivate != (current.private ?? false) { fields["private"] = AnyEncodable(isPrivate) }
      var settings: Fields = [:]
      if answerer != (current.settings?.defaultAgentId ?? "") { settings["defaultAgentId"] = .nullable(answerer) }
      if replyInThread != (current.settings?.replyInThread ?? false) { settings["replyInThread"] = AnyEncodable(replyInThread) }
      if instructions != (current.settings?.instructions ?? "") { settings["instructions"] = AnyEncodable(instructions) }
      if !settings.isEmpty { fields["settings"] = AnyEncodable(settings) }
      try await store.updateChannel(channel.id, fields)
      reset()
      await load()
    }
  }

  private func load() async {
    do {
      async let members = store.channelMembers(channel.id)
      async let pinned = store.channelPins(channel.id)
      people = try await members; pins = try await pinned
      loadError = nil
    } catch { loadError = error.localizedDescription }
  }
}

struct AddChannelMembers: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var channel: Channel
  var existing: Set<Actor>
  @State private var selected: Set<Actor> = []
  @State private var action = FormAction()

  var body: some View {
    NavigationStack {
      Form {
        MemberChoices(selected: $selected, excluding: existing)
        InlineError(error: action.error)
      }
      .navigationTitle("Add people or agents")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Add") {
            action.run {
              for actor in selected {
                try await store.addMember(actor, to: channel.id)
                selected.remove(actor)
              }
              dismiss()
            }
          }.disabled(selected.isEmpty || action.busy)
        }
      }
      .interactiveDismissDisabled(action.busy)
    }
  }
}
