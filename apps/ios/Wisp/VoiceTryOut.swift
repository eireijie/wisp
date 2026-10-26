import AVFoundation
import SwiftUI

/** Settings → Voice → "Try it out": hear your microphone and your speaker before a call. */
@MainActor @Observable
final class VoiceTryOutModel {
  struct Outcome: Equatable { var ok: Bool; var text: String }
  static let micSeconds = 3

  var micTesting = false
  var micLevel = 0.0
  var micResult: Outcome?
  var speakerTesting = false
  var speakerResult: Outcome?

  private var mic: MicCapture?
  private var peak = 0.0
  private var micRun = 0
  private var speaker: CallSpeaker?
  private var speakerRun = 0

  /** Listen for a few seconds and say plainly whether anything was picked up. */
  func testMicrophone() async {
    micRun += 1
    let run = micRun
    stopMic()
    micResult = nil; micLevel = 0; peak = 0
    micTesting = true
    guard await CallAudio.requestMicrophone() else {
      finishMic(run, Outcome(ok: false, text: "Microphone access is off. Allow it for Wisp in Settings."))
      return
    }
    do {
      try CallAudio.activate()
      let capture = MicCapture()
      mic = capture
      try capture.start(onBuffer: { _ in }, level: { [weak self] level in Task { @MainActor in self?.heard(level, run) } }, activity: { _ in })
    } catch {
      finishMic(run, Outcome(ok: false, text: (error as? CallAudioError)?.errorDescription ?? "We couldn't use the microphone. Check that no other app is using it."))
      return
    }
    try? await Task.sleep(for: .seconds(Self.micSeconds))
    finishMic(run, peak > 0.07 ? Outcome(ok: true, text: "Your microphone works.") : Outcome(ok: false, text: "We couldn't hear anything. Check that nothing covers the microphone."))
  }

  private func heard(_ level: Double, _ run: Int) {
    guard run == micRun, micTesting else { return }
    micLevel = level; peak = max(peak, level)
  }

  private func finishMic(_ run: Int, _ outcome: Outcome) {
    guard run == micRun else { return }
    stopMic()
    micTesting = false; micLevel = 0; micResult = outcome
    CallAudio.deactivate()
  }

  private func stopMic() { mic?.stop(); mic = nil }

  /** Say a short sentence with the speaking voice that is picked. */
  func testSpeaker(engine: String, hub: VoiceHub) async {
    speakerRun += 1
    let run = speakerRun
    speaker?.cancel()
    speakerTesting = true; speakerResult = nil
    defer { if run == speakerRun { speakerTesting = false; CallAudio.deactivate() } }
    do {
      try CallAudio.activate()
      let voice = CallEngines.speaker(engine: engine, voice: nil, seed: "test", hub: hub)
      speaker = voice
      try await voice.speak("Hello! This is how your helpers will sound.", level: { _ in })
      if run == speakerRun { speakerResult = Outcome(ok: true, text: "Did you hear it? If not, check your volume.") }
    } catch {
      if run == speakerRun { speakerResult = Outcome(ok: false, text: error.localizedDescription) }
    }
  }

  func stop() {
    micRun += 1; speakerRun += 1
    stopMic(); speaker?.cancel()
    micTesting = false; speakerTesting = false; micLevel = 0
  }
}

struct VoiceTryOutView: View {
  @Environment(Store.self) private var store
  /** the speaking engine as picked on the screen, even if not saved yet */
  var speak: String
  @State private var model = VoiceTryOutModel()
  @State private var editing: Agent?

  var body: some View {
    SettingsPage("Try it out", id: "voice-try") {
      CardGroup {
        VStack(alignment: .leading, spacing: 10) {
          HStack {
            VStack(alignment: .leading, spacing: 2) {
              Text("Microphone").font(.system(size: 15)).foregroundStyle(Palette.text)
              Text("Say something and watch the level move").font(.system(size: 13)).foregroundStyle(Palette.faint)
            }
            Spacer(minLength: 8)
          }
          if model.micTesting { ProgressView(value: model.micLevel).tint(Palette.green).accessibilityHidden(true) }
          Button(model.micTesting ? "Listening…" : "Test microphone") { Task { await model.testMicrophone() } }
            .buttonStyle(.pill(.secondary)).disabled(model.micTesting).accessibilityIdentifier("voice-test-mic")
          outcome(model.micResult)
        }.padding(.horizontal, 18).padding(.vertical, 14)
        VStack(alignment: .leading, spacing: 10) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Speaker").font(.system(size: 15)).foregroundStyle(Palette.text)
            Text("Plays a short sentence").font(.system(size: 13)).foregroundStyle(Palette.faint)
          }
          Button(model.speakerTesting ? "Playing…" : "Test speaker") { Task { await model.testSpeaker(engine: speak, hub: VoiceHub(api: { try store.connection() })) } }
            .buttonStyle(.pill(.secondary)).disabled(model.speakerTesting).accessibilityIdentifier("voice-test-speaker")
          outcome(model.speakerResult)
        }.padding(.horizontal, 18).padding(.vertical, 14)
      }
      if !store.agents.isEmpty {
        CardLabel("Each agent's voice")
        CardGroup {
          ForEach(store.agents) { agent in
            Button { editing = agent } label: {
              RowLabel(title: agent.name, value: agent.settings?.voice?[speak] ?? "Default") { AgentAvatar(agent: agent, size: 30, showStatus: false) }
            }.buttonStyle(.plain)
          }
        }
        CardHint("Every agent can have its own voice. Tap one to pick it and hear a sample. Save first if you changed the speaking voice.")
      }
    }
    .onDisappear { model.stop(); CallAudio.deactivate() }
    .sheet(item: $editing) { AgentVoiceSheet(agent: $0).environment(store) }
  }

  @ViewBuilder private func outcome(_ result: VoiceTryOutModel.Outcome?) -> some View {
    if let result { Text(result.text).font(.system(size: 13)).foregroundStyle(result.ok ? Palette.green : Palette.red).accessibilityAddTraits(.updatesFrequently) }
  }
}
