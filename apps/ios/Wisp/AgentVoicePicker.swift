import SwiftUI
import AVFoundation

/** Plays a sample of a voice: this phone's own voices, or the person's OpenAI / ElevenLabs account. */
@MainActor @Observable
final class VoicePreview: NSObject, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
  private(set) var playing: String?
  var error: String?
  private let synthesizer = AVSpeechSynthesizer()
  private var player: AVAudioPlayer?
  private var generation = 0

  override init() {
    super.init()
    synthesizer.delegate = self
  }

  func stop() {
    generation += 1
    synthesizer.stopSpeaking(at: .immediate)
    player?.stop()
    player = nil
    playing = nil
  }

  /** Plays `text` in voice `id` of `engine`; "" means the agent's automatic voice. Pressing it again stops it. */
  func toggle(id: String, engine: String, agent: Agent, language: String, store: Store) async {
    if playing == id { stop(); return }
    stop()
    let mine = generation
    playing = id
    error = nil
    let text = "Hi, I'm \(agent.name). It's lovely to hear from you!"
    do {
      if engine == "device" {
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = Self.deviceVoice(id: id, seed: agent.handle, language: language)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 1.03
        try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        synthesizer.speak(utterance)
      } else {
        let voice = id.isEmpty
          ? (engine == "openai" ? AgentVoices.openai[AgentVoices.index(agent.handle, count: AgentVoices.openai.count)]
             : AgentVoices.elevenlabs[AgentVoices.index(agent.handle, count: AgentVoices.elevenlabs.count)].id)
          : id
        let data = try await store.speechAudio(provider: engine, voice: voice, text: text)
        guard mine == generation else { return }
        try AVAudioSession.sharedInstance().setCategory(.playback)
        let made = try AVAudioPlayer(data: data)
        made.delegate = self
        player = made
        made.play()
      }
    } catch {
      if mine == generation { self.error = error.localizedDescription; playing = nil }
    }
  }

  /** The chosen voice, or one picked from the agent's handle among the phone's voices in the person's language. */
  static func deviceVoice(id: String, seed: String, language: String) -> AVSpeechSynthesisVoice? {
    if !id.isEmpty, let chosen = AVSpeechSynthesisVoice(identifier: id) { return chosen }
    let all = AVSpeechSynthesisVoice.speechVoices()
    let base = language.split(separator: "-").first.map(String.init) ?? "en"
    let local = all.filter { $0.language.split(separator: "-").first.map(String.init) == base }
    let candidates = local.isEmpty ? all : local
    return candidates.isEmpty ? nil : candidates[AgentVoices.index(seed, count: candidates.count)]
  }

  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    Task { @MainActor in self.playing = nil }
  }
  nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    Task { @MainActor in self.playing = nil }
  }
}

/**
 * How an agent sounds: pick a speech engine, then a voice, and listen to each before choosing.
 * Device voices come from this phone; the OpenAI and ElevenLabs lists are the ones the web offers.
 */
struct AgentVoicePicker: View {
  @Environment(Store.self) private var store
  var agent: Agent
  @Binding var voice: AgentVoice
  @State private var engine = "device"
  @State private var voices: [DeviceVoice] = []
  @State private var preview = VoicePreview()
  @State private var query = ""
  @State private var lang: String?
  @State private var showAll = false

  private let language = Locale.preferredLanguages.first ?? "en"
  private var selected: String { voice[engine] ?? "" }
  private var activeLang: String { lang ?? AgentVoices.defaultLanguage(voices, language: language) }
  private var recommended: [DeviceVoice] { AgentVoices.recommend(voices, language: language) }
  private var languages: [String] { Array(Set(voices.map(\.lang))).sorted { name($0) < name($1) } }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Voice").font(.headline)
      Text("Choose how \(agent.name) sounds. Press the play button to hear a voice before you pick it. Calls use the voice type chosen in Settings.")
        .font(.footnote).foregroundStyle(.secondary)
      Picker("Voice type", selection: $engine) {
        Text("On this phone").tag("device")
        Text("OpenAI").tag("openai")
        Text("ElevenLabs").tag("elevenlabs")
      }
      .pickerStyle(.segmented)
      .disabled(preview.playing != nil)
      if engine != "device" { Text("Uses your own \(engine == "openai" ? "OpenAI" : "ElevenLabs") key from Voice settings.").font(.caption).foregroundStyle(.secondary) }

      list(AgentVoices.choices(engine: engine, agent: agent, selected: selected, recommended: recommended, all: voices, language: name))

      if engine == "device" {
        if voices.isEmpty { Text("This phone hasn't listed any voices yet.").font(.caption).foregroundStyle(.secondary) }
        else {
          DisclosureGroup("All voices", isExpanded: $showAll) {
            VStack(alignment: .leading, spacing: 10) {
              TextField("Search by name", text: $query).textFieldStyle(.roundedBorder).textInputAutocapitalization(.never).autocorrectionDisabled()
              Picker("Language", selection: Binding(get: { activeLang }, set: { lang = $0 })) {
                Text("All languages").tag("")
                ForEach(languages, id: \.self) { Text(name($0)).tag($0) }
              }
              let filtered = AgentVoices.filter(voices, query: query, lang: activeLang)
              if filtered.isEmpty { Text("No voices match. Clear the search or choose another language.").font(.caption).foregroundStyle(.secondary) }
              else { list(filtered.prefix(60).map { VoiceChoice(id: $0.id, label: $0.name, detail: name($0.lang)) }) }
            }.padding(.top, 8)
          }.font(.subheadline)
        }
      }
      if let error = preview.error { Text(error).font(.caption).foregroundStyle(.red) }
    }
    .padding(16)
    .background(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).fill(Color(.secondarySystemBackground)))
    .task {
      loadVoices()
      if let settings = try? await store.voiceSettings() { engine = settings.speak }
    }
    .onChange(of: engine) { preview.stop() }
    .onDisappear { preview.stop() }
  }

  private func list(_ choices: [VoiceChoice]) -> some View {
    VStack(spacing: 0) {
      ForEach(choices) { choice in
        let on = choice.id == selected
        HStack(spacing: 8) {
          Button { voice[engine] = choice.id } label: {
            HStack {
              VStack(alignment: .leading, spacing: 2) {
                Text(choice.label).foregroundStyle(on ? Color.accentColor : .primary).lineLimit(1)
                if let detail = choice.detail { Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
              }
              Spacer(minLength: 0)
              if on { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
            }.contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityAddTraits(on ? .isSelected : [])
          Button {
            Task { await preview.toggle(id: choice.id, engine: engine, agent: agent, language: language, store: store) }
          } label: {
            Image(systemName: preview.playing == choice.id ? "stop.fill" : "play.fill").frame(width: 32, height: 32)
          }
          .buttonStyle(.borderless)
          .accessibilityLabel("\(preview.playing == choice.id ? "Stop" : "Listen to") \(choice.label)")
        }
        .padding(.vertical, 8)
        if choice.id != choices.last?.id { Divider() }
      }
    }
  }

  private func name(_ tag: String) -> String {
    Locale.current.localizedString(forIdentifier: tag.replacingOccurrences(of: "_", with: "-")) ?? tag
  }

  private func loadVoices() {
    let defaultLanguage = AVSpeechSynthesisVoice.currentLanguageCode()
    voices = AVSpeechSynthesisVoice.speechVoices().map {
      DeviceVoice(name: $0.name, lang: $0.language, id: $0.identifier,
                  quality: $0.quality == .premium ? 5 : $0.quality == .enhanced ? 4 : 0,
                  isDefault: $0.language == defaultLanguage)
    }.sorted { $0.id < $1.id }
  }
}
