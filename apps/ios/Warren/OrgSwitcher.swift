import SwiftUI

/** The organization's name as the title of Chats, with a menu to switch, make or join another. */
struct OrgSwitcher: ViewModifier {
  @Environment(Store.self) private var store
  @State private var sheet: Sheet?
  @State private var action = FormAction()

  enum Sheet: String, Identifiable { case create, join; var id: String { rawValue } }

  func body(content: Content) -> some View {
    content
      .navigationTitle(store.workspace?.name ?? "Warren")
      // inline, so the title shows its chevron and opens the switcher
      .navigationBarTitleDisplayMode(.inline)
      .toolbarTitleMenu {
        ForEach(store.orgList) { org in
          Button {
            action.run { try await store.switchOrg(org) }
          } label: {
            if store.isCurrent(org) {
              Label { Text(org.name); Text(org.subtitle) } icon: { Image(systemName: "checkmark") }
            } else {
              Label { Text(org.name); Text(org.subtitle) } icon: { Image(systemName: org.unread == true ? "circle.fill" : "building.2") }
            }
          }
          .accessibilityLabel("\(org.name), \(org.subtitle)\(store.isCurrent(org) ? ", current" : org.unread == true ? ", new messages" : "")")
        }
        Divider()
        Button("New organization", systemImage: "plus") { sheet = .create }
        Button("Join with an invite link", systemImage: "link") { sheet = .join }
      }
      .task { await store.refreshOrgs() }
      .sheet(item: $sheet) { which in
        switch which {
        case .create: NewOrgSheet()
        case .join: JoinOrgSheet()
        }
      }
      .managementAlert(action)
  }
}

extension View {
  func orgSwitcher() -> some View { modifier(OrgSwitcher()) }
}

struct NewOrgSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var name = ""
  @State private var action = FormAction()

  var body: some View {
    NavigationStack {
      Form {
        Section {
          VStack(spacing: 10) {
            IconTile(symbol: "building.2", color: .indigo, size: 56)
            Text("A fresh place with its own agents, channels and memory. It starts simple; turn on more in Settings → Features.")
              .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
          }.frame(maxWidth: .infinity).padding(.vertical, 8)
        }
        Section("Name") {
          TextField("Weekend project", text: $name).submitLabel(.done).onSubmit(create)
        }
        Section { InlineError(error: action.error) }
      }
      .navigationTitle("New organization")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(action.busy) }
        ToolbarItem(placement: .confirmationAction) {
          Button("Create", action: create).disabled(name.trimmed.isEmpty || name.count > 60 || action.busy)
        }
      }
      .interactiveDismissDisabled(action.busy)
    }
  }

  private func create() {
    guard !name.trimmed.isEmpty else { return }
    action.run {
      try await store.createOrg(name.trimmed)
      dismiss()
    }
  }
}

struct JoinOrgSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var link = ""
  @State private var action = FormAction()

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("Invite link", text: $link, axis: .vertical)
            .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
          if UIPasteboard.general.hasStrings || UIPasteboard.general.hasURLs {
            Button("Paste", systemImage: "doc.on.clipboard") { link = UIPasteboard.general.url?.absoluteString ?? UIPasteboard.general.string ?? "" }
          }
        } footer: { Text("Someone in that organization shares the link from Settings → People.") }
        Section { InlineError(error: action.error) }
      }
      .navigationTitle("Join an organization")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(action.busy) }
        ToolbarItem(placement: .confirmationAction) {
          Button("Join") {
            action.run {
              try await store.joinOrg(link)
              dismiss()
            }
          }.disabled(Store.inviteCode(link).isEmpty || action.busy)
        }
      }
      .interactiveDismissDisabled(action.busy)
    }
  }
}
