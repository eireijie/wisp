import SwiftUI

@main
struct WispApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @AppStorage("wisp.mode", store: WispPreferences.standard) private var mode = "system"
  private var store: Store { delegate.store }
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(store)
        .preferredColorScheme(mode == "dark" ? .dark : mode == "light" ? .light : nil)
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
        ProgressView()
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    case .failed(let msg):
      ContentUnavailableView {
        Label("Can't reach Wisp", systemImage: "wifi.exclamationmark")
      } description: {
        Text(msg)
      } actions: {
        Button("Try again") { Task { await store.load() } }.primaryButton()
        Button("Sign out", role: .destructive) { store.signOut() }
      }
    case .ready:
      MainTabs()
        // a pairing code scanned while signed in: offer to switch to that Wisp
        .alert("Pair with another Wisp?", isPresented: Binding(get: { store.pendingPair != nil }, set: { if !$0 { store.pendingPair = nil } })) {
          Button("Sign out and pair", role: .destructive) {
            let link = store.pendingPair
            store.signOut()
            store.pendingPair = link
          }
          Button("Cancel", role: .cancel) { store.pendingPair = nil }
        } message: {
          Text("This phone is signed in to \(store.workspace?.name ?? "a Wisp") already.")
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
      if store.canViewComputers {
        Tab("Computers", systemImage: "macbook.and.iphone", value: 2) { ComputersView() }
      }
      Tab("You", systemImage: "person.crop.circle.fill", value: 3) { YouView() }
    }
    .minimizingTabBar()
    .safeAreaInset(edge: .top) {
      if let error = store.syncError {
        Text(error).font(.footnote).foregroundStyle(.red).padding(8)
          .frame(maxWidth: .infinity).background(.regularMaterial)
      }
    }
    .onChange(of: store.canViewComputers) { _, allowed in
      if !allowed && tab == 2 { tab = 0 }
    }
    .onChange(of: store.unreadTotal, initial: true) { store.updateBadge() }
    // a tapped notification: go to its tab; the tab's own screen opens the chat, computer or approval
    .onChange(of: store.route, initial: true) { _, route in
      switch route {
      case .chat, .approval: tab = 0
      case .computer: if store.canViewComputers { tab = 2 } else { store.route = nil }
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
