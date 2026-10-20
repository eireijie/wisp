import SwiftUI

struct NativeSettingsView: View {
  @Environment(Store.self) private var store
  var body: some View {
    List {
      Section("Account") {
        NavigationLink("Profile") { ProfileSettingsView() }.accessibilityIdentifier("settings-profile")
        NavigationLink("App behavior") { PreferencesView() }
        NavigationLink("Notifications") { NotificationSettingsView() }
        if store.features.voice { NavigationLink("Voice") { VoiceSettingsView() } }
        NavigationLink("Appearance") { Form { ModePicker(); Text("Text size and reduced motion follow this iPhone's Accessibility settings.").font(.footnote) }.navigationTitle("Appearance") }
        NavigationLink("Security") { SecuritySettingsView() }
        NavigationLink("Mobile") { Form { Text("This iPhone is connected to \(store.workspace?.name ?? "Warren")."); Text("To connect another phone, open Settings → Mobile on the computer, scan its QR code, then match the code."); NavigationLink("Where you're signed in") { SecuritySettingsView() } }.navigationTitle("Mobile") }
      }
      Section("Organization") {
        NavigationLink("Organization") { WorkspaceSettingsView() }.accessibilityIdentifier("settings-workspace")
        if store.features.invite || store.members.count > 1 {
          NavigationLink("People") { PeopleSettingsView() }.accessibilityIdentifier("settings-people")
        }
        NavigationLink("Features") { FeaturesView() }.accessibilityIdentifier("settings-features")
        if store.canManage {
          NavigationLink("Agent defaults") { AgentDefaultsView() }.accessibilityIdentifier("settings-agent-defaults")
          NavigationLink("Agents") { AgentPolicyView() }
          NavigationLink("Computers") { ComputerSettingsView() }
          if !store.simple { advanced }
        }
        NavigationLink("Memory storage") { MemoryStorageView() }
        NavigationLink("Data & export") { DataExportView() }
        NavigationLink("Updates & about") { UpdatesView() }
        NavigationLink("Approvals") { InboxView() }
      }
      if store.simple && store.canManage { Section("Advanced") { advanced } }
      Section { Text("Warren · Free and open source (Apache-2.0)").font(.footnote).foregroundStyle(.secondary) }
    }.sectionScreen("Settings", id: "settings")
  }
  @ViewBuilder private var advanced: some View {
    NavigationLink("Agent runtimes") { AgentRuntimesView() }
    NavigationLink("Connections") { ConnectionsSettingsView() }
  }
}

struct PreferencesView: View {
  @Environment(Store.self) private var store
  @State private var action = FormAction()
  var body: some View {
    Form {
      Section("How much to show") { ExperiencePicker(); Text("Simple keeps the advanced parts behind Advanced so the everyday ones stand out. You can switch any time.").font(.footnote) }
      Section("Messages") {
        preference("Sending a message", key: "sendWith", value: store.prefs?.sendWith ?? "enter", options: [("enter", "Enter"), ("mod-enter", "⌘ + Enter")])
        preference("Clock", key: "clock", value: store.prefs?.clock ?? "auto", options: [("auto", "Automatic"), ("12h", "12-hour"), ("24h", "24-hour")])
      }
      Section("Agents") { preference("Tools agents used", key: "toolCalls", value: store.prefs?.toolCalls ?? "collapsed", options: [("collapsed", "Collapsed"), ("expanded", "Expanded"), ("hidden", "Hidden")]) }
      Text("These preferences also apply when you use Warren on the web. The iPhone uses its native keyboard and clock display.").font(.footnote).foregroundStyle(.secondary)
      InlineError(error: action.error)
    }.navigationTitle("App behavior")
  }
  private func preference(_ label: String, key: String, value: String, options: [(String, String)]) -> some View {
    Picker(label, selection: Binding(get: { value }, set: { new in action.run { try await store.savePrefs([key: AnyEncodable(new)]) } })) { ForEach(options, id: \.0) { Text($0.1).tag($0.0) } }.disabled(action.busy)
  }
}

struct WorkspaceSettingsView: View {
  @Environment(Store.self) private var store
  @State private var name = ""
  @State private var saved = false
  @State private var action = FormAction()
  var body: some View {
    Form {
      Section("Organization name") {
        TextField("Name", text: $name).disabled(!store.isOwner)
        if store.isOwner { Button("Save") { action.run { try await store.renameWorkspace(name.trimmed); saved = true } }.disabled(action.busy || name.trimmed.isEmpty || name.count > 60) }
        else { Text("Only owners can change organization settings.").font(.footnote) }
        if saved { Text("Saved.").foregroundStyle(.green) }
      }
      Section("Hub address") { Text(store.api?.base.absoluteString ?? "").textSelection(.enabled) }
      Section {
        LabeledContent("Your role", value: store.role)
        LabeledContent("Live updates", value: store.connected ? "Connected" : "Reconnecting")
        LabeledContent("People", value: String(store.members.count))
        LabeledContent("Agents", value: String(store.agents.count))
      }
      InlineError(error: action.error)
    }.sectionScreen("Organization", id: "workspace").onAppear { name = store.workspace?.name ?? "" }
  }
}
