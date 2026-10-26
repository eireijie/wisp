import AVFoundation
import SwiftUI

// A voice call with an agent. The full screen and the bar it shrinks into (at the top of the chat) are
// two views of one CallController, which owns the call, so shrinking never interrupts it.

/** What a person sets for their own calls (the settings panel). Kept on this phone. */
@MainActor
enum CallPrefs {
  static let speedKey = "wisp.call.speed", languageKey = "wisp.call.language", activityKey = "wisp.call.activity"
  static let speeds: [Double] = [0.8, 1, 1.25, 1.5]
  /** language tags for listening; "" follows the phone */
  static let languages: [(tag: String, name: String)] = [("", "Auto"), ("en-US", "English (US)"), ("en-GB", "English (UK)"), ("es-ES", "Spanish"), ("fr-FR", "French"), ("de-DE", "German"), ("it-IT", "Italian"), ("pt-BR", "Portuguese"), ("ja-JP", "Japanese"), ("ko-KR", "Korean"), ("zh-CN", "Chinese"), ("hi-IN", "Hindi")]
  static var speed: Double { let v = WispPreferences.standard.double(forKey: speedKey); return speeds.contains(v) ? v : 1 }
  static var language: String { WispPreferences.standard.string(forKey: languageKey) ?? "" }
  static var showActivity: Bool { WispPreferences.standard.object(forKey: activityKey) as? Bool ?? true }
  static var listenLocale: Locale { language.isEmpty ? Locale.current : Locale(identifier: language) }
  static func speedLabel(_ v: Double) -> String { v == v.rounded() ? "\(Int(v))x" : "\(v)x" }
}

/** What the call looks like right now, worked out from its state (the web's callFacts). */
struct CallFacts: Equatable {
  var offline: Bool
  var phase: CallPhase
  var paused: Bool
  var failed: Bool
  var micTrouble: Bool
  var label: String
  var activity: String

  init(state: CallState, offline: Bool, connected: Bool, showActivity: Bool) {
    self.offline = offline
    phase = state.phase
    paused = !offline && connected && !state.ready && state.startedAt != nil && state.error.isEmpty && !state.needsMic && !state.muted
    failed = !offline && (!connected || (!state.error.isEmpty && !state.needsMic && !state.ready))
    micTrouble = !offline && connected && state.needsMic
    if offline { label = "Asleep" }
    else if !connected { label = "Reconnecting…" }
    else if micTrouble { label = "Can't hear you yet" }
    else if failed { label = "Couldn't connect just yet" }
    else if !state.error.isEmpty { label = "Something went wrong" }
    else { label = CallFacts.phaseLabel(state.phase, paused: paused) }
    activity = showActivity && state.phase == .working ? state.activity : ""
  }

  static func phaseLabel(_ phase: CallPhase, paused: Bool) -> String {
    if paused { return "Paused" }
    switch phase {
    case .connecting: return "Calling…"
    case .muted: return "Muted"
    case .listening, .hearing: return "Listening"
    case .thinking: return "Thinking"
    case .working: return "Working"
    case .speaking: return "Speaking"
    case .error: return "Can't connect"
    }
  }

  static func clock(_ seconds: Int) -> String { "\(seconds / 60):\(String(format: "%02d", seconds % 60))" }
}

/** One call: the session, the engines it uses and whether it shows full screen or as a bar. */
@MainActor @Observable
final class CallController {
  let agent: Agent
  let channel: Channel
  private(set) var session: VoiceCallSession?
  private(set) var engine = ""
  private(set) var speakEngine = "device"
  private(set) var loadError = ""
  var expanded = true
  var settingsOpen = false
  var voice: AgentVoice
  /** called after the person hangs up, so the chat drops the call */
  @ObservationIgnored var onHangUp: (() -> Void)?
  @ObservationIgnored private var deviceSpeaker: DeviceSpeaker?
  @ObservationIgnored private var cloudSpeaker: CloudSpeaker?
  /** bumped by every begin and by hanging up, so a start that finishes late can tell it was replaced */
  @ObservationIgnored private var generation = 0

  init(agent: Agent, channel: Channel) {
    self.agent = agent; self.channel = channel
    voice = agent.settings?.voice ?? AgentVoice()
  }

  var state: CallState { session?.state ?? CallState(error: loadError) }

  func begin(store: Store) async {
    stopSession()
    generation += 1
    let mine = generation
    loadError = ""; engine = ""
    guard store.agent(agent.id)?.status != .offline else { return }
    do {
      let api = try store.connection()
      let prefs: VoicePreferences = try await api.get("/api/voice/settings")
      guard mine == generation, !Task.isCancelled else { return }
      let hub = VoiceHub(api: { try store.connection() })
      let channelId = channel.id, agentId = agent.id
      let speaker = CallEngines.speaker(engine: prefs.speak, voice: voice, seed: agent.handle, hub: hub)
      deviceSpeaker = speaker as? DeviceSpeaker; cloudSpeaker = speaker as? CloudSpeaker
      speakEngine = prefs.speak
      let call = VoiceCallSession(
        agentId: agentId, channelId: channelId, cloudListening: prefs.listen == "openai",
        listener: { CallEngines.listener(engine: prefs.listen, callbacks: $0, hub: hub) },
        speaker: speaker,
        send: { text in try await store.sendVoiceMessage(text, in: channelId) },
        messages: { store.messages[channelId] ?? [] },
        refresh: { try? await store.loadMessages(channelId) })
      if Task.isCancelled { call.stop(); return }
      session = call
      store.onCallRunEvent = { [weak call] in call?.event($0) }
      engine = CallEngines.engineLabel(prefs)
      if store.connected { await call.start() } else { call.disconnect() }
    } catch { loadError = error.localizedDescription }
  }

  func retry(store: Store) {
    if let session { Task { await session.start() } } else { Task { await begin(store: store) } }
  }

  private func stopSession() {
    session?.stop(); session = nil
  }

  /** hang up: stop everything and let the chat drop the call */
  func end(store: Store) {
    generation += 1
    stopSession()
    store.onCallRunEvent = nil
    CallAudio.deactivate()
    UIApplication.shared.isIdleTimerDisabled = false
  }

  func hangUp(store: Store) { end(store: store); onHangUp?() }

  // MARK: settings

  /** this agent's voices for the engine the call speaks with, Automatic first */
  func voiceChoices() -> [VoiceChoice] {
    let all = AVSpeechSynthesisVoice.speechVoices().map {
      DeviceVoice(name: $0.name, lang: $0.language, id: $0.identifier, quality: $0.quality == .premium ? 5 : $0.quality == .enhanced ? 4 : 0, isDefault: $0.language == AVSpeechSynthesisVoice.currentLanguageCode())
    }.sorted { $0.id < $1.id }
    let language = Locale.preferredLanguages.first ?? "en"
    return AgentVoices.choices(engine: speakEngine, agent: agent, selected: voice[speakEngine] ?? "", recommended: AgentVoices.recommend(all, language: language), all: all,
                               language: { Locale.current.localizedString(forIdentifier: $0) ?? $0 })
  }

  var voiceName: String {
    let id = voice[speakEngine] ?? ""
    return id.isEmpty ? "Automatic" : voiceChoices().first { $0.id == id }?.label ?? "Saved voice"
  }

  /** change the agent's voice: heard on its next sentence, and saved on the agent */
  func chooseVoice(_ id: String, store: Store) {
    voice[speakEngine] = id.isEmpty ? nil : id
    deviceSpeaker?.preferred = voice.device
    if let cloudSpeaker {
      let provider = speakEngine
      cloudSpeaker.voice = voice[provider] ?? (provider == "openai" ? VoiceText.openaiVoices[VoiceText.voiceIndex(agent.handle, VoiceText.openaiVoices.count)] : VoiceText.elevenVoices[VoiceText.voiceIndex(agent.handle, VoiceText.elevenVoices.count)])
    }
    let saved = voice, agent = agent
    Task { try? await store.saveVoice(saved, for: agent) }
  }
}

/** Keeps a call alive in the background of a chat: new messages, the connection, the app going away and phone calls. */
struct CallLifecycle: ViewModifier {
  @Environment(Store.self) private var store
  @Environment(\.scenePhase) private var scenePhase
  var call: CallController?

  func body(content: Content) -> some View {
    content
      .onChange(of: call.flatMap { store.messages[$0.channel.id] }) { call?.session?.sync() }
      .onChange(of: store.connected) { _, connected in
        guard let session = call?.session else { return }
        if !connected { session.disconnect() } else if !session.state.ready { Task { await session.start() } }
      }
      .onChange(of: scenePhase) { _, phase in
        // the system stops the microphone while Wisp is in the background; pick the call back up on return
        guard phase == .active, let session = call?.session, !session.state.ready, session.state.startedAt != nil, session.state.error.isEmpty, store.connected else { return }
        Task { await session.start() }
      }
      .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { note in
        guard let session = call?.session, let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt, let kind = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if kind == .began { session.pauseForInterruption() }
        else if store.connected {
          let options = AVAudioSession.InterruptionOptions(rawValue: (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt) ?? 0)
          if options.contains(.shouldResume) { Task { await session.start() } }
        }
      }
      .onChange(of: call == nil) { _, none in UIApplication.shared.isIdleTimerDisabled = !none }
  }
}

extension View {
  func callLifecycle(_ call: CallController?) -> some View { modifier(CallLifecycle(call: call)) }
}

// MARK: the ghost in a call

/** The agent's ghost with its phase around it: a breathing ring while listening, a spinning arc while working, a pulse while speaking. */
struct CallGhost: View {
  var agent: Agent
  var state: CallState
  var facts: CallFacts
  var size: CGFloat
  var ring: CGFloat
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var breathe = false
  @State private var spin = false
  @State private var bob = false

  private var tint: Color { Color(hex: (agent.settings?.appearance ?? GhostLook.defaultAppearance(agent.handle)).resolved.color) }
  private var level: Double { state.speaking ? state.speechLevel : state.micLevel }
  private var mood: GhostMood {
    if facts.offline { return .asleep }
    switch facts.phase {
    case .hearing: return .listening
    case .thinking: return .thinking
    case .working: return .working
    default: return .awake
    }
  }
  private var dim: Bool { facts.paused || facts.failed || facts.micTrouble }

  var body: some View {
    ZStack {
      if !facts.offline {
        switch facts.phase {
        case .listening, .hearing:
          Circle().fill(tint.opacity(0.18))
            .scaleEffect(facts.phase == .hearing ? 1.05 + level * 0.2 : (breathe ? 1.12 : 1))
            .opacity(facts.phase == .hearing ? 0.5 + level * 0.5 : (breathe ? 0.9 : 0.35))
            .animation(facts.phase == .hearing ? .easeOut(duration: 0.1) : nil, value: level)
            .onAppear { guard !reduceMotion else { return }; withAnimation(.easeInOut(duration: 2.2).repeatForever(autoreverses: true)) { breathe = true } }
        case .thinking, .working:
          Circle().trim(from: 0, to: 0.5).stroke(tint, style: StrokeStyle(lineWidth: ring > 100 ? 3 : 2.5, lineCap: .round))
            .rotationEffect(.degrees(spin ? 315 : -45))
            .onAppear { guard !reduceMotion else { return }; withAnimation(.linear(duration: 1.1).repeatForever(autoreverses: false)) { spin = true } }
        case .speaking:
          Circle().strokeBorder(tint.opacity(0.6), lineWidth: 2)
            .scaleEffect(reduceMotion ? 1 : 1 + level * 0.12)
            .opacity(reduceMotion ? 0.5 : 0.3 + level * 0.7)
            .animation(.easeOut(duration: 0.1), value: level)
        default: EmptyView()
        }
      }
      GhostView(look: agent.settings?.appearance, seed: agent.handle, asleep: facts.offline, size: size, mood: mood, interactive: size > 60)
        .offset(y: facts.phase == .working && bob ? -5 : 0)
        .scaleEffect(facts.phase == .speaking && !reduceMotion ? 1 + level * 0.05 : 1)
        .animation(.easeOut(duration: 0.1), value: level)
        .opacity(dim ? 0.55 : 1)
        .onAppear { guard !reduceMotion else { return }; withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) { bob = true } }
    }
    .frame(width: ring, height: ring)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(agent.name), \(facts.label.lowercased())")
  }
}

/** A glass circle with a line icon, in the sizes a call uses. */
private struct CallCircle: View {
  var symbol: String
  var label: String
  var id: String
  var size: CGFloat = 56
  var filled = false
  var disabled = false
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(systemName: symbol).font(.system(size: size * 0.4, weight: .regular))
        .foregroundStyle(filled ? Palette.ground : Palette.text)
        .frame(width: size, height: size)
        .background { if filled { Circle().fill(Palette.text) } }
        .glassCircleIf(!filled)
        .contentShape(Circle())
    }
    .buttonStyle(.plain).disabled(disabled).opacity(disabled ? 0.4 : 1)
    .accessibilityLabel(label).accessibilityIdentifier(id)
  }
}

private extension View {
  @ViewBuilder func glassCircleIf(_ on: Bool) -> some View { if on { glassCircle() } else { self } }
}

// MARK: the full screen

struct CallScreen: View {
  /** the hang-up button: the same red in both modes */
  static let endRed = Color(hex: 0xE5484D)
  @Environment(Store.self) private var store
  var call: CallController
  @AppStorage(CallPrefs.speedKey, store: WispPreferences.standard) private var speed = 1.0
  @AppStorage(CallPrefs.languageKey, store: WispPreferences.standard) private var language = ""
  @AppStorage(CallPrefs.activityKey, store: WispPreferences.standard) private var showActivity = true

  private var live: Agent { store.agent(call.agent.id) ?? call.agent }
  private var state: CallState { call.state }
  private var facts: CallFacts { CallFacts(state: state, offline: live.status == .offline, connected: store.connected, showActivity: showActivity) }

  var body: some View {
    let facts = facts
    NavigationStack {
      ZStack {
        Palette.ground.ignoresSafeArea()
        VStack(spacing: 0) {
          HStack { CallCircle(symbol: "chevron.up", label: "Shrink call into the chat", id: "call-shrink", size: 44) { call.expanded = false }; Spacer() }
            .padding(.horizontal, 18).padding(.top, 8)
          hero(facts)
          if call.settingsOpen { settings.padding(.horizontal, 18).padding(.top, 18).transition(.opacity) }
          content(facts)
          controls(facts)
        }
      }
      .toolbar(.hidden, for: .navigationBar)
    }
    .animation(.snappy, value: call.settingsOpen)
    .animation(.snappy, value: facts.phase == .connecting)
    .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
    .interactiveDismissDisabled()
  }

  // MARK: parts

  private func hero(_ facts: CallFacts) -> some View {
    let connecting = facts.phase == .connecting && !facts.offline
    return VStack(spacing: 6) {
      if connecting { Spacer(minLength: 0) }
      CallGhost(agent: live, state: state, facts: facts, size: connecting ? 150 : 96, ring: connecting ? 170 : 120)
      Text(live.name).font(.system(size: 22, weight: .semibold)).foregroundStyle(Palette.text).padding(.top, 6)
      if facts.offline {
        Text("\(live.name) is asleep. Wake their computer to talk.").font(.system(size: 15)).foregroundStyle(Palette.faint).multilineTextAlignment(.center).padding(.horizontal, 28)
      } else if connecting {
        Text("Calling…").font(.system(size: 15)).foregroundStyle(Palette.faint)
      } else {
        timer.font(.system(size: 15).monospacedDigit()).foregroundStyle(Palette.faint)
        Text(facts.label).font(.system(size: 15))
          .foregroundStyle(facts.micTrouble ? Color.orange : facts.failed ? Palette.red : facts.phase == .listening || facts.phase == .hearing ? Palette.green : Palette.muted)
          .padding(.top, 6).accessibilityAddTraits(.updatesFrequently)
        if !facts.activity.isEmpty {
          HStack(spacing: 8) {
            Image(systemName: "doc.text").font(.system(size: 15))
            Text(facts.activity).lineLimit(1)
          }
          .font(.system(size: 15)).foregroundStyle(Palette.muted)
          .padding(.horizontal, 14).frame(height: 36).background(Capsule().fill(Palette.card))
          .padding(.top, 8).padding(.horizontal, 24)
        }
      }
      if connecting { Spacer(minLength: 0) }
    }
    .frame(maxHeight: connecting ? .infinity : nil)
    .padding(.top, connecting ? 0 : 14)
  }

  private var timer: some View {
    Group {
      if let started = state.startedAt {
        TimelineView(.periodic(from: .now, by: 1)) { context in
          let seconds = max(0, Int(context.date.timeIntervalSince(started)))
          Text(CallFacts.clock(seconds)).accessibilityLabel("Call duration \(seconds) seconds")
        }
      }
    }
  }

  @ViewBuilder private func content(_ facts: CallFacts) -> some View {
    if facts.offline || facts.phase == .connecting && !facts.failed && !facts.micTrouble {
      Spacer(minLength: 0)
    } else if facts.micTrouble {
      problemCard {
        HStack(spacing: 12) {
          Image(systemName: "mic.slash").font(.system(size: 18)).foregroundStyle(Color.orange)
            .frame(width: 40, height: 40).background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.orange.opacity(0.15)))
          Text("A little help with the microphone?").font(.system(size: 16, weight: .semibold)).foregroundStyle(Palette.text)
        }
        Text("Wisp needs your microphone to hear you. Turn it on in Settings, then come back. \(live.name) will still answer in chat.").font(.system(size: 15)).foregroundStyle(Palette.muted)
        if let url = URL(string: UIApplication.openSettingsURLString) {
          pill("Open Settings", primary: true, id: "call-open-settings") { UIApplication.shared.open(url) }
        }
        pill("Keep chatting by text", id: "call-keep-text") { call.expanded = false }
      }
    } else if facts.failed {
      problemCard {
        if !state.error.isEmpty { Text(state.error).font(.system(size: 13)).foregroundStyle(Palette.red) }
        Text("Check that your Wisp is reachable and that the voice you picked has its key. The conversation is still here in chat.").font(.system(size: 15)).foregroundStyle(Palette.muted)
        if store.connected { pill("Try again", primary: true, id: "call-retry") { call.retry(store: store) } }
        NavigationLink { VoiceSettingsView() } label: {
          HStack(spacing: 8) { Text("Voice settings"); Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.faint) }
            .font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text).frame(maxWidth: .infinity).frame(height: 52).glassPill()
        }.buttonStyle(.plain).accessibilityIdentifier("call-voice-settings")
      }
    } else if facts.paused {
      VStack(spacing: 16) {
        pill("Resume", primary: true, id: "call-resume") { call.retry(store: store) }.frame(width: 200)
        Text("The call is on hold. \(live.name) keeps working and its full reply will be waiting in chat.").font(.system(size: 13)).foregroundStyle(Palette.faint).multilineTextAlignment(.center)
      }.padding(.horizontal, 38).padding(.top, 28)
      Spacer(minLength: 0)
    } else {
      transcript
    }
  }

  private var transcript: some View {
    ScrollView {
      VStack(spacing: 22) {
        if !state.userCaption.isEmpty {
          Text(state.userCaption).font(.system(size: 15)).foregroundStyle(Palette.faint).multilineTextAlignment(.trailing)
            .frame(maxWidth: .infinity, alignment: .trailing).padding(.leading, 60)
        }
        if !state.agentCaption.isEmpty {
          Text(state.agentCaption).font(.system(size: 19)).lineSpacing(3).foregroundStyle(Palette.text)
            .frame(maxWidth: .infinity, alignment: .leading).padding(.trailing, 20)
        }
        if !state.error.isEmpty { Text(state.error).font(.system(size: 13)).foregroundStyle(Palette.red).frame(maxWidth: .infinity, alignment: .leading) }
        if state.longWork { Text("Feel free to hang up. Watch for the done glow or a notification.").font(.system(size: 13)).foregroundStyle(Palette.faint).frame(maxWidth: .infinity) }
      }
      .padding(.horizontal, 28).padding(.vertical, 16)
      .frame(maxWidth: .infinity)
    }
    .defaultScrollAnchor(.bottom)
    .accessibilityElement(children: .contain)
  }

  private func problemCard<C: View>(@ViewBuilder _ content: () -> C) -> some View {
    VStack(alignment: .leading, spacing: 12, content: content)
      .padding(20).frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).fill(Palette.card))
      .padding(.horizontal, 18).padding(.top, 18)
      .frame(maxHeight: .infinity, alignment: .top)
  }

  private func pill(_ title: String, primary: Bool = false, id: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Text(title).font(.system(size: 15, weight: .semibold))
        .foregroundStyle(primary ? Palette.ground : Palette.text)
        .frame(maxWidth: .infinity).frame(height: 52)
        .background { if primary { Capsule().fill(Palette.text) } }
        .glassPillIf(!primary)
    }.buttonStyle(.plain).accessibilityIdentifier(id)
  }

  private var settings: some View {
    VStack(alignment: .leading, spacing: 8) {
      CardGroup {
        Menu {
          Picker("Voice", selection: Binding(get: { call.voice[call.speakEngine] ?? "" }, set: { call.chooseVoice($0, store: store) })) {
            ForEach(call.voiceChoices()) { Text($0.label).tag($0.id) }
          }
        } label: { RowLabel(title: "Voice", value: call.voiceName, chevron: false) }
          .accessibilityIdentifier("call-voice")
        Menu {
          Picker("Speed", selection: $speed) { ForEach(CallPrefs.speeds, id: \.self) { Text(CallPrefs.speedLabel($0)).tag($0) } }
        } label: { RowLabel(title: "Speed", value: CallPrefs.speedLabel(speed), chevron: false) }
          .accessibilityIdentifier("call-speed")
        Menu {
          Picker("Language", selection: $language) { ForEach(CallPrefs.languages, id: \.tag) { Text($0.name).tag($0.tag) } }
        } label: { RowLabel(title: "Language", value: CallPrefs.languages.first { $0.tag == language }?.name ?? "Auto", chevron: false) }
          .accessibilityIdentifier("call-language")
        Button { showActivity.toggle() } label: { RowLabel(title: "Show what it's doing", value: showActivity ? "On" : "Off", chevron: false) }
          .buttonStyle(.plain).accessibilityIdentifier("call-activity")
      }
      if !call.engine.isEmpty { CardCaption("\(call.engine). Full replies stay in chat. Language is used when listening on this phone.") }
    }
  }

  private func controls(_ facts: CallFacts) -> some View {
    HStack(spacing: 14) {
      CallCircle(symbol: state.muted ? "mic.slash" : "mic", label: state.muted ? "Unmute microphone" : "Mute microphone", id: "call-mute", filled: state.muted,
                 disabled: facts.offline || call.session == nil || (!state.ready && !state.muted)) { Task { await call.session?.mute(!state.muted) } }
      CallCircle(symbol: "gearshape", label: "Call settings", id: "call-settings", filled: call.settingsOpen) { call.settingsOpen.toggle() }
      Spacer()
      Button { call.hangUp(store: store) } label: {
        Image(systemName: "xmark").font(.system(size: 22, weight: .semibold)).foregroundStyle(.white)
          .frame(width: 56, height: 56).background(Circle().fill(CallScreen.endRed))
      }.buttonStyle(.plain).accessibilityLabel("End call").accessibilityIdentifier("call-end")
    }
    .padding(.horizontal, 28).padding(.bottom, 18).padding(.top, 8)
  }
}

private extension View {
  @ViewBuilder func glassPillIf(_ on: Bool) -> some View { if on { glassPill() } else { self } }
}

// MARK: the bar in the chat

/** The call shrunk into a bar at the top of the chat: the ghost's phase, time and state, what it is doing, and the controls. */
struct CallBar: View {
  @Environment(Store.self) private var store
  var call: CallController
  @AppStorage(CallPrefs.activityKey, store: WispPreferences.standard) private var showActivity = true

  private var live: Agent { store.agent(call.agent.id) ?? call.agent }
  private var state: CallState { call.state }
  private var facts: CallFacts { CallFacts(state: state, offline: live.status == .offline, connected: store.connected, showActivity: showActivity) }

  var body: some View {
    let facts = facts
    VStack(spacing: 6) {
      HStack(spacing: 10) {
        CallGhost(agent: live, state: state, facts: facts, size: 30, ring: 46)
        VStack(alignment: .leading, spacing: 2) {
          title(facts).font(.system(size: 15, weight: .semibold).monospacedDigit()).foregroundStyle(Palette.text).lineLimit(2).fixedSize(horizontal: false, vertical: true)
          if !facts.activity.isEmpty { Text(facts.activity).font(.system(size: 13)).foregroundStyle(Palette.muted).lineLimit(2).fixedSize(horizontal: false, vertical: true) }
        }
        Spacer(minLength: 0)
        barButton("gearshape", "Call settings", "call-bar-settings") { call.settingsOpen = true; call.expanded = true }
        barButton(state.muted ? "mic.slash" : "mic", state.muted ? "Unmute microphone" : "Mute microphone", "call-bar-mute", disabled: facts.offline || call.session == nil || (!state.ready && !state.muted)) { Task { await call.session?.mute(!state.muted) } }
        Button { call.hangUp(store: store) } label: {
          Image(systemName: "xmark").font(.system(size: 17, weight: .semibold)).foregroundStyle(.white)
            .frame(width: 44, height: 44).background(Circle().fill(CallScreen.endRed))
        }.buttonStyle(.press).accessibilityLabel("End call").accessibilityIdentifier("call-bar-end")
      }
      .contentShape(Rectangle())
      .onTapGesture { call.expanded = true }
      Capsule().fill(Palette.faint.opacity(0.6)).frame(width: 44, height: 5).padding(.vertical, 4)
        .accessibilityLabel("Expand the call").accessibilityAddTraits(.isButton).accessibilityIdentifier("call-expand")
        .onTapGesture { call.expanded = true }
    }
    .padding(.leading, 16).padding(.trailing, 12).padding(.top, 12).padding(.bottom, 6)
    .background(RoundedRectangle(cornerRadius: Corner.sheet, style: .continuous).fill(Palette.control))
    .overlay(RoundedRectangle(cornerRadius: Corner.sheet, style: .continuous).strokeBorder(Palette.hairline))
    .gesture(DragGesture(minimumDistance: 12).onEnded { if $0.translation.height > 20 { call.expanded = true } })
    .padding(.horizontal, 18).padding(.bottom, 6)
    .accessibilityElement(children: .contain).accessibilityIdentifier("call-bar")
  }

  /** "0:26 · Working", with the clock ticking */
  private func title(_ facts: CallFacts) -> some View {
    Group {
      if let started = state.startedAt, !facts.offline {
        TimelineView(.periodic(from: .now, by: 1)) { context in
          Text("\(CallFacts.clock(max(0, Int(context.date.timeIntervalSince(started))))) · \(facts.label)")
        }
      } else { Text(facts.label) }
    }
  }

  private func barButton(_ symbol: String, _ label: String, _ id: String, disabled: Bool = false, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: symbol).font(.system(size: 17)).foregroundStyle(Palette.text)
        .frame(width: 44, height: 44).background(Circle().fill(Color(light: 0xE8E8EE, dark: 0x38383E)))
    }.buttonStyle(.press).disabled(disabled).opacity(disabled ? 0.4 : 1)
      .accessibilityLabel(label).accessibilityIdentifier(id)
  }
}
