import SwiftUI

// A request going through a team's steps: where each step is (steps that run at the same time each
// have their own), and what a person can do about the ones waiting on them.

/**
 * Where a request in a stepped team is, at the top of its thread: a pill per step (done, on now,
 * waiting, still to come) and, for every step waiting on a person, what they can do about it.
 */
struct FlowStrip: View {
  @Environment(Store.self) private var store
  var channelId: String
  var threadId: String
  @State private var flow: TeamFlow?
  @State private var action = FormAction()
  @State private var note = ""
  @State private var asking: String?

  private var team: ChannelTeam? { store.channels.first { $0.id == channelId }?.settings?.team }

  var body: some View {
    VStack(spacing: 0) {
      if let flow, let team, team.hasSteps { strip(flow, team) }
    }
    .task(id: "\(channelId) \(threadId) \(store.flowVersions[channelId] ?? 0)") {
      guard team?.hasSteps == true else { return }
      if let all = try? await store.flows(in: channelId) { flow = all.first { $0.threadId == threadId } }
    }
  }

  private func strip(_ flow: TeamFlow, _ team: ChannelTeam) -> some View {
    let order = team.orderedSteps
    let lanes = flow.allLanes
    return VStack(alignment: .leading, spacing: 8) {
      WrapLayout(spacing: 6, lineSpacing: 6) {
        ForEach(Array(order.enumerated()), id: \.element.id) { _, s in pill(s, team: team, flow: flow, lane: lanes[s.id]) }
        if flow.status == "failed" { Text("Stopped").font(.caption.weight(.semibold)).foregroundStyle(Palette.red).padding(.leading, 4) }
        // a running request can be stopped too (the hub cancels the work still open)
        if flow.status == "running" {
          Button("Stop", role: .destructive) { decide("stop") }.font(.caption).buttonStyle(.borderless).disabled(action.busy).padding(.leading, 4)
        }
      }
      .padding(.horizontal, 16)
      ForEach(order.filter { lanes[$0.id]?.status == "waiting" && lanes[$0.id]?.waitingFor != nil }) { s in
        if let lane = lanes[s.id], let waiting = lane.waitingFor { waitingCard(s, lane, waiting, flow, team) }
      }
      InlineError(error: action.error).padding(.horizontal, 16)
      Divider()
    }
    .padding(.top, 10)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Team steps")
  }

  /** one step waiting on a person: its own buttons */
  private func waitingCard(_ s: ChannelTeam.Step, _ lane: TeamFlow.Lane, _ waiting: TeamFlow.Waiting, _ flow: TeamFlow, _ team: ChannelTeam) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(s.action.isEmpty ? "A step" : s.action).font(.footnote.weight(.semibold))
      if waiting.options == "ask" {
        Label("Waiting for you", systemImage: "hand.raised").font(.footnote).foregroundStyle(.orange)
        Text(waiting.why).font(.footnote).foregroundStyle(.secondary)
        if let id = approvalId(lane, flow) {
          NavigationLink { ApprovalDetail(approvalId: id) } label: { Text("Open it").font(.footnote.weight(.semibold)) }
        } else {
          Text("Answer it in your Inbox.").font(.footnote).foregroundStyle(.secondary)
        }
      } else {
        Text(waiting.why).font(.footnote).foregroundStyle(.orange)
        HStack(spacing: 8) {
          // the app tint is the text color, so a filled button's label is the background's (as in primaryButton)
          Button("Approve anyway") { decide("approve", stepId: s.id) }.foregroundStyle(Color(.systemBackground)).buttonStyle(.borderedProminent)
          Button(waiting.options == "rounds" ? "Another round" : "Try again") { decide("retry", stepId: s.id) }.buttonStyle(.bordered)
          Button("Stop", role: .destructive) { decide("stop", stepId: s.id) }.buttonStyle(.bordered)
        }
        .controlSize(.small)
        .disabled(action.busy)
      }
    }
    .padding(.horizontal, 16)
  }

  private func approvalId(_ lane: TeamFlow.Lane, _ flow: TeamFlow) -> String? {
    lane.approvalId ?? store.approvals.first { $0.flow?.flowId == flow.id && $0.flow?.stepId == lane.stepId && $0.status == "pending" }?.id
  }

  private func pill(_ s: ChannelTeam.Step, team: ChannelTeam, flow: TeamFlow, lane: TeamFlow.Lane?) -> some View {
    let status = lane?.status
    let done = status == "done" || flow.status == "done"
    let now = status == "running" || status == "waiting"
    let waiting = status == "waiting"
    let skipped = status == "skipped"
    let rounds = flow.rounds[s.id] ?? 0
    let fg: Color = now ? (waiting ? .orange : Color(.systemBackground)) : done ? Palette.statusOnline : Palette.muted
    let bg: Color = now ? (waiting ? Color.orange.opacity(0.15) : Palette.text) : done ? Palette.statusOnline.opacity(0.15) : Palette.badge
    return HStack(spacing: 3) {
      Text(s.action.isEmpty ? "Step \(team.number(of: s.id))" : s.action).strikethrough(skipped)
      if done && !now { Image(systemName: "checkmark").font(.caption2.weight(.bold)) }
      if rounds > 1 { Text("· round \(rounds)") }
    }
    .font(.caption.weight(.medium))
    .foregroundStyle(fg)
    .padding(.horizontal, 9)
    .padding(.vertical, 4)
    .background(Capsule().fill(bg))
    .opacity(skipped ? 0.5 : 1)
    .accessibilityLabel("\(s.action), \(waiting ? "waiting on you" : now ? "on now" : skipped ? "skipped" : done ? "done" : "to come")")
  }

  private func decide(_ choice: String, stepId: String? = nil) {
    guard let id = flow?.id else { return }
    action.run { flow = try await store.decideFlow(id, choice, stepId: stepId) }
  }
}

/** Views in a row that wraps onto the next line when it runs out of room. */
private struct WrapLayout: Layout {
  var spacing: CGFloat = 4
  var lineSpacing: CGFloat = 6

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let rows = rows(width: proposal.width ?? .infinity, subviews)
    let width = rows.map { $0.width }.max() ?? 0
    let height = rows.map(\.height).reduce(0, +) + lineSpacing * CGFloat(max(rows.count - 1, 0))
    return CGSize(width: width, height: height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var y = bounds.minY
    for row in rows(width: bounds.width, subviews) {
      var x = bounds.minX
      for i in row.items {
        let size = subviews[i].sizeThatFits(.unspecified)
        subviews[i].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: ProposedViewSize(size))
        x += size.width + spacing
      }
      y += row.height + lineSpacing
    }
  }

  private struct Row { var items: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }
  private func rows(width: CGFloat, _ subviews: Subviews) -> [Row] {
    var rows: [Row] = [Row()]
    for (i, view) in subviews.enumerated() {
      let size = view.sizeThatFits(.unspecified)
      if !rows[rows.count - 1].items.isEmpty && rows[rows.count - 1].width + spacing + size.width > width { rows.append(Row()) }
      var row = rows[rows.count - 1]
      row.width += (row.items.isEmpty ? 0 : spacing) + size.width
      row.height = max(row.height, size.height)
      row.items.append(i)
      rows[rows.count - 1] = row
    }
    return rows
  }
}
