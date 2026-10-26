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
    VStack(spacing: 0) {
      HStack {
        CircleButton(symbol: "xmark", label: "Later") { later() }
          .accessibilityIdentifier("join-later")
        Spacer()
      }
      VStack(spacing: 14) {
        Text("\(request.name) wants to join")
          .font(.system(size: 28, weight: .bold))
          .foregroundStyle(Palette.text)
          .multilineTextAlignment(.center)
        Text("It should show the same code.")
          .font(.system(size: 16))
          .foregroundStyle(Palette.muted)
        CodeCard(code: request.displayCode).padding(.top, 6).accessibilityIdentifier("join-code")
        InlineError(error: action.error)
      }
      .padding(.top, 36)
      .padding(.horizontal, 6)
      Spacer(minLength: 16)
      VStack(spacing: 6) {
        AuthButton(title: "Approve", id: "join-approve") { decide(true) }.disabled(action.busy)
        AuthLinkButton(title: "Deny") { decide(false) }.disabled(action.busy)
      }
    }
    .padding(.horizontal, 22)
    .padding(.top, 18)
    .padding(.bottom, 18)
    .background(Palette.sheet.ignoresSafeArea())
    .presentationDetents([.medium, .large])
    .presentationCornerRadius(Corner.sheet)
    .interactiveDismissDisabled(action.busy)
  }

  private func decide(_ approve: Bool) {
    action.run { try await store.decideJoin(request, approve: approve) }
  }
}
