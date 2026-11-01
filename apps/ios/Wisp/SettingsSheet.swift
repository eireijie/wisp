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
 * You, opened from your avatar: your profile and organization, the agent rules, notifications and
 * appearance, and sign out, with the full settings list one row away. Features are in More.
 */
struct SettingsSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @AppStorage(ThemeSettings.themeKey, store: WispPreferences.standard) private var theme = "mono"
  @Environment(\.openURL) private var openURL
  @State private var confirmSignOut = false
  @State private var orgs = false
  @State private var policyAction = FormAction()

  private var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "" }

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        SheetHeader { dismiss() }
        ScrollView {
          VStack(spacing: 14) {
            primary
            if store.role == "guest" {
              guestNote
            }
            if store.canManage {
              CardCaption("Agents")
              CardGroup {
                if store.isOwner {
                  ToggleRow(title: "Ask before risky actions", subtitle: "Shell, apps and computer use", symbol: "shield", isOn: askBefore, id: "you-ask-before")
                    .disabled(policyAction.busy)
                } else {
                  NavigationLink { AgentPolicyView() } label: { RowLabel(title: "Ask before risky actions", subtitle: "Shell, apps and computer use", leading: { rowIcon("shield") }) }
                    .accessibilityIdentifier("you-ask-before")
                }
                NavigationLink { AgentDefaultsView() } label: { RowLabel(title: "Agent defaults", value: store.agentDefaults?.model ?? "Each harness", leading: { rowIcon("cpu") }) }
                  .accessibilityIdentifier("settings-agent-defaults")
              }
            }
            CardGroup {
              ToggleRow(title: "Notifications", symbol: "bell", isOn: notifications, id: "you-notifications")
              NavigationLink { AppearanceSettingsView() } label: { RowLabel(title: "Appearance", value: themeName, leading: { rowIcon("paintpalette") }) }
                .accessibilityIdentifier("settings-appearance")
              if store.role != "guest" {
                NavigationLink { NativeSettingsView() } label: { RowLabel(title: "All settings", leading: { rowIcon("gearshape") }) }.accessibilityIdentifier("you-settings")
              } else {
                NavigationLink { NativeSettingsView() } label: { RowLabel(title: "Settings", leading: { rowIcon("gearshape") }) }.accessibilityIdentifier("you-settings")
              }
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
      .chatDestinations()
    }
    .tint(Palette.text)
    .presentationBackground(Palette.sheet)
    .presentationCornerRadius(Corner.sheet)
    .presentationDragIndicator(.hidden)
    .sheet(isPresented: $orgs) { OrgSwitcherSheet().environment(store) }
    .confirmCard($confirmSignOut, title: "Sign out of Wisp on this iPhone?", message: "Your agents keep working. To come back, scan your Wisp's QR code or sign in again.", confirm: "Sign out") {
      dismiss(); store.signOut()
    }
    .managementAlert(policyAction)
    .task { try? await store.refreshAgentPolicy(); await store.refreshAgentDefaults(); await store.setUpPush() }
  }

  private var themeName: String { AppTheme.named(theme).name }

  /** the switch for "Ask before risky actions": on when any action asks first */
  private var askBefore: Binding<Bool> {
    Binding(get: { !(store.agentPolicy?.askBefore.isEmpty ?? true) }, set: { on in
      guard var next = store.agentPolicy, !policyAction.busy else { return }
      next.askBefore = on ? ["send", "spend", "delete", "post", "signup", "share"] : []
      store.agentPolicy = next
      policyAction.run { try await store.saveAgentPolicyOrRestore(next) }
    })
  }

  /** notifications on this phone: turning them on asks iOS; turning them off opens the iPhone's own settings */
  private var notifications: Binding<Bool> {
    Binding(get: { store.notificationStatus == .authorized || store.notificationStatus == .provisional }, set: { on in
      if on { Task { await store.enableNotifications() } }
      else if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
    })
  }

  private var guestNote: some View {
    Text("You're a guest in \(store.workspace?.name ?? "this workspace"). You can chat in the teams you're added to and use the shared folder in memory. Agents, computers and settings belong to the owner.")
      .font(.system(size: 15)).foregroundStyle(Palette.muted).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 6)
  }

  /** profile, organization and what agents know about you (a guest sees their profile) */
  private var primary: some View {
    CardGroup {
      if store.me != nil {
        NavigationLink { ProfileSettingsView() } label: {
          RowLabel(title: store.me?.preferredName ?? store.me?.name ?? "You", subtitle: "\(store.role.capitalized) · \(store.workspace?.name ?? "Wisp")") {
            ProfileInitials(size: 46)
          }
        }.accessibilityIdentifier("you-profile")
      }
      if store.role != "guest" {
        Button { orgs = true } label: { RowLabel(title: "Workspace", value: store.workspace?.name, leading: { rowIcon("building.2") }) }
          .buttonStyle(.plain).accessibilityIdentifier("you-workspaces")
        NavigationLink { AboutYouView() } label: { RowLabel(title: "About you", leading: { rowIcon("brain") }) }
          .accessibilityIdentifier("you-about")
      }
    }
  }

  private var footer: some View {
    VStack(spacing: 4) {
      GhostView(look: GhostLook(color: "#f5f5f5", color2: "#d9d9d9"), seed: "", size: 30, animate: false).accessibilityHidden(true)
      Text("Wisp").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text)
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
