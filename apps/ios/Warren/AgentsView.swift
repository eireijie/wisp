import SwiftUI

/** Everyone you work with: each agent's ghost, what it's doing now, and a tap to chat. */
struct AgentsView: View {
  @Environment(Store.self) private var store
  @State private var path = NavigationPath()
  @State private var error: String?

  private var sorted: [Agent] {
    store.agents.sorted { a, b in
      let rank: (Agent.Status) -> Int = { $0 == .busy ? 0 : $0 == .online ? 1 : 2 }
      return rank(a.status) != rank(b.status) ? rank(a.status) < rank(b.status) : a.name < b.name
    }
  }

  var body: some View {
    NavigationStack(path: $path) {
      ScrollView {
        if store.agents.isEmpty {
          ContentUnavailableView("No agents yet", systemImage: "sparkles", description: Text("Add your first agent from Warren on your computer: pick a harness like Claude Code or Codex and a device to run it."))
            .padding(.top, 80)
        }
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 160), spacing: 12)], spacing: 12) {
          ForEach(sorted) { a in
            Button {
              open(a)
            } label: {
              AgentTile(agent: a, doing: store.activity[a.id])
            }
            .buttonStyle(.plain)
          }
        }
        .padding(16)
        if let error { Text(error).font(.footnote).foregroundStyle(.red) }
      }
      .navigationTitle("Agents")
      .refreshable { await store.load() }
      .navigationDestination(for: Channel.self) { ChannelView(channel: $0) }
      .navigationDestination(for: ThreadRef.self) { ThreadView(ref: $0) }
    }
  }

  private func open(_ a: Agent) {
    Task {
      do { path.append(try await store.dm(with: a)) } catch { self.error = error.localizedDescription }
    }
  }
}

struct AgentTile: View {
  var agent: Agent
  var doing: String?

  var body: some View {
    VStack(spacing: 10) {
      GhostView(look: agent.settings?.appearance, seed: agent.id, asleep: agent.status == .offline, size: 64)
        .phaseAnimator(agent.status == .offline ? [0] : [0, -4]) { v, y in v.offset(y: y) } animation: { _ in .easeInOut(duration: agent.status == .busy ? 0.7 : 1.8) }
        .shadow(color: glow.opacity(agent.status == .offline ? 0 : 0.45), radius: 14, y: 4)
        .padding(.top, 6)
      VStack(spacing: 3) {
        Text(agent.name).font(.headline).lineLimit(1)
        Text(harnessLabel).font(.caption).foregroundStyle(.secondary).lineLimit(1)
      }
      HStack(spacing: 5) {
        GlowDot(color: statusColor)
        Text(doing ?? statusWord).font(.caption).foregroundStyle(agent.status == .busy ? .blue : .secondary).lineLimit(1)
      }
    }
    .frame(maxWidth: .infinity)
    .padding(14)
    .background(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).fill(Color(.secondarySystemBackground)))
  }

  private var glow: Color { Color(hex: agent.settings?.appearance?.color ?? "#8bd4ff") }
  private var statusWord: String { agent.status == .busy ? "Working" : agent.status == .online ? "Online" : "Offline" }
  private var statusColor: Color { agent.status == .busy ? .blue : agent.status == .online ? .green : .gray }
  private var harnessLabel: String {
    let names = ["claude-code": "Claude Code", "codex": "Codex", "gemini": "Gemini CLI", "hermes": "Hermes", "opencode": "OpenCode", "goose": "Goose", "openclaw": "OpenClaw", "kimi": "Kimi CLI", "qwen": "Qwen Code", "cursor": "Cursor", "grok": "Grok", "custom": "Custom"]
    return names[agent.harness] ?? agent.harness.replacingOccurrences(of: "acp:", with: "").capitalized
  }
}
