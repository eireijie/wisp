import SwiftUI

struct AboutYouView: View {
  @Environment(Store.self) private var store
  @State private var user = "me"
  @State private var category = "preference"
  @State private var adding = false
  @State private var editing: MemoryItem?
  @State private var deleting: MemoryItem?
  @State private var action = FormAction()
  private var profile: MemoryProfile? { store.profiles[user] }
  static let kinds = [("preference", "Preferences"), ("plan", "Plans"), ("did", "Activity"), ("detail", "Details")]
  var body: some View {
    List {
      Section {
        Text("What helpers should know about you").font(.headline)
        Text("Every agent reads this before it works, so you don't have to repeat yourself. Fix or delete anything; it applies from the next message.").font(.subheadline).foregroundStyle(.secondary)
        if store.isOwner {
          Picker("Whose memory", selection: $user) {
            Text("You").tag("me")
            ForEach(store.members.filter { $0.id != store.me?.id }) { Text($0.name).tag($0.id) }
          }
        }
        Picker("Category", selection: $category) { ForEach(Self.kinds, id: \.0) { Text($0.1).tag($0.0) } }
      }
      InlineError(error: action.error)
      let items = (profile?.items ?? []).filter { $0.kind == category }.sorted { $0.pinned == true && $1.pinned != true }
      if items.isEmpty { Text("No \(Self.kinds.first { $0.0 == category }?.1.lowercased() ?? "notes") yet").foregroundStyle(.secondary) }
      if category == "did" { JournalDays(items: items) }
      else { ForEach(items) { item in
        Section {
          Text(item.text).textSelection(.enabled)
          if let due = item.due, let date = Wire.date(due) { Text("Due \(date, format: .dateTime.year().month().day())").font(.caption) }
          if let by = item.by { Text("by \(by)").font(.caption).foregroundStyle(.secondary) }
          if let status = item.status { Text(status).font(.caption) }
          NavigationLink(item.kind == "did" ? "Edit day" : "Open in Memory") { NoteView(path: item.path) }
          if let channel = store.channels.first(where: { $0.id == item.channelId }) { NavigationLink(item.source ?? "Source") { ChannelView(channel: channel) } }
          if profile?.editable == true && item.kind != "did" {
            HStack {
              Button(item.pinned == true ? "Unpin" : "Pin") { change(item, ["pinned": AnyEncodable(item.pinned != true)]) }
              Spacer()
              Button("Edit") { editing = item }
              Button("Delete", role: .destructive) { deleting = item }
            }.buttonStyle(.borderless).disabled(action.busy)
            if item.kind == "plan" {
              Button(item.status == "done" || item.status == "dropped" ? "Reopen" : "Mark done") {
                change(item, ["status": AnyEncodable(item.status == "done" || item.status == "dropped" ? "active" : "done")])
              }.disabled(action.busy)
            }
          }
        }
      } }
    }
    .sectionScreen(user == "me" ? "About you" : "About \(profile?.person.name ?? "…")", id: "about")
    .toolbar { if profile?.editable == true { Button("Remember this", systemImage: "plus") { adding = true } } }
    .sheet(isPresented: $adding) { MemoryItemEditor(user: user, kind: category) }
    .sheet(item: $editing) { MemoryItemEditor(user: user, kind: $0.kind, item: $0) }
    .confirmationDialog("Delete this memory? Git history keeps the old version.", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
      Button("Delete", role: .destructive) { if let item = deleting { action.run { try await store.deleteNote(item.path); try await store.refreshProfile(user) } } }
    }
    .task(id: user + String(store.memoryVersion)) { do { try await store.refreshProfile(user) } catch { action.error = error.localizedDescription } }
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
    }.onAppear { text = item?.text ?? ""; due = item?.due ?? ""; selectedKind = kind }
  }
}
