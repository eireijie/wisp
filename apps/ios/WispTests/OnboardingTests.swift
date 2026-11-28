import SwiftUI
import XCTest
@testable import Wisp

/** The phone's first run follows the web's rules (apps/web/test/agent-picker.test.ts): the same kinds, apps, rows and wording. */
@MainActor
final class OnboardingTests: XCTestCase {
  private let apps = OnboardingCatalog.startApps
  private func defaults() -> UserDefaults {
    let name = "onboarding-tests-\(UUID().uuidString)"
    let d = UserDefaults(suiteName: name)!
    d.removePersistentDomain(forName: name)
    return d
  }

  // MARK: pick your agent

  func testUsesTheOwnersNamesInOrder() {
    XCTAssertEqual(OnboardingCatalog.agentTypes.map(\.name), ["Daily assistant", "Work assistant", "Coding assistant", "Business manager", "Research assistant", "Something else"])
    XCTAssertEqual(OnboardingCatalog.agentTypes.map(\.sub).first, "Texts, calendar, reminders, email.")
  }

  func testMergesThePickedKindsAppsOnceEachInOrder() {
    XCTAssertEqual(OnboardingCatalog.apps(for: ["work", "biz"], other: "", onMac: true).map(\.id), ["gmail", "gcal", "gdrive", "slack", "notion", "linear", "jira", "stripe"])
    // the order is the catalogue's, whichever was tapped first
    XCTAssertEqual(OnboardingCatalog.apps(for: ["biz", "work"], other: "", onMac: true).map(\.id), ["gmail", "gcal", "gdrive", "slack", "notion", "linear", "jira", "stripe"])
  }

  func testAppleAppsOnlyWhenWispLivesOnAMac() {
    XCTAssertEqual(Array(OnboardingCatalog.apps(for: ["daily"], other: "", onMac: true).map(\.id).prefix(4)), ["messages", "calendar", "reminders", "contacts"])
    XCTAssertFalse(OnboardingCatalog.apps(for: ["daily"], other: "", onMac: false).contains { $0.how == .mac })
    XCTAssertTrue(OnboardingCatalog.missesMac(["daily"], onMac: false))
    XCTAssertFalse(OnboardingCatalog.missesMac(["daily"], onMac: true))
    XCTAssertFalse(OnboardingCatalog.missesMac(["code"], onMac: false))
  }

  func testNeverFakesAnApp() {
    // every catalog app is a real connector in the app's copy of the catalog, Google and Vercel included
    for a in apps.values where a.how == .key { XCTAssertNotNil(OnboardingCatalog.connector(a.catalogId), "\(a.id) is missing from ConnectorCatalog.json") }
    for id in ["gmail", "gcal", "gdrive", "vercel"] { XCTAssertEqual(apps[id]?.how, .key); XCTAssertEqual(apps[id]?.catalogId, id) }
    // the kinds only name apps that exist
    for t in OnboardingCatalog.agentTypes { for a in t.apps { XCTAssertNotNil(apps[a], "\(t.id) names \(a)") } }
    for a in OnboardingCatalog.otherApps { XCTAssertNotNil(apps[a]) }
  }

  func testTheBundledCatalogSaysHowEachAppSignsIn() {
    XCTAssertEqual(OnboardingCatalog.connector("gmail")?.signIn, CatalogSignIn(via: "app", provider: "google", localOnly: nil))
    XCTAssertEqual(OnboardingCatalog.connector("notion")?.signIn?.via, "mcp")
    XCTAssertEqual(OnboardingCatalog.connector("vercel")?.signIn?.localOnly, true)
    XCTAssertNil(OnboardingCatalog.connector("jira")?.signIn)
    // Gmail and Google Calendar only sign in: there is no key to paste
    XCTAssertEqual(OnboardingCatalog.connector("gmail")?.fields?.isEmpty, true)
  }

  func testEachRowSignsInTakesAKeyOrSaysSoon() throws {
    let a = apps
    // still asking the hub: apps that might sign in wait; key-only apps don't
    XCTAssertEqual([AppRows.mode(a["gmail"]!, options: nil), AppRows.mode(a["slack"]!, options: nil), AppRows.mode(a["jira"]!, options: nil), AppRows.mode(a["messages"]!, options: nil)], [.loading, .loading, .key, .mac])
    let here = try JSONDecoder().decode([String: SignInOption].self, from: Data(##"""
    {"gmail":{"signIn":false,"key":false,"reason":"Signing in with Google isn't set up for Bubble AI yet."},
     "slack":{"signIn":false,"key":true,"reason":"Signing in with Slack isn't set up for Bubble AI yet."},
     "notion":{"signIn":true,"key":true},
     "vercel":{"signIn":false,"key":true,"reason":"Vercel only signs in when Bubble AI is open on this computer."}}
    """##.utf8))
    XCTAssertEqual(AppRows.mode(a["gmail"]!, options: here), .soon)
    XCTAssertEqual(AppRows.mode(a["slack"]!, options: here), .key)
    XCTAssertEqual(AppRows.mode(a["notion"]!, options: here), .signIn)
    XCTAssertEqual(AppRows.mode(a["vercel"]!, options: here), .key)
    XCTAssertEqual(here["gmail"]?.reason, "Signing in with Google isn't set up for Bubble AI yet.")
    // the hub couldn't be asked: keys still work, sign-in apps without one say Soon
    XCTAssertEqual([AppRows.mode(a["github"]!, options: [:]), AppRows.mode(a["gcal"]!, options: [:])], [.key, .soon])
  }

  func testOneGoogleSignInCoversTheOtherGoogleRows() {
    let list = OnboardingCatalog.apps(for: ["work"], other: "", onMac: true)
    var modes = Dictionary(uniqueKeysWithValues: list.map { ($0.id, AppRowMode.signIn) })
    XCTAssertEqual(AppRows.signInGroup(apps["gmail"]!, apps: list, modes: modes) { _ in false }.map(\.id), ["gmail", "gcal", "gdrive"])
    XCTAssertEqual(AppRows.signInGroup(apps["gmail"]!, apps: list, modes: modes) { $0 == "gcal" }.map(\.id), ["gmail", "gdrive"])
    // a server's own sign-in (Notion) and other companies stay on their own
    XCTAssertEqual(AppRows.signInGroup(apps["notion"]!, apps: list, modes: modes) { _ in false }.map(\.id), ["notion"])
    XCTAssertEqual(AppRows.signInGroup(apps["slack"]!, apps: list, modes: modes) { _ in false }.map(\.id), ["slack"])
    modes["gdrive"] = .soon
    XCTAssertEqual(AppRows.signInGroup(apps["gmail"]!, apps: list, modes: modes) { _ in false }.map(\.id), ["gmail", "gcal"])
  }

  func testSomethingElseSuggestsAppsOnlyOnceThereAreWords() {
    XCTAssertEqual(OnboardingCatalog.apps(for: ["other"], other: "", onMac: true), [])
    XCTAssertEqual(OnboardingCatalog.apps(for: ["other"], other: "plan my garden", onMac: true).map(\.id), ["notion", "brave"])
    XCTAssertEqual(OnboardingCatalog.pickedNames(["other", "daily"], other: " plan my garden "), ["Daily assistant", "plan my garden"])
  }

  func testWhatIDoComesFromTheFirstPickOrTheirWords() {
    XCTAssertEqual(OnboardingCatalog.typeRole(["daily", "code"], other: ""), "Keep my days on track.")
    XCTAssertEqual(OnboardingCatalog.typeRole(["other"], other: "plan my garden"), "Plan my garden.")
    XCTAssertNil(OnboardingCatalog.typeRole([], other: ""))
    var answers = OnboardingAnswers()
    XCTAssertEqual(OnboardingText.role(for: answers), "Helps with whatever you need, so you have more time.")
    answers.agentTypes = ["biz"]
    XCTAssertEqual(OnboardingText.role(for: answers), "Keep the business side in order.")
  }

  func testTheSheetsButtonCountsWhatIsConnected() {
    XCTAssertEqual(OnboardingCatalog.sheetCta(0), "Connect one to continue")
    XCTAssertEqual(OnboardingCatalog.sheetCta(1), "Continue with 1 app")
    XCTAssertEqual(OnboardingCatalog.sheetCta(3), "Continue with 3 apps")
  }

  func testAKeyRowSaysWhatIsMissing() throws {
    let github = try XCTUnwrap(OnboardingCatalog.connector("github"))
    XCTAssertEqual(AppRows.missing(github, values: [:]), "Add the personal access token.")
    XCTAssertNil(AppRows.missing(github, values: ["GITHUB_TOKEN": "x"]))
  }

  // MARK: make me yours

  func testTheAgentItMakes() {
    XCTAssertEqual(OnboardingText.names(for: "Juno Park"), ["Atlas", "Pip", "Nova"])
    XCTAssertEqual(OnboardingText.names(for: "Sam"), ["Juno", "Atlas", "Pip"])
    XCTAssertEqual(OnboardingText.preview(person: "Sam Lee", agent: "Juno"), "Hi Sam, I'm Juno. I'll start by learning how you like things done.")
    XCTAssertEqual(OnboardingText.preview(person: "", agent: "Juno"), "Hi, I'm Juno. I'll start by learning how you like things done.")
    XCTAssertEqual(OnboardingText.instructions(agent: "Juno", person: "Sam Lee", role: "Keep my days on track."),
                   "You are Juno, Sam's agent in Bubble AI. Your job: Keep my days on track. What you know about them is in your notes; use it without asking again. Ask before connecting an account, spending money or sending anything as them.")
    XCTAssertEqual(OnboardingText.handle("  Juno the 2nd! "), "juno-the-2nd")
    XCTAssertEqual(OnboardingText.freeHandle("Juno", taken: ["juno", "juno-2"]), "juno-3")
    XCTAssertEqual(OnboardingText.freeHandle("42", taken: []), "agent")
    XCTAssertEqual(OnboardingText.colors.count, OnboardingText.colorNames.count)
    XCTAssertEqual(OnboardingText.shapes, GhostLook.shapes)
    XCTAssertEqual(OnboardingLook.agent(color: "#3cc0a6", shape: "tall").resolved.shape, "tall")
  }

  func testAMorningPlanOnlyWhenThereIsSomethingToBuildItFrom() {
    XCTAssertNil(OnboardingText.morningPlan(person: "Sam", role: "Helps with whatever you need, so you have more time."))
    XCTAssertNil(OnboardingText.morningPlan(person: "Sam", role: " "))
    let plan = OnboardingText.morningPlan(person: "Sam Lee", role: "Keep my days on track.")
    XCTAssertEqual(plan?.name, "Morning plan")
    XCTAssertEqual(plan?.schedule, "0 8 * * *")
    XCTAssertEqual(plan?.steps.contains("message Sam in your chat"), true)
    XCTAssertEqual(plan?.steps.contains("What they want help with: Keep my days on track."), true)
    XCTAssertEqual(OnboardingText.morningPlan(person: "", role: "Helps with your inbox and research, so you have more time.")?.steps.contains("What they want help with: your inbox and research."), true)
  }

  func testAnswersAreKeptPerWorkspaceAndSurviveOlderShapes() throws {
    let d = defaults()
    XCTAssertEqual(OnboardingAnswers.load("w1", from: d), OnboardingAnswers())
    OnboardingAnswers.save("w1", in: d) { $0.agentTypes = ["daily"]; $0.typeDone = true; $0.appNames = ["GitHub", "Slack", "Notion"]; $0.appleApps = ["messages"] }
    let saved = OnboardingAnswers.load("w1", from: d)
    XCTAssertEqual(saved.agentTypes, ["daily"]); XCTAssertTrue(saved.typeDone); XCTAssertFalse(saved.closed)
    XCTAssertEqual(saved.appsLine, "Messages, GitHub and more")
    XCTAssertNil(OnboardingAnswers().appsLine)
    XCTAssertEqual(OnboardingAnswers.load("w2", from: d), OnboardingAnswers())
    // a save from before a field existed still loads
    let old = try JSONDecoder().decode(OnboardingAnswers.self, from: Data(#"{"agentTypes":["code"],"future":1}"#.utf8))
    XCTAssertEqual(old.agentTypes, ["code"]); XCTAssertEqual(old.apps, [])
  }

  // MARK: what it thinks with

  func testPicksTheHarnessAConnectionRunsOn() throws {
    let providers = try Wire.decoder.decode([ModelProviderInfo].self, from: Data(##"""
    [{"id":"anthropic","label":"Claude","site":"https://claude.ai","keyUrl":"https://console.anthropic.com","signIn":[{"harness":"claude-code"}]},
     {"id":"openrouter","label":"OpenRouter","site":"https://openrouter.ai","keyUrl":"https://openrouter.ai/keys"}]
    """##.utf8))
    let support = [CredentialSupport(harness: "hermes", provider: "openrouter", kind: "key"), CredentialSupport(harness: "opencode", provider: "openrouter", kind: "key"), CredentialSupport(harness: "codex", provider: "anthropic", kind: "key")]
    XCTAssertEqual(OnboardingAI.harness(for: "anthropic", kind: "oauth", providers: providers, support: support), "claude-code")
    XCTAssertEqual(OnboardingAI.harness(for: "anthropic", kind: "key", providers: providers, support: support), "codex")
    XCTAssertEqual(OnboardingAI.harness(for: "openrouter", kind: "key", providers: providers, support: support), "hermes")
    XCTAssertEqual(OnboardingAI.harness(for: "xai", kind: "key", providers: providers, support: []), "hermes")
  }

  func testTheAIPageOneButton() {
    XCTAssertEqual(OnboardingAI.next(nil, signedIn: false, installed: false, hasDevice: true), .none)
    XCTAssertEqual(OnboardingAI.next("claude-code", signedIn: true, installed: true, hasDevice: true), .use)
    // Claude Code missing on the computer is offered as Install, not a dead end
    XCTAssertEqual(OnboardingAI.next("claude-code", signedIn: false, installed: false, hasDevice: true), .install)
    XCTAssertEqual(OnboardingAI.next("claude-code", signedIn: false, installed: true, hasDevice: true), .signIn)
    XCTAssertEqual(OnboardingAI.next("hermes", signedIn: false, installed: false, hasDevice: true), .model)
    XCTAssertEqual(OnboardingAI.next("gemini", signedIn: false, installed: false, hasDevice: false), .signIn)
    XCTAssertEqual(OnboardingAI.featured.map(\.harness), ["claude-code", "codex", "hermes"])
    XCTAssertFalse(OnboardingAI.more.contains { $0.protocolName == "mcp" || $0.id == "codex" })
  }

  func testEachRowSaysItsOwnSignIn() throws {
    let mac = try Wire.decoder.decode(AgentNode.self, from: Data(##"{"id":"n1","name":"Studio","online":true,"mine":true,"harnesses":[{"id":"codex","accounts":{"default":true}},{"id":"gemini","accounts":{"default":true}}]}"##.utf8))
    XCTAssertNil(OnboardingAI.found(on: mac, connections: [], support: [], only: "claude-code"))
    XCTAssertEqual(OnboardingAI.found(on: mac, connections: [], support: [], only: "gemini")?.harness, "gemini")
  }

  // MARK: Make it yours and Connect (BubbleSetup.tsx)

  func testTheMessageItWouldSend() {
    XCTAssertEqual(SetupGoals.sample(["days"], talk: .short, when: .morning, about: "", person: "Sam Lee"), "Morning, Sam! The dentist is at 10, so I moved the gym to 6.")
    XCTAssertEqual(SetupGoals.sample(["days"], talk: .short, when: .needed, about: "", person: "Sam Lee"), "Hey Sam, the dentist is at 10, so I moved the gym to 6.")
    XCTAssertEqual(SetupGoals.sample([], talk: .friendly, when: .evening, about: "", person: ""), "Evening. Tell me what's on your mind and I'll take it from there.")
    let s = SetupGoals.sample(["days", "people"], talk: .thorough, when: .morning, about: "I work weekends.", person: "Sam")
    XCTAssertTrue(s.contains("Also, it's your mom's birthday Saturday. Want me to find a gift?"))
    XCTAssertTrue(s.hasSuffix("say go and I'll handle it. (I'll keep in mind: I work weekends.)"))
  }

  func testPicksGoToTheAgentAndShapeItsInstructions() {
    XCTAssertEqual(SetupGoals.picksMessage(["days"], about: "  student,  I love hiking. "), "I'd like help with: keeping my days on track. About me: student, I love hiking.")
    XCTAssertEqual(SetupGoals.picksMessage([], about: ""), "I'm not sure yet what I'd like help with.")
    XCTAssertEqual(SetupGoals.role(["days"]), "Helps with keeping my days on track.")
    XCTAssertEqual(SetupGoals.role([]), OnboardingText.noGoalRole)
    let text = SetupGoals.instructions(agent: "Juno", person: "Sam Lee", goals: ["msgs"], talk: .short, when: .needed, about: "I work nights")
    XCTAssertTrue(text.hasPrefix("You are Juno, Sam's agent in Bubble AI. Your job: help with staying on top of my messages."))
    XCTAssertTrue(text.contains("About Sam, in their words: \"I work nights.\""))
    XCTAssertTrue(text.hasSuffix("Keep messages short: one or two lines. Only message Sam when something matters."))
    XCTAssertEqual(SetupGoals.all.count, 8)
    XCTAssertEqual(SetupPath.simple.features, .simple)
  }

  func testFindsWhatIsAlreadySignedIn() throws {
    func node(_ json: String) throws -> AgentNode { try Wire.decoder.decode(AgentNode.self, from: Data(json.utf8)) }
    let mac = try node(##"{"id":"n1","name":"Studio","online":true,"mine":true,"harnesses":[{"id":"codex","accounts":{"default":true}},{"id":"claude-code","accounts":{"default":false}}]}"##)
    XCTAssertEqual(OnboardingAI.found(on: mac, connections: [], support: []), OnboardingAI.Found(harness: "codex", connectionId: nil, share: true))
    let claude = try node(##"{"id":"n1","name":"Studio","online":true,"mine":true,"harnesses":[{"id":"claude-code","accounts":{"default":true}}]}"##)
    XCTAssertEqual(OnboardingAI.found(on: claude, connections: [], support: []), OnboardingAI.Found(harness: "claude-code"))
    XCTAssertNil(OnboardingAI.found(on: try node(##"{"id":"n2","name":"Empty","online":true}"##), connections: [], support: []))
    // a connection Bubble AI keeps wins over the computer's own sign-in
    let kept = try Wire.decoder.decode(ModelConnection.self, from: Data(##"{"id":"mc1","provider":"anthropic","kind":"oauth","label":"Claude","mine":true,"harnesses":["claude-code"]}"##.utf8))
    XCTAssertEqual(OnboardingAI.found(on: mac, connections: [kept], support: []), OnboardingAI.Found(harness: "claude-code", connectionId: "mc1"))
    // the first agent goes on one of your own computers, connected and not paused
    let other = try node(##"{"id":"n3","name":"Shared","online":true,"mine":false}"##)
    let paused = try node(##"{"id":"n4","name":"Paused","online":true,"mine":true,"paused":true}"##)
    XCTAssertEqual(OnboardingAI.device([other, paused, mac])?.id, "n1")
    XCTAssertNil(OnboardingAI.device([paused]))
  }

  // MARK: first chat

  private func message(_ kind: Actor.Kind, _ id: String, thread: String? = nil) -> Message {
    Message(id: UUID().uuidString, channelId: "c1", threadId: thread, author: Actor(kind: kind, id: id), body: "hi", parts: [], createdAt: "2026-11-22T10:00:00.000Z")
  }

  func testOffersOnePrimaryQuickReply() {
    XCTAssertEqual(FirstChat.quick.first, "Yes, go ahead")
    XCTAssertEqual(FirstChat.quick.count, 2)
  }

  func testWaitsForTheAgentToAnswerBeforeAskingAboutPings() {
    XCTAssertFalse(FirstChat.answeredOnce([message(.agent, "a1")], agentId: "a1"))
    XCTAssertFalse(FirstChat.answeredOnce([message(.agent, "a1"), message(.user, "u1")], agentId: "a1"))
    XCTAssertTrue(FirstChat.answeredOnce([message(.agent, "a1"), message(.user, "u1"), message(.agent, "a1")], agentId: "a1"))
    XCTAssertFalse(FirstChat.answeredOnce([message(.user, "u1"), message(.agent, "a2")], agentId: "a1"))
    // replies inside a thread don't count
    XCTAssertFalse(FirstChat.answeredOnce([message(.user, "u1", thread: "t"), message(.agent, "a1")], agentId: "a1"))
  }

  func testAsksThenShowsWhatTheSystemSaid() {
    XCTAssertEqual(FirstChat.ping(answered: false, asked: false, busy: false, permission: .notAsked), .hidden)
    XCTAssertEqual(FirstChat.ping(answered: true, asked: false, busy: false, permission: .notAsked), .ask)
    XCTAssertEqual(FirstChat.ping(answered: true, asked: false, busy: true, permission: .notAsked), .asking)
    XCTAssertEqual(FirstChat.ping(answered: true, asked: false, busy: false, permission: .denied), .off)
    XCTAssertEqual(FirstChat.ping(answered: true, asked: true, busy: false, permission: .denied), .hidden)
    XCTAssertEqual(FirstChat.ping(answered: true, asked: false, busy: false, permission: .granted), .hidden)
    XCTAssertEqual(FirstChat.ping(answered: true, asked: false, busy: false, permission: .unsupported), .hidden)
  }

  func testAFirstChatIsTheOneItsHelloStarted() throws {
    func agent(_ setup: String) throws -> Agent {
      try Wire.decoder.decode(Agent.self, from: Data(##"{"id":"a1","handle":"juno","name":"Juno","harness":"codex","status":"online","settings":{\##(setup)}}"##.utf8))
    }
    let now = Wire.date("2026-11-22T12:00:00.000Z")!
    let fresh = try agent(##""setup":{"userId":"u1","channelId":"c1","startedAt":"2026-11-22T10:00:00.000Z","greetingId":"m1","replies":[],"steps":{},"done":false}"##)
    XCTAssertEqual(fresh.settings?.setup?.greetingId, "m1")
    XCTAssertTrue(FirstChat.isFirstChat(fresh, channelId: "c1", now: now))
    XCTAssertFalse(FirstChat.isFirstChat(fresh, channelId: "c2", now: now))
    // its hello isn't said yet, or the chat is more than a week old
    XCTAssertFalse(FirstChat.isFirstChat(try agent(##""setup":{"userId":"u1","channelId":"c1","startedAt":"2026-11-22T10:00:00.000Z","done":false}"##), channelId: "c1", now: now))
    XCTAssertFalse(FirstChat.isFirstChat(try agent(##""setup":{"userId":"u1","channelId":"c1","startedAt":"2026-11-01T10:00:00.000Z","greetingId":"m1","done":true}"##), channelId: "c1", now: now))
    XCTAssertFalse(FirstChat.isFirstChat(try agent(##""role":"Helper""##), channelId: "c1", now: now))
  }

  func testUnderlinesWhatItReadWholeWordsOnly() {
    let terms = FirstHello.terms([HelloRead.App(app: "GitHub", terms: ["acme/shop-web", "ab", " Checkout "])])
    XCTAssertEqual(terms.map(\.term), ["acme/shop-web", "checkout"])
    XCTAssertEqual(terms.first?.src, "GitHub, just now")
    let text = "I read acme/shop-web: the Checkout fix is open, not checkouts."
    XCTAssertEqual(FirstHello.ranges(of: terms.map(\.term), in: text).map { String(text[$0]) }, ["acme/shop-web", "Checkout"])
    // the longer phrase wins where two overlap
    let both = "the shop web deploy"
    XCTAssertEqual(FirstHello.ranges(of: ["shop", "shop web"], in: both).map { String(both[$0]) }, ["shop web"])
    XCTAssertEqual(FirstHello.ranges(of: [], in: text).count, 0)
  }

  func testAHelloTypesInOnceWhileItIsNew() {
    let d = defaults()
    let now = Date()
    XCTAssertTrue(FirstHello.shouldType(messageId: "m1", createdAt: now.addingTimeInterval(-60), reduceMotion: false, now: now, defaults: d))
    XCTAssertFalse(FirstHello.shouldType(messageId: "m1", createdAt: now.addingTimeInterval(-60), reduceMotion: true, now: now, defaults: d))
    XCTAssertFalse(FirstHello.shouldType(messageId: "m1", createdAt: now.addingTimeInterval(-11 * 60), reduceMotion: false, now: now, defaults: d))
    d.set(true, forKey: FirstChat.typedKey("m1"))
    XCTAssertFalse(FirstHello.shouldType(messageId: "m1", createdAt: now.addingTimeInterval(-60), reduceMotion: false, now: now, defaults: d))
  }

  // MARK: here's your Bubble AI

  func testWordsOnHeresYourWisp() {
    XCTAssertEqual(OnboardingText.list(["GitHub"]), "GitHub")
    XCTAssertEqual(OnboardingText.list(["Messages", "Calendar", "Slack"]), "Messages, Calendar and Slack")
    XCTAssertEqual(OnboardingText.list([]), "")
    XCTAssertEqual(OnboardingText.cronLine("0 8 * * *"), "Every day at 08:00.")
    XCTAssertEqual(OnboardingText.cronLine("30 17 * * 1-5"), "Weekdays at 17:30.")
    XCTAssertEqual(OnboardingText.cronLine("0 9 * * 1"), "On a schedule.")
    XCTAssertEqual(OnboardingText.cronLine(nil), "When you run it.")
  }

  func testFinishSetupStaysUntilTheListIsDone() {
    let d = defaults()
    XCTAssertEqual(ReadyList.list("w1", agentCount: 1, in: d).map(\.label), ["Get Bubble AI on your phone", "Add your password manager", "Connect your email", "Make a second agent"])
    // on the phone, "Get Bubble AI on your phone" already is
    XCTAssertEqual(ReadyList.list("w1", agentCount: 1, in: d).map(\.done), [true, false, false, false])
    XCTAssertEqual(ReadyList.list("w1", agentCount: 2, in: d).map(\.done), [true, false, false, true])
    // not before the first look at Here's your Bubble AI
    XCTAssertFalse(ReadyList.showsFinishSetup("w1", agentCount: 1, in: d))
    ReadyList.set("w1", "started", true, in: d)
    XCTAssertTrue(ReadyList.showsFinishSetup("w1", agentCount: 1, in: d))
    ReadyList.set("w1", "logins", true, in: d); ReadyList.set("w1", "email", true, in: d)
    XCTAssertTrue(ReadyList.showsFinishSetup("w1", agentCount: 1, in: d))
    XCTAssertFalse(ReadyList.showsFinishSetup("w1", agentCount: 2, in: d))
  }

  // MARK: the host

  func testTheHostThinksBeforeItReacts() async throws {
    let stage = HostStage()
    stage.answer(.nod, reduceMotion: false)
    stage.answer(.hop, reduceMotion: false)
    XCTAssertEqual(stage.beat, 0); XCTAssertTrue(stage.thinking)
    try await Task.sleep(for: HostStage.think + .milliseconds(200))
    // only the last answer plays
    XCTAssertEqual(stage.beat, 1); XCTAssertEqual(stage.kind, .hop); XCTAssertFalse(stage.thinking)
    // Reduce Motion skips the pause
    stage.answer(.grab, reduceMotion: true)
    XCTAssertEqual(stage.beat, 2); XCTAssertEqual(stage.kind, .grab)
  }

  func testEveryMoveStartsAndEndsAtRest() {
    for kind in [HostReaction.hop, .nod, .grab, .celebrate, .doze] {
      XCTAssertEqual(kind.pose(at: 0), HostReaction.Pose()); XCTAssertEqual(kind.pose(at: 1), HostReaction.Pose())
      XCTAssertEqual(kind.frames.map(\.at), kind.frames.map(\.at).sorted())
    }
    XCTAssertEqual(HostReaction.hop.pose(at: 0.35).lift, -0.14, accuracy: 0.0001)
    XCTAssertEqual(HostReaction.nod.pose(at: 0.7).tilt, 4, accuracy: 0.0001)
  }

  // MARK: the hub's calls

  private func reply(_ method: String, _ path: String, _ json: String, status: Int = 200) {
    ManagementHTTPStub.responses.withLock { $0[method + " " + path] = (status, Data(json.utf8)) }
  }
  private func makeStore() -> Store {
    ManagementHTTPStub.responses.withLock { $0 = [:] }; ManagementHTTPStub.requests.withLock { $0 = [] }
    let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [ManagementHTTPStub.self]
    let store = Store(loadSession: false)
    store.api = API(base: URL(string: "https://management.test:8443/")!, token: "test", session: URLSession(configuration: configuration))
    store.role = "owner"; store.me = User(id: "u1", email: "sam@example.test", name: "Sam")
    store.workspace = Workspace(id: "w-\(UUID().uuidString)", name: "Sam's Bubble AI")
    return store
  }
  private func sent(_ method: String, _ path: String) throws -> URLRequest {
    try XCTUnwrap(ManagementHTTPStub.requests.withLock { $0.last { $0.httpMethod == method && $0.url?.path == path } })
  }

  func testSignInGoesThroughTheHubNeverAPassword() async throws {
    let store = makeStore()
    XCTAssertEqual(store.hubOrigin, "https://management.test:8443")
    reply("GET", "/api/connectors/sign-in", ##"{"notion":{"signIn":true,"key":true,"reads":"Reads and edits the pages you pick"},"gmail":{"signIn":false,"key":false,"reason":"Signing in with Google isn't set up for Bubble AI yet."}}"##)
    let options = try await store.signInOptions()
    XCTAssertEqual(options["notion"]?.signIn, true); XCTAssertEqual(options["gmail"]?.key, false)
    XCTAssertEqual(try sent("GET", "/api/connectors/sign-in").url?.query, "origin=https://management.test:8443")

    reply("POST", "/api/connectors/connect", ##"{"url":"https://mcp.notion.com/authorize?state=abc","connectors":[{"id":"cn1","name":"Notion","kind":"mcp-http","catalogId":"notion","auth":{"required":true,"signedIn":false}}]}"##)
    reply("GET", "/api/connectors", ##"[{"id":"cn1","name":"Notion","kind":"mcp-http","catalogId":"notion","auth":{"required":true,"signedIn":false}}]"##)
    let start = try await store.connectApps(["notion"])
    XCTAssertEqual(BrowserPage(start.url)?.url.host, "mcp.notion.com")
    XCTAssertEqual(start.connectors.map(\.id), ["cn1"])
    let request = try sent("POST", "/api/connectors/connect")
    let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
    // only which apps, where to come back to, and who gets them (every agent, like the web): nothing the person typed
    XCTAssertEqual(Set(body.keys), ["catalogIds", "origin", "returnTo", "allAgents"])
    XCTAssertEqual(body["allAgents"] as? Bool, true)
    XCTAssertEqual(body["catalogIds"] as? [String], ["notion"]); XCTAssertEqual(body["returnTo"] as? String, "close"); XCTAssertEqual(body["origin"] as? String, "https://management.test:8443")
    // the browser sheet only opens web pages
    XCTAssertNil(BrowserPage("javascript:alert(1)")); XCTAssertNil(BrowserPage("wisp://pair")); XCTAssertNil(BrowserPage(nil))
  }

  func testAKeyThatCannotBeCheckedCountsAsAddedNotWrong() async throws {
    let store = makeStore()
    reply("POST", "/api/connectors/cn1/check", ##"{"ok":false,"checked":true,"error":"GitHub said that token is wrong."}"##)
    let refused = await store.checkConnector("cn1")
    XCTAssertFalse(refused.ok); XCTAssertEqual(refused.error, "GitHub said that token is wrong.")
    // an older hub has no check: the key is kept, and the row says Added
    let unknown = await store.checkConnector("cn2")
    XCTAssertTrue(unknown.ok); XCTAssertEqual(unknown.checked, false)
  }

  func testTheFirstRunOpensOnlyWhenNobodyHasMadeAnAgent() throws {
    let store = makeStore()
    let id = try XCTUnwrap(store.workspace?.id)
    XCTAssertTrue(store.wantsOnboarding())
    store.role = "guest"
    XCTAssertFalse(store.wantsOnboarding())
    store.role = "member"
    OnboardingAnswers.save(id) { $0.closed = true }
    XCTAssertFalse(store.wantsOnboarding())
    WispPreferences.standard.removeObject(forKey: OnboardingAnswers.key(id))
    store.agents = [try Wire.decoder.decode(Agent.self, from: Data(##"{"id":"a1","handle":"juno","name":"Juno","harness":"codex","status":"online"}"##.utf8))]
    XCTAssertFalse(store.wantsOnboarding())
  }
}
