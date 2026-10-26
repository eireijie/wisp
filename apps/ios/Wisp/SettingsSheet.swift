import SwiftUI

/** How a screen opens the settings sheet (your avatar); MainTabs holds the sheet. */
struct SheetOpener: Sendable {
  var open: @Sendable @MainActor () -> Void = {}
  @MainActor func callAsFunction() { open() }
}
private struct OpenSettingsKey: EnvironmentKey { static let defaultValue = SheetOpener() }
private struct OpenOrgsKey: EnvironmentKey { static let defaultValue = SheetOpener() }

extension EnvironmentValues {
  var openSettings: SheetOpener {
    get { self[OpenSettingsKey.self] }
    set { self[OpenSettingsKey.self] = newValue }
  }

  var openOrganizations: SheetOpener {
    get { self[OpenOrgsKey.self] }
    set { self[OpenOrgsKey.self] = newValue }
  }
}

/**
 * Settings, opened from your avatar (Settings.dc.html). It holds what used to be the You tab: your
 * profile, computers, apps, memory, tasks, help and sign out, with the full settings list one row away.
 */
struct SettingsSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @AppStorage(ThemeSettings.modeKey, store: WispPreferences.standard) private var mode = ThemeSettings.defaultMode
  @State private var confirmSignOut = false
  @State private var newTask = false
  @State private var orgs = false

  private var online: Int { store.nodes.filter(\.online).count }
  private var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "" }

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        SheetHeader { dismiss() }
        ScrollView {
          VStack(spacing: 14) {
            primary
            if store.canManage {
              CardCaption("Agents")
              CardGroup {
                NavigationLink { AgentPolicyView() } label: { RowLabel(title: "Ask before risky actions", subtitle: "Shell, apps and computer use") }
                  .accessibilityIdentifier("you-ask-before")
                NavigationLink { AgentDefaultsView() } label: { RowLabel(title: "Default model", value: store.agentDefaults?.model ?? "Each harness") }
                  .accessibilityIdentifier("settings-agent-defaults")
              }
            }
            CardGroup {
              NavigationLink { NotificationSettingsView() } label: {
                RowLabel(title: "Notifications", value: store.notificationStatus == .authorized ? "On" : "Off")
              }.accessibilityIdentifier("you-notifications")
              NavigationLink { AppearanceSettingsView() } label: { RowLabel(title: "Appearance", value: modeName) }
                .accessibilityIdentifier("settings-appearance")
              NavigationLink { HelpView() } label: { RowLabel(title: "Help", subtitle: "Setup, fixes and plain words") }.accessibilityIdentifier("you-help")
              NavigationLink { NativeSettingsView() } label: { RowLabel(title: "All settings") }.accessibilityIdentifier("you-settings")
            }
            CardGroup {
              Button { confirmSignOut = true } label: { RowLabel(title: "Sign out", chevron: false, tint: Palette.red) }
                .buttonStyle(.plain).accessibilityIdentifier("you-sign-out")
            }
            footer
          }
          .padding(.horizontal, 18).padding(.top, 14).padding(.bottom, 30)
        }
      }
      .background(Palette.sheet.ignoresSafeArea())
      .toolbar(.hidden, for: .navigationBar)
    }
    .tint(Palette.text)
    .presentationBackground(Palette.sheet)
    .presentationCornerRadius(Corner.sheet)
    .presentationDragIndicator(.hidden)
    .sheet(isPresented: $newTask) { NewTaskView() }
    .sheet(isPresented: $orgs) { OrgSwitcherSheet().environment(store) }
    .confirmationDialog("Sign out of Wisp on this iPhone?", isPresented: $confirmSignOut, titleVisibility: .visible) {
      Button("Sign out", role: .destructive) { dismiss(); store.signOut() }
    }
  }

  private var modeName: String { mode == "light" ? "Light" : mode == "system" ? "System" : "Dark" }

  /** profile, organization, computers, apps, memory, tasks */
  private var primary: some View {
    CardGroup {
      if store.me != nil {
        NavigationLink { ProfileSettingsView() } label: {
          RowLabel(title: store.me?.preferredName ?? store.me?.name ?? "You", subtitle: "\(store.role.capitalized) · \(store.workspace?.name ?? "Wisp")") {
            ProfileInitials(size: 46)
          }
        }.accessibilityIdentifier("you-profile")
      }
      Button { orgs = true } label: { RowLabel(title: "Organization", value: store.workspace?.name) }
        .buttonStyle(.plain).accessibilityIdentifier("you-organizations")
      Button { dismiss(); store.route = .device(id: nil) } label: {
        RowLabel(title: "Computers", value: online > 0 ? "\(online) online" : nil)
      }.buttonStyle(.plain).accessibilityIdentifier("you-devices")
      NavigationLink { MarketplaceView() } label: { RowLabel(title: "Connect apps", subtitle: "Tools and skills for your agents") }
        .accessibilityIdentifier("you-marketplace")
      NavigationLink { MemoryView() } label: { RowLabel(title: "Memory", subtitle: "Notes you and your agents share") }
        .accessibilityIdentifier("you-memory")
      NavigationLink { AboutYouView() } label: { RowLabel(title: "About you", subtitle: "What agents should know about you") }
        .accessibilityIdentifier("you-about")
      if store.features.tasks {
        NavigationLink { TasksView() } label: { RowLabel(title: "Tasks", subtitle: "Work you handed to an agent") }
          .accessibilityIdentifier("you-tasks")
        if store.canManage {
          Button { newTask = true } label: { RowLabel(title: "New task", chevron: false) }
            .buttonStyle(.plain).accessibilityIdentifier("you-new-task")
        }
      }
    }
  }

  private var footer: some View {
    VStack(spacing: 4) {
      GhostView(look: GhostLook(color: "#f5f5f5", color2: "#d9d9d9"), seed: "", size: 30, animate: false).accessibilityHidden(true)
      Text("Wisp").font(.system(size: 16, weight: .semibold)).foregroundStyle(Palette.text)
      if !version.isEmpty { Text(version).font(.system(size: 13)).foregroundStyle(Palette.faint) }
    }.padding(.top, 6)
  }
}

/** Your initials on a soft circle, for the settings profile row. */
struct ProfileInitials: View {
  @Environment(Store.self) private var store
  var size: CGFloat = 46

  var body: some View {
    let name = store.me?.preferredName ?? store.me?.name ?? ""
    let letters = name.split(separator: " ").prefix(2).compactMap { $0.first }
    Text(letters.isEmpty ? "?" : String(letters).uppercased())
      .font(.system(size: size * 0.35, weight: .semibold))
      .foregroundStyle(Palette.muted)
      .frame(width: size, height: size)
      .background(Circle().fill(Color(light: 0xE3E3EA, dark: 0x34343A)))
      .accessibilityHidden(true)
  }
}

struct ModePicker: View {
  @AppStorage(ThemeSettings.modeKey, store: WispPreferences.standard) private var mode = ThemeSettings.defaultMode
  var body: some View {
    Picker("Mode", selection: $mode) { Text("System").tag("system"); Text("Light").tag("light"); Text("Dark").tag("dark") }.pickerStyle(.segmented)
  }
}
