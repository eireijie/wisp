import SwiftUI

struct EditorSheet<Content: View>: View {
  @Environment(\.dismiss) private var dismiss
  var title: String
  var action: FormAction
  var valid = true
  var saveTitle = "Save"
  var save: () -> Void
  @ViewBuilder var content: () -> Content
  var body: some View {
    NavigationStack {
      Form {
        content().disabled(action.busy)
        InlineError(error: action.error)
      }
      .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(action.busy) }
        ToolbarItem(placement: .confirmationAction) { Button(saveTitle, action: save).disabled(!valid || action.busy) }
      }
      .interactiveDismissDisabled(action.busy)
    }
  }
}

struct AgentSelection: View {
  @Environment(Store.self) private var store
  @Binding var selected: Set<String>
  var allowed: (Agent) -> Bool = { _ in true }
  var body: some View {
    Section("Which agents have it") {
      ForEach(store.agents) { agent in
        Toggle(agent.name, isOn: Binding(get: { selected.contains(agent.id) }, set: { on in
          if on { selected.insert(agent.id) } else { selected.remove(agent.id) }
        })).disabled(!allowed(agent) && !selected.contains(agent.id))
      }
      if store.agents.isEmpty { Text("Add an agent first.").foregroundStyle(.secondary) }
    }
  }
}


extension String {
  var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

extension View {
  func sectionScreen(_ title: String, id: String) -> some View {
    navigationTitle(title).navigationBarTitleDisplayMode(.inline).accessibilityIdentifier("screen-\(id)")
  }
}
