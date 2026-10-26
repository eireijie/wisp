import SwiftUI

@main
struct WispApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @AppStorage(ThemeSettings.modeKey, store: WispPreferences.standard) private var mode = ThemeSettings.defaultMode
  private var store: Store { delegate.store }
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(store)
        .preferredColorScheme(mode == "dark" ? .dark : mode == "light" ? .light : nil)
        .appearance()
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
      .background(Palette.ground.ignoresSafeArea())
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
        .joinApproval()
        // a pairing code scanned while signed in: offer to switch to that Wisp
        .alert("Pair with another Wisp?", isPresented: Binding(get: { store.pendingPair != nil }, set: { if !$0 { store.pendingPair = nil } })) {
          Button("Sign out and pair", role: .destructive) {
            let link = store.pendingPair
            store.signOut()
            store.pendingPair = link
          }
          Button("Cancel", role: .cancel) { store.pendingPair = nil }
        } message: {
          Text("You're signed in to \(store.workspace?.name ?? "a Wisp"). Pairing signs you out of it first.")
        }
    }
  }
}

/** The four places: Inbox, Chats, Agents and Computers (hidden for guests). */
enum MainTab: Int { case inbox, chats, agents, computers }

struct MainTabs: View {
  @Environment(Store.self) private var store
  @State private var tab = MainTab.chats
  @State private var settings = false
  @State private var orgs = false

  var body: some View {
    TabView(selection: $tab) {
      Tab(value: MainTab.inbox) { InboxTab() } label: { Label("Inbox", systemImage: "tray") }
        .badge(store.needsYouCount)
      Tab(value: MainTab.chats) { ChatsView() } label: { Label("Chats", systemImage: "bubble.left") }
        .badge(store.unreadTotal)
      Tab(value: MainTab.agents) { AgentsView() } label: { Label { Text("Agents") } icon: { Image(uiImage: TabIcons.ghost) } }
      if store.canViewComputers {
        Tab(value: MainTab.computers) { ComputersView() } label: { Label("Computers", systemImage: "desktopcomputer") }
      }
    }
    .environment(\.openSettings, SheetOpener(open: { settings = true }))
    .environment(\.openOrganizations, SheetOpener(open: { orgs = true }))
    .overlay(alignment: .top) { AppBanners() }
    .sheet(isPresented: $settings) { SettingsSheet().environment(store) }
    .sheet(isPresented: $orgs) { OrgSwitcherSheet().environment(store) }
    .onChange(of: store.canViewComputers) { _, allowed in
      if !allowed && tab == .computers { tab = .chats }
    }
    .onChange(of: store.unreadTotal, initial: true) { store.updateBadge() }
    // a tapped notification: go to its tab; the tab's own screen opens the chat, computer or approval
    .onChange(of: store.route, initial: true) { _, route in
      switch route {
      case .chat: tab = .chats
      case .approval: tab = .inbox
      case .computer, .device: if store.canViewComputers { tab = .computers } else { store.route = nil }
      case nil: break
      }
    }
  }
}

/** The tab bar's agent icon: the ghost outline, drawn like the design's line icons. */
enum TabIcons {
  static let ghost: UIImage = {
    let side: CGFloat = 25
    let k = side / 24
    let image = UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { _ in
      let p = UIBezierPath()
      p.move(to: CGPoint(x: 12 * k, y: 2.5 * k))
      p.addArc(withCenter: CGPoint(x: 12 * k, y: 10 * k), radius: 7.5 * k, startAngle: -.pi / 2, endAngle: .pi, clockwise: false)
      p.addLine(to: CGPoint(x: 4.5 * k, y: 21 * k))
      for (x, y) in [(7.0, 19.3), (9.5, 21.0), (12.0, 19.3), (14.5, 21.0), (17.0, 19.3), (19.5, 21.0)] {
        p.addLine(to: CGPoint(x: x * k, y: y * k))
      }
      p.addLine(to: CGPoint(x: 19.5 * k, y: 10 * k))
      p.addArc(withCenter: CGPoint(x: 12 * k, y: 10 * k), radius: 7.5 * k, startAngle: 0, endAngle: -.pi / 2, clockwise: false)
      p.close()
      p.lineWidth = 1.8
      p.lineJoinStyle = .round
      UIColor.black.setStroke()
      p.stroke()
      UIColor.black.setFill()
      UIBezierPath(arcCenter: CGPoint(x: 9.5 * k, y: 10.5 * k), radius: 1.1 * k, startAngle: 0, endAngle: .pi * 2, clockwise: true).fill()
      UIBezierPath(arcCenter: CGPoint(x: 14.5 * k, y: 10.5 * k), radius: 1.1 * k, startAngle: 0, endAngle: .pi * 2, clockwise: true).fill()
    }
    return image.withRenderingMode(.alwaysTemplate)
  }()
}
