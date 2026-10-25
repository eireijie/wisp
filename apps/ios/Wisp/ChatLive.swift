import SwiftUI

/** An agent's reply as it streams in over the websocket, before it's posted as a message. */
struct LiveRun: Identifiable, Equatable {
  var id: String
  var agentId: String
  var channelId: String
  var threadId: String?
  var text = ""

  /** Add what a run event says, the way the web does: text appends, status lines and errors get their own line. */
  mutating func apply(type: String, text new: String?) {
    guard let new, !new.isEmpty else { return }
    switch type {
    case "text":
      text += new
    case "status", "notice", "error":
      if type == "status" && new == "started" { return }
      let line = type == "error" ? "Error: \(new)" : new
      text += (text.isEmpty || text.hasSuffix("\n") ? "" : "\n") + line + "\n"
    default:
      break
    }
  }
}

extension Store {
  func applyLive(runId: String, agentId: String, channelId: String, threadId: String?, type: String, text: String?) {
    var run = liveRuns[runId] ?? LiveRun(id: runId, agentId: agentId, channelId: channelId, threadId: threadId)
    run.apply(type: type, text: text)
    if liveRuns[runId] != run { liveRuns[runId] = run }
  }

  /** The agent's reply was posted (or it stopped): its preview goes away. */
  func clearLive(agent agentId: String, channel channelId: String? = nil) {
    guard liveRuns.values.contains(where: { $0.agentId == agentId && (channelId == nil || $0.channelId == channelId) }) else { return }
    liveRuns = liveRuns.filter { !($0.value.agentId == agentId && (channelId == nil || $0.value.channelId == channelId)) }
  }

  /** What's being written right now in this channel (or thread), oldest first. */
  func streaming(in channelId: String, thread: String?) -> [LiveRun] {
    liveRuns.values
      .filter { $0.channelId == channelId && $0.threadId == thread && !$0.text.isEmpty }
      .sorted { $0.id < $1.id }
  }

  var liveLength: Int { liveRuns.values.reduce(0) { $0 + $1.text.count } }
}

/** A reply as it's being written, faded a little, until the real message replaces it. */
struct StreamingRow: View {
  @Environment(Store.self) private var store
  var run: LiveRun

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      AgentAvatar(agent: store.agent(run.agentId), size: 34, showStatus: false).frame(width: 34)
      VStack(alignment: .leading, spacing: 5) {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(store.agent(run.agentId)?.name ?? "Agent").font(.subheadline.weight(.semibold))
          Text("writing…").font(.caption2).foregroundStyle(.tertiary)
        }
        MarkdownText(run.text).opacity(0.7)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.horizontal, 16)
    .padding(.top, 10)
    .padding(.bottom, 2)
    .accessibilityElement(children: .combine)
  }
}
