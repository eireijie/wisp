import Foundation
import Observation

/** What a call looks like at one moment (CallState in the web's voice/call.ts). */
struct CallState: Equatable {
  var ready = false
  var muted = false
  var speaking = false
  var talking = false
  var waiting = false
  var needsMic = false
  var startedAt: Date?
  var micLevel = 0.0
  var speechLevel = 0.0
  var userCaption = ""
  var agentCaption = ""
  var error = ""
  var longWork = false
  /** a short line for the tool the agent is using ("Reading main.ts"), empty when it is just thinking */
  var activity = ""

  /** What the call is doing right now, for the screen to show. */
  var phase: CallPhase {
    if !error.isEmpty || needsMic { return .error }
    if !ready { return muted ? .muted : .connecting }
    if muted { return .muted }
    if speaking { return .speaking }
    if talking { return .hearing }
    if waiting { return activity.isEmpty ? .thinking : .working }
    return .listening
  }
}

enum CallPhase: String, Equatable { case connecting, muted, listening, hearing, thinking, working, speaking, error }

/** One agent run event for the call (the hub's run_event, trimmed to what a call needs). */
struct CallRunEvent {
  var runId: String?
  var agentId: String
  var channelId: String
  var threadId: String?
  var type: String
  var text: String?
  var tool: String?
  var file: String?
}

enum CallActivity {
  /** "Reading main.ts", "Searching the web": a short line for the tool the agent just started. */
  static func line(tool name: String, file: String?) -> String {
    var t = name.lowercased()
    for prefix in ["mcp__wisp__", "mcp__warren__"] where t.hasPrefix(prefix) { t.removeFirst(prefix.count) }
    let base = file.flatMap { $0.split(whereSeparator: { $0 == "/" }).last.map(String.init) }
    if t.hasPrefix("computer_") || t == "computer" { return "Using its computer" }
    if t.hasPrefix("memory_") || t.hasPrefix("vault_") { return t.contains("remember") || t.contains("write") || t.contains("append") ? "Updating memory" : "Searching memory" }
    if ["edit", "multiedit", "write", "apply_patch", "str_replace", "notebookedit"].contains(t) { return base.map { "Editing \($0)" } ?? "Editing files" }
    if ["read", "view", "cat", "read_file", "open_file"].contains(t) { return base.map { "Reading \($0)" } ?? "Reading files" }
    if ["glob", "grep", "ls", "find", "list_dir"].contains(t) { return "Looking through files" }
    if ["bash", "shell", "exec", "exec_command", "run_command", "terminal"].contains(t) { return "Running a command" }
    if t.contains("search") { return "Searching the web" }
    if t.contains("fetch") || t.contains("browse") || t.contains("navigate") { return "Browsing" }
    if t.hasPrefix("task_") { return "Updating tasks" }
    return "Working"
  }
}

struct ListenCallbacks {
  var partial: @MainActor (String) -> Void
  var final: @MainActor (String) -> Void
  var level: @MainActor (Double) -> Void
  var activity: @MainActor (Bool) -> Void
  var error: @MainActor (String) -> Void
}

@MainActor protocol CallListener: AnyObject {
  func start() async throws
  func stop()
}

@MainActor protocol CallSpeaker: AnyObject {
  func speak(_ text: String, level: @escaping @MainActor (Double) -> Void) async throws
  func cancel()
}

struct CallTiming {
  var filler: Duration = .milliseconds(2500)
  var longWork: Duration = .seconds(20)
  var micHint: Duration = .seconds(4)
  var echoWindow: TimeInterval = 1.2
}

/**
 * Owns one call: listen, send what was said as a voice message, wait for the agent's reply
 * (it arrives in the channel's messages), speak it, listen again. A port of the web's VoiceCall;
 * it has no audio or UI in it, so late callbacks and interruptions are testable.
 */
@MainActor @Observable
final class VoiceCallSession {
  private(set) var state = CallState()
  @ObservationIgnored private var listener: CallListener!
  @ObservationIgnored private let speaker: CallSpeaker
  @ObservationIgnored private let agentId: String
  @ObservationIgnored private let channelId: String
  @ObservationIgnored private let cloudListening: Bool
  @ObservationIgnored private let sendText: (String) async throws -> Void
  @ObservationIgnored private let messages: () -> [Message]
  @ObservationIgnored private let refresh: (() async -> Void)?
  @ObservationIgnored private let timing: CallTiming

  @ObservationIgnored private var stopped = false
  @ObservationIgnored private var pending = 0
  @ObservationIgnored private var capture = 0
  @ObservationIgnored private var speech = 0
  @ObservationIgnored private var spoken = ""
  @ObservationIgnored private var streamed = ""
  @ObservationIgnored private var streamRun = ""
  /** the first sentence of the reply, spoken while the agent is still working */
  @ObservationIgnored private var early = ""
  @ObservationIgnored private var spokenAt = Date.distantPast
  @ObservationIgnored private var filler: Task<Void, Never>?
  @ObservationIgnored private var long: Task<Void, Never>?
  @ObservationIgnored private var micHint: Task<Void, Never>?
  @ObservationIgnored private var seen = Set<String>()
  @ObservationIgnored private var lastSeen: String?
  @ObservationIgnored private var lastSeenAt = ""

  init(agentId: String, channelId: String, cloudListening: Bool,
       listener: (ListenCallbacks) -> CallListener, speaker: CallSpeaker,
       send: @escaping (String) async throws -> Void, messages: @escaping () -> [Message],
       refresh: (() async -> Void)? = nil, timing: CallTiming = CallTiming()) {
    self.agentId = agentId; self.channelId = channelId; self.cloudListening = cloudListening
    self.speaker = speaker; self.sendText = send; self.messages = messages; self.refresh = refresh; self.timing = timing
    markSeen(conversation().last)
    self.listener = listener(ListenCallbacks(
      partial: { [unowned self] text in
        if stopped || state.muted || !state.ready || echo(text) { return }
        if !text.isEmpty { interrupt() }
        update { $0.userCaption = text; $0.talking = !text.isEmpty }
      },
      final: { [unowned self] text in
        if !stopped && !state.muted && state.ready && !echo(text) { Task { await self.turn(text) } }
      },
      level: { [unowned self] level in update { $0.micLevel = level } },
      activity: { [unowned self] talking in
        if stopped || state.muted || !state.ready { return }
        update { $0.talking = talking }
        if talking && cloudListening { interrupt() }
      },
      error: { [unowned self] message in
        micHint?.cancel()
        update { $0.error = message; $0.needsMic = true; $0.ready = false; $0.talking = false }
      }))
  }

  private func update(_ change: (inout CallState) -> Void) {
    if stopped { return }
    var next = state
    change(&next)
    if !next.waiting { next.activity = "" }
    if next != state { state = next }
  }

  private func echo(_ text: String) -> Bool {
    (state.speaking || Date().timeIntervalSince(spokenAt) < timing.echoWindow) && VoiceText.isSpeechEcho(heard: text, spoken: spoken)
  }

  func start() async {
    if stopped { return }
    if capture > 0 { listener.stop() }
    capture += 1
    let mine = capture
    micHint?.cancel()
    update { $0.error = ""; $0.muted = false; $0.ready = false; $0.needsMic = false; $0.talking = false; $0.micLevel = 0 }
    micHint = Task { [weak self, timing] in
      try? await Task.sleep(for: timing.micHint)
      guard !Task.isCancelled, let self, mine == self.capture else { return }
      self.update { $0.needsMic = true }
    }
    do {
      if pending > 0 { await refresh?() }
      if mine != capture || stopped { return }
      try await listener.start()
      if mine == capture && state.error.isEmpty {
        update { $0.ready = true; $0.needsMic = false; if $0.startedAt == nil { $0.startedAt = Date() } }
        sync(catchUp: true)
      }
    } catch {
      if mine == capture { update { $0.error = error.localizedDescription; $0.needsMic = true; $0.ready = false } }
    }
    if mine == capture { micHint?.cancel() }
  }

  func mute(_ muted: Bool) async {
    update { $0.muted = muted; $0.talking = false; if muted { $0.userCaption = "" } }
    if muted { capture += 1; micHint?.cancel(); listener.stop() } else { await start() }
  }

  /** Stop speaking, because the person started talking (or a new turn began). */
  func interrupt() {
    speech += 1
    speaker.cancel()
    spokenAt = Date()
    update { $0.speaking = false; $0.speechLevel = 0 }
  }

  private func say(_ text: String) async {
    if stopped || text.isEmpty || !state.ready { return }
    interrupt()
    let mine = speech
    spoken = text
    update { $0.speaking = true; $0.agentCaption = text }
    do {
      try await speaker.speak(text) { [weak self] level in
        guard let self, mine == self.speech else { return }
        self.update { $0.speechLevel = level }
      }
    } catch {
      if mine == speech { update { $0.error = error.localizedDescription } }
    }
    if mine == speech {
      spokenAt = Date()
      update { $0.speaking = false; $0.speechLevel = 0 }
    }
  }

  private func startTimers() {
    filler?.cancel(); long?.cancel()
    filler = Task { [weak self, timing] in
      try? await Task.sleep(for: timing.filler)
      guard !Task.isCancelled, let self, self.pending > 0, self.early.isEmpty, !self.state.talking, !self.state.speaking else { return }
      await self.say("On it…")
    }
    long = Task { [weak self, timing] in
      try? await Task.sleep(for: timing.longWork)
      guard !Task.isCancelled, let self, self.pending > 0 else { return }
      self.update { $0.longWork = true }
      let text = "This needs a little longer. I'll ping you when it's ready. You can hang up; I'll keep working."
      if !self.state.talking { await self.say(text) } else { self.update { $0.agentCaption = text } }
    }
  }
  private func clearTimers() { filler?.cancel(); long?.cancel() }

  func turn(_ raw: String) async {
    let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty || stopped { return }
    interrupt()
    pending += 1
    streamed = ""; streamRun = ""; early = ""
    update { $0.userCaption = text; $0.agentCaption = ""; $0.activity = ""; $0.talking = false; $0.waiting = true; $0.longWork = false; $0.error = "" }
    startTimers()
    do { try await sendText(text) }
    catch {
      pending = max(0, pending - 1)
      if pending == 0 { clearTimers() }
      update { $0.error = "Couldn't send your voice message: \(error.localizedDescription)"; $0.waiting = pending > 0 }
    }
  }

  private func conversation() -> [Message] { messages().filter { $0.channelId == channelId && $0.threadId == nil } }
  private func markSeen(_ m: Message?) { if let m { lastSeen = m.id; lastSeenAt = m.createdAt } }
  private func isAgentReply(_ m: Message) -> Bool { m.author.kind == .agent && m.author.id == agentId }
  private func failure(_ m: Message) -> String? {
    for case .status(let text) in m.parts where text.hasPrefix("Run failed:") { return text }
    return nil
  }

  /**
   * Look at the channel's messages for what arrived since the last look: the agent's reply (speak it),
   * a hub notice such as "Not waking…", or a failed run. Call whenever the messages change.
   */
  func sync(catchUp: Bool = false) {
    if stopped || !state.ready { return }
    let all = conversation()
    let index = all.firstIndex { $0.id == lastSeen }
    let fresh = index.map { Array(all[($0 + 1)...]) } ?? all.filter { $0.createdAt >= lastSeenAt }
    let had = pending
    var replies: [Message] = []
    for m in fresh {
      if m.author.id == "system" {
        for case .status(let text) in m.parts {
          update { $0.error = text }
          filler?.cancel()
          if text.hasPrefix("Not waking") { pending = max(0, pending - 1); long?.cancel() }
        }
      } else if isAgentReply(m) && !seen.contains(m.id) {
        seen.insert(m.id)
        replies.append(m)
      }
    }
    pending = max(0, pending - replies.count)
    // an agent message after the person's last one means nothing is left to wait for
    let lastAgent = all.lastIndex { isAgentReply($0) }
    let lastPerson = all.lastIndex { $0.author.kind == .user && $0.author.id != "system" }
    if catchUp, let a = lastAgent, a > (lastPerson ?? -1) { pending = 0 }
    markSeen(all.last)
    update { $0.waiting = pending > 0; if !replies.isEmpty || pending == 0 { $0.longWork = false } }
    if pending > 0 { if filler == nil || filler?.isCancelled == true { startTimers() } } else { clearTimers() }
    guard had > 0, pending == 0, let newest = replies.last else { return }
    if let failed = failure(newest) { interrupt(); update { $0.error = failed }; return }
    let text = VoiceText.spokenReply(newest.body)
    let line = text.isEmpty ? "I've put the details in our chat." : text
    if state.talking { update { $0.agentCaption = line } } else { sayReply(line) }
  }

  /** Speak a finished reply, skipping the part already said while it streamed. */
  private func sayReply(_ text: String) {
    let said = early; early = ""
    let rest = !said.isEmpty && text.hasPrefix(said) ? String(text.dropFirst(said.count)).trimmingCharacters(in: .whitespacesAndNewlines) : text
    if !rest.isEmpty { Task { await self.say(rest) } }
  }

  /** The agent's run while it happens: what tool it is using, and its first sentence as soon as it is whole. */
  func event(_ e: CallRunEvent) {
    if stopped || !state.ready || pending == 0 || e.agentId != agentId || e.threadId != nil { return }
    switch e.type {
    case "tool_call": update { $0.activity = CallActivity.line(tool: e.tool ?? "", file: e.file) }
    case "tool_result": update { $0.activity = "" }
    case "text":
      if streamRun != (e.runId ?? "") { streamed = ""; streamRun = e.runId ?? "" }
      streamed = String((streamed + (e.text ?? "")).prefix(40_000))
      let excerpt = VoiceText.spokenReply(streamed)
      if early.isEmpty, !state.talking, !state.speaking, let first = VoiceText.firstSentence(excerpt) {
        early = first
        Task { await self.say(first) }
      } else if !state.speaking { update { $0.agentCaption = excerpt; $0.activity = "" } }
    default: break
    }
  }

  /** The connection to the hub dropped. The agent keeps working; reconnecting resumes the call. */
  func disconnect() {
    capture += 1
    clearTimers(); micHint?.cancel()
    listener.stop(); interrupt()
    update { $0.ready = false; $0.needsMic = false; $0.error = "Connection lost. Your agent can keep working. Reconnect to resume the call." }
  }

  /** The system took the audio (a phone call, Siri): pause without an error, and resume when it's given back. */
  func pauseForInterruption() {
    capture += 1
    micHint?.cancel()
    listener.stop(); interrupt()
    update { $0.ready = false; $0.talking = false; $0.micLevel = 0 }
  }

  func stop() {
    stopped = true
    capture += 1; speech += 1
    clearTimers(); micHint?.cancel()
    listener.stop(); speaker.cancel()
  }
}
