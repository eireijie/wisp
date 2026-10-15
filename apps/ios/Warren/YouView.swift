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
              PersonAvatar(name: me.name, size: 52)
              VStack(alignment: .leading, spacing: 2) {
                Text(me.preferredName ?? me.name).font(.title3.weight(.semibold))
                Text(me.email).font(.subheadline).foregroundStyle(.secondary)
              }
            }
            .padding(.vertical, 4)
          }
        }
        Section("Workspace") {
          LabeledContent("Name", value: store.workspace?.name ?? "Warren")
          LabeledContent("Your role", value: store.role.capitalized)
          LabeledContent("Address", value: store.api?.base.host() ?? "")
          LabeledContent("Live updates") {
            HStack(spacing: 5) {
              Circle().fill(store.connected ? Color.green : .orange).frame(width: 7, height: 7)
              Text(store.connected ? "Connected" : "Reconnecting")
            }
          }
          LabeledContent("People", value: "\(store.members.count)")
          LabeledContent("Agents", value: "\(store.agents.count)")
        }
        Section {
          if let base = store.api?.base {
            Button("Open Warren in Safari") { openURL(base) }
            Button("Settings in Safari") { if let u = URL(string: base.absoluteString + "/#/settings") { openURL(u) } }
          }
        } footer: {
          Text("Setting up agents, devices and memory works best in Warren on a bigger screen or in Safari.")
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
