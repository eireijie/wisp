import XCTest
@testable import Wisp

@MainActor
private final class FakeListener: CallListener {
  var starts = 0, stops = 0
  var failure: Error?
  func start() async throws { starts += 1; if let failure { throw failure } }
  func stop() { stops += 1 }
}

@MainActor
private final class FakeSpeaker: CallSpeaker {
  var said: [String] = []
  var cancels = 0
  var finish: CheckedContinuation<Void, Never>?
  /** hold the speech open until `end()`, like real playback */
  var hold = true
  func speak(_ text: String, level: @escaping @MainActor (Double) -> Void) async throws {
    said.append(text)
    if hold { await withCheckedContinuation { finish = $0 } }
  }
  func cancel() { cancels += 1; end() }
  func end() { let f = finish; finish = nil; f?.resume() }
}

@MainActor
final class VoiceCallTests: XCTestCase {
  private var listener = FakeListener()
  private var speaker = FakeSpeaker()
  private var callbacks: ListenCallbacks!
  private var sent: [String] = []
  private var sendError: Error?
  private var list: [Message] = []
  private var session: VoiceCallSession!

  private func msg(_ id: String, kind: String = "agent", author: String = "a1", body: String = "hi", parts: String = "[]", at: Int = 0) -> Message {
    let json = #"{"id":"\#(id)","channelId":"c1","threadId":null,"author":{"kind":"\#(kind)","id":"\#(author)"},"body":"\#(body)","parts":\#(parts),"createdAt":"2026-10-24T10:00:\#(String(format: "%02d", at))Z"}"#
    return try! Wire.decoder.decode(Message.self, from: Data(json.utf8))
  }

  private func makeSession(cloud: Bool = false, filler: Duration = .seconds(30)) async -> VoiceCallSession {
    let s = VoiceCallSession(agentId: "a1", channelId: "c1", cloudListening: cloud,
      listener: { [self] cb in callbacks = cb; return listener }, speaker: speaker,
      send: { [self] text in if let sendError { throw sendError }; sent.append(text) },
      messages: { [self] in list }, timing: CallTiming(filler: filler, longWork: .seconds(60), micHint: .seconds(60)))
    session = s
    await s.start()
    return s
  }

  private func settle() async { for _ in 0..<5 { await Task.yield() } }

  func testStartMakesTheCallReadyAndStartsTheClock() async {
    let s = await makeSession()
    XCTAssertTrue(s.state.ready)
    XCTAssertNotNil(s.state.startedAt)
    XCTAssertEqual(listener.starts, 1)
  }

  func testListenerFailureAsksForTheMicrophone() async {
    listener.failure = CallAudioError.microphoneDenied
    let s = await makeSession()
    XCTAssertFalse(s.state.ready)
    XCTAssertTrue(s.state.needsMic)
    XCTAssertFalse(s.state.error.isEmpty)
  }

  func testWhatIsSaidIsSentAndTheReplyIsSpoken() async {
    let s = await makeSession()
    callbacks.final("  what's the weather  ")
    await settle()
    XCTAssertEqual(sent, ["what's the weather"])
    XCTAssertTrue(s.state.waiting)
    XCTAssertEqual(s.state.userCaption, "what's the weather")
    list = [msg("m1", kind: "user", author: "u1", body: "what's the weather", at: 1), msg("m2", body: "It's sunny. Bring a hat.\\n\\nMore detail follows in a long paragraph.", at: 2)]
    s.sync()
    await settle()
    XCTAssertFalse(s.state.waiting)
    XCTAssertEqual(speaker.said, ["It's sunny. Bring a hat."])
    XCTAssertTrue(s.state.speaking)
    speaker.end(); await settle()
    XCTAssertFalse(s.state.speaking)
  }

  func testFirstSentenceIsSpokenWhileWorkingAndOnlyTheRestAfter() async {
    let s = await makeSession()
    callbacks.final("what is in main"); await settle()
    XCTAssertEqual(s.state.phase, .thinking)
    s.event(CallRunEvent(runId: "r1", agentId: "a1", channelId: "c1", threadId: nil, type: "tool_call", text: nil, tool: "Read", file: "/a/b/main.ts"))
    XCTAssertEqual(s.state.phase, .working)
    XCTAssertEqual(s.state.activity, "Reading main.ts")
    s.event(CallRunEvent(runId: "r1", agentId: "a1", channelId: "c1", threadId: nil, type: "text", text: "It exports one function. And", tool: nil, file: nil))
    await settle()
    XCTAssertEqual(speaker.said, ["It exports one function."])
    XCTAssertEqual(s.state.phase, .speaking)
    speaker.end(); await settle()
    list = [msg("m2", body: "It exports one function. And it is small.\\n\\nMore.", at: 2)]
    s.sync(); await settle()
    XCTAssertEqual(speaker.said, ["It exports one function.", "And it is small."])
  }

  func testTheFinishedReplyWaitsForTheFirstSentenceStillPlaying() async {
    let s = await makeSession()
    callbacks.final("what is in main"); await settle()
    s.event(CallRunEvent(runId: "r1", agentId: "a1", channelId: "c1", threadId: nil, type: "text", text: "It exports one function. And", tool: nil, file: nil))
    await settle()
    let cancels = speaker.cancels
    list = [msg("m2", body: "It exports one function. And it is small.\\n\\nMore.", at: 2)]
    s.sync(); await settle()
    XCTAssertEqual(speaker.said, ["It exports one function."])
    XCTAssertEqual(speaker.cancels, cancels)
    speaker.end(); await settle()
    XCTAssertEqual(speaker.said, ["It exports one function.", "And it is small."])
  }

  func testAnotherTeamsStreamingDoesNotEnterTheCall() async {
    let s = await makeSession()
    callbacks.final("what is in main"); await settle()
    s.event(CallRunEvent(runId: "r9", agentId: "a1", channelId: "other", threadId: nil, type: "tool_call", text: nil, tool: "Read", file: "/a/x.ts"))
    s.event(CallRunEvent(runId: "r9", agentId: "a1", channelId: "other", threadId: nil, type: "text", text: "Elsewhere. More", tool: nil, file: nil))
    await settle()
    XCTAssertEqual(s.state.activity, "")
    XCTAssertTrue(speaker.said.isEmpty)
  }

  func testRepliesAreOnlySpokenOnce() async {
    let s = await makeSession()
    callbacks.final("hello"); await settle()
    list = [msg("m2", body: "Hi there.", at: 2)]
    s.sync(); await settle()
    s.sync(); await settle()
    XCTAssertEqual(speaker.said, ["Hi there."])
  }

  func testTalkingOverTheAgentStopsItSpeaking() async {
    let s = await makeSession()
    callbacks.final("hello"); await settle()
    list = [msg("m2", body: "Hi there. How are you?", at: 2)]
    s.sync(); await settle()
    XCTAssertTrue(s.state.speaking)
    callbacks.partial("wait"); await settle()
    XCTAssertFalse(s.state.speaking)
    XCTAssertGreaterThan(speaker.cancels, 0)
    XCTAssertTrue(s.state.talking)
  }

  func testTheAgentsOwnVoiceHeardBackIsIgnored() async {
    let s = await makeSession()
    callbacks.final("hello"); await settle()
    list = [msg("m2", body: "Hi there. How are you today?", at: 2)]
    s.sync(); await settle()
    callbacks.partial("how are you today"); callbacks.final("how are you today"); await settle()
    XCTAssertEqual(sent, ["hello"])
    XCTAssertTrue(s.state.speaking)
  }

  func testMutingStopsTheMicrophoneAndUnmutingStartsItAgain() async {
    let s = await makeSession()
    await s.mute(true)
    XCTAssertTrue(s.state.muted)
    XCTAssertEqual(listener.stops, 1)
    callbacks.final("ignored while muted"); await settle()
    XCTAssertTrue(sent.isEmpty)
    await s.mute(false)
    XCTAssertFalse(s.state.muted)
    XCTAssertTrue(s.state.ready)
    XCTAssertEqual(listener.starts, 2)
  }

  func testAFailedSendShowsTheErrorAndStopsWaiting() async {
    sendError = API.Failure(status: 500, message: "boom")
    let s = await makeSession()
    callbacks.final("hello"); await settle()
    XCTAssertFalse(s.state.waiting)
    XCTAssertTrue(s.state.error.contains("boom"))
  }

  func testAFailedRunIsShownNotSpoken() async {
    let s = await makeSession()
    callbacks.final("do it"); await settle()
    list = [msg("m2", body: "", parts: #"[{"type":"status","text":"Run failed: out of credit"}]"#, at: 2)]
    s.sync(); await settle()
    XCTAssertEqual(s.state.error, "Run failed: out of credit")
    XCTAssertTrue(speaker.said.isEmpty)
  }

  func testNotWakingNoticeEndsTheWait() async {
    let s = await makeSession()
    callbacks.final("hello"); await settle()
    list = [msg("m2", kind: "agent", author: "system", body: "", parts: #"[{"type":"status","text":"Not waking Atlas: asleep"}]"#, at: 2)]
    s.sync(); await settle()
    XCTAssertFalse(s.state.waiting)
    XCTAssertTrue(s.state.error.hasPrefix("Not waking"))
  }

  func testAReplyThatArrivedWhileAwayIsSpokenOnResume() async {
    let s = await makeSession()
    callbacks.final("hello"); await settle()
    s.disconnect()
    XCTAssertFalse(s.state.ready)
    XCTAssertFalse(s.state.error.isEmpty)
    list = [msg("m1", kind: "user", author: "u1", body: "hello", at: 1), msg("m2", body: "Sorry for the wait.", at: 2)]
    await s.start()
    await settle()
    XCTAssertEqual(speaker.said, ["Sorry for the wait."])
  }

  func testAnInterruptionPausesWithoutAnErrorAndResumes() async {
    let s = await makeSession()
    s.pauseForInterruption()
    XCTAssertFalse(s.state.ready)
    XCTAssertTrue(s.state.error.isEmpty)
    await s.start()
    XCTAssertTrue(s.state.ready)
  }

  func testStopSilencesEverything() async {
    let s = await makeSession()
    s.stop()
    XCTAssertGreaterThan(listener.stops, 0)
    callbacks.final("late"); await settle()
    XCTAssertTrue(sent.isEmpty)
  }

  func testOnItFillerSpeaksWhenTheAgentIsSlow() async {
    let s = await makeSession(filler: .milliseconds(30))
    callbacks.final("hello"); await settle()
    try? await Task.sleep(for: .milliseconds(150))
    XCTAssertEqual(speaker.said, ["On it…"])
    XCTAssertTrue(s.state.waiting)
  }

  // MARK: text

  func testSpokenReplyDropsCodeLinksAndMarkdown() {
    XCTAssertEqual(VoiceText.spokenReply("**Done.** See [the docs](https://x.y) now.\n\n```\ncode\n```\n\nMore."), "Done. See now.")
    XCTAssertEqual(VoiceText.spokenReply("# Title\n\nFirst. Second. Third."), "Title")
    XCTAssertEqual(VoiceText.spokenReply("```js\nlet a\n```"), "")
    XCTAssertEqual(VoiceText.spokenReply("- one two\n- three"), "one two three")
  }

  func testSpokenReplyIsShort() {
    let long = String(repeating: "word ", count: 200)
    let spoken = VoiceText.spokenReply(long)
    XCTAssertLessThanOrEqual(spoken.count, 481)
    XCTAssertTrue(spoken.hasSuffix("…"))
  }

  func testEchoDetection() {
    XCTAssertTrue(VoiceText.isSpeechEcho(heard: "How are you?", spoken: "Hi there. How are you today?"))
    XCTAssertFalse(VoiceText.isSpeechEcho(heard: "stop talking", spoken: "Hi there. How are you today?"))
    XCTAssertFalse(VoiceText.isSpeechEcho(heard: "", spoken: "Hi"))
  }

  func testVoiceIndexMatchesTheWeb() {
    // voiceIndex("atlas", 10) in the web's text.ts: hash = 31-multiply over UTF-16 units, unsigned 32-bit
    XCTAssertEqual(VoiceText.voiceIndex("atlas", 10), 3)
    XCTAssertEqual(VoiceText.voiceIndex("anything", 0), 0)
  }

  func testWavHeader() {
    let wav = WavRecorder.wav(Data(count: 100))
    XCTAssertEqual(wav.count, 144)
    XCTAssertEqual(String(decoding: wav.prefix(4), as: UTF8.self), "RIFF")
    XCTAssertEqual(String(decoding: wav[8..<12], as: UTF8.self), "WAVE")
  }

  // MARK: how the call looks

  private func facts(_ state: CallState, offline: Bool = false, connected: Bool = true, showActivity: Bool = true) -> CallFacts {
    CallFacts(state: state, offline: offline, connected: connected, showActivity: showActivity)
  }

  func testPhasesGetTheirOwnWords() {
    XCTAssertEqual(CallFacts.phaseLabel(.connecting, paused: false), "Calling…")
    XCTAssertEqual(CallFacts.phaseLabel(.hearing, paused: false), "Listening")
    XCTAssertEqual(CallFacts.phaseLabel(.working, paused: false), "Working")
    XCTAssertEqual(CallFacts.phaseLabel(.listening, paused: true), "Paused")
    XCTAssertEqual(CallFacts.clock(26), "0:26")
    XCTAssertEqual(CallFacts.clock(605), "10:05")
  }

  func testActivityLineShowsOnlyWhileWorkingAndWhenWanted() {
    var state = CallState(); state.ready = true; state.startedAt = Date(); state.waiting = true; state.activity = "Reading main.ts"
    XCTAssertEqual(facts(state).activity, "Reading main.ts")
    XCTAssertEqual(facts(state, showActivity: false).activity, "")
    state.activity = ""
    XCTAssertEqual(facts(state).phase, .thinking)
    XCTAssertEqual(facts(state).activity, "")
  }

  func testLostMicrophonePausedAndFailedCallsLookDifferent() {
    var live = CallState(); live.ready = true; live.startedAt = Date()
    var mic = live; mic.ready = false; mic.needsMic = true
    XCTAssertTrue(facts(mic).micTrouble)
    XCTAssertEqual(facts(mic).label, "Can't hear you yet")
    var paused = live; paused.ready = false
    XCTAssertTrue(facts(paused).paused)
    XCTAssertEqual(facts(paused).label, "Paused")
    var failed = CallState(); failed.error = "No key"
    XCTAssertTrue(facts(failed).failed)
    XCTAssertTrue(facts(live, connected: false).failed)
    XCTAssertEqual(facts(live, connected: false).label, "Reconnecting…")
    XCTAssertEqual(facts(CallState()).label, "Calling…")
    XCTAssertTrue(facts(live, offline: true).offline)
    XCTAssertFalse(facts(live, offline: true).failed)
  }

  func testCallPrefsFallBackToSensibleDefaults() {
    let defaults = WispPreferences.standard
    for key in [CallPrefs.speedKey, CallPrefs.languageKey, CallPrefs.activityKey] { defaults.removeObject(forKey: key) }
    XCTAssertEqual(CallPrefs.speed, 1)
    XCTAssertEqual(CallPrefs.language, "")
    XCTAssertTrue(CallPrefs.showActivity)
    defaults.set(7.0, forKey: CallPrefs.speedKey)
    XCTAssertEqual(CallPrefs.speed, 1, "a speed the panel doesn't offer is ignored")
    defaults.set(1.5, forKey: CallPrefs.speedKey)
    XCTAssertEqual(CallPrefs.speed, 1.5)
    XCTAssertEqual(CallPrefs.speedLabel(1.25), "1.25x")
    XCTAssertEqual(CallPrefs.speedLabel(1), "1x")
    defaults.removeObject(forKey: CallPrefs.speedKey)
  }
}
