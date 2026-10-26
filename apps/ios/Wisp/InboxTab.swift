import SwiftUI

/** Screens a tab's stack can open besides chats, threads and agents. */
enum ChatsScreen: Hashable { case inbox, approval(id: String), note(path: String) }

extension View {
  func chatsScreens() -> some View {
    navigationDestination(for: ChatsScreen.self) { screen in
      switch screen {
      case .inbox: InboxView()
      case .approval(let id): ApprovalDetail(approvalId: id)
      case .note(let path): NoteView(path: path)
      }
    }
  }

  /** The chat, thread and agent pages every tab's stack can reach. */
  func chatDestinations() -> some View {
    navigationDestination(for: Channel.self) { ChannelView(channel: $0) }
      .navigationDestination(for: ThreadRef.self) { ThreadView(ref: $0) }
      .navigationDestination(for: Agent.self) { AgentPage(agent: $0) }
      .chatsScreens()
  }
}

/** The Inbox as its own tab: what's waiting on you, with your avatar at the top left. */
struct InboxTab: View {
  @Environment(Store.self) private var store
  @Environment(\.openSettings) private var openSettings
  @State private var path = NavigationPath()

  var body: some View {
    NavigationStack(path: $path) {
      InboxView()
        .toolbar {
          ToolbarItem(placement: .topBarLeading) {
            Button { openSettings() } label: { ProfileCircle(size: 34, glass: false) }
              .accessibilityLabel("You and settings").accessibilityIdentifier("profile-button")
          }
        }
        .chatDestinations()
    }
    .task(id: store.route) {
      // a tapped approval notification opens that approval
      guard case .approval(let id) = store.route else { return }
      store.route = nil
      var p = NavigationPath()
      p.append(ChatsScreen.approval(id: id))
      path = p
    }
  }
}
