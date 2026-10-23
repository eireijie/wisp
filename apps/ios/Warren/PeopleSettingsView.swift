import SwiftUI

struct PeopleSettingsView: View {
  @Environment(Store.self) private var store
  @State private var role = "member"
  @State private var days = 7
  @State private var fresh: URL?
  @State private var adding = false
  @State private var editing: Member?
  @State private var revoking: WorkspaceInvite?
  @State private var action = FormAction()
  var body: some View {
    List {
      if store.isOwner {
        Section("Invite people") {
          Text("Make a link and send it to them privately. It works once, for the role you pick, until it expires.").font(.footnote)
          Picker("Role", selection: $role) { Text("Member").tag("member"); Text("Guest").tag("guest"); Text("Owner").tag("owner") }
          Stepper("Expires in \(days) days", value: $days, in: 1...30)
          Button("Create invite") {
            action.run {
              let invite = try await store.createInvite(role: role, days: days)
              if let code = invite.code, let base = store.api?.base {
                var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
                components?.fragment = "/join/\(code)"
                fresh = components?.url
              }
            }
          }.disabled(action.busy)
          if let fresh { ShareLink("Share invite link", item: fresh); Button("Copy link") { UIPasteboard.general.url = fresh } }
          Button("Add someone directly") { adding = true }
        }
      }
      Section("People") {
        ForEach(store.members) { member in
          VStack(alignment: .leading, spacing: 5) {
            Text(member.name).font(.headline)
            Text("\(member.email) · \(member.role)").font(.caption).foregroundStyle(.secondary)
            if store.isOwner { Button("Manage \(member.name)") { editing = member } }
          }
        }
      }
      if store.isOwner {
        Section("Open invites") {
          ForEach(store.invites) { invite in
            VStack(alignment: .leading) { Text(invite.role.capitalized); if let value = invite.expiresAt, let date = Wire.date(value) { Text("Expires \(date, format: .dateTime.month().day().hour().minute())").font(.caption) }; Button("Revoke", role: .destructive) { revoking = invite } }
          }
        }
      }
      InlineError(error: action.error)
    }.sectionScreen("People", id: "people")
      .sheet(isPresented: $adding) { AddPersonView() }
      .sheet(item: $editing) { PersonEditor(member: $0) }
      .task { do { try await store.refreshPeople() } catch { action.error = error.localizedDescription } }
      .confirmationDialog("Revoke this invite?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible) {
        Button("Revoke", role: .destructive) { if let invite = revoking { action.run { try await store.revokeInvite(invite.id) } } }
      }
  }
}

struct AddPersonView: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var name = ""
  @State private var email = ""
  @State private var password = ""
  @State private var role = "member"
  @State private var action = FormAction()
  var body: some View {
    EditorSheet(title: "Add someone directly", action: action, valid: !name.trimmed.isEmpty && email.contains("@") && password.count >= 8, saveTitle: "Add person", save: {
      action.run {
        try await store.addPerson(["name": AnyEncodable(name.trimmed), "email": AnyEncodable(email.trimmed), "password": AnyEncodable(password), "role": AnyEncodable(role)])
        dismiss()
      }
    }) {
      Text("Makes their account now, with a temporary password you give them. An invite link lets them pick their own.").font(.footnote)
      TextField("Name", text: $name).textContentType(.name)
      TextField("Email", text: $email).textContentType(.emailAddress).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
      SecureField("Temporary password", text: $password).textContentType(.newPassword)
      Picker("Role", selection: $role) { Text("Member").tag("member"); Text("Guest").tag("guest"); Text("Owner").tag("owner") }
    }
  }
}

struct PersonEditor: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var member: Member
  @State private var role = "member"
  @State private var password = ""
  @State private var removing = false
  @State private var resetting = false
  @State private var action = FormAction()
  private var lastOwner: Bool { member.role == "owner" && store.members.filter { $0.role == "owner" }.count < 2 }
  var body: some View {
    EditorSheet(title: member.name, action: action, save: { action.run { try await store.updateMember(member.id, role: role); dismiss() } }) {
      Picker("Role", selection: $role) { Text("Owner").tag("owner"); if !lastOwner { Text("Member").tag("member"); Text("Guest").tag("guest") } }
      if lastOwner { Text("A workspace needs at least one owner; make someone else an owner first.").font(.footnote) }
      if member.id != store.me?.id {
        Section("Reset password") {
          SecureField("Temporary password", text: $password)
          Text("At least 8 characters. Share it with them privately. Their sign-ins will end.").font(.footnote)
          Button("Set password") { resetting = true }.disabled(action.busy || password.count < 8 || password.count > 200)
        }
      }
      if member.id != store.me?.id { Button("Remove person", role: .destructive) { removing = true } }
    }.onAppear { role = member.role }
      .confirmationDialog("Remove \(member.name)? Their tokens and devices will be disconnected.", isPresented: $removing, titleVisibility: .visible) {
        Button("Remove", role: .destructive) { action.run { try await store.removePerson(member.id); dismiss() } }
      }
      .confirmationDialog("Set a new password and end their sign-ins?", isPresented: $resetting, titleVisibility: .visible) {
        Button("Set password") { action.run { try await store.resetPassword(member.id, password: password); dismiss() } }
      }
  }
}
