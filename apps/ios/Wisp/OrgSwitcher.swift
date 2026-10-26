import SwiftUI

/**
 * The organizations sheet (core-OrgSwitcher): the ones you belong to with a check on the current one,
 * a way to make a new one, and a way to join one with an invite link or code.
 */
struct OrgSwitcherSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var creating = false
  @State private var joining = false
  @State private var link = ""
  @State private var action = FormAction()

  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: "Organizations") { dismiss() }
      ScrollView {
        VStack(spacing: 14) {
          CardGroup {
            ForEach(store.orgList) { org in
              Button {
                action.run { try await store.switchOrg(org); if store.isCurrent(org) { dismiss() } }
              } label: { orgRow(org) }
                .buttonStyle(.plain)
                .disabled(action.busy)
                .accessibilityLabel("\(org.name), \(org.role?.capitalized ?? org.subtitle)\(store.isCurrent(org) ? ", current" : org.unread == true ? ", new messages" : "")")
            }
          }
          CardGroup {
            Button { creating = true } label: {
              RowLabel(title: "New organization", chevron: false) { Image(systemName: "plus").foregroundStyle(Palette.muted).frame(width: 26) }
            }.buttonStyle(.plain).accessibilityIdentifier("org-new")
            Button { withAnimation(.snappy) { joining.toggle() } } label: {
              RowLabel(title: "Join with an invite link", chevron: false) { Image(systemName: "link").foregroundStyle(Palette.muted).frame(width: 26) }
            }.buttonStyle(.plain).accessibilityIdentifier("org-join")
          }
          if joining { joinCard }
          InlineError(error: action.error)
        }
        .padding(.horizontal, 18).padding(.top, 8).padding(.bottom, 24)
      }
    }
    .background(Palette.sheet.ignoresSafeArea())
    .presentationBackground(Palette.sheet)
    .presentationCornerRadius(Corner.sheet)
    .presentationDragIndicator(.hidden)
    .task { await store.refreshOrgs() }
    .sheet(isPresented: $creating) { NewOrgSheet() }
    .managementAlert(action)
  }

  private func orgRow(_ org: OrgSummary) -> some View {
    HStack(spacing: 12) {
      Image(systemName: "building.2").font(.system(size: 20)).foregroundStyle(Palette.muted).frame(width: 26)
      VStack(alignment: .leading, spacing: 2) {
        Text(org.name).font(.system(size: 17, weight: .semibold)).foregroundStyle(Palette.text)
        Text(org.role?.capitalized ?? org.subtitle).font(.system(size: 13)).foregroundStyle(Palette.faint)
      }
      Spacer()
      if store.isCurrent(org) { Image(systemName: "checkmark").font(.system(size: 17, weight: .semibold)).foregroundStyle(Palette.blue) }
      else if org.unread == true { Circle().fill(Palette.blue).frame(width: 9, height: 9).accessibilityHidden(true) }
    }
    .padding(.horizontal, 18).frame(minHeight: 64).contentShape(Rectangle())
  }

  private var joinCard: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Invite link or code").font(.system(size: 13)).foregroundStyle(Palette.faint)
      HStack(spacing: 10) {
        TextField("https://…/#/join/…", text: $link)
          .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
          .padding(.horizontal, 16).frame(height: 46)
          .background(Capsule().fill(Palette.sheet)).overlay(Capsule().strokeBorder(Palette.hairline))
          .accessibilityLabel("Invite link or code")
        if UIPasteboard.general.hasStrings || UIPasteboard.general.hasURLs {
          Button("Paste") { link = UIPasteboard.general.url?.absoluteString ?? UIPasteboard.general.string ?? "" }
            .font(.system(size: 15, weight: .medium)).foregroundStyle(Palette.text)
            .padding(.horizontal, 18).frame(height: 46).glassPill().buttonStyle(.plain)
        }
      }
      Button {
        action.run { try await store.joinOrg(link); dismiss() }
      } label: {
        Text("Join").font(.system(size: 16, weight: .semibold)).foregroundStyle(Palette.ground).frame(maxWidth: .infinity).frame(height: 50)
          .background(Capsule().fill(Palette.text))
      }
      .buttonStyle(.plain)
      .disabled(Store.inviteCode(link).isEmpty || action.busy)
      .opacity(Store.inviteCode(link).isEmpty ? 0.4 : 1)
    }
    .padding(.horizontal, 16).padding(.vertical, 14)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .transition(.opacity)
  }
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
            IconTile(symbol: "building.2", size: 56)
            Text("A fresh place with its own agents, teams and memory. It starts simple; turn on more in Settings → Mods.")
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
