import SwiftUI

struct YouView: View {
  @Environment(Store.self) private var store
  @Environment(\.openURL) private var openURL
  @State private var confirmSignOut = false

  var body: some View {
    NavigationStack {
      List {
        if let me = store.me {
          Section {
            HStack(spacing: 14) {
              PersonAvatar(name: me.name, size: 60)
              VStack(alignment: .leading, spacing: 2) {
                Text(me.preferredName ?? me.name).font(.title3.weight(.semibold))
                Text(me.email).font(.subheadline).foregroundStyle(.secondary)
              }
            }
            .padding(.vertical, 4)
          }
        }
        Section {
          HStack(spacing: 12) {
            IconTile(symbol: "bell.badge.fill", color: .red, size: 32)
            Text("Notifications")
            Spacer()
            switch store.notificationStatus {
            case .authorized, .provisional, .ephemeral: Text("On").foregroundStyle(.secondary)
            case .denied: Button("Turn on") { if let u = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(u) } }
            default:
              if store.pushAvailable { Button("Turn on") { Task { await store.enableNotifications() } } } else { Text("Off").foregroundStyle(.secondary) }
            }
          }
          NavigationLink {
            InboxView()
          } label: {
            HStack(spacing: 12) {
              IconTile(symbol: "checkmark.seal.fill", color: .green, size: 32)
              Text("Approvals")
              Spacer()
              if !store.pendingApprovals.isEmpty { UnreadBadge(count: store.pendingApprovals.count) }
            }
          }
          if let base = store.api?.base {
            Button {
              openURL(base)
            } label: {
              HStack(spacing: 12) {
                IconTile(symbol: "safari.fill", color: .blue, size: 32)
                Text("Open Warren in Safari").foregroundStyle(.primary)
              }
            }
          }
        }
        Section {
          NavigationLink {
            WorkspaceDetails()
          } label: {
            HStack(spacing: 12) {
              IconTile(symbol: "building.2.fill", color: .gray, size: 32)
              VStack(alignment: .leading, spacing: 1) {
                Text(store.workspace?.name ?? "Warren")
                Text("Workspace details").font(.caption).foregroundStyle(.secondary)
              }
            }
          }
        }
        Section {
          Button("Sign out", role: .destructive) { confirmSignOut = true }
        }
        Section {
        } footer: {
          Text("Warren \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "") · Free and open source (Apache-2.0)")
            .frame(maxWidth: .infinity)
        }
      }
      .navigationTitle("You")
      .confirmationDialog("Sign out of Warren on this iPhone?", isPresented: $confirmSignOut, titleVisibility: .visible) {
        Button("Sign out", role: .destructive) { store.signOut() }
      }
    }
  }
}

/** The technical side of the Warren this phone is paired with: where it is, who's in it, live updates. */
struct WorkspaceDetails: View {
  @Environment(Store.self) private var store
  @Environment(\.openURL) private var openURL

  var body: some View {
    List {
      Section {
        LabeledContent("Name", value: store.workspace?.name ?? "Warren")
        LabeledContent("Your role", value: store.role.capitalized)
        LabeledContent("People", value: "\(store.members.count)")
        LabeledContent("Agents", value: "\(store.agents.count)")
      }
      Section {
        LabeledContent("Address", value: store.api?.base.host() ?? "")
        LabeledContent("Live updates") {
          HStack(spacing: 6) {
            GlowDot(color: store.connected ? .green : .orange)
            Text(store.connected ? "Connected" : "Reconnecting")
          }
        }
      } footer: {
        Text(store.pushAvailable
          ? "Notifications reach this iPhone while Warren is closed: agent replies, @mentions, approvals and agents that need you on a computer."
          : "This Warren isn't set up to send notifications. Its owner can add an Apple push key; see Warren's deploy guide.")
      }
      if let base = store.api?.base {
        Section {
          Button("Settings in Safari") { if let u = URL(string: base.absoluteString + "/#/settings") { openURL(u) } }
        }
      }
    }
    .navigationTitle("Workspace")
    .navigationBarTitleDisplayMode(.inline)
  }
}
