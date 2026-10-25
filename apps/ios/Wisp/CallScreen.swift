import AVFoundation
import SwiftUI

/** A voice call with an agent, full screen. Talks to the DM the agent is in; the full replies stay in the chat. */
struct CallScreen: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  var agent: Agent
  var channel: Channel
  @State private var session: VoiceCallSession?
  @State private var engine = ""
  @State private var loadError = ""
  @State private var attempt = 0

  private var live: Agent { store.agent(agent.id) ?? agent }
  private var offline: Bool { live.status == .offline }
  private var state: CallState { session?.state ?? CallState(error: loadError) }
  private var look: GhostLook { (live.settings?.appearance ?? GhostLook.defaultAppearance(live.handle)).resolved }
  private var tint: Color { Color(hex: look.color) }

  var body: some View {
    NavigationStack {
      ZStack {
        LinearGradient(colors: [tint.opacity(0.28), Color(.systemBackground)], startPoint: .top, endPoint: .bottom).ignoresSafeArea()
        VStack(spacing: 14) {
          timer.frame(height: 24)
          Spacer(minLength: 0)
          ghost
          Text(live.name).font(.system(.title, design: .rounded, weight: .semibold))
          Text(label).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center).accessibilityAddTraits(.updatesFrequently)
          captions
          if state.longWork { Text("Feel free to hang up. Watch for the done glow or a notification.").font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center) }
          problem
          Spacer(minLength: 0)
          controls
          Text(engine.isEmpty ? "Full replies stay in chat" : "\(engine) · Full replies stay in chat").font(.caption2).foregroundStyle(.tertiary).multilineTextAlignment(.center)
        }
        .padding(.horizontal, 24).padding(.bottom, 12)
      }
      .toolbar(.hidden, for: .navigationBar)
    }
    .task(id: attempt) { await begin() }
    .onChange(of: store.messages[channel.id]) { session?.sync() }
    .onChange(of: store.connected) { _, connected in
      guard let session else { return }
      if !connected { session.disconnect() } else if !session.state.ready { Task { await session.start() } }
    }
    .onChange(of: scenePhase) { _, phase in
      // the system stops the microphone while Wisp is in the background; pick the call back up on return
      guard phase == .active, let session, !session.state.ready, session.state.startedAt != nil, session.state.error.isEmpty, store.connected else { return }
      Task { await session.start() }
    }
    .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { note in
      guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt, let kind = AVAudioSession.InterruptionType(rawValue: raw) else { return }
      if kind == .began { session?.pauseForInterruption() }
      else if let session, store.connected {
        let options = AVAudioSession.InterruptionOptions(rawValue: (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt) ?? 0)
        if options.contains(.shouldResume) { Task { await session.start() } }
      }
    }
    .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
    .onDisappear { end() }
    .interactiveDismissDisabled()
  }

  // MARK: parts

  private var timer: some View {
    Group {
      if !offline, let started = state.startedAt {
        TimelineView(.periodic(from: .now, by: 1)) { context in
          let seconds = max(0, Int(context.date.timeIntervalSince(started)))
          Text("\(seconds / 60):\(String(format: "%02d", seconds % 60))").font(.system(.subheadline, design: .rounded).monospacedDigit()).foregroundStyle(.secondary)
            .accessibilityLabel("Call duration \(seconds) seconds")
        }
      }
    }
  }

  private var ghost: some View {
    ZStack {
      if !offline {
        // the halo follows the person's voice while they talk and the agent's while it speaks
        let level = state.speaking ? state.speechLevel : state.micLevel
        Circle().fill(tint.opacity(0.22 + level * 0.3)).frame(width: 250, height: 250).scaleEffect(1 + level * 0.18)
          .animation(.easeOut(duration: 0.12), value: level)
      }
      GhostView(look: live.settings?.appearance, seed: live.handle, asleep: offline, size: 200, mood: mood, interactive: true)
    }.frame(height: 260).accessibilityElement(children: .ignore).accessibilityLabel("\(live.name), \(label.lowercased())")
  }

  private var mood: GhostMood { state.talking ? .listening : state.waiting && !state.speaking ? .thinking : .awake }

  private var label: String {
    if offline { return "\(live.name) is asleep. Wake their computer to talk." }
    if !store.connected { return "Reconnecting…" }
    if state.needsMic { return "A little help with the microphone?" }
    if !state.error.isEmpty && !state.ready { return "Couldn't connect just yet" }
    if !state.ready { return state.startedAt != nil ? "Paused" : "Calling…" }
    if state.muted { return "Microphone muted" }
    if state.talking { return "I'm listening" }
    if state.speaking { return "Speaking" }
    if state.waiting { return "Thinking…" }
    return "Go ahead, I'm listening"
  }

  private var captions: some View {
    VStack(spacing: 6) {
      if !state.userCaption.isEmpty { (Text("You  ").fontWeight(.semibold) + Text(state.userCaption)).foregroundStyle(.secondary) }
      if !state.agentCaption.isEmpty { (Text("\(live.name)  ").fontWeight(.semibold) + Text(state.agentCaption)) }
    }
    .font(.callout).multilineTextAlignment(.center).lineLimit(6).frame(maxWidth: .infinity, minHeight: 20)
    .accessibilityElement(children: .combine)
  }

  @ViewBuilder private var problem: some View {
    if !offline && (state.needsMic || !state.error.isEmpty || (!state.ready && state.startedAt != nil)) {
      VStack(spacing: 8) {
        if state.needsMic { Text("Allow the microphone so you can talk to \(live.name).").font(.footnote).foregroundStyle(.secondary) }
        if !state.error.isEmpty { Text(state.error).font(.footnote).foregroundStyle(.red) }
        HStack(spacing: 10) {
          if !state.ready && store.connected { Button(state.error.isEmpty && state.startedAt != nil ? "Resume" : "Try again") { retry() }.buttonStyle(.bordered) }
          if state.needsMic, let url = URL(string: UIApplication.openSettingsURLString) { Button("Open Settings") { UIApplication.shared.open(url) }.buttonStyle(.bordered) }
          if !state.error.isEmpty { NavigationLink("Voice settings") { VoiceSettingsView() }.buttonStyle(.bordered) }
        }
      }.multilineTextAlignment(.center).accessibilityElement(children: .contain)
    }
  }

  private var controls: some View {
    HStack(spacing: 36) {
      Button { Task { await session?.mute(!state.muted) } } label: {
        Image(systemName: state.muted ? "mic.slash" : "mic").font(.system(size: 24, weight: .medium))
          .frame(width: 68, height: 68).glassCapsule(tint: state.muted ? .red.opacity(0.4) : nil, interactive: true)
      }
      .buttonStyle(.plain).foregroundStyle(.primary)
      .disabled(offline || session == nil || (!state.ready && !state.muted))
      .accessibilityLabel(state.muted ? "Unmute microphone" : "Mute microphone")
      Button { end(); dismiss() } label: {
        Image(systemName: "phone.down.fill").font(.system(size: 26)).foregroundStyle(.white)
          .frame(width: 68, height: 68).background(Circle().fill(.red))
      }.accessibilityLabel("Hang up")
    }.padding(.top, 8)
  }

  // MARK: the call

  private func begin() async {
    end()
    loadError = ""; engine = ""
    guard !offline else { return }
    do {
      let api = try store.connection()
      let prefs: VoicePreferences = try await api.get("/api/voice/settings")
      let voice = await agentVoice(api)
      let hub = VoiceHub(api: { try store.connection() })
      let channelId = channel.id, agentId = agent.id
      let call = VoiceCallSession(
        agentId: agentId, channelId: channelId, cloudListening: prefs.listen == "openai",
        listener: { CallEngines.listener(engine: prefs.listen, callbacks: $0, hub: hub) },
        speaker: CallEngines.speaker(engine: prefs.speak, voice: voice, seed: live.handle, hub: hub),
        send: { text in try await store.sendVoiceMessage(text, in: channelId) },
        messages: { store.messages[channelId] ?? [] },
        refresh: { try? await store.loadMessages(channelId) })
      if Task.isCancelled { call.stop(); return }
      session = call
      engine = CallEngines.engineLabel(prefs)
      if store.connected { await call.start() } else { call.disconnect() }
    } catch { loadError = error.localizedDescription }
  }

  /** The agent's own voice choice, if it has one. The list is the same one the app already loads. */
  private func agentVoice(_ api: API) async -> AgentVoice? {
    struct Row: Decodable { struct S: Decodable { var voice: AgentVoice? }; var id: String; var settings: S? }
    let rows: [Row]? = try? await api.get("/api/agents")
    return rows?.first { $0.id == agent.id }?.settings?.voice
  }

  private func retry() {
    if let session { Task { await session.start() } } else { attempt += 1 }
  }

  private func end() {
    session?.stop(); session = nil
    CallAudio.deactivate()
    UIApplication.shared.isIdleTimerDisabled = false
  }
}
