import SwiftUI

/** Everything agents asked you, waiting and decided: the Inbox tab. */
struct InboxView: View {
  @Environment(Store.self) private var store
  @State private var chat: Channel?
  @State private var thread: ThreadRef?
  @State private var agentPage: Agent?
  @State private var showDevices = false
  @State private var addingAgent = false
  @State private var action = FormAction()

  private var helpWanted: [Computer] { store.canViewComputers ? store.computers.filter { $0.help != nil } : [] }
  private var decided: [Approval] { store.approvals.filter { $0.status != "pending" }.prefix(20).map { $0 } }

  var body: some View {
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
        InboxSections(open: open)
        if !decided.isEmpty {
          Section("Decided") {
            ForEach(decided) { a in approvalRow(a) }
          }
        }
      }
      .listStyle(.insetGrouped)
      .groundBackground()
      .navigationTitle("Inbox")
      .toolbar {
        if store.features.background, let a = store.allowance {
          ToolbarItem(placement: .topBarTrailing) {
            NavigationLink { UsageView() } label: { Text(Store.allowanceText(a)).font(.footnote.weight(.semibold)) }
              .accessibilityLabel("\(Store.allowanceText(a)). Open usage")
          }
        }
      }
      .task { await load() }
      .refreshable {
        await store.refreshApprovals()
        await store.refreshComputers()
        await load()
      }
      .navigationDestination(item: $chat) { ChannelView(channel: $0) }
      .navigationDestination(item: $thread) { ThreadView(ref: $0) }
      .navigationDestination(item: $agentPage) { AgentPage(agent: $0) }
      .navigationDestination(isPresented: $showDevices) { DevicesView() }
      .sheet(isPresented: $addingAgent) { AddAgent { chat = nil; agentPage = $0 } }
      .managementAlert(action)
  }

  /** The pieces the sections show that the app doesn't already keep fresh. */
  private func load() async {
    try? await store.refreshOnboarding()
    if store.features.tasks { try? await store.refreshTasks() }
    if store.features.background { try? await store.refreshAllowance() }
  }

  private func open(_ target: InboxTarget) {
    switch target {
    case .chat(let c): chat = c
    case .thread(let t): thread = t
    case .agent(let a): agentPage = a
    case .devices: showDevices = true
    case .addAgent: addingAgent = true
    case .dm(let a): action.run { chat = try await store.dm(with: a) }
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
      ApprovalBox(approval: a, inList: true)
    }
    .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
  }
}
