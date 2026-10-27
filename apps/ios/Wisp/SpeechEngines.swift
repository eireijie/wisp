import AVFoundation
import Foundation
import Speech

// The audio side of a voice call: the microphone, listening (on this device or OpenAI through the hub)
// and speaking (on this device, or OpenAI / ElevenLabs through the hub). Same engines as the web's voice/providers.ts.

enum CallAudioError: LocalizedError {
  case microphoneDenied, speechDenied, speechUnavailable, noMicrophone
  var errorDescription: String? {
    switch self {
    case .microphoneDenied: "Microphone access is off. Allow the microphone for Wisp in Settings, then call again."
    case .speechDenied: "Speech recognition is off. Allow it for Wisp in Settings, or choose OpenAI for listening in Voice settings."
    case .speechUnavailable: "Speech recognition isn't available right now. Try again, or choose OpenAI for listening in Voice settings."
    case .noMicrophone: "We couldn't find a microphone to use. Check that no other app is using it."
    }
  }
}

enum CallAudio {
  /** Talking and listening at once, through the loudspeaker unless headphones are in. */
  static func activate() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
    try session.setActive(true)
  }

  static func deactivate() {
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  static func requestMicrophone() async -> Bool { await AVAudioApplication.requestRecordPermission() }

  static func requestSpeech() async -> Bool {
    await withCheckedContinuation { continuation in
      SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
    }
  }
}

// MARK: microphone

/** Watches input loudness and says when someone starts and stops talking (about 100 ms in, 550 ms of quiet out). */
final class VoiceActivityDetector: @unchecked Sendable {
  private let level: @Sendable (Double) -> Void
  private let activity: @Sendable (Bool) -> Void
  private var lastVoice = 0.0, since = 0.0, lastLevel = 0.0
  private var talking = false

  init(level: @escaping @Sendable (Double) -> Void, activity: @escaping @Sendable (Bool) -> Void) {
    self.level = level; self.activity = activity
  }

  static func rms(_ buffer: AVAudioPCMBuffer) -> Float {
    guard let data = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
    var sum: Float = 0
    for i in 0..<Int(buffer.frameLength) { sum += data[i] * data[i] }
    return (sum / Float(buffer.frameLength)).squareRoot()
  }

  func process(_ buffer: AVAudioPCMBuffer, now: Double = ProcessInfo.processInfo.systemUptime) {
    let rms = Double(Self.rms(buffer))
    if now - lastLevel > 0.05 { lastLevel = now; level(min(1, rms * 7)) }
    if rms > 0.018 {
      lastVoice = now
      if since == 0 { since = now }
      if !talking && now - since > 0.1 { talking = true; activity(true) }
    } else { since = 0 }
    if talking && now - lastVoice > 0.55 { talking = false; activity(false) }
  }

  func reset() { talking = false; since = 0 }
}

/** One AVAudioEngine tap on the microphone. Its callbacks run on the audio thread. */
final class MicCapture: @unchecked Sendable {
  private let engine = AVAudioEngine()
  private var tapped = false

  func start(onBuffer: @escaping @Sendable (AVAudioPCMBuffer) -> Void, level: @escaping @Sendable (Double) -> Void,
             activity: @escaping @Sendable (Bool) -> Void) throws {
    stop()
    // touching inputNode with no audio input (mic in use, route change, no hardware) aborts the app; say so instead
    let session = AVAudioSession.sharedInstance()
    guard session.isInputAvailable, !session.currentRoute.inputs.isEmpty || !(session.availableInputs ?? []).isEmpty else { throw CallAudioError.noMicrophone }
    // echo cancellation, so the agent's own voice isn't heard as the person; not every device offers it
    var voiceProcessing = (try? engine.inputNode.setVoiceProcessingEnabled(true)) != nil
    do { try begin(onBuffer, level, activity) }
    catch {
      guard voiceProcessing else { throw error }
      stop()
      try? engine.inputNode.setVoiceProcessingEnabled(false)
      voiceProcessing = false
      try begin(onBuffer, level, activity)
    }
  }

  private func begin(_ onBuffer: @escaping @Sendable (AVAudioPCMBuffer) -> Void, _ level: @escaping @Sendable (Double) -> Void,
                     _ activity: @escaping @Sendable (Bool) -> Void) throws {
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else { throw CallAudioError.noMicrophone }
    let detector = VoiceActivityDetector(level: level, activity: activity)
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
      onBuffer(buffer)
      detector.process(buffer)
    }
    tapped = true
    engine.prepare()
    try engine.start()
  }

  func stop() {
    if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
    if engine.isRunning { engine.stop() }
  }
}

// MARK: listening on this device

/** Hands microphone buffers to whichever recognition request is current. */
final class RecognitionSink: @unchecked Sendable {
  private let lock = NSLock()
  private var request: SFSpeechAudioBufferRecognitionRequest?
  func set(_ next: SFSpeechAudioBufferRecognitionRequest?) {
    lock.lock(); defer { lock.unlock() }
    request?.endAudio()
    request = next
  }
  func append(_ buffer: AVAudioPCMBuffer) {
    lock.lock(); defer { lock.unlock() }
    request?.append(buffer)
  }
}

/** Apple's speech recognition (on the device where the language supports it), restarted after each sentence. */
@MainActor
final class DeviceListener: CallListener {
  private let callbacks: ListenCallbacks
  private let mic = MicCapture()
  private let sink = RecognitionSink()
  private var recognizer: SFSpeechRecognizer?
  private var task: SFSpeechRecognitionTask?
  private var currentRequest: ObjectIdentifier?
  private var active = false
  private var talking = false
  private var text = ""
  private var timer: Task<Void, Never>?
  private var restartTask: Task<Void, Never>?
  private var failures = 0

  init(callbacks: ListenCallbacks) { self.callbacks = callbacks }

  func start() async throws {
    if active { return }
    guard await CallAudio.requestMicrophone() else { throw CallAudioError.microphoneDenied }
    guard await CallAudio.requestSpeech() else { throw CallAudioError.speechDenied }
    let recognizer = SFSpeechRecognizer(locale: CallPrefs.listenLocale) ?? SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    guard let recognizer, recognizer.isAvailable else { throw CallAudioError.speechUnavailable }
    self.recognizer = recognizer
    try CallAudio.activate()
    active = true; failures = 0; talking = false
    let callbacks = callbacks
    do {
      try mic.start(onBuffer: { [sink] in sink.append($0) },
        level: { level in Task { @MainActor in callbacks.level(level) } },
        activity: { [weak self] value in Task { @MainActor in self?.voice(value) } })
    } catch { active = false; throw error }
    boot()
  }

  private func voice(_ value: Bool) {
    guard active else { return }
    talking = value
    callbacks.activity(value)
  }

  private func boot() {
    guard active, let recognizer else { return }
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.taskHint = .dictation
    if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
    let id = ObjectIdentifier(request)
    currentRequest = id
    text = ""
    sink.set(request)
    task = recognizer.recognitionTask(with: request) { [weak self] result, error in
      let transcript = result?.bestTranscription.formattedString
      let isFinal = result?.isFinal ?? false
      let failed = error != nil
      Task { @MainActor in self?.recognized(id, transcript, isFinal, failed) }
    }
  }

  private func recognized(_ id: ObjectIdentifier, _ transcript: String?, _ isFinal: Bool, _ failed: Bool) {
    guard active, id == currentRequest else { return }
    if let transcript {
      failures = 0
      text = transcript
      callbacks.partial(transcript)
      if isFinal { commit(); return }
      timer?.cancel()
      if !transcript.isEmpty { timer = Task { [weak self] in await self?.settle() } }
    } else if failed {
      failures += 1
      if failures >= 4 { fail(CallAudioError.speechUnavailable.localizedDescription); return }
      commit(after: .milliseconds(300))
    }
  }

  /** 450 ms with nothing new means the sentence is done (and not while the mic still hears speech). */
  private func settle() async {
    try? await Task.sleep(for: .milliseconds(450))
    while active, talking, !Task.isCancelled { try? await Task.sleep(for: .milliseconds(100)) }
    guard active, !Task.isCancelled else { return }
    commit()
  }

  /** Send what was said, then listen afresh so old results can't replay a turn. */
  private func commit(after delay: Duration = .milliseconds(0)) {
    timer?.cancel()
    let final = text.trimmingCharacters(in: .whitespacesAndNewlines)
    text = ""
    sink.set(nil)
    task?.cancel(); task = nil; currentRequest = nil
    if !final.isEmpty { callbacks.final(final) }
    restartTask?.cancel()
    restartTask = Task { [weak self] in
      try? await Task.sleep(for: delay + .milliseconds(100))
      guard !Task.isCancelled else { return }
      self?.boot()
    }
  }

  private func fail(_ message: String) {
    stop()
    callbacks.error(message)
  }

  func stop() {
    let wasActive = active
    active = false; talking = false
    timer?.cancel(); restartTask?.cancel()
    sink.set(nil)
    task?.cancel(); task = nil; currentRequest = nil
    mic.stop()
    if wasActive { callbacks.level(0); callbacks.activity(false) }
  }
}

// MARK: listening through the hub (OpenAI)

/** Collects what the microphone hears as 16 kHz mono 16-bit audio, keeping a little before speech starts. */
final class WavRecorder: @unchecked Sendable {
  static let rate = 16_000.0
  private let lock = NSLock()
  private var pcm = Data()
  private var capturing = false
  private var converter: AVAudioConverter?
  private let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: true)!
  /** half a second of lead-in so the first syllable isn't cut off */
  private let lead = Int(rate * 0.6) * 2

  func append(_ buffer: AVAudioPCMBuffer) {
    if converter == nil || converter?.inputFormat != buffer.format { converter = AVAudioConverter(from: buffer.format, to: target) }
    guard let converter else { return }
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * Self.rate / buffer.format.sampleRate) + 64
    guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
    var supplied = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if supplied { status.pointee = .noDataNow; return nil }
      supplied = true; status.pointee = .haveData; return buffer
    }
    guard error == nil, out.frameLength > 0, let samples = out.int16ChannelData?[0] else { return }
    let bytes = Data(bytes: samples, count: Int(out.frameLength) * 2)
    lock.lock(); defer { lock.unlock() }
    pcm.append(bytes)
    if !capturing && pcm.count > lead { pcm = pcm.suffix(lead) }
  }

  func setCapturing(_ value: Bool) { lock.lock(); capturing = value; lock.unlock() }

  /** What was heard since speech began, as a WAV file; empty when there was only a moment of it. */
  func take() -> Data? {
    lock.lock(); defer { lock.unlock() }
    let data = pcm
    pcm = Data(); capturing = false
    return data.count > Int(Self.rate * 0.3) * 2 ? Self.wav(data) : nil
  }

  func clear() { lock.lock(); pcm = Data(); capturing = false; converter = nil; lock.unlock() }

  static func wav(_ pcm: Data) -> Data {
    func le<T: FixedWidthInteger>(_ v: T) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
    var out = Data("RIFF".utf8)
    out += le(UInt32(36 + pcm.count)) + Data("WAVEfmt ".utf8) + le(UInt32(16)) + le(UInt16(1)) + le(UInt16(1))
    out += le(UInt32(rate)) + le(UInt32(rate) * 2) + le(UInt16(2)) + le(UInt16(16))
    out += Data("data".utf8) + le(UInt32(pcm.count)) + pcm
    return out
  }
}

/** The hub's voice endpoint (`POST /api/voice/audio`): OpenAI listening and OpenAI / ElevenLabs speaking. */
struct VoiceHub: Sendable {
  var api: @MainActor @Sendable () throws -> API

  private struct Listen: Encodable { var kind = "listen"; var mime = "audio/wav"; var audio: String }
  private struct Speak: Encodable { var kind = "speak"; var provider: String; var text: String; var voice: String }
  private struct Heard: Decodable { var text: String }

  func listen(wav: Data) async throws -> String {
    let connection = try await api()
    let (data, _) = try await connection.withTimeout(60).request("POST", "/api/voice/audio", body: Listen(audio: wav.base64EncodedString()))
    return try Wire.decoder.decode(Heard.self, from: data).text.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  func speak(provider: String, text: String, voice: String) async throws -> Data {
    let connection = try await api()
    return try await connection.withTimeout(60).request("POST", "/api/voice/audio", body: Speak(provider: provider, text: text, voice: voice)).0
  }
}

@MainActor
final class CloudListener: CallListener {
  private let callbacks: ListenCallbacks
  private let hub: VoiceHub
  private let mic = MicCapture()
  private let recorder = WavRecorder()
  private var active = false
  private var generation = 0
  private var chain: Task<Void, Never>?
  private var maxTurn: Task<Void, Never>?

  init(callbacks: ListenCallbacks, hub: VoiceHub) { self.callbacks = callbacks; self.hub = hub }

  func start() async throws {
    if active { return }
    guard await CallAudio.requestMicrophone() else { throw CallAudioError.microphoneDenied }
    try CallAudio.activate()
    active = true; generation += 1
    recorder.clear()
    let callbacks = callbacks, recorder = recorder
    do {
      try mic.start(onBuffer: { recorder.append($0) },
        level: { level in Task { @MainActor in callbacks.level(level) } },
        activity: { [weak self] value in
          recorder.setCapturing(value) // on the audio thread, so the lead-in is kept from the first moment
          Task { @MainActor in self?.voice(value) }
        })
    } catch { active = false; throw error }
  }

  private func voice(_ value: Bool) {
    guard active else { return }
    callbacks.activity(value)
    maxTurn?.cancel()
    if value {
      // a very long turn is cut at a minute
      maxTurn = Task { [weak self] in
        try? await Task.sleep(for: .seconds(60))
        guard !Task.isCancelled else { return }
        self?.finishSegment()
      }
    } else { finishSegment() }
  }

  private func finishSegment() {
    guard active, let wav = recorder.take() else { return }
    let mine = generation
    let previous = chain
    chain = Task { [weak self] in
      await previous?.value
      await self?.transcribe(wav, generation: mine)
    }
  }

  private func transcribe(_ wav: Data, generation mine: Int) async {
    guard active, mine == generation else { return }
    callbacks.partial("Transcribing…")
    do {
      let text = try await hub.listen(wav: wav)
      guard active, mine == generation else { return }
      callbacks.partial("")
      if !text.isEmpty { callbacks.final(text) }
    } catch {
      guard active, mine == generation else { return }
      stop()
      callbacks.error(error.localizedDescription)
    }
  }

  func stop() {
    let wasActive = active
    active = false; generation += 1
    maxTurn?.cancel(); chain?.cancel(); chain = nil
    mic.stop(); recorder.clear()
    if wasActive { callbacks.level(0); callbacks.activity(false) }
  }
}

// MARK: speaking

/** The agent's own device voice (`voice.device` on the agent), else one picked from its handle so it keeps the same one. */
enum DeviceVoices {
  static func pick(preferred: String?, seed: String) -> AVSpeechSynthesisVoice? {
    if let preferred, let voice = AVSpeechSynthesisVoice(identifier: preferred) { return voice }
    // com.apple.speech.synthesis.voice.* are the novelty voices (Bells, Zarvox…)
    let all = AVSpeechSynthesisVoice.speechVoices().filter { !$0.identifier.contains("speech.synthesis.voice") }.sorted { $0.identifier < $1.identifier }
    let language = Locale.current.language.languageCode?.identifier ?? "en"
    let local = all.filter { $0.language.hasPrefix(language) }
    let candidates = local.isEmpty ? all : local
    return candidates.isEmpty ? nil : candidates[VoiceText.voiceIndex(seed, candidates.count)]
  }
}

@MainActor
final class DeviceSpeaker: NSObject, CallSpeaker, AVSpeechSynthesizerDelegate {
  private let synthesizer = AVSpeechSynthesizer()
  var preferred: String?
  private let seed: String
  private var finish: (() -> Void)?
  private var levelTask: Task<Void, Never>?
  private var level: (@MainActor (Double) -> Void)?

  init(preferred: String?, seed: String) { self.preferred = preferred; self.seed = seed }

  func speak(_ text: String, level: @escaping @MainActor (Double) -> Void) async throws {
    cancel()
    let utterance = AVSpeechUtterance(string: text)
    utterance.voice = DeviceVoices.pick(preferred: preferred, seed: seed)
    utterance.rate = min(AVSpeechUtteranceMaximumSpeechRate, AVSpeechUtteranceDefaultSpeechRate * Float(CallPrefs.speed))
    synthesizer.delegate = self
    self.level = level
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      var done = false
      finish = { if !done { done = true; continuation.resume() } }
      // the system gives word boundaries, not audio levels, so the mouth follows a gentle estimate
      levelTask = Task { @MainActor in
        var t = 0.0
        while !Task.isCancelled { t += 1; level(0.2 + 0.55 * abs(sin(t * 1.7))); try? await Task.sleep(for: .milliseconds(90)) }
      }
      synthesizer.speak(utterance)
    }
    levelTask?.cancel(); level(0)
  }

  func cancel() {
    levelTask?.cancel()
    synthesizer.stopSpeaking(at: .immediate)
    let done = finish; finish = nil
    done?()
  }

  nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, willSpeakRangeOfSpeechString r: NSRange, utterance: AVSpeechUtterance) {
    Task { @MainActor in self.level?(0.85) }
  }
  nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    Task { @MainActor in let done = self.finish; self.finish = nil; done?() }
  }
  nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    Task { @MainActor in let done = self.finish; self.finish = nil; done?() }
  }
}

/** OpenAI / ElevenLabs speech from the hub: it sends an MP3, which plays here, a sentence at a time
 * so the first plays while the next is still being made. */
@MainActor
final class CloudSpeaker: NSObject, CallSpeaker, AVAudioPlayerDelegate {
  private let provider: String
  var voice: String
  private let hub: VoiceHub
  private var token = 0
  private var player: AVAudioPlayer?
  private var finish: (() -> Void)?
  private var meter: Task<Void, Never>?

  init(provider: String, voice: String, hub: VoiceHub) { self.provider = provider; self.voice = voice; self.hub = hub }

  /** Audio fetched or on its way, shared by every speaker; a cancelled reply can leave its audio for the next. */
  private static var cache: [String: Task<Data, Error>] = [:]
  private static var cacheOrder: [String] = []
  private func audio(_ text: String) -> Task<Data, Error> {
    let key = "\(provider)|\(voice)|\(text)"
    if let cached = Self.cache[key] { return cached }
    let hub = hub, provider = provider, voice = voice
    let fetch = Task { try await hub.speak(provider: provider, text: text, voice: voice) }
    Self.cache[key] = fetch; Self.cacheOrder.append(key)
    if Self.cacheOrder.count > 12 { Self.cache.removeValue(forKey: Self.cacheOrder.removeFirst()) }
    Task { if (try? await fetch.value) == nil, Self.cache[key] == fetch { Self.cache.removeValue(forKey: key) } }
    return fetch
  }

  func prepare(_ text: String) {
    // the first two pieces are enough to start; later ones are fetched while those play
    for chunk in VoiceText.speechChunks(text).prefix(2) { _ = audio(chunk) }
  }

  func speak(_ text: String, level: @escaping @MainActor (Double) -> Void) async throws {
    cancel()
    let mine = token
    let chunks = VoiceText.speechChunks(text)
    var next = audio(chunks[0])
    for i in chunks.indices {
      let current = next
      // fetch the next sentence while this one plays, so there's no gap between them
      if i + 1 < chunks.count { next = audio(chunks[i + 1]) }
      let data = try await current.value
      guard mine == token else { return }
      try await play(data, level: level)
      guard mine == token else { return }
    }
  }

  private func play(_ data: Data, level: @escaping @MainActor (Double) -> Void) async throws {
    let player = try AVAudioPlayer(data: data)
    player.isMeteringEnabled = true
    player.enableRate = true
    player.rate = Float(CallPrefs.speed)
    player.delegate = self
    self.player = player
    player.prepareToPlay()
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      var done = false
      finish = { if !done { done = true; continuation.resume() } }
      meter = Task { @MainActor in
        while !Task.isCancelled {
          player.updateMeters()
          level(max(0, min(1, Double(player.averagePower(forChannel: 0) + 50) / 50)))
          try? await Task.sleep(for: .milliseconds(50))
        }
      }
      if !player.play() { finish?(); finish = nil }
    }
    meter?.cancel(); level(0)
    if self.player === player { self.player = nil }
  }

  func cancel() {
    token += 1
    meter?.cancel()
    player?.stop(); player = nil
    let done = finish; finish = nil
    done?()
  }

  nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    Task { @MainActor in let done = self.finish; self.finish = nil; done?() }
  }
}

// MARK: choosing the engines

@MainActor enum CallEngines {
  static func listener(engine: String, callbacks: ListenCallbacks, hub: VoiceHub) -> CallListener {
    engine == "openai" ? CloudListener(callbacks: callbacks, hub: hub) : DeviceListener(callbacks: callbacks)
  }

  static func speaker(engine: String, voice: AgentVoice?, seed: String, hub: VoiceHub) -> CallSpeaker {
    switch engine {
    case "openai":
      return CloudSpeaker(provider: "openai", voice: voice?.openai ?? VoiceText.openaiVoices[VoiceText.voiceIndex(seed, VoiceText.openaiVoices.count)], hub: hub)
    case "elevenlabs":
      return CloudSpeaker(provider: "elevenlabs", voice: voice?.elevenlabs ?? VoiceText.elevenVoices[VoiceText.voiceIndex(seed, VoiceText.elevenVoices.count)], hub: hub)
    default:
      return DeviceSpeaker(preferred: voice?.device, seed: seed)
    }
  }

  static func engineLabel(_ prefs: VoicePreferences) -> String {
    let speaking = prefs.speak == "device" ? "On this device" : prefs.speak == "openai" ? "OpenAI voice" : "ElevenLabs voice"
    return prefs.listen == "openai" ? "OpenAI listening · \(speaking)" : speaking
  }
}
