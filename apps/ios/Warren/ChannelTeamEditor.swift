import SwiftUI

/**
 * A channel's team on a phone: the chart (leads on top, arrows to whoever each agent hands work
 * to), then everyone on it with who hands them work, then your other agents to add, with Create
 * agent at the bottom. It edits the same `settings.team` the web's drag-and-drop chart saves.
 * Use it inside a Form.
 */
struct ChannelTeamEditor: View {
  @Environment(Store.self) private var store
  @Binding var team: ChannelTeam
  var editable = true
  /** the channel it's the team of, to show who's working there */
  var channelId: String? = nil
  @State private var creating = false

  private var others: [Agent] { store.agents.filter { !team.contains($0.id) } }
  private var busy: Set<String> { channelId.map { Set(store.working(in: $0).map(\.id)) } ?? [] }

  var body: some View {
    Section {
      if team.nodes.isEmpty {
        Text(editable ? "Nobody yet. Add agents from the list below; the first one leads." : "No team yet.")
          .font(.subheadline).foregroundStyle(.secondary)
      } else {
        TeamChartView(team: team, busy: busy).listRowInsets(EdgeInsets(top: 12, leading: 0, bottom: 12, trailing: 0))
      }
    } footer: {
      if !team.nodes.isEmpty, let problem = team.problem { Text(problem).foregroundStyle(.red) }
    }
    if !team.nodes.isEmpty {
      Section("On the team") {
        ForEach(team.rows.flatMap { $0 }, id: \.self) { id in
          TeamMemberRow(team: $team, agentId: id, editable: editable)
        }
      }
    }
    if editable {
      Section {
        ForEach(others) { agent in
          Button { withAnimation(.snappy) { team = team.adding(agent.id) } } label: {
            HStack(spacing: 10) {
              AgentAvatar(agent: agent, size: 30, showStatus: false)
              VStack(alignment: .leading, spacing: 1) {
                Text(agent.name).foregroundStyle(.primary)
                Text(agent.settings?.role ?? agent.settings?.description ?? "@\(agent.handle)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
              }
              Spacer()
              Image(systemName: "plus.circle").foregroundStyle(.secondary)
            }
          }
          .accessibilityLabel("Add \(agent.name) to the team")
        }
        if store.canManage {
          Button("Create agent", systemImage: "plus") { creating = true }
        }
      } header: {
        Text(team.nodes.isEmpty ? "Your agents" : "Add to the team")
      } footer: {
        if others.isEmpty && store.agents.isEmpty { Text("You don't have any agents yet. Create one for this team.") }
      }
    }
    Section {
      DisclosureGroup("How the team works") {
        VStack(alignment: .leading, spacing: 8) {
          ForEach(ChannelTeam.rules, id: \.self) { rule in
            HStack(alignment: .firstTextBaseline, spacing: 6) {
              Text("•")
              Text(rule)
            }
          }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .padding(.vertical, 4)
      }
    }
    .sheet(isPresented: $creating) {
      // back to the team with the new agent on it
      AddAgent { agent in team = team.adding(agent.id) }
    }
  }
}

/** One agent on the team: lead or not, and who hands it work. */
private struct TeamMemberRow: View {
  @Environment(Store.self) private var store
  @Binding var team: ChannelTeam
  var agentId: String
  var editable: Bool

  private var node: ChannelTeam.Node? { team.node(agentId) }
  private var givers: [String] { team.from(agentId) }
  /** everyone who could hand it work: anyone else on the chart */
  private var candidates: [String] { team.nodes.map(\.agentId).filter { $0 != agentId } }

  var body: some View {
    let agent = store.agent(agentId)
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 10) {
        AgentAvatar(agent: agent, size: 30, showStatus: false)
        VStack(alignment: .leading, spacing: 1) {
          Text(agent?.name ?? "Agent")
          Text(node?.lead == true ? "Reads every new message" : agent.map { "@\($0.handle)" } ?? "").font(.caption).foregroundStyle(.secondary)
        }
        Spacer()
        if editable {
          Text("Lead").font(.subheadline).foregroundStyle(.secondary)
          Toggle("Lead", isOn: Binding(get: { node?.lead ?? false }, set: { on in withAnimation(.snappy) { team = team.setting(agentId, lead: on) } }))
            .labelsHidden()
            .accessibilityLabel("\(agent?.name ?? "Agent") leads")
        }
      }
      if node?.lead == false {
        if editable {
          Menu {
            ForEach(candidates, id: \.self) { id in
              Toggle(store.agent(id)?.name ?? "Agent", isOn: Binding(get: { givers.contains(id) }, set: { on in team = team.setting(agentId, from: id, on: on) }))
            }
          } label: {
            HStack(spacing: 4) {
              Text("Gets work from").foregroundStyle(.secondary)
              Text(names(givers) ?? "Nobody yet").foregroundStyle(givers.isEmpty ? .red : .primary)
              Image(systemName: "chevron.up.chevron.down").font(.caption2).foregroundStyle(.secondary)
            }
            .font(.subheadline)
          }
          .padding(.leading, 40)
        } else {
          Text("Gets work from \(names(givers) ?? "nobody")").font(.subheadline).foregroundStyle(.secondary).padding(.leading, 40)
        }
      }
    }
    .swipeActions {
      if editable {
        Button("Take off", role: .destructive) { withAnimation(.snappy) { team = team.removing(agentId) } }
      }
    }
    .contextMenu {
      if editable { Button("Take off the team", systemImage: "minus.circle", role: .destructive) { team = team.removing(agentId) } }
    }
  }

  private func names(_ ids: [String]) -> String? {
    let list = ids.compactMap { store.agent($0)?.name }
    return list.isEmpty ? nil : ChannelTeam.list(list)
  }
}

/** The chart, read-only: a row per level, leads on top, an arrow from each agent to whoever it hands work to. */
struct TeamChartView: View {
  @Environment(Store.self) private var store
  var team: ChannelTeam
  var busy: Set<String> = []

  var body: some View {
    // centered when it fits, scrolling sideways when a row is too wide
    ViewThatFits(in: .horizontal) {
      chart.frame(maxWidth: .infinity)
      ScrollView(.horizontal, showsIndicators: false) { chart }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(description)
  }

  private var chart: some View {
    VStack(spacing: 34) {
      ForEach(Array(team.rows.enumerated()), id: \.offset) { _, row in
        HStack(spacing: 10) {
          ForEach(row, id: \.self) { id in card(id) }
        }
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 4)
    .backgroundPreferenceValue(CardFrames.self) { frames in
      GeometryReader { geo in
        ForEach(team.edges, id: \.self) { e in
          if let a = frames[e.from].map({ geo[$0] }), let b = frames[e.to].map({ geo[$0] }) {
            arrow(from: a, to: b, live: busy.contains(e.from) && busy.contains(e.to))
          }
        }
      }
    }
  }

  private func card(_ id: String) -> some View {
    let agent = store.agent(id), lead = team.node(id)?.lead == true
    return VStack(spacing: 4) {
      ZStack(alignment: .topTrailing) {
        AgentAvatar(agent: agent, size: 38, showStatus: false)
        if busy.contains(id) { GlowDot(color: .green).offset(x: 2, y: -2) }
      }
      HStack(spacing: 3) {
        if lead { Image(systemName: "crown").font(.caption2) }
        Text(agent?.name ?? "Agent").lineLimit(1)
      }
      .font(.caption.weight(lead ? .semibold : .regular))
    }
    .frame(minWidth: 64)
    .padding(.horizontal, 8)
    .padding(.vertical, 6)
    .background(RoundedRectangle(cornerRadius: Corner.tile, style: .continuous).fill(Color(.tertiarySystemFill)))
    .anchorPreference(key: CardFrames.self, value: .bounds) { [id: $0] }
  }

  private func arrow(from a: CGRect, to b: CGRect, live: Bool) -> some View {
    // down from the giver's bottom to the taker's top; sideways when they share a row
    let sameRow = abs(a.midY - b.midY) < 4
    let start = sameRow ? CGPoint(x: a.midX < b.midX ? a.maxX : a.minX, y: a.midY) : CGPoint(x: a.midX, y: b.midY > a.midY ? a.maxY : a.minY)
    let end = sameRow ? CGPoint(x: a.midX < b.midX ? b.minX : b.maxX, y: b.midY) : CGPoint(x: b.midX, y: b.midY > a.midY ? b.minY : b.maxY)
    let down = end.y >= start.y ? 1.0 : -1.0
    let reach = max(14, abs(end.y - start.y) / 2)
    var path = Path()
    path.move(to: start)
    if sameRow { path.addLine(to: end) } else {
      path.addCurve(to: end, control1: CGPoint(x: start.x, y: start.y + reach * down), control2: CGPoint(x: end.x, y: end.y - reach * down))
    }
    // the arrowhead, pointing the way the line arrives
    let angle = sameRow ? (end.x > start.x ? 0.0 : .pi) : (down > 0 ? .pi / 2 : -.pi / 2)
    var head = Path()
    head.move(to: end)
    head.addLine(to: CGPoint(x: end.x - 6 * cos(angle - 0.5), y: end.y - 6 * sin(angle - 0.5)))
    head.move(to: end)
    head.addLine(to: CGPoint(x: end.x - 6 * cos(angle + 0.5), y: end.y - 6 * sin(angle + 0.5)))
    let color = live ? Color.green : Color.secondary.opacity(0.6)
    return ZStack {
      path.stroke(color, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, dash: live ? [4, 3] : []))
      head.stroke(color, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
    }
  }

  private var description: String {
    let name = { (id: String) in store.agent(id)?.name ?? "Agent" }
    let leads = ChannelTeam.list(team.leads.map(name))
    let handoffs = team.edges.map { "\(name($0.from)) hands work to \(name($0.to))" }
    return (["Team chart. \(leads) \(team.leads.count > 1 ? "lead" : "leads")."] + handoffs).joined(separator: ". ")
  }
}

private struct CardFrames: PreferenceKey {
  static let defaultValue: [String: Anchor<CGRect>] = [:]
  static func reduce(value: inout [String: Anchor<CGRect>], nextValue: () -> [String: Anchor<CGRect>]) {
    value.merge(nextValue()) { $1 }
  }
}
