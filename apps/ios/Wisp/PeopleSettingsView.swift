import SwiftUI

private let roleHint = [
  "owner": "Everything, including people, devices and settings",
  "member": "Chat, agents, tasks and memory",
  "guest": "Chat and the shared folder in memory",
]

/** Settings → People (set-People.dc.html): members, guests, invites and computers waiting to join. */
struct PeopleSettingsView: View {
  @Environment(Store.self) private var store
  @State private var revoking: WorkspaceInvite?
  @State private var action = FormAction()

  private var people: [Member] { store.members.filter { $0.role != "guest" } }
  private var guests: [Member] { store.members.filter { $0.role == "guest" } }

  var body: some View {
    SettingsPage(title: "People", id: "people", trailing: {
      if store.isOwner {
        NavigationLink { InvitePeopleView() } label: { CircleLabel(symbol: "person.badge.plus") }
          .accessibilityLabel("Invite people").accessibilityIdentifier("people-invite")
      }
    }) {
      CardLabel("Members")
      CardGroup { ForEach(people) { personRow($0) } }
      if !guests.isEmpty {
        CardLabel("Guests")
        CardGroup { ForEach(guests) { personRow($0) } }
      }
      if store.isOwner && (!store.invites.isEmpty || !store.joinRequests.isEmpty) {
        CardLabel("Waiting to join")
        CardGroup {
          ForEach(store.invites) { invite in
            HStack(spacing: 12) {
              Image(systemName: "link").font(.system(size: 16)).foregroundStyle(Palette.muted).frame(width: 34, height: 34)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color(light: 0xE3E3EA, dark: 0x2E2E32)))
              VStack(alignment: .leading, spacing: 2) {
                Text("Invite link for a \(invite.role)").font(.system(size: 15)).foregroundStyle(Palette.text)
                if let value = invite.expiresAt, let date = Wire.date(value) { Text("Expires \(date.formatted(.relative(presentation: .named)))").font(.system(size: 13)).foregroundStyle(Palette.faint) }
              }
              Spacer(minLength: 8)
              Button("Revoke") { revoking = invite }.buttonStyle(.pill(.secondary, small: true)).accessibilityLabel("Revoke invite")
            }.padding(.horizontal, 18).frame(minHeight: 64)
          }
          ForEach(store.joinRequests) { request in
            VStack(spacing: 12) {
              HStack(spacing: 12) {
                Image(systemName: "desktopcomputer").font(.system(size: 16)).foregroundStyle(Palette.muted).frame(width: 34, height: 34)
                  .background(RoundedRectangle(cornerRadius: 10).fill(Color(light: 0xE3E3EA, dark: 0x2E2E32)))
                VStack(alignment: .leading, spacing: 2) {
                  Text("\(request.name) wants to join").font(.system(size: 15)).foregroundStyle(Palette.text)
                  Text("It should show the code \(request.displayCode)").font(.system(size: 13)).foregroundStyle(Palette.faint)
                }
                Spacer(minLength: 0)
              }
              HStack(spacing: 10) {
                Button("Approve") { action.run { try await store.decideJoin(request, approve: true) } }.buttonStyle(.pill(.primary, small: true)).frame(maxWidth: .infinity)
                Button("Deny") { action.run { try await store.decideJoin(request, approve: false) } }.buttonStyle(.pill(.secondary, small: true)).frame(maxWidth: .infinity)
              }.disabled(action.busy)
            }.padding(.horizontal, 18).padding(.vertical, 14)
          }
        }
      }
      StatusLine(error: action.error)
    }
    .task { do { try await store.refreshPeople(); try? await store.refreshJoinRequests() } catch { action.error = error.localizedDescription } }
    .confirmCard(Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), title: "Revoke this invite?", message: "The link stops working.", confirm: "Revoke") {
      if let invite = revoking { action.run { try await store.revokeInvite(invite.id) } }
    }
  }

  @ViewBuilder private func personRow(_ member: Member) -> some View {
    let me = member.id == store.me?.id
    let detail = member.role == "guest" ? roleHint["guest"]! : "\(member.role.capitalized)\(me ? " · you" : "")"
    if store.isOwner && !me {
      NavigationLink { ManagePersonView(member: member) } label: { personFace(member, detail: detail, chevron: true) }.accessibilityIdentifier("person-\(member.id)")
    } else {
      personFace(member, detail: detail, chevron: false)
    }
  }

  private func personFace(_ member: Member, detail: String, chevron: Bool) -> some View {
    HStack(spacing: 12) {
      InitialsDot(name: member.name, size: 40)
      VStack(alignment: .leading, spacing: 2) {
        Text(member.name).font(.system(size: 15)).foregroundStyle(Palette.text)
        Text(detail).font(.system(size: 13)).foregroundStyle(Palette.faint)
      }
      Spacer(minLength: 8)
      if chevron { Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.faint) }
    }.padding(.horizontal, 18).frame(minHeight: 64).contentShape(Rectangle())
  }
}

/** Make an invite link and send it privately (set-InvitePeople.dc.html). */
struct InvitePeopleView: View {
  @Environment(Store.self) private var store
  @State private var role = "member"
  @State private var owner = false
  @State private var days = 7
  @State private var fresh: URL?
  @State private var copied = false
  @State private var action = FormAction()

  private var effectiveRole: String { role == "member" && owner ? "owner" : role }
  private var reachable: Bool { store.api?.base.host()?.hasSuffix(".local") == false && store.api?.base.host()?.range(of: #"^(10\.|192\.168\.)"#, options: .regularExpression) == nil }

  var body: some View {
    SettingsPage("Invite people", id: "invite-people") {
      CardLabel("Role")
      SegmentedPicker(options: [("member", "Member"), ("guest", "Guest")], selection: $role, label: "Role", id: "invite-role")
      CardGroup {
        HStack {
          Text("Link expires").font(.system(size: 15)).foregroundStyle(Palette.text)
          Spacer(minLength: 8)
          Picker("Link expires", selection: $days) {
            Text("In a day").tag(1); Text("In 3 days").tag(3); Text("In a week").tag(7); Text("In 2 weeks").tag(14); Text("In a month").tag(30)
          }.pickerStyle(.menu).tint(Palette.faint).labelsHidden()
        }.padding(.horizontal, 18).frame(minHeight: 54)
        MoreOptionsRow {
          ToggleRow(title: "Make them an owner", subtitle: "Owners can change everything, including people", isOn: $owner).disabled(role != "member")
        }
      }
      StatusLine(error: action.error)
      Button("Create invite link") {
        action.run {
          let invite = try await store.createInvite(role: effectiveRole, days: days)
          if let code = invite.code, let base = store.api?.base {
            var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
            components?.fragment = "/join/\(code)"
            fresh = components?.url
            copied = false
          }
        }
      }.buttonStyle(.pill(.primary)).disabled(action.busy).accessibilityIdentifier("invite-create")
      if let fresh {
        CardLabel("Invite link · works once")
        VStack(alignment: .leading, spacing: 10) {
          Text(fresh.absoluteString).font(.system(size: 14, design: .monospaced)).foregroundStyle(Palette.text).textSelection(.enabled)
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading).background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
        HStack(spacing: 10) {
          Button(copied ? "Copied" : "Copy link") { UIPasteboard.general.url = fresh; copied = true }.buttonStyle(.pill(.secondary))
          ShareLink(item: fresh) { Text("Share").frame(maxWidth: .infinity) }.buttonStyle(.pill(.secondary))
        }
        if !reachable { CardHint("This link only works on this Wi-Fi. To invite someone elsewhere, turn on an address that works from anywhere in Access.") }
      }
      CardGroup {
        NavigationLink { AddPersonView() } label: { RowLabel(title: "Add someone directly") }
          .accessibilityIdentifier("people-add-direct")
      }
    }
  }
}

/** Make someone's account now, with a temporary password. */
struct AddPersonView: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var name = ""
  @State private var email = ""
  @State private var password = ""
  @State private var role = "member"
  @State private var action = FormAction()

  private var valid: Bool { !name.trimmed.isEmpty && email.contains("@") && password.count >= 8 }

  var body: some View {
    SettingsPage("Add someone directly", id: "add-person") {
      CardGroup {
        FieldRow(title: "Name", text: $name, contentType: .name, id: "add-name")
        FieldRow(title: "Email", text: $email, keyboard: .emailAddress, contentType: .emailAddress, id: "add-email")
        FieldRow(title: "Temporary password", text: $password, secure: true, contentType: .newPassword, id: "add-password")
      }
      CardHint("At least 8 characters. Share it with them privately.")
      CardLabel("Role")
      SegmentedPicker(options: [("member", "Member"), ("guest", "Guest"), ("owner", "Owner")], selection: $role, label: "Role", id: "add-role")
      StatusLine(error: action.error)
      Button("Add person") {
        action.run {
          try await store.addPerson(["name": AnyEncodable(name.trimmed), "email": AnyEncodable(email.trimmed), "password": AnyEncodable(password), "role": AnyEncodable(role)])
          dismiss()
        }
      }.buttonStyle(.pill(.primary)).disabled(action.busy || !valid).accessibilityIdentifier("add-person-save")
    }
  }
}

/** One person: their role, a temporary password, and removing them (set-ManagePerson.dc.html). */
struct ManagePersonView: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var member: Member
  @State private var role = "member"
  @State private var removing = false
  @State private var action = FormAction()

  /** the role the hub has now (the `member` passed in is a snapshot from when the page opened) */
  private var savedRole: String { store.members.first { $0.id == member.id }?.role ?? member.role }
  private var lastOwner: Bool { savedRole == "owner" && store.members.filter { $0.role == "owner" }.count < 2 }

  var body: some View {
    SettingsPage(member.name, id: "manage-person") {
      HStack(spacing: 14) {
        InitialsDot(name: member.name, size: 56)
        VStack(alignment: .leading, spacing: 2) {
          Text(member.name).font(.system(size: 20, weight: .semibold)).foregroundStyle(Palette.text)
          Text("\(member.role.capitalized) · \(member.email)").font(.system(size: 13)).foregroundStyle(Palette.faint)
        }
        Spacer(minLength: 0)
      }
      CardLabel("Role")
      SegmentedPicker(options: lastOwner ? [("owner", "Owner")] : [("owner", "Owner"), ("member", "Member"), ("guest", "Guest")], selection: $role, label: "Role", id: "manage-role")
        .disabled(action.busy)
        .onChange(of: role) {
          guard role != savedRole else { return }
          let wanted = role
          action.run {
            do { try await store.updateMember(member.id, role: wanted) }
            catch { role = savedRole; throw error }
          }
        }
      if lastOwner { CardHint("A workspace needs at least one owner; make someone else an owner first.") }
      CardGroup {
        NavigationLink { TemporaryPasswordView(member: member) } label: { RowLabel(title: "Set a temporary password") }
          .accessibilityIdentifier("manage-password")
      }
      StatusLine(error: action.error)
      Button("Remove person") { removing = true }.buttonStyle(.pill(.destructive)).accessibilityIdentifier("manage-remove")
    }
    .onAppear { role = savedRole }
    .confirmCard($removing, title: "Remove \(member.name)?", message: "Their tokens and devices will be disconnected.", confirm: "Remove") {
      action.run { try await store.removePerson(member.id); dismiss() }
    }
  }
}

struct TemporaryPasswordView: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var member: Member
  @State private var password = ""
  @State private var action = FormAction()

  var body: some View {
    SettingsPage("Temporary password", subtitle: "For \(member.name).", id: "temp-password") {
      CardGroup { FieldRow(title: "New password", text: $password, secure: true, contentType: .newPassword, id: "temp-password-field") }
      CardHint("At least 8 characters. Share it with them privately. Their sign-ins will end.")
      StatusLine(error: action.error)
      Button("Set password") { action.run { try await store.resetPassword(member.id, password: password); dismiss() } }
        .buttonStyle(.pill(.primary)).disabled(action.busy || password.count < 8 || password.count > 200)
    }
  }
}
