import SwiftUI

/**
 * A computer asking to join shows up wherever an owner is in the app: the hub sends it live
 * ("join_request"), and this asks again every so often in case one was missed.
 */
struct JoinApprovalModifier: ViewModifier {
  @Environment(Store.self) private var store
  /** requests the owner chose to answer later; they stay pending on the hub */
  @State private var dismissed: Set<String> = []

  private var pending: JoinRequest? { store.joinRequests.first { !dismissed.contains($0.id) } }

  func body(content: Content) -> some View {
    content
      .task(id: "\(store.isOwner)\(store.workspace?.id ?? "")") {
        dismissed = []
        guard store.isOwner else { store.joinRequests = []; return }
        while !Task.isCancelled {
          // an older Wisp has no join requests; the live events still arrive if it does
          try? await store.refreshJoinRequests()
          do { try await Task.sleep(for: .seconds(15)) } catch { return }
        }
      }
      .sheet(item: Binding(get: { pending }, set: { if $0 == nil, let current = pending { dismissed.insert(current.id) } })) { request in
        JoinApprovalSheet(request: request) { dismissed.insert(request.id) }
      }
  }
}

extension View {
  func joinApproval() -> some View { modifier(JoinApprovalModifier()) }
}

struct JoinApprovalSheet: View {
  @Environment(Store.self) private var store
  var request: JoinRequest
  var later: () -> Void
  @State private var action = FormAction()

  var body: some View {
    VStack(spacing: 22) {
      Image(systemName: "desktopcomputer").font(.system(size: 34)).foregroundStyle(.secondary).padding(.top, 28)
      Text("\(request.name) wants to join").font(.title2.weight(.semibold)).multilineTextAlignment(.center)
      VStack(spacing: 8) {
        Text("It should show the same code").font(.subheadline).foregroundStyle(.secondary)
        Text(request.displayCode).font(.system(size: 40, weight: .semibold, design: .monospaced)).monospacedDigit().accessibilityIdentifier("join-code")
      }.frame(maxWidth: .infinity).padding(.vertical, 22).card()
      InlineError(error: action.error)
      Spacer(minLength: 0)
      VStack(spacing: 10) {
        Button { decide(true) } label: { Text("Approve").frame(maxWidth: .infinity) }.primaryButton().disabled(action.busy).accessibilityIdentifier("join-approve")
        HStack(spacing: 10) {
          Button { later() } label: { Text("Later").frame(maxWidth: .infinity) }.secondaryButton()
          Button(role: .destructive) { decide(false) } label: { Text("Deny").frame(maxWidth: .infinity) }.secondaryButton().disabled(action.busy)
        }
      }
    }.padding(20).presentationDetents([.medium, .large])
      .interactiveDismissDisabled(action.busy)
  }

  private func decide(_ approve: Bool) {
    action.run { try await store.decideJoin(request, approve: approve) }
  }
}

/** A link a new computer pastes into Join my Wisp, then approve it here. */
struct JoinInviteView: View {
  @Environment(Store.self) private var store
  @State private var invite: JoinInvite?
  @State private var action = FormAction()
  private var expired: Bool { invite.flatMap { Wire.date($0.expiresAt) }.map { $0 <= Date() } ?? false }

  var body: some View {
    Form {
      Section("On the other computer") {
        Label("Get Wisp on it from the Wisp website.", systemImage: "1.circle")
        Label("Pick Join my Wisp.", systemImage: "2.circle")
        Label("Paste this link. On this Wi-Fi it can also find you by itself.", systemImage: "3.circle")
        Label("Approve it here when this phone asks.", systemImage: "4.circle")
      }
      Section("Join link") {
        if let invite, !expired {
          Text(invite.url).font(.footnote.monospaced()).textSelection(.enabled)
          ShareLink("Share link", item: invite.url)
          Button("Copy link") { UIPasteboard.general.string = invite.url }
          if let date = Wire.date(invite.expiresAt) { Text("Works once, until \(date, format: .dateTime.month().day().hour().minute()).").font(.footnote).foregroundStyle(.secondary) }
        }
        if action.busy { HStack { ProgressView(); Text("Making a join link…") } }
        if !action.busy && (invite == nil || expired) { Button(expired ? "Make a new link" : "Try again", action: make) }
        InlineError(error: action.error)
      }
      if let url = invite.flatMap({ URL(string: $0.url) }), !["https"].contains(url.scheme ?? "") {
        Section { Text("This link only works on the same Wi-Fi. To add a computer somewhere else, turn on Away from home in Settings, then make a new link.").font(.footnote) }
      }
    }.navigationTitle("Join with a link")
      .task { if store.isOwner && invite == nil { make() } }
  }

  private func make() { action.run { invite = try await store.makeJoinInvite() } }
}
