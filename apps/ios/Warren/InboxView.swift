import SwiftUI

/** What's waiting on you: agents asking for an OK, and agents that need you on their computer. */
struct InboxView: View {
  @Environment(Store.self) private var store

  private var helpWanted: [Computer] { store.computers.filter { $0.help != nil } }
  private var decided: [Approval] { store.approvals.filter { $0.status != "pending" }.prefix(20).map { $0 } }

  var body: some View {
    NavigationStack {
      List {
        if store.pendingApprovals.isEmpty && helpWanted.isEmpty {
          Section {
            VStack(spacing: 10) {
              GhostView(look: GhostLook(color: "#beffe8", color2: "#26dfff"), seed: "", size: 52)
              Text("Nothing needs you right now").font(.headline)
              Text("When an agent wants your OK, or needs you on its computer, it shows up here.")
                .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
          }
        }
        if !helpWanted.isEmpty {
          Section("Needs you on a computer") {
            ForEach(helpWanted) { c in
              NavigationLink {
                ComputerDetail(computerId: c.id)
              } label: {
                HStack(spacing: 12) {
                  AgentAvatar(agent: store.agent(c.help!.agentId), size: 34)
                  VStack(alignment: .leading, spacing: 2) {
                    Text(c.help!.request).font(.subheadline.weight(.semibold))
                    Text("\(store.agent(c.help!.agentId)?.name ?? "An agent") on \(c.name)").font(.caption).foregroundStyle(.secondary)
                  }
                }
              }
            }
          }
        }
        if !store.pendingApprovals.isEmpty {
          Section("Asking for your OK") {
            ForEach(store.pendingApprovals) { a in approvalRow(a) }
          }
        }
        if !decided.isEmpty {
          Section("Decided") {
            ForEach(decided) { a in approvalRow(a) }
          }
        }
      }
      .listStyle(.insetGrouped)
      .navigationTitle("Inbox")
      .refreshable {
        await store.refreshApprovals()
        await store.refreshComputers()
      }
    }
  }

  private func approvalRow(_ a: Approval) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        AgentAvatar(agent: store.agent(a.agentId), size: 24, showStatus: false)
        Text(store.agent(a.agentId)?.name ?? "Agent").font(.subheadline.weight(.semibold))
        Spacer()
        if let d = Wire.date(a.createdAt) { Text(d, format: .relative(presentation: .named)).font(.caption).foregroundStyle(.tertiary) }
      }
      ApprovalBox(approval: a)
    }
    .listRowInsets(EdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12))
  }
}
