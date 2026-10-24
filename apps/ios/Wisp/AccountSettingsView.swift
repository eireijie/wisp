import SwiftUI

struct ProfileSettingsView: View {
  @Environment(Store.self) private var store
  @State private var name = ""
  @State private var preferred = ""
  @State private var email = ""
  @State private var timezone = ""
  @State private var saved = false
  @State private var action = FormAction()
  var body: some View {
    Form {
      Section("Full name") { TextField("Full name", text: $name).textContentType(.name) }
      Section("What should agents call you?") { TextField("Preferred name", text: $preferred).textContentType(.nickname) }
      Section("Email") { TextField("Email", text: $email).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled() }
      Picker("Time zone", selection: $timezone) {
        Text("Not set (agents see UTC)").tag("")
        ForEach(TimeZone.knownTimeZoneIdentifiers, id: \.self) { Text($0).tag($0) }
      }
      Button("Save") {
        action.run { try await store.saveProfile(["name": AnyEncodable(name.trimmed), "preferredName": .nullable(preferred.trimmed), "email": AnyEncodable(email.trimmed), "timezone": .nullable(timezone)]); saved = true }
      }.disabled(action.busy || name.trimmed.isEmpty || name.count > 80 || preferred.count > 40 || !email.contains("@"))
      if saved { Text("Saved.").foregroundStyle(.green) }
      InlineError(error: action.error)
      NavigationLink("Password and sign-ins") { SecuritySettingsView() }
    }.sectionScreen("Profile", id: "profile")
      .onAppear { name = store.me?.name ?? ""; preferred = store.me?.preferredName ?? ""; email = store.me?.email ?? ""; timezone = store.me?.timezone ?? "" }
  }
}

struct SecuritySettingsView: View {
  @Environment(Store.self) private var store
  @State private var current = ""
  @State private var next = ""
  @State private var again = ""
  @State private var saved = false
  @State private var others = false
  @State private var action = FormAction()
  var body: some View {
    Form {
      Section("Password") {
        SecureField("Current password", text: $current).textContentType(.password)
        SecureField("New password", text: $next).textContentType(.newPassword)
        SecureField("New password again", text: $again).textContentType(.newPassword)
        Text("At least 8 characters. Your other sign-ins will end.").font(.footnote)
        Button("Change password") { action.run { try await store.changePassword(current: current, next: next); current = ""; next = ""; again = ""; saved = true } }.disabled(action.busy || current.isEmpty || next.count < 8 || next.count > 200 || next != again)
        if saved { Text("Password changed.").foregroundStyle(.green) }
      }
      Section("Where you're signed in") {
        ForEach(store.sessions) { session in
          VStack(alignment: .leading) {
            Text(session.label ?? "Unknown device")
            if session.current == true { Text("This device").font(.caption).foregroundStyle(.secondary) }
            else { Button("Sign out") { action.run { try await store.revokeSession(session.id) } }.disabled(action.busy) }
            if let last = session.lastUsed, let date = Wire.date(last) { Text("Last used \(date, format: .relative(presentation: .named))").font(.caption).foregroundStyle(.secondary) }
          }
        }
        Button("Sign out others", role: .destructive) { others = true }.disabled(action.busy)
      }
      InlineError(error: action.error)
    }.navigationTitle("Security")
      .task { do { try await store.refreshSessions() } catch { action.error = error.localizedDescription } }
      .confirmationDialog("Sign out all your other browsers and apps?", isPresented: $others, titleVisibility: .visible) { Button("Sign out others", role: .destructive) { action.run { try await store.signOutOthers() } } }
  }
}

struct NotificationSettingsView: View {
  @Environment(Store.self) private var store
  @Environment(\.openURL) private var openURL
  @AppStorage("wisp.notify.enabled", store: WispPreferences.standard) private var enabled = true
  @AppStorage("wisp.notify.sound", store: WispPreferences.standard) private var sound = false
  @AppStorage("wisp.notify.dms", store: WispPreferences.standard) private var dms = true
  @AppStorage("wisp.notify.replies", store: WispPreferences.standard) private var replies = true
  @AppStorage("wisp.notify.approvals", store: WispPreferences.standard) private var approvals = true
  @AppStorage("wisp.notify.help", store: WispPreferences.standard) private var help = true
  @AppStorage("wisp.notify.tasks", store: WispPreferences.standard) private var tasks = true
  @State private var action = FormAction()
  @State private var sent = false
  var body: some View {
    Form {
      Section("Notify me when a task finishes or needs me") {
        LabeledContent("This iPhone", value: store.notificationStatus == .authorized ? "On" : "Off")
        if !store.pushAvailable { Text("This Wisp isn't set up to send notifications. Its owner can add an Apple push key.").font(.footnote) }
        Button("Turn on notifications") { Task { await store.enableNotifications() } }.disabled(!store.pushAvailable)
        if let error = store.pushRegistrationError {
          Text(error).font(.footnote).foregroundStyle(.red)
          Button("Try again") { store.retryPushRegistration() }
        }
        Button("iPhone notification settings") { if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) } }
        Button("Send a test notification") { action.run { try await store.connection().post("/api/me/push/test", Empty()); sent = true } }.disabled(!store.pushAvailable || action.busy)
        if sent { Text("Sent. You should see it now.") }
      }
      Section("While Wisp is open") {
        Toggle("Notifications while Wisp is open", isOn: $enabled)
        Toggle("Play a sound", isOn: $sound)
      }
      Section("Tell me about") {
        Toggle("Direct messages", isOn: $dms); Toggle("Replies to you", isOn: $replies)
        Toggle("Approvals", isOn: $approvals); Toggle("Help on a computer", isOn: $help); Toggle("Finished tasks", isOn: $tasks)
      }
      Text("These choices apply while this app is open. Push notifications while it's closed are controlled by iPhone settings; this hub has no per-category push preferences.").font(.footnote).foregroundStyle(.secondary)
      InlineError(error: action.error)
    }.navigationTitle("Notifications").task { await store.setUpPush() }
  }
}
