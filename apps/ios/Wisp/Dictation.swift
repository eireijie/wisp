import AVFoundation
import Speech

/**
 * Talk instead of type: the composer's mic. It turns what you say into text as you say it (the same
 * on-device speech recognition a voice call uses) and hands the words to the message field.
 */
@MainActor @Observable
final class Dictation {
  private(set) var active = false
  var error: String?
  @ObservationIgnored private let engine = AVAudioEngine()
  @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
  @ObservationIgnored private var task: SFSpeechRecognitionTask?
  /** a start is waiting on permissions or the microphone; another tap must not begin a second one */
  @ObservationIgnored private var starting = false

  func toggle(_ onText: @escaping (String) -> Void) {
    if active { stop(); return }
    guard !starting else { return }
    starting = true
    Task { await start(onText); starting = false }
  }

  private func start(_ onText: @escaping (String) -> Void) async {
    error = nil
    guard await CallAudio.requestMicrophone(), await CallAudio.requestSpeech() else {
      error = "Allow the microphone and speech recognition for Wisp in Settings to dictate."
      return
    }
    guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
      error = "Dictation isn't available right now."
      return
    }
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.record, mode: .measurement, options: .duckOthers)
      try session.setActive(true, options: .notifyOthersOnDeactivation)
      let request = SFSpeechAudioBufferRecognitionRequest()
      request.shouldReportPartialResults = true
      self.request = request
      let input = engine.inputNode
      input.removeTap(onBus: 0)
      input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in request.append(buffer) }
      engine.prepare()
      try engine.start()
      task = recognizer.recognitionTask(with: request) { [weak self] result, failure in
        let text = result?.bestTranscription.formattedString
        let done = failure != nil || result?.isFinal == true
        Task { @MainActor in
          if let text { onText(text) }
          if done { self?.stop() }
        }
      }
      active = true
    } catch {
      stop()
      self.error = "Couldn't start the microphone."
    }
  }

  func stop() {
    guard active || request != nil else { return }
    if engine.isRunning { engine.stop() }
    engine.inputNode.removeTap(onBus: 0)
    request?.endAudio()
    task?.cancel()
    request = nil
    task = nil
    active = false
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}
