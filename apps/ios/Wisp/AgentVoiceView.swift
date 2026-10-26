import SwiftUI
import AVFoundation

/**
 * How an agent sounds (agent-Voice.dc.html): pick On device, OpenAI or ElevenLabs, search and
 * narrow by language, listen to a voice with its play button, and pick it. Device voices come
 * from this phone. More options holds a custom ElevenLabs voice id.
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
  @State private var customOpen = false

  private let language = Locale.preferredLanguages.first ?? "en"
  private var selected: String { voice[engine] ?? "" }
  private var activeLang: String { lang ?? "" }
  private var recommended: [DeviceVoice] { AgentVoices.recommend(voices, language: language) }
  private var languages: [String] {
    let all = Array(Set(voices.map(\.lang))).sorted { name($0) < name($1) }
    let mine = AgentVoices.defaultLanguage(voices, language: language)
    return mine.isEmpty ? all : [mine] + all.filter { $0 != mine }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Segments(options: [("device", "On device"), ("openai", "OpenAI"), ("elevenlabs", "ElevenLabs")], selection: $engine, id: "voice-engine")
        .disabled(preview.playing != nil)
      if engine != "device" { CardCaption("Uses your own \(engine == "openai" ? "OpenAI" : "ElevenLabs") key from Voice settings.") }
      if engine == "device" { search }
      list(choices)
      if engine == "device", voices.isEmpty { CardCaption("This phone hasn't listed any voices yet.") }
      if engine == "device", showingSearch, choices.count == 1 { CardCaption("No voices match. Clear the search or choose another language.") }
      if engine == "elevenlabs" {
        CardGroup {
          Button { customOpen.toggle() } label: {
            RowLabel(title: "More options", subtitle: "Custom ElevenLabs voice id", chevron: false) {
              EmptyView()
            }
            .overlay(alignment: .trailing) {
              Image(systemName: customOpen ? "chevron.up" : "chevron.down").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.faint).padding(.trailing, 18)
            }
          }.buttonStyle(.plain).accessibilityIdentifier("voice-more")
        }
        if customOpen {
          FieldCard(label: "ElevenLabs voice id", text: Binding(get: { voice.elevenlabs ?? "" }, set: { voice.elevenlabs = $0.trimmed.isEmpty ? "" : $0.trimmed }), prompt: "e.g. JBFqnCBsd6RMkjVDRZzb", lowercase: true)
        }
      }
      AgentError(text: preview.error)
    }
    .task {
      loadVoices()
      if let settings = try? await store.voiceSettings() { engine = settings.speak }
    }
    .onChange(of: engine) { preview.stop() }
    .onDisappear { preview.stop() }
  }

  private var showingSearch: Bool { !query.trimmed.isEmpty || !activeLang.isEmpty }

  private var choices: [VoiceChoice] {
    guard engine == "device", showingSearch else {
      return AgentVoices.choices(engine: engine, agent: agent, selected: selected, recommended: recommended, all: voices, language: name)
    }
    let filtered = AgentVoices.filter(voices, query: query, lang: activeLang)
    var result = [VoiceChoice(id: "", label: "Automatic for \(agent.name)", detail: "A voice picked for this helper")]
    result += filtered.prefix(60).map { VoiceChoice(id: $0.id, label: $0.name, detail: name($0.lang)) }
    return result
  }

  private var search: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 10) {
        Image(systemName: "magnifyingglass").foregroundStyle(Palette.faint)
        TextField("Search voices", text: $query).textInputAutocapitalization(.never).autocorrectionDisabled().foregroundStyle(Palette.text)
          .accessibilityIdentifier("voice-search")
      }
      .padding(.horizontal, 16).frame(height: 48)
      .background(Palette.field, in: Capsule())
      if languages.count > 1 {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            AgentChip(title: "All", on: activeLang.isEmpty) { lang = "" }
            ForEach(languages.prefix(12), id: \.self) { code in
              AgentChip(title: name(code), on: activeLang == code) { lang = activeLang == code ? "" : code }
            }
          }
        }
      }
    }
  }

  private func list(_ choices: [VoiceChoice]) -> some View {
    CardGroup {
      ForEach(choices) { choice in
        let on = choice.id == selected
        HStack(spacing: 8) {
          Button { voice[engine] = choice.id } label: {
            HStack(spacing: 12) {
              VStack(alignment: .leading, spacing: 2) {
                Text(choice.label).font(.system(size: 17)).foregroundStyle(Palette.text).lineLimit(1)
                if let detail = choice.detail { Text(detail).font(.system(size: 14)).foregroundStyle(Palette.faint).lineLimit(1) }
              }
              Spacer(minLength: 8)
              Radio(on: on)
            }
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityAddTraits(on ? .isSelected : [])
          Button {
            Task { await preview.toggle(id: choice.id, engine: engine, agent: agent, language: language, store: store) }
          } label: {
            Image(systemName: preview.playing == choice.id ? "stop.fill" : "play.fill").font(.system(size: 14))
              .foregroundStyle(Palette.text).frame(width: 36, height: 36).background(Circle().fill(Palette.control))
          }
          .buttonStyle(.plain)
          .accessibilityLabel("\(preview.playing == choice.id ? "Stop" : "Listen to") \(choice.label)")
        }
        .padding(.horizontal, 18).padding(.vertical, 8).frame(minHeight: 60)
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
