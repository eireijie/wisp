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
    VStack(spacing: 18) {
      Image(systemName: "desktopcomputer").font(.system(size: 30)).foregroundStyle(Palette.muted).padding(.top, 30)
      Text("New device wants to join").font(.system(size: 22, weight: .bold)).foregroundStyle(Palette.text).multilineTextAlignment(.center)
      Text("\(request.name) asked to join \(store.workspace?.name ?? "your Wisp"). It should show the same code:")
        .font(.system(size: 15)).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
      Text(request.displayCode).font(.system(size: 40, weight: .semibold, design: .monospaced)).monospacedDigit().foregroundStyle(Palette.text)
        .frame(maxWidth: .infinity).padding(.vertical, 22)
        .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
        .accessibilityIdentifier("join-code")
      Text("Only approve a device you set up yourself.").font(.system(size: 13)).foregroundStyle(Palette.faint)
      InlineError(error: action.error)
      Spacer(minLength: 0)
      VStack(spacing: 10) {
        HStack(spacing: 10) {
          Button(role: .destructive) { decide(false) } label: { Text("Deny").frame(maxWidth: .infinity) }.secondaryButton().disabled(action.busy).accessibilityIdentifier("join-deny")
          Button { decide(true) } label: { Text("Approve").frame(maxWidth: .infinity) }.primaryButton().disabled(action.busy).accessibilityIdentifier("join-approve")
        }
        Button("Later") { later() }.font(.system(size: 15)).foregroundStyle(Palette.muted)
      }
    }
    .padding(.horizontal, 20).padding(.bottom, 16)
    .background(Palette.sheet.ignoresSafeArea())
    .presentationBackground(Palette.sheet)
    .presentationCornerRadius(Corner.sheet)
    .presentationDetents([.medium, .large])
    .interactiveDismissDisabled(action.busy)
  }

  private func decide(_ approve: Bool) {
    action.run { try await store.decideJoin(request, approve: approve) }
  }
}
