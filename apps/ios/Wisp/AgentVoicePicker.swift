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

