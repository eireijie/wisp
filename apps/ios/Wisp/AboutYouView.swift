import SwiftUI

/** What helpers should know about you: preferences, plans, what you did, and details. Reached from Settings and from Memory. */
struct AboutYouView: View {
  @Environment(Store.self) private var store
  @State private var user = "me"
  @State private var category = "preference"
  @State private var draft = ""
  @State private var draftKind = "preference"
  @State private var due: Date?
  @State private var editing: MemoryItem?
  @State private var deleting: MemoryItem?
  @State private var opened: MemoryNote?
  @State private var chat: Channel?
  @State private var action = FormAction()
  @FocusState private var focused: Bool
  private var profile: MemoryProfile? { store.profiles[user] }
  static let kinds = [("preference", "Preferences"), ("plan", "Plans"), ("did", "Activity"), ("detail", "Details")]

  private var title: String {
    if user != "me" { return "About \(profile?.person.name ?? "…")" }
    return category == "preference" ? "About you" : Self.kinds.first { $0.0 == category }?.1 ?? "About you"
  }

  var body: some View {
    MemoryScreen(title: title, id: "about", trailing: {
      if profile?.editable == true { CircleButton(symbol: "plus", label: "Remember this", id: "about-add") { focused = true } }
    }) {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          ForEach(Self.kinds, id: \.0) { kind in
            FilterChip(title: kind.1, on: category == kind.0) { category = kind.0; draftKind = kind.0 == "did" || kind.0 == "detail" ? "preference" : kind.0 }
          }
        }
      }
      if store.isOwner {
        Menu {
          Picker("Whose memory", selection: $user) {
            Text("You").tag("me")
            ForEach(store.members.filter { $0.id != store.me?.id }) { Text($0.name).tag($0.id) }
          }
        } label: {
          HStack {
            Text("Whose memory").font(.system(size: 17)).foregroundStyle(Palette.faint)
            Spacer()
            Text(user == "me" ? "You" : profile?.person.name ?? "…").font(.system(size: 17, weight: .semibold)).foregroundStyle(Palette.text)
            Image(systemName: "chevron.down").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.faint)
          }.padding(.horizontal, 18).frame(height: 54).background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous)).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityIdentifier("about-whose")
      }
      InlineError(error: action.error)
      if profile?.editable == true { composer }
      content
    }
    .navigationDestination(item: $opened) { NoteView(path: $0.path) }
    .navigationDestination(item: $chat) { ChannelView(channel: $0) }
    .sheet(item: $editing) { MemoryItemEditor(user: user, kind: $0.kind, item: $0) }
    .confirmationDialog("Delete this memory? Git history keeps the old version.", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
      Button("Delete", role: .destructive) { if let item = deleting { action.run { try await store.deleteNote(item.path); try await store.refreshProfile(user) } } }
    }
    .task(id: user + String(store.memoryVersion)) { do { try await store.refreshProfile(user) } catch { action.error = error.localizedDescription } }
  }

  private var composer: some View {
    VStack(alignment: .leading, spacing: 12) {
      TextField("What would you like your helper to remember?", text: $draft, axis: .vertical).lineLimit(1...6).focused($focused).foregroundStyle(Palette.text)
        .accessibilityIdentifier("about-remember")
      HStack(spacing: 8) {
        if !draft.trimmed.isEmpty || draftKind == "plan" || focused {
          Menu {
            Picker("Category", selection: $draftKind) { ForEach(Self.kinds, id: \.0) { Text($0.1).tag($0.0) } }
          } label: { chip("number", Self.kinds.first { $0.0 == draftKind }?.1 ?? "Category", chevron: true) }
          if draftKind == "plan" {
            if let due { DatePicker("Due date", selection: Binding(get: { due }, set: { self.due = $0 }), displayedComponents: .date).labelsHidden().fixedSize() }
            else { Button { due = Date() } label: { chip("calendar", "Due date", chevron: false) }.buttonStyle(.plain) }
          }
          Spacer()
          Button { add() } label: { Text("Add").font(.system(size: 16, weight: .semibold)).foregroundStyle(Palette.sheet).padding(.horizontal, 20).frame(height: 40).background(Capsule().fill(Palette.text)).opacity(draft.trimmed.isEmpty || action.busy ? 0.4 : 1) }
            .buttonStyle(.plain).disabled(draft.trimmed.isEmpty || action.busy).accessibilityIdentifier("about-add-confirm")
        }
      }
    }.padding(18).frame(maxWidth: .infinity, alignment: .leading).background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
  }

  private func chip(_ symbol: String, _ title: String, chevron: Bool) -> some View {
    HStack(spacing: 6) {
      Image(systemName: symbol).font(.system(size: 13))
      Text(title).font(.system(size: 15, weight: .semibold))
      if chevron { Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold)) }
    }.foregroundStyle(Palette.muted).padding(.horizontal, 12).frame(height: 40).background(Capsule().fill(Palette.control)).overlay(Capsule().strokeBorder(Palette.hairline))
  }

  private func add() {
    let text = draft.trimmed
    guard !text.isEmpty else { return }
    action.run {
      var body: Fields = ["kind": AnyEncodable(draftKind), "text": AnyEncodable(text)]
      if draftKind == "plan", let due { body["due"] = .nullable(due.formatted(.iso8601.year().month().day())) }
      try await store.remember(body, user: user)
      draft = ""; due = nil; focused = false
      category = draftKind
    }
  }

  @ViewBuilder private var content: some View {
    let items = (profile?.items ?? []).filter { $0.kind == category }.sorted { $0.pinned == true && $1.pinned != true }
    if profile == nil && action.error == nil { ProgressView().frame(maxWidth: .infinity).padding(30) }
    else if category == "did" {
      if items.isEmpty { CardCaption("No activity yet") }
      JournalDays(items: items)
    } else if category == "plan" {
      let open = items.filter { $0.status != "done" && $0.status != "dropped" }.sorted { ($0.due ?? "9") < ($1.due ?? "9") }
      let done = items.filter { $0.status == "done" || $0.status == "dropped" }
      if items.isEmpty { CardCaption("What you're planning to do, with due dates. Agents mark them done.") }
      if !open.isEmpty { SectionCaption("Coming up"); CardGroup { ForEach(open) { row($0) } } }
      if !done.isEmpty { SectionCaption("Done"); CardGroup { ForEach(done) { row($0) } } }
      let journal = (profile?.items ?? []).filter { $0.kind == "did" }
      if !journal.isEmpty { SectionCaption("Journal"); JournalDays(items: journal, compact: true) }
    } else {
      if items.isEmpty { CardCaption("No \(Self.kinds.first { $0.0 == category }?.1.lowercased() ?? "notes") yet") }
      else { SectionCaption(Self.kinds.first { $0.0 == category }?.1 ?? ""); CardGroup { ForEach(items) { row($0) } } }
      CardCaption("Agents add these as you talk with them. Edit or delete anything that is wrong.")
    }
  }

  private func subtitle(_ item: MemoryItem) -> String {
    var parts: [String] = []
    if let due = item.due, let date = Wire.date(due) { parts.append("Due \(date.formatted(.dateTime.month(.abbreviated).day()))") }
    if let by = item.by { parts.append("Added by \(by)\(item.source != nil ? " from a chat" : "")") }
    if item.pinned == true { parts.append("Pinned") }
    return parts.joined(separator: " · ")
  }

  private func row(_ item: MemoryItem) -> some View {
    HStack(spacing: 8) {
      VStack(alignment: .leading, spacing: 3) {
        Text(item.text).font(.system(size: 17)).foregroundStyle(Palette.text).strikethrough(item.status == "done").textSelection(.enabled)
        let sub = subtitle(item)
        if !sub.isEmpty { Text(sub).font(.system(size: 14)).foregroundStyle(Palette.faint) }
      }
      Spacer(minLength: 4)
      Menu {
        if profile?.editable == true && item.kind != "did" {
          Button(item.pinned == true ? "Unpin" : "Pin", systemImage: "pin") { change(item, ["pinned": AnyEncodable(item.pinned != true)]) }
          if item.kind == "plan" {
            let finished = item.status == "done" || item.status == "dropped"
            Button(finished ? "Reopen" : "Mark done", systemImage: "checkmark.circle") { change(item, ["status": AnyEncodable(finished ? "active" : "done")]) }
          }
          Button("Edit", systemImage: "pencil") { editing = item }
        }
        Button("Open in Memory", systemImage: "book") { opened = MemoryNote(path: item.path) }
        if let channel = store.channels.first(where: { $0.id == item.channelId }) { Button(item.source ?? "Open the chat", systemImage: "bubble.left") { chat = channel } }
        if profile?.editable == true && item.kind != "did" { Button("Delete", systemImage: "trash", role: .destructive) { deleting = item } }
      } label: { Image(systemName: "ellipsis").font(.system(size: 17, weight: .semibold)).foregroundStyle(Palette.faint).frame(width: 40, height: 40).contentShape(Rectangle()) }
        .accessibilityLabel("More").accessibilityIdentifier("about-item-more")
    }.padding(.leading, 18).padding(.trailing, 8).padding(.vertical, 10).frame(maxWidth: .infinity, alignment: .leading)
  }

  private func change(_ item: MemoryItem, _ fields: Fields) {
    var body = fields; body["kind"] = AnyEncodable(item.kind); body["replaces"] = AnyEncodable(item.path)
    action.run { try await store.remember(body, user: user) }
  }
}

struct MemoryItemEditor: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var user: String
  var kind: String
  var item: MemoryItem?
  @State private var text = ""
  @State private var due = ""
  @State private var selectedKind = "preference"
  @State private var action = FormAction()
  var body: some View {
    EditorSheet(title: item == nil ? "Remember this" : "Edit memory", action: action, valid: !text.trimmed.isEmpty && text.count <= 4000 && (due.isEmpty || due.range(of: "^\\d{4}-\\d{2}-\\d{2}$", options: .regularExpression) != nil), save: {
      action.run {
        var body: Fields = ["kind": AnyEncodable(selectedKind), "text": AnyEncodable(text.trimmed)]
        if let item { body["replaces"] = AnyEncodable(item.path) }
        if selectedKind == "plan" { body["due"] = .nullable(due) }
        try await store.remember(body, user: user); dismiss()
      }
    }) {
      TextField("What would you like your helper to remember?", text: $text, axis: .vertical).lineLimit(4...12)
      if item == nil { Picker("Category", selection: $selectedKind) { ForEach(AboutYouView.kinds, id: \.0) { Text($0.1).tag($0.0) } } }
      if selectedKind == "plan" { TextField("Due date (YYYY-MM-DD)", text: $due).keyboardType(.numbersAndPunctuation) }
    }
    .presentationBackground(Palette.sheet)
    .onAppear { text = item?.text ?? ""; due = item?.due ?? ""; selectedKind = kind }
  }
}
