import SwiftUI

/** Editing how an existing team works: the builder over the team's own steps, saved to its channel. */
struct TeamEditSession: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var channel: Channel
  @State private var team = ChannelTeam(nodes: [], edges: [], roles: [], steps: [])
  @State private var original = ChannelTeam(nodes: [], edges: [], roles: [], steps: [])
  @State private var loaded = false
  @State private var discarding = false
  @State private var action = FormAction()

  var body: some View {
    NavigationStack {
      TeamBuilder(team: $team, name: channel.name, channelId: channel.id, saving: action.busy, error: action.error,
        onBack: { if team == original { dismiss() } else { discarding = true } }, onDone: save)
    }
    .presentationBackground(Palette.ground)
    .onAppear {
      guard !loaded else { return }
      var start = (store.channels.first { $0.id == channel.id } ?? channel).settings?.team ?? ChannelTeam(nodes: [], edges: [], roles: [], steps: [])
      start = start.migrated
      team = start
      original = start
      loaded = true
    }
    .confirmationDialog("Leave without saving?", isPresented: $discarding, titleVisibility: .visible) {
      Button("Discard changes", role: .destructive) { dismiss() }
      Button("Keep editing", role: .cancel) {}
    }
    .interactiveDismissDisabled(action.busy)
  }

  private func save() {
    action.run {
      var next = team.migrated
      next.roles = next.roles ?? []
      try await store.updateChannel(channel.id, ["settings": AnyEncodable(ChannelTeam.settingsPatch(next.withChart))])
      dismiss()
    }
  }
}

/**
 * "How the team works" for a team's details: the plain lines, and a link to edit them in the
 * builder. A team without steps gets a way to set it up.
 */
struct TeamHowCard: View {
  @Environment(Store.self) private var store
  var channel: Channel
  var editable = true
  @State private var editing = false

  private var current: Channel { store.channels.first { $0.id == channel.id } ?? channel }

  var body: some View {
    let team = current.settings?.team?.migrated
    VStack(alignment: .leading, spacing: 10) {
      Text("How the team works").font(.system(size: 15)).foregroundStyle(Palette.muted).padding(.horizontal, 18)
      VStack(alignment: .leading, spacing: 0) {
        if let team, team.hasSteps {
          VStack(alignment: .leading, spacing: 10) {
            ForEach(team.flowLines(store)) { line in
              (Text("\(line.n). ").foregroundColor(Palette.muted)
                + Text(line.together ? "At the same time, " : "").foregroundColor(Palette.muted)
                + Text(line.together ? line.who : FlowWords.capitalized(line.who)).bold().foregroundColor(Palette.text)
                + Text(" \(line.rest).").foregroundColor(Palette.muted))
                .font(.system(size: 17)).fixedSize(horizontal: false, vertical: true)
                .accessibilityElement(children: .combine)
            }
          }
          .padding(18).frame(maxWidth: .infinity, alignment: .leading)
        } else {
          Text("Nothing here yet. Draw the steps and say how each one works.").font(.system(size: 16)).foregroundStyle(Palette.muted).padding(18)
        }
        if editable {
          Rectangle().fill(Palette.separator).frame(height: 1).padding(.leading, 18)
          Button { editing = true } label: {
            RowLabel(title: team?.hasSteps == true ? "Edit how it works" : "Set up how it works", tint: Palette.blue) {
              Image(systemName: "square.and.pencil").font(.system(size: 17)).foregroundStyle(Palette.blue).frame(width: 26)
            }
          }
          .buttonStyle(.plain)
          .accessibilityIdentifier("team-edit-how")
        }
      }
      .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    }
    .fullScreenCover(isPresented: $editing) { TeamEditSession(channel: current) }
  }
}
