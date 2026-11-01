import SwiftUI

/** The More tab: the same list the rail's More menu holds on the desktop. */
struct MoreTab: View {
  @Environment(Store.self) private var store
  @Environment(\.openSettings) private var openSettings

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        TopBar {
          Button { openSettings() } label: { ProfileCircle() }.buttonStyle(.press).accessibilityIdentifier("profile-button")
        } center: {
          Text("More").font(.system(size: 20, weight: .bold)).foregroundStyle(Palette.text).accessibilityAddTraits(.isHeader)
        } trailing: {
          EmptyView()
        }
        ScrollView {
          CardGroup {
            NavigationLink { MemoryView() } label: { RowLabel(title: "Memory", value: store.role == "guest" ? "Shared folder" : nil, leading: { rowIcon("book") }) }
              .accessibilityIdentifier("you-memory")
            if store.role != "guest" {
              if store.features.tasks {
                NavigationLink { TasksView() } label: { RowLabel(title: "Tasks", leading: { rowIcon("checklist") }) }
                  .accessibilityIdentifier("you-tasks")
              }
              NavigationLink { MarketplaceView() } label: { RowLabel(title: "Marketplace", leading: { rowIcon("storefront") }) }
                .accessibilityIdentifier("you-marketplace")
              NavigationLink { FeaturesView() } label: { RowLabel(title: "Mods", leading: { rowIcon("square.grid.2x2") }) }
                .accessibilityIdentifier("you-mods")
            }
            NavigationLink { HelpView() } label: { RowLabel(title: "Help", leading: { rowIcon("lifepreserver") }) }
              .accessibilityIdentifier("you-help")
          }
          .padding(.horizontal, 18).padding(.top, 8).padding(.bottom, 30)
        }
      }
      .background(Palette.sheet.ignoresSafeArea())
      .toolbar(.hidden, for: .navigationBar)
      .chatDestinations()
    }
  }
}
