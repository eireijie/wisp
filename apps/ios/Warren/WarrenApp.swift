import SwiftUI

@main
struct WarrenApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  private var store: Store { delegate.store }
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(store)
        .tint(.primary)
        .fontDesign(.rounded)
        .onOpenURL { url in
          if let link = PairLink(url.absoluteString) { store.pendingPair = link }
        }
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { store.resume() }
      if phase == .background { store.updateBadge() }
    }
  }
}

struct RootView: View {
  @Environment(Store.self) private var store

  var body: some View {
    switch store.phase {
    case .signedOut:
      PairView()
    case .loading:
      VStack(spacing: 14) {
        GhostView(look: GhostLook(color: "#f5f5f5", color2: "#d9d9d9"), seed: "", size: 56)
          .phaseAnimator([0, -4]) { v, y in v.offset(y: y) } animation: { _ in .easeInOut(duration: 1.4) }
        ProgressView()
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    case .failed(let msg):
      ContentUnavailableView {
        Label("Can't reach Warren", systemImage: "wifi.exclamationmark")
      } description: {
        Text(msg)
      } actions: {
        Button("Try again") { Task { await store.load() } }.primaryButton()
        Button("Sign out", role: .destructive) { store.signOut() }
      }
    case .ready:
      MainTabs()
        // a pairing code scanned while signed in: offer to switch to that Warren
        .alert("Pair with another Warren?", isPresented: Binding(get: { store.pendingPair != nil }, set: { if !$0 { store.pendingPair = nil } })) {
          Button("Sign out and pair", role: .destructive) {
            let link = store.pendingPair
            store.signOut()
            store.pendingPair = link
          }
          Button("Cancel", role: .cancel) { store.pendingPair = nil }
        } message: {
          Text("This phone is signed in to \(store.workspace?.name ?? "a Warren") already.")
        }
    }
  }
}

struct MainTabs: View {
  @Environment(Store.self) private var store
  @State private var tab = 0

  var body: some View {
    TabView(selection: $tab) {
      // what needs you (approvals, computers) sits at the top of Chats, so there's no Inbox to check
      Tab("Chats", systemImage: "bubble.left.and.bubble.right.fill", value: 0) { ChatsView() }
        .badge(store.unreadTotal + store.needsYouCount)
      Tab("Agents", systemImage: "sparkles", value: 1) { AgentsView() }
      Tab("Computers", systemImage: "macbook.and.iphone", value: 2) { ComputersView() }
      Tab("You", systemImage: "person.crop.circle.fill", value: 3) { YouView() }
    }
    .minimizingTabBar()
    .onChange(of: store.unreadTotal, initial: true) { store.updateBadge() }
    // a tapped notification: go to its tab; the tab's own screen opens the chat, computer or approval
    .onChange(of: store.route, initial: true) { _, route in
      switch route {
      case .chat, .approval: tab = 0
      case .computer: tab = 2
      case nil: break
      }
    }
  }
}

private extension View {
  /** On iOS 26 the glass tab bar tucks away while you scroll down a list. */
  @ViewBuilder func minimizingTabBar() -> some View {
    if #available(iOS 26, *) { self.tabBarMinimizeBehavior(.onScrollDown) } else { self }
  }
}
