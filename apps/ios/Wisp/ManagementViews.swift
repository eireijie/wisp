import SwiftUI

@MainActor @Observable
final class FormAction {
  var busy = false
  var error: String?

  func run(_ work: @escaping @MainActor () async throws -> Void) {
    guard !busy else { return }
    busy = true
    error = nil
    Task {
      defer { busy = false }
      do { try await work() }
      catch { self.error = error.localizedDescription }
    }
  }
}

struct InlineError: View {
  var error: String?
  var body: some View {
    if let error { Text(error).font(.footnote).foregroundStyle(.red).accessibilityLabel("Error: \(error)") }
  }
}

extension View {
  func managementAlert(_ action: FormAction) -> some View {
    alert("Couldn't save", isPresented: Binding(get: { action.error != nil }, set: { if !$0 { action.error = nil } })) {
      Button("OK") { action.error = nil }
    } message: { Text(action.error ?? "") }
  }
}

/** The rarely used knobs, behind a disclosure so everyone gets the same plain screen. */
struct TechnicalDetails<Content: View>: View {
  var title = "More options"
  @ViewBuilder var content: () -> Content

  var body: some View {
    DisclosureGroup(title, content: content)
  }
}

struct SectionPicker: View {
  @Environment(Store.self) private var store
  @Binding var selection: String
  var body: some View {
    Picker("Section", selection: $selection) {
      Text("No section").tag("")
      ForEach(store.sections) { Text($0.title).tag($0.id) }
    }
  }
}

struct AnswerPicker: View {
  @Environment(Store.self) private var store
  @Binding var selection: String
  var body: some View {
    Menu {
      Button("Nobody: only agents someone @mentions") { selection = "" }
      ForEach(store.agents) { agent in
        Button("\(agent.name) (@\(agent.handle))") { selection = agent.id }
      }
    } label: {
      VStack(alignment: .leading, spacing: 8) {
        Text("Who answers messages without an @mention?").foregroundStyle(.primary).multilineTextAlignment(.leading)
        HStack(alignment: .top) {
          Text(store.agent(selection).map { "\($0.name) (@\($0.handle))" } ?? "Nobody: only agents someone @mentions")
            .fixedSize(horizontal: false, vertical: true)
          Spacer(minLength: 8)
          Image(systemName: "chevron.up.chevron.down")
        }.font(.subheadline).foregroundStyle(.secondary)
      }.padding(.vertical, 4)
    }
  }
}

struct SectionEditor: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var section: ChannelSection?
  @State private var name = ""
  @State private var emoji = "🐇"
  @State private var action = FormAction()

  var body: some View {
    NavigationStack {
      Form {
        TextField("Name", text: $name)
        Picker("Emoji", selection: $emoji) {
          Text("None").tag("")
          ForEach(["🐇", "🛠️", "🚀", "📣", "🎨", "🧪", "📊", "💬", "🌱", "🔒", "🤖", "⭐"], id: \.self) { Text($0).tag($0) }
          if !emoji.isEmpty && !["🐇", "🛠️", "🚀", "📣", "🎨", "🧪", "📊", "💬", "🌱", "🔒", "🤖", "⭐"].contains(emoji) { Text(emoji).tag(emoji) }
        }
        InlineError(error: action.error)
      }
      .navigationTitle(section == nil ? "New section" : "Edit section")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") {
            action.run {
              if let section { try await store.updateSection(section.id, name: name, emoji: emoji) }
              else { try await store.createSection(name: name, emoji: emoji) }
              dismiss()
            }
          }.disabled(action.busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.count > 40)
        }
      }
      .onAppear { if let section { name = section.name; emoji = section.emoji } }
      .interactiveDismissDisabled(action.busy)
    }
  }
}

struct MemberChoices: View {
  @Environment(Store.self) private var store
  @Binding var selected: Set<Actor>
  var excluding: Set<Actor> = []

  var body: some View {
    Section("People") {
      ForEach(store.members.filter { !excluding.contains(Actor(kind: .user, id: $0.id)) }) { member in
        choice(member.preferredName ?? member.name, actor: Actor(kind: .user, id: member.id))
      }
    }
    Section("Agents") {
      ForEach(store.agents.filter { !excluding.contains(Actor(kind: .agent, id: $0.id)) }) { agent in
        choice("\(agent.name) (@\(agent.handle))", actor: Actor(kind: .agent, id: agent.id))
      }
    }
  }

  private func choice(_ name: String, actor: Actor) -> some View {
    Toggle(name, isOn: Binding(get: { selected.contains(actor) }, set: { on in
      if on { selected.insert(actor) } else { selected.remove(actor) }
    }))
  }
}
