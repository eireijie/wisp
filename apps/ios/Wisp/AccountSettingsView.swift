import SwiftUI

/** Settings → Profile (set-Profile.dc.html). */
struct ProfileSettingsView: View {
  @Environment(Store.self) private var store
  @State private var name = ""
  @State private var preferred = ""
  @State private var email = ""
  @State private var timezone = ""
  @State private var saved = false
  @State private var action = FormAction()

  private var roleName: String { store.role == "owner" ? "Owner" : store.role == "guest" ? "Guest" : "Member" }
  private var valid: Bool { !name.trimmed.isEmpty && name.count <= 80 && preferred.count <= 40 && email.contains("@") }
  private var zoneLabel: String { timezone.isEmpty ? "Not set" : timezone.replacingOccurrences(of: "_", with: " ") }

  var body: some View {
    SettingsPage("Profile", id: "profile") {
      VStack(spacing: 6) {
        InitialsDot(name: store.me?.preferredName ?? store.me?.name ?? "", size: 84)
        Text(store.me?.name ?? "").font(.system(size: 20, weight: .semibold)).foregroundStyle(Palette.text).padding(.top, 6)
        Text("\(roleName) · \(store.workspace?.name ?? "Wisp")").font(.system(size: 13)).foregroundStyle(Palette.faint)
      }.padding(.vertical, 4)
      if store.role == "guest" {
        Text("You're a guest in \(store.workspace?.name ?? "this organization"). You can chat in the teams you're added to and use the shared folder in memory. Agents, computers and people belong to the owner.")
          .font(.system(size: 15)).foregroundStyle(Palette.muted).padding(16).frame(maxWidth: .infinity, alignment: .leading)
          .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
      }
      CardGroup {
        FieldRow(title: "Full name", text: $name, contentType: .name, id: "profile-name")
        FieldRow(title: "Preferred name", subtitle: "What agents call you", text: $preferred, contentType: .nickname, id: "profile-preferred")
      }
      CardHint("Agents use your preferred name when they talk to you.")
      CardGroup {
        FieldRow(title: "Email", text: $email, keyboard: .emailAddress, contentType: .emailAddress, id: "profile-email")
        HStack {
          Text("Time zone").font(.system(size: 15)).foregroundStyle(Palette.text)
          Spacer(minLength: 8)
          Picker("Time zone", selection: $timezone) {
            Text("Not set (agents see UTC)").tag("")
            ForEach(TimeZone.knownTimeZoneIdentifiers, id: \.self) { Text($0.replacingOccurrences(of: "_", with: " ")).tag($0) }
          }.pickerStyle(.menu).tint(Palette.faint).labelsHidden()
            .accessibilityLabel("Time zone, \(zoneLabel)")
        }.padding(.horizontal, 18).frame(minHeight: 54)
      }
      CardGroup { ValueRow(title: "Your role", value: roleName) }
      StatusLine(error: action.error, saved: saved ? "Saved." : nil)
      Button("Save changes") {
        action.run {
          try await store.saveProfile(["name": AnyEncodable(name.trimmed), "preferredName": .nullable(preferred.trimmed), "email": AnyEncodable(email.trimmed), "timezone": .nullable(timezone)])
          saved = true
        }
      }.buttonStyle(.pill(.primary)).disabled(action.busy || !valid).accessibilityIdentifier("profile-save")
      NavigationLink { SecuritySettingsView() } label: { Text("Password and sign-ins").font(.system(size: 15)).foregroundStyle(Palette.muted).frame(maxWidth: .infinity) }
    }
    .onAppear { name = store.me?.name ?? ""; preferred = store.me?.preferredName ?? ""; email = store.me?.email ?? ""; timezone = store.me?.timezone ?? "" }
    .onChange(of: name) { saved = false }
    .onChange(of: preferred) { saved = false }
    .onChange(of: email) { saved = false }
    .onChange(of: timezone) { saved = false }
  }
}

/** Settings → Security: where you're signed in, and your password (set-Security.dc.html). */
struct SecuritySettingsView: View {
  @Environment(Store.self) private var store
  @State private var current = ""
  @State private var next = ""
  @State private var again = ""
  @State private var saved = false
  @State private var others = false
  @State private var action = FormAction()

  private func device(_ session: AccountSession) -> String { ["login", "setup"].contains(session.label ?? "") ? "A browser" : session.label ?? "Unknown device" }

  var body: some View {
    SettingsPage("Security", id: "security") {
      CardLabel("Where you're signed in")
      CardGroup {
        ForEach(store.sessions) { session in
          HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
              Text(session.current == true ? "This device" : device(session)).font(.system(size: 15)).foregroundStyle(Palette.text)
              Text(detail(session)).font(.system(size: 13)).foregroundStyle(Palette.faint)
            }
            Spacer(minLength: 8)
            if session.current != true {
              Button("Sign out") { action.run { try await store.revokeSession(session.id) } }.buttonStyle(.pill(.secondary, small: true)).disabled(action.busy)
            }
          }.padding(.horizontal, 18).frame(minHeight: 62)
        }
        if store.sessions.isEmpty { RowLabel(title: "Loading…", chevron: false) }
      }
      if store.sessions.contains(where: { $0.current != true }) {
        Button("Sign out everywhere else") { others = true }.buttonStyle(.pill(.destructive)).disabled(action.busy)
      }
      CardHint("Sign out of anything you don't recognize. Changing your password signs out everything else too.")
      CardLabel("Password")
      CardGroup {
        FieldRow(title: "Current", text: $current, secure: true, contentType: .password, id: "password-current")
        FieldRow(title: "New", text: $next, secure: true, contentType: .newPassword, id: "password-new")
        FieldRow(title: "Again", text: $again, secure: true, contentType: .newPassword, id: "password-again")
      }
      CardHint(!again.isEmpty && next != again ? "The new passwords don't match." : "At least 8 characters. Your other sign-ins will end.")
      StatusLine(error: action.error, saved: saved ? "Password changed." : nil)
      Button("Change password") {
        action.run { try await store.changePassword(current: current, next: next); current = ""; next = ""; again = ""; saved = true }
      }.buttonStyle(.pill(.primary)).disabled(action.busy || current.isEmpty || next.count < 8 || next.count > 200 || next != again)
        .accessibilityIdentifier("password-save")
    }
    .task { do { try await store.refreshSessions() } catch { action.error = error.localizedDescription } }
    .confirmCard($others, title: "Sign out all your other browsers and apps?", message: "They will need to sign in again.", confirm: "Sign out others") {
      action.run { try await store.signOutOthers() }
    }
  }

  private func detail(_ session: AccountSession) -> String {
    if session.current == true { return "Signed in now" }
    if let last = session.lastUsed, let date = Wire.date(last) { return "Last used \(date.formatted(.relative(presentation: .named)))" }
    if let made = session.createdAt, let date = Wire.date(made) { return "Signed in \(date.formatted(.relative(presentation: .named)))" }
    return ""
  }
}

/** Settings → Notifications (set-Notifications.dc.html). */
struct NotificationSettingsView: View {
  @Environment(Store.self) private var store
  @Environment(\.openURL) private var openURL
  @AppStorage("wisp.notify.enabled", store: WispPreferences.standard) private var enabled = true
  @AppStorage("wisp.notify.onlyAway", store: WispPreferences.standard) private var onlyAway = false
  @AppStorage("wisp.notify.sound", store: WispPreferences.standard) private var sound = false
  @AppStorage("wisp.notify.dms", store: WispPreferences.standard) private var dms = true
  @AppStorage("wisp.notify.replies", store: WispPreferences.standard) private var replies = true
  @AppStorage("wisp.notify.approvals", store: WispPreferences.standard) private var approvals = true
  @AppStorage("wisp.notify.help", store: WispPreferences.standard) private var help = true
  @AppStorage("wisp.notify.tasks", store: WispPreferences.standard) private var tasks = true
  @State private var action = FormAction()
  @State private var sent = false

  private var authorized: Bool { store.notificationStatus == .authorized || store.notificationStatus == .provisional }

  var body: some View {
    SettingsPage("Notifications", id: "notifications") {
      CardLabel("Notifications on this phone")
      CardGroup {
        ToggleRow(title: authorized ? "You'll get notifications on this phone, even with Wisp closed." : "Get notifications on this phone, even with Wisp closed.", isOn: Binding(get: { authorized }, set: { on in
          if on { Task { await store.enableNotifications() } }
          else if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
        }), id: "notify-phone")
        .disabled(!store.pushAvailable && !authorized)
        ValueRow(title: "Status", value: authorized ? "Active" : store.notificationStatus == .denied ? "Blocked" : "Off")
        Button { action.run { try await store.connection().post("/api/me/push/test", Empty()); sent = true } } label: { RowLabel(title: "Send a test notification", chevron: false) }
          .buttonStyle(.plain).disabled(!store.pushAvailable || action.busy)
      }
      if !store.pushAvailable { CardHint("This Wisp isn't set up to send notifications. Its owner can add an Apple push key.") }
      if let error = store.pushRegistrationError {
        CardHint(error)
        Button("Try again") { store.retryPushRegistration() }.buttonStyle(.pill(.secondary, small: true))
      }
      if store.notificationStatus == .denied {
        CardHint("Notifications are blocked for Wisp in iPhone settings.")
        Button("iPhone notification settings") { if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) } }.buttonStyle(.pill(.secondary, small: true))
      }
      if sent { CardHint("Sent. You should see it now.") }
      CardLabel("While Wisp is open")
      CardGroup {
        ToggleRow(title: "Show notifications while open", isOn: $enabled)
        ToggleRow(title: "Only when I'm away", isOn: $onlyAway)
        ToggleRow(title: "Play a sound", isOn: $sound)
      }
      CardLabel("Tell me about")
      CardGroup {
        ToggleRow(title: "Direct messages", isOn: $dms)
        ToggleRow(title: "Replies to you", isOn: $replies)
        ToggleRow(title: "Approvals", isOn: $approvals)
        ToggleRow(title: "Help on a computer", isOn: $help)
        ToggleRow(title: "Finished tasks", isOn: $tasks)
      }
      StatusLine(error: action.error)
    }
    .task { await store.setUpPush() }
  }
}
