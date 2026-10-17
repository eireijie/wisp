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
      SignInView()
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
        Button("Try again") { Task { await store.load() } }.buttonStyle(.borderedProminent)
        Button("Sign out", role: .destructive) { store.signOut() }
      }
    case .ready:
      MainTabs()
    }
  }
}

struct MainTabs: View {
  @Environment(Store.self) private var store
  @State private var tab = 0

  var body: some View {
    TabView(selection: $tab) {
      Tab("Chats", systemImage: "bubble.left.and.bubble.right", value: 0) { ChatsView() }
        .badge(store.unreadTotal)
      Tab("Agents", systemImage: "sparkles", value: 1) { AgentsView() }
      Tab("Computers", systemImage: "desktopcomputer", value: 2) { ComputersView() }
      Tab("Inbox", systemImage: "tray", value: 3) { InboxView() }
        .badge(store.pendingApprovals.count + store.computers.filter { $0.help != nil }.count)
      Tab("You", systemImage: "person.crop.circle", value: 4) { YouView() }
    }
    .onChange(of: store.unreadTotal, initial: true) { store.updateBadge() }
    // a tapped notification: go to its tab; the tab's own screen opens the chat or computer
    .onChange(of: store.route, initial: true) { _, route in
      switch route {
      case .chat: tab = 0
      case .computer: tab = 2
      case .approval: tab = 3; store.route = nil
      case nil: break
      }
    }
  }
}
