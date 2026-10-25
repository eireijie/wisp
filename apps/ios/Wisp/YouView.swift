import SwiftUI

struct YouView: View {
  @Environment(Store.self) private var store
  @State private var confirmSignOut = false
  @State private var newTask = false
  var body: some View {
    NavigationStack {
      List {
        if let me = store.me {
          Section {
            HStack(spacing: 14) {
              PersonAvatar(name: me.name, size: 60)
              VStack(alignment: .leading, spacing: 3) {
                Text(me.preferredName ?? me.name).font(.title3.weight(.semibold))
                Text("\(me.email) · \(store.role)").font(.subheadline).foregroundStyle(.secondary)
              }
            }.padding(.vertical, 4)
          }
        }
        if store.features.tasks {
        Section {
          NavigationLink { TasksView() } label: { YouRow("Tasks", "Work you handed to a helper", "list.bullet.rectangle", .cyan) }.accessibilityIdentifier("you-tasks")
          if store.canManage { Button { newTask = true } label: { YouRow("New task", nil, "square.and.pencil", .green) }.accessibilityIdentifier("you-new-task") }
        }
        }
        Section {
          NavigationLink { MemoryView() } label: { YouRow("Memory", "Notes you and your helpers share", "book.fill", .purple) }.accessibilityIdentifier("you-memory")
          NavigationLink { AboutYouView() } label: { YouRow("About you", "What helpers should know about you", "brain", .pink) }.accessibilityIdentifier("you-about")
          NavigationLink { ConnectorsView() } label: { YouRow("Connected apps", "Gmail, Slack and other apps helpers can use", "powerplug.fill", .orange) }.accessibilityIdentifier("you-connectors")
          NavigationLink { SkillsView() } label: { YouRow("Skills", "Things helpers know how to do", "wand.and.stars", .yellow) }.accessibilityIdentifier("you-skills")
          NavigationLink { DevicesView() } label: { YouRow("Devices", "Computers running Wisp", "server.rack", .gray) }.accessibilityIdentifier("you-devices")
        }
        Section {
          NavigationLink { HelpView() } label: { YouRow("Help", "Setup, fixes and plain words", "lifepreserver", .teal) }.accessibilityIdentifier("you-help")
          NavigationLink { NativeSettingsView() } label: { YouRow("Settings", nil, "gearshape.fill", .gray) }.accessibilityIdentifier("you-settings")
        }
        Section { ExperiencePicker(); ModePicker() }
        Section { Button("Sign out", role: .destructive) { confirmSignOut = true } }
      }.navigationTitle("You")
        .sheet(isPresented: $newTask) { NewTaskView() }
        .confirmationDialog("Sign out of Wisp on this iPhone?", isPresented: $confirmSignOut, titleVisibility: .visible) { Button("Sign out", role: .destructive) { store.signOut() } }
    }
  }
}

struct YouRow: View {
  var title: String
  var detail: String?
  var symbol: String
  var color: Color
  init(_ title: String, _ detail: String?, _ symbol: String, _ color: Color) { self.title = title; self.detail = detail; self.symbol = symbol; self.color = color }
  var body: some View {
    HStack(spacing: 12) {
      IconTile(symbol: symbol, color: color, size: 32)
      VStack(alignment: .leading, spacing: 2) { Text(title).foregroundStyle(.primary); if let detail { Text(detail).font(.caption).foregroundStyle(.secondary) } }
    }.padding(.vertical, 3)
  }
}

struct ModePicker: View {
  @AppStorage("wisp.mode", store: WispPreferences.standard) private var mode = "system"
  var body: some View {
    Picker("Mode", selection: $mode) { Text("System").tag("system"); Text("Light").tag("light"); Text("Dark").tag("dark") }.pickerStyle(.segmented)
  }
}

struct ExperiencePicker: View {
  @Environment(Store.self) private var store
  @State private var action = FormAction()
  var body: some View {
    Picker("Experience", selection: Binding(get: { store.simple ? "simple" : "advanced" }, set: { value in action.run { try await store.savePrefs(["experience": AnyEncodable(value)]) } })) {
      Text("Simple").tag("simple"); Text("Advanced").tag("advanced")
    }.disabled(action.busy).managementAlert(action).accessibilityIdentifier("experience-picker")
  }
}
