import SwiftUI

/** An agent's reply as it streams in over the websocket, before it's posted as a message. */
struct LiveRun: Identifiable, Equatable {
  var id: String
  var agentId: String
  var channelId: String
  var threadId: String?
  var text = ""
  /** the last tool it called, and the file that tool works on, for "Reading main.ts" */
  var tool: String?
  var file: String?

  /**
   * Add what a run event says. Only the agent's own words go into the reply text; a tool call
   * moves the working line, and tool output, statuses and errors never land in the bubble.
   */
  mutating func apply(type: String, text new: String?, tool newTool: String? = nil, file newFile: String? = nil) {
    if type == "tool_call", let newTool { tool = newTool; file = newFile }
    if type == "text", let new { text += new }
  }
}

extension Store {
  func applyLive(runId: String, agentId: String, channelId: String, threadId: String?, type: String, text: String?, tool: String? = nil, file: String? = nil) {
    var run = liveRuns[runId] ?? LiveRun(id: runId, agentId: agentId, channelId: channelId, threadId: threadId)
    run.apply(type: type, text: text, tool: tool, file: file)
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
      .filter { $0.channelId == channelId && $0.threadId == thread }
      .sorted { $0.id < $1.id }
  }

  var liveLength: Int { liveRuns.values.reduce(0) { $0 + $1.text.count } }
}

