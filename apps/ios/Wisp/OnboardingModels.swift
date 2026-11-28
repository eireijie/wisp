import Foundation

// The first run on the phone, as the web app's (apps/web/src/views/onboarding): pick your agent and
// the apps it starts with, make it yours, choose what it thinks with, then its first chat and
// "Here's your Bubble AI". Everything here is plain data and rules, so the tests can check them against
// the web's (apps/web/test/agent-picker.test.ts).

/** How a starting app is set up: an Apple app read on the Mac Bubble AI runs on, a catalog connector, or nothing yet. */
enum AppHow: Equatable { case mac, key, soon }

/** An app a kind of agent starts with (START_APPS in agentTypes.ts). */
struct StartApp: Identifiable, Equatable {
  var id: String
  var name: String
  /** what it reads, in a few words */
  var what: String
  var how: AppHow
  /** a plain line icon */
  var symbol: String
  /** `key`: the catalog connector it adds */
  var catalogId: String?
  /** `mac`: the Apple app the Apple mod reads */
  var apple: AppleApp?
}

/** A kind of first agent (AGENT_TYPES in agentTypes.ts). */
struct AgentType: Identifiable, Equatable {
  var id: String
  var name: String
  /** what it handles, one short line */
  var sub: String
  var apps: [String]
  /** "What I do" on Make me yours */
  var role: String
  var symbol: String
}

enum OnboardingCatalog {
  static let startApps: [String: StartApp] = {
    let list: [StartApp] = [
      StartApp(id: "messages", name: "Messages", what: "Recent texts", how: .mac, symbol: "message", apple: .messages),
      StartApp(id: "calendar", name: "Calendar", what: "Your week", how: .mac, symbol: "calendar", apple: .calendar),
      StartApp(id: "reminders", name: "Reminders", what: "Your lists", how: .mac, symbol: "list.bullet", apple: .reminders),
      StartApp(id: "contacts", name: "Contacts", what: "Who's who", how: .mac, symbol: "person", apple: .contacts),
      StartApp(id: "gmail", name: "Gmail", what: "Email", how: .key, symbol: "envelope", catalogId: "gmail"),
      StartApp(id: "gcal", name: "Google Calendar", what: "Your week", how: .key, symbol: "calendar", catalogId: "gcal"),
      StartApp(id: "gdrive", name: "Google Drive", what: "Documents", how: .key, symbol: "folder", catalogId: "gdrive"),
      StartApp(id: "slack", name: "Slack", what: "Channels and DMs", how: .key, symbol: "number", catalogId: "slack"),
      StartApp(id: "notion", name: "Notion", what: "Pages you share with it", how: .key, symbol: "doc.text", catalogId: "notion"),
      StartApp(id: "linear", name: "Linear", what: "Issues and projects", how: .key, symbol: "ticket", catalogId: "linear"),
      StartApp(id: "jira", name: "Jira", what: "Tickets", how: .key, symbol: "ticket", catalogId: "jira"),
      StartApp(id: "github", name: "GitHub", what: "Repos, issues, pull requests", how: .key, symbol: "chevron.left.forwardslash.chevron.right", catalogId: "github"),
      StartApp(id: "vercel", name: "Vercel", what: "Deploys", how: .key, symbol: "triangle", catalogId: "vercel"),
      StartApp(id: "supabase", name: "Supabase", what: "Projects and databases", how: .key, symbol: "cylinder.split.1x2", catalogId: "supabase"),
      StartApp(id: "sentry", name: "Sentry", what: "Errors", how: .key, symbol: "exclamationmark.triangle", catalogId: "sentry"),
      StartApp(id: "cloudflare", name: "Cloudflare", what: "Sites and Workers", how: .key, symbol: "cloud", catalogId: "cloudflare"),
      StartApp(id: "stripe", name: "Stripe", what: "Payments and invoices", how: .key, symbol: "creditcard", catalogId: "stripe"),
      StartApp(id: "brave", name: "Web search", what: "Brave Search", how: .key, symbol: "magnifyingglass", catalogId: "brave-search"),
    ]
    return Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
  }()

  static let agentTypes: [AgentType] = [
    AgentType(id: "daily", name: "Daily assistant", sub: "Texts, calendar, reminders, email.", apps: ["messages", "calendar", "reminders", "contacts", "gmail", "gcal", "gdrive"], role: "Keep my days on track.", symbol: "sun.max"),
    AgentType(id: "work", name: "Work assistant", sub: "Email, calendar, Slack, Notion, tickets.", apps: ["gmail", "gcal", "gdrive", "slack", "notion", "linear", "jira"], role: "Keep work moving.", symbol: "briefcase"),
    AgentType(id: "code", name: "Coding assistant", sub: "GitHub, deploys, databases, errors.", apps: ["github", "vercel", "supabase", "sentry", "cloudflare", "linear"], role: "Help with my code.", symbol: "chevron.left.forwardslash.chevron.right"),
    AgentType(id: "biz", name: "Business manager", sub: "Payments, customers, email, docs.", apps: ["stripe", "gmail", "gdrive", "notion", "slack"], role: "Keep the business side in order.", symbol: "chart.bar"),
    AgentType(id: "research", name: "Research assistant", sub: "Web search, notes, documents.", apps: ["brave", "notion", "gdrive"], role: "Find things out and write them up.", symbol: "magnifyingglass"),
    AgentType(id: "other", name: "Something else", sub: "Say it in your own words.", apps: [], role: "", symbol: "ellipsis"),
  ]

  /** "Something else" in their words: until the agent can suggest apps from them, a notes app and web search fit most things. */
  static let otherApps = ["notion", "brave"]

  /** The app's own copy of the connector catalog (packages/core/src/connectors.ts), with how each one signs in. */
  static let connectors: [AppConnector] = (try? NativeCatalog.read("ConnectorCatalog", as: [AppConnector].self)) ?? []
  static func connector(_ id: String?) -> AppConnector? { id.flatMap { id in connectors.first { $0.id == id } } }

  /**
   * The apps the picked kinds start with, merged, each once, in catalogue order. Apps that work now
   * come first and "Soon" ones last; Apple apps only when Bubble AI lives on a Mac.
   */
  static func apps(for types: [String], other: String, onMac: Bool) -> [StartApp] {
    var seen = Set<String>(), ids: [String] = []
    for t in agentTypes where types.contains(t.id) {
      let apps = t.id == "other" ? (other.trimmed.isEmpty ? [] : otherApps) : t.apps
      for a in apps where seen.insert(a).inserted { ids.append(a) }
    }
    let apps = ids.compactMap { startApps[$0] }.filter { $0.how != .mac || onMac }
    return apps.filter { $0.how != .soon } + apps.filter { $0.how == .soon }
  }

  /** Do the picked kinds want Apple apps that this Bubble AI can't reach (it doesn't live on a Mac)? */
  static func missesMac(_ types: [String], onMac: Bool) -> Bool {
    !onMac && agentTypes.contains { t in types.contains(t.id) && t.apps.contains { startApps[$0]?.how == .mac } }
  }

  /** "What I do" from the picks: the first picked kind's line, or their own words for "Something else". */
  static func typeRole(_ types: [String], other: String) -> String? {
    guard let first = agentTypes.first(where: { types.contains($0.id) }) else { return nil }
    guard first.id == "other" else { return first.role }
    let own = other.trimmed.replacingOccurrences(of: "[.\\s]+$", with: "", options: .regularExpression)
    return own.isEmpty ? nil : own.prefix(1).uppercased() + own.dropFirst() + "."
  }

  /** The line under the host on the picker: the picked kinds by name, then their own words. */
  static func pickedNames(_ types: [String], other: String) -> [String] {
    var names = agentTypes.filter { types.contains($0.id) && $0.id != "other" }.map(\.name)
    if types.contains("other"), !other.trimmed.isEmpty { names.append(other.trimmed) }
    return names
  }

  /** "Continue with 2 apps" / "Connect one to continue" */
  static func sheetCta(_ n: Int) -> String { n > 0 ? "Continue with \(n) \(n == 1 ? "app" : "apps")" : "Connect one to continue" }

  /** The macOS permission behind each Apple app, as the Apple mod names it. */
  static func applePermission(_ app: AppleApp) -> String {
    switch app {
    case .messages: "fullDiskAccess"
    case .calendar: "calendars"
    case .reminders: "reminders"
    case .contacts: "contacts"
    case .location: ""
    }
  }
}

/** How a catalog app signs in with one click (`signIn` in the catalog): through Bubble AI's own app with that company, or the app's own server. */
struct CatalogSignIn: Decodable, Hashable {
  var via: String
  var provider: String?
  var localOnly: Bool?
}

/** What `GET /api/connectors/sign-in` says about one catalog app, from where Bubble AI is open. */
struct SignInOption: Decodable, Equatable {
  var signIn: Bool
  var reason: String?
  var reads: String?
  var key: Bool?
}

/** How a row in "Set up apps" connects from here. */
enum AppRowMode: Equatable { case mac, signIn, key, soon, loading }

enum AppRows {
  /** The hub says which apps sign in from this address; without a sign-in a key, and with neither, Soon (rowMode in TypeStep.tsx). */
  static func mode(_ app: StartApp, options: [String: SignInOption]?, catalog: [AppConnector] = OnboardingCatalog.connectors) -> AppRowMode {
    if app.how == .mac { return .mac }
    if app.how == .soon { return .soon }
    guard let entry = catalog.first(where: { $0.id == app.catalogId }) else { return .soon }
    if entry.signIn != nil && options == nil { return .loading }
    let o = options?[entry.id]
    if o?.signIn == true { return .signIn }
    let needsValue = (entry.fields ?? []).contains { $0.optional != true }
    return needsValue && (o?.key ?? true) ? .key : .soon
  }

  /**
   * The rows one sign-in covers: Gmail, Google Calendar and Drive share one Google sign-in, so
   * signing in to one connects the others in the sheet that aren't connected yet (signInGroup).
   */
  static func signInGroup(_ app: StartApp, apps: [StartApp], modes: [String: AppRowMode], done: (String) -> Bool, catalog: [AppConnector] = OnboardingCatalog.connectors) -> [StartApp] {
    func signIn(_ a: StartApp) -> CatalogSignIn? { catalog.first { $0.id == a.catalogId }?.signIn }
    guard let s = signIn(app), s.via == "app" else { return [app] }
    let rest = apps.filter { a in
      guard a.id != app.id, modes[a.id] == .signIn, !done(a.id), let o = signIn(a) else { return false }
      return o.via == "app" && o.provider == s.provider
    }
    return Array(([app] + rest).prefix(5))
  }

  /** The values a key row still needs, by their labels: "Add the personal access token." */
  static func missing(_ entry: AppConnector, values: [String: String]) -> String? {
    let missing = (entry.fields ?? []).filter { $0.optional != true && (values[$0.key] ?? "").trimmed.isEmpty }.map(\.label)
    return missing.isEmpty ? nil : "Add the \(missing.joined(separator: " and ").lowercased())."
  }
}

/** Page 2's agent, saved on Continue; the AI page creates the real agent from it. */
struct FirstAgentDraft: Codable, Equatable {
  var name: String
  var handle: String?
  /** "What I do", one line */
  var role: String
  /** one of OnboardingLook.colors; the ghost shades it into its gradient */
  var color: String
  var shape: String
  /** the start of its instructions */
  var instructions: String
}

/** The first run's answers, kept per workspace on this phone (the web keeps the same in the browser). */
struct OnboardingAnswers: Codable, Equatable {
  var agentTypes: [String] = []
  var agentOther = ""
  /** "Pick your agent" was answered (Set up apps, Continue) or passed (Skip for now) */
  var typeDone = false
  /** the connectors set up there (ids), given to the first agent once it exists */
  var apps: [String] = []
  /** their names, for "Reading GitHub" while the agent starts */
  var appNames: [String] = []
  /** the Apple apps allowed there */
  var appleApps: [String] = []
  var agentDraft: FirstAgentDraft?
  /** the agent the AI page made */
  var agentId: String?
  /** the AI page's Continue switched on what it recommends (routines and a morning plan) */
  var setupDone = false
  /** the flow is over on this phone: its agent is made, or the person closed it for later */
  var closed = false
  /** How it starts: "simple" or "advanced" (nil: not picked yet) */
  var path: String?
  /** Make it yours: what it helps with, how it talks, when it checks in */
  var goals: [String]?
  var talk: String?
  var checkIn: String?

  init() {}
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    agentTypes = (try? c.decode([String].self, forKey: .agentTypes)) ?? []
    agentOther = (try? c.decode(String.self, forKey: .agentOther)) ?? ""
    typeDone = (try? c.decode(Bool.self, forKey: .typeDone)) ?? false
    apps = (try? c.decode([String].self, forKey: .apps)) ?? []
    appNames = (try? c.decode([String].self, forKey: .appNames)) ?? []
    appleApps = (try? c.decode([String].self, forKey: .appleApps)) ?? []
    agentDraft = try? c.decode(FirstAgentDraft.self, forKey: .agentDraft)
    agentId = try? c.decode(String.self, forKey: .agentId)
    setupDone = (try? c.decode(Bool.self, forKey: .setupDone)) ?? false
    closed = (try? c.decode(Bool.self, forKey: .closed)) ?? false
    path = try? c.decode(String.self, forKey: .path)
    goals = try? c.decode([String].self, forKey: .goals)
    talk = try? c.decode(String.self, forKey: .talk)
    checkIn = try? c.decode(String.self, forKey: .checkIn)
  }

  static func key(_ workspaceId: String) -> String { "wisp.onboardingV3.\(workspaceId)" }

  @MainActor static func load(_ workspaceId: String, from defaults: UserDefaults = WispPreferences.standard) -> OnboardingAnswers {
    guard let data = defaults.data(forKey: key(workspaceId)), let saved = try? JSONDecoder().decode(OnboardingAnswers.self, from: data) else { return OnboardingAnswers() }
    return saved
  }

  @discardableResult
  @MainActor static func save(_ workspaceId: String, in defaults: UserDefaults = WispPreferences.standard, _ change: (inout OnboardingAnswers) -> Void) -> OnboardingAnswers {
    var next = load(workspaceId, from: defaults)
    change(&next)
    if let data = try? JSONEncoder().encode(next) { defaults.set(data, forKey: key(workspaceId)) }
    return next
  }

  /** The apps set up on "Pick your agent", by name, for "Reading Messages and Calendar" (nil: none). */
  var appsLine: String? {
    let names = appleApps.compactMap { AppleApp(rawValue: $0)?.name } + appNames
    if names.isEmpty { return nil }
    return names.count <= 2 ? names.joined(separator: " and ") : "\(names.prefix(2).joined(separator: ", ")) and more"
  }
}

/** The wording of "Make me yours" and the agent it makes (AgentStep.tsx, onboardingV3.ts). */
enum OnboardingText {
  static let namePool = ["Juno", "Atlas", "Pip", "Nova", "Milo", "Iris", "Otto", "Wren", "Remy", "Luna"]
  /** the six family colours and their names, in the web's order */
  static let colors = ["#a98bf5", "#3cc0a6", "#f2a04a", "#6aa2f5", "#ef7fa8", "#cfd36a"]
  static let colorNames = ["Violet", "Teal", "Orange", "Blue", "Pink", "Lime"]
  static let shapes = ["classic", "round", "tall", "sheet", "wisp"]
  static let shapeLabels = ["classic": "Round", "round": "Squircle", "tall": "Egg", "sheet": "Blob", "wisp": "Drop"]
  /** "What I do" when nothing was picked */
  static let noGoalRole = "Helps with whatever you need, so you have more time."

  static func first(_ person: String) -> String { person.trimmed.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? "" }

  /** Three names to tap, never the person's own. */
  static func names(for person: String) -> [String] {
    let me = first(person).lowercased()
    return Array(namePool.filter { $0.lowercased() != me }.prefix(3))
  }

  /** "What I do" for the picks: the kind's line, else the plain default. */
  static func role(for answers: OnboardingAnswers) -> String {
    OnboardingCatalog.typeRole(answers.agentTypes, other: answers.agentOther) ?? noGoalRole
  }

  /** "Hi Sam, I'm Juno. I'll start by learning how you like things done." */
  static func preview(person: String, agent: String) -> String {
    let who = first(person)
    return "\(who.isEmpty ? "Hi" : "Hi \(who)"), I'm \(agent). I'll start by learning how you like things done."
  }

  static func handle(_ name: String) -> String {
    let slug = name.trimmed.lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
      .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    return String(slug.prefix(32))
  }

  /** A handle nobody has yet: the name's, then with 2, 3, … after it. */
  static func freeHandle(_ name: String, taken: [String]) -> String {
    var base = handle(name)
    if base.isEmpty || !(base.first?.isLetter ?? false) { base = "agent" }
    if !taken.contains(base) { return base }
    for n in 2...99 where !taken.contains("\(String(base.prefix(29)))-\(n)") { return "\(String(base.prefix(29)))-\(n)" }
    return base
  }

  /** "You are Juno, Sam's agent in Bubble AI. Your job: … Ask before connecting an account, spending money or sending anything as them." */
  static func instructions(agent: String, person: String, role: String) -> String {
    let who = first(person).isEmpty ? "the person" : first(person)
    let job = role.trimmed.replacingOccurrences(of: "[.\\s]+$", with: "", options: .regularExpression)
    return ["You are \(agent.trimmed), \(who)'s agent in Bubble AI.",
            job.isEmpty ? "" : "Your job: \(job).",
            "What you know about them is in your notes; use it without asking again.",
            "Ask before connecting an account, spending money or sending anything as them."]
      .filter { !$0.isEmpty }.joined(separator: " ")
  }

  /** "GitHub", "Messages and Calendar", "GitHub, Slack and Notion" */
  static func list(_ names: [String]) -> String {
    names.count <= 1 ? (names.first ?? "") : "\(names.dropLast().joined(separator: ", ")) and \(names.last!)"
  }

  /**
   * The setup the first run recommends from what the person told it: a morning routine when
   * "What I do" says something real, else nothing (recommendedSetup in onboardingPlan.ts).
   */
  static func morningPlan(person: String, role: String) -> (name: String, schedule: String, steps: String)? {
    let r = role.trimmed
    guard !r.isEmpty, r.range(of: "^Helps with whatever you need", options: [.regularExpression, .caseInsensitive]) == nil else { return nil }
    let goal = r.replacingOccurrences(of: "^helps? with\\s+", with: "", options: [.regularExpression, .caseInsensitive])
      .replacingOccurrences(of: ",?\\s*(so you have more time|and whatever else you need)\\.?$", with: "", options: [.regularExpression, .caseInsensitive])
      .replacingOccurrences(of: "[.\\s]+$", with: "", options: .regularExpression)
    guard !goal.isEmpty else { return nil }
    let who = first(person).isEmpty ? "them" : first(person)
    let steps = ["# Morning plan", "", "Every morning, message \(who) in your chat with a short plan for the day:", "- what needs them today",
                 "- one thing you can do for them now, asked as a yes/no question", "", "What they want help with: \(goal).", "",
                 "Keep it under 80 words. Never send, buy or post anything as them without a yes."].joined(separator: "\n")
    return ("Morning plan", "0 8 * * *", steps)
  }

  /** "Every day at 08:00." for a routine's schedule on Here's your Bubble AI. */
  static func cronLine(_ schedule: String?) -> String {
    guard let schedule, !schedule.trimmed.isEmpty else { return "When you run it." }
    let m = schedule.trimmed.split(whereSeparator: \.isWhitespace).map(String.init)
    if m.count == 5, let minute = Int(m[0]), let hour = Int(m[1]), m[2] == "*", m[3] == "*" {
      let t = String(format: "%02d:%02d", hour, minute)
      if m[4] == "*" { return "Every day at \(t)." }
      if m[4] == "1-5" { return "Weekdays at \(t)." }
    }
    return "On a schedule."
  }
}

/** A new agent getting to know the person it works for, in their chat (AgentSetup in core/types.ts). */
struct AgentSetup: Codable, Hashable {
  var userId: String?
  var channelId: String?
  var startedAt: String?
  /** the hello Bubble AI wrote for it */
  var greetingId: String?
  var done: Bool?
}

/** What a hello read in the person's apps just before it (GET /api/agents/:id/hello-read). */
struct HelloRead: Decodable, Equatable {
  struct App: Decodable, Equatable { var app: String; var terms: [String]? }
  var read: [App]?
}

/** The first chat with a new agent (FirstChat.tsx): one tap answers, pings asked for after its first answer, and a way to "Here's your Bubble AI". */
enum FirstChat {
  /** What you can answer its hello with in one tap: the first is the one filled button. */
  static let quick = ["Yes, go ahead", "Something else first"]
  static let fresh: TimeInterval = 7 * 86_400

  /** Is this the chat the agent's hello started, and has the hello been said? */
  static func isFirstChat(_ agent: Agent?, channelId: String, now: Date = Date()) -> Bool {
    guard let s = agent?.settings?.setup, s.channelId == channelId, s.greetingId != nil, let started = s.startedAt.flatMap(Wire.date) else { return false }
    return now.timeIntervalSince(started) < fresh
  }

  /** Has the agent answered the person at least once (a reply after something they wrote)? */
  static func answeredOnce(_ messages: [Message], agentId: String) -> Bool {
    var spoke = false
    for m in messages where m.threadId == nil && m.deletedAt == nil {
      if m.author.kind == .user { spoke = true } else if spoke, m.author.kind == .agent, m.author.id == agentId { return true }
    }
    return false
  }

  /** Where the notifications card stands: hidden, asking, waiting on the system prompt, on, or off (said no). */
  enum Ping: Equatable { case hidden, ask, asking, on, off }
  /** What the system says about notifications, as the card needs it. */
  enum Permission: Equatable { case notAsked, granted, denied, unsupported }

  /** Nothing until the agent has answered once; afterwards, what the system says (pingState). */
  static func ping(answered: Bool, asked: Bool, busy: Bool, permission: Permission) -> Ping {
    if permission == .unsupported { return .hidden }
    if busy { return .asking }
    // a "Don't Allow" stays visible with its switch until dismissed; a yes shows once, then goes
    if permission == .denied { return asked ? .hidden : answered ? .off : .hidden }
    if asked || permission == .granted { return .hidden }
    return answered ? .ask : .hidden
  }

  static func askedKey(_ workspaceId: String) -> String { "wisp.notifyAsked.\(workspaceId)" }
  static func hereSeenKey(_ agentId: String) -> String { "wisp.hereSeen.\(agentId)" }
  static func typedKey(_ messageId: String) -> String { "wisp.helloTyped.\(messageId)" }
}

/** A first chat's hello: what it read just before is underlined, and it types in once (FirstHello.tsx). */
enum FirstHello {
  /** What it read in the person's apps: each phrase, from its app. */
  static func terms(_ read: [HelloRead.App]) -> [(term: String, src: String)] {
    read.flatMap { r in (r.terms ?? []).map(\.trimmed).filter { $0.count >= 3 }.map { (term: $0.lowercased(), src: "\(r.app), just now") } }
  }

  /** Where each known phrase stands in some text: whole words only, the longest phrase first, never overlapping. */
  static func ranges(of terms: [String], in text: String) -> [Range<String.Index>] {
    var out: [Range<String.Index>] = []
    func wordChar(_ c: Character?) -> Bool { c.map { $0.isLetter || $0.isNumber } ?? false }
    for term in Set(terms).sorted(by: { $0.count > $1.count }) where !term.isEmpty {
      var from = text.startIndex
      while let r = text.range(of: term, options: [.caseInsensitive], range: from..<text.endIndex) {
        from = r.upperBound
        let before = r.lowerBound > text.startIndex ? text[text.index(before: r.lowerBound)] : nil
        let after = r.upperBound < text.endIndex ? text[r.upperBound] : nil
        if wordChar(before) || wordChar(after) || out.contains(where: { $0.overlaps(r) }) { continue }
        out.append(r)
      }
    }
    return out.sorted { $0.lowerBound < $1.lowerBound }
  }

  /** Whether a hello is new enough, and unseen, to type in. */
  @MainActor static func shouldType(messageId: String, createdAt: Date, reduceMotion: Bool, now: Date = Date(), defaults: UserDefaults = WispPreferences.standard) -> Bool {
    !reduceMotion && !defaults.bool(forKey: FirstChat.typedKey(messageId)) && now.timeIntervalSince(createdAt) < 10 * 60
  }
}

/** "When you're ready" on Here's your Bubble AI: four things, ticked by the person (the second also by having two agents). */
@MainActor enum ReadyList {
  struct Item: Identifiable, Equatable { var id: String; var label: String; var done: Bool }
  static let items: [(id: String, label: String)] = [("phone", "Get Bubble AI on your phone"), ("logins", "Add your password manager"), ("email", "Connect your email"), ("second", "Make a second agent")]
  static func key(_ workspaceId: String) -> String { "wisp.ready.v1.\(workspaceId)" }

  static func ticks(_ workspaceId: String, in defaults: UserDefaults = WispPreferences.standard) -> [String: Bool] {
    (defaults.dictionary(forKey: key(workspaceId)) as? [String: Bool]) ?? [:]
  }

  static func set(_ workspaceId: String, _ id: String, _ done: Bool, in defaults: UserDefaults = WispPreferences.standard) {
    var t = ticks(workspaceId, in: defaults)
    t[id] = done
    defaults.set(t, forKey: key(workspaceId))
  }

  /** Each item and whether it's done. On the phone, "Get Bubble AI on your phone" already is. */
  static func list(_ workspaceId: String, agentCount: Int, in defaults: UserDefaults = WispPreferences.standard) -> [Item] {
    let t = ticks(workspaceId, in: defaults)
    return items.map { i in
      let auto = i.id == "phone" ? t["phone"] ?? true : i.id == "second" ? agentCount >= 2 || t["second"] == true : t[i.id] == true
      return Item(id: i.id, label: i.label, done: auto)
    }
  }

  /** "Finish setup" shows from the first look at Here's your Bubble AI until the list is done. */
  static func showsFinishSetup(_ workspaceId: String, agentCount: Int, in defaults: UserDefaults = WispPreferences.standard) -> Bool {
    ticks(workspaceId, in: defaults)["started"] == true && list(workspaceId, agentCount: agentCount, in: defaults).contains { !$0.done }
  }
}

// MARK: - The first run of 2026-11-26 (canvas "Bubble AI onboarding flow", iPhone board)

/** How the first agent starts: Simple opens its chat right away; Advanced asks what it helps with and connects apps first. */
enum SetupPath: String, Codable, Equatable {
  case simple, advanced

  /** What each start switches on for the organization (the web's featuresForExperience). */
  var features: Features { self == .simple ? .simple : .everything }
}

/** How it talks, on Make it yours. */
enum SetupTalk: String, Codable, CaseIterable, Identifiable {
  case short, friendly, thorough
  var id: String { rawValue }
  var label: String { rawValue.prefix(1).uppercased() + rawValue.dropFirst() }
}

/** When it checks in, on Make it yours. */
enum SetupCheckIn: String, Codable, CaseIterable, Identifiable {
  case morning, evening, needed
  var id: String { rawValue }
  var label: String {
    switch self {
    case .morning: "Each morning"
    case .evening: "Each evening"
    case .needed: "Only when it matters"
    }
  }
}

/** One thing the agent can help with, in the person's own words (SETUP_GOALS in BubbleSetup.tsx, round 7). */
struct SetupGoal: Identifiable, Equatable {
  var id: String
  /** as they'd say it */
  var label: String
  /** the same, as it reads after "I'd like help with:" */
  var want: String
  var symbol: String
  /** what it would tell you, for the sample message */
  var say: String
}

/** Make it yours, as on the web (apps/web/src/views/onboarding/BubbleSetup.tsx, round 7). The apps come after, from the agent itself. */
enum SetupGoals {
  static let all: [SetupGoal] = [
    SetupGoal(id: "days", label: "Keep my days on track", want: "keeping my days on track", symbol: "calendar", say: "the dentist is at 10, so I moved the gym to 6"),
    SetupGoal(id: "msgs", label: "Stay on top of my messages", want: "staying on top of my messages", symbol: "envelope", say: "your landlord replied, and Friday works for him"),
    SetupGoal(id: "people", label: "Remember the people I care about", want: "remembering the people I care about", symbol: "heart", say: "it's your mom's birthday Saturday. Want me to find a gift?"),
    SetupGoal(id: "plans", label: "Plan trips and weekends", want: "planning trips and weekends", symbol: "mappin.and.ellipse", say: "flights to Chicago for the 14th dropped to $142"),
    SetupGoal(id: "money", label: "Keep an eye on money and bills", want: "keeping an eye on money and bills", symbol: "creditcard", say: "your phone bill ($64) is due Thursday"),
    SetupGoal(id: "health", label: "Help me stay healthy", want: "staying healthy", symbol: "waveform.path.ecg", say: "you've slept under 6 hours three nights running. Earlier night tonight?"),
    SetupGoal(id: "business", label: "Help run my business", want: "running my business", symbol: "storefront", say: "2 customers wrote in overnight and 4 orders are ready to ship"),
    SetupGoal(id: "learn", label: "Help me learn and build things", want: "learning and building things", symbol: "book", say: "I found 5 good sources on what you asked. Short answer: yes"),
  ]
  /** what's picked before anyone picks */
  static let start = ["days", "people"]

  private static func picked(_ goals: [String]) -> [SetupGoal] { all.filter { goals.contains($0.id) } }
  private static func sentence(_ s: String) -> String { s.prefix(1).uppercased() + s.dropFirst() }
  /** a full stop, unless it already ends with one ("…find a gift?") */
  private static func stop(_ s: String) -> String { s.hasSuffix(".") || s.hasSuffix("?") || s.hasSuffix("!") ? s : s + "." }
  /** what they wrote about themselves, tidied: one line, no full stop at the end */
  static func tidy(_ about: String) -> String {
    var t = about.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    while let last = t.last, last == "." || last == " " { t.removeLast() }
    return t
  }

  /** The message it would send you, from what's picked and who you are: the preview on Make it yours. */
  static func sample(_ goals: [String], talk: SetupTalk, when: SetupCheckIn, about: String, person: String) -> String {
    let first = OnboardingText.first(person)
    let hi = switch when {
    case .morning: "Morning\(first.isEmpty ? "" : ", \(first)")!"
    case .evening: "Evening\(first.isEmpty ? "" : ", \(first)")."
    case .needed: "Hey\(first.isEmpty ? "" : " \(first)"),"
    }
    let news = picked(goals)
    guard let lead0 = news.first else { return "\(hi) Tell me what's on your mind and I'll take it from there." }
    // a new sentence after "Morning, Sam!", not after "Hey Sam,"
    let lead = stop(hi.hasSuffix(",") ? lead0.say : sentence(lead0.say))
    let also = news.count > 1 ? " Also, \(stop(news[1].say))" : ""
    let known = tidy(about)
    let nod = known.isEmpty ? "" : " (I'll keep in mind: \(known).)"
    switch talk {
    case .short: return "\(hi) \(lead)"
    case .friendly: return "\(hi) \(lead)\(also)\(nod)"
    case .thorough: return "\(hi) \(lead)\(also) I've already drafted what I can; say go and I'll handle it.\(nod)"
    }
  }

  /** What goes to the agent as the person's first message: their picks and what they wrote, in plain words. */
  static func picksMessage(_ goals: [String], about: String) -> String {
    let want = picked(goals).map(\.want)
    let known = tidy(about)
    return [want.isEmpty ? "I'm not sure yet what I'd like help with." : "I'd like help with: \(OnboardingText.list(want)).", known.isEmpty ? "" : "About me: \(known)."]
      .filter { !$0.isEmpty }.joined(separator: " ")
  }

  /**
   * Introduce yourself (board 16b): the person's own first message, written from their picks, and
   * exactly what's sent. "Hi Juno, I'm Sam. I'd like help keeping my days on track and staying on top
   * of my messages. About me: I work weekends. Keep it friendly, and check in each morning."
   */
  static func introMessage(agent: String, person: String, goals: [String], about: String, talk: SetupTalk, when: SetupCheckIn) -> String {
    let first = OnboardingText.first(person)
    let hi = agent.trimmed.isEmpty ? "Hi" : "Hi \(agent.trimmed)"
    let greet = first.isEmpty ? "\(hi)!" : "\(hi), I'm \(first)."
    let want = picked(goals).map(\.want)
    let help = want.isEmpty ? "I'm not sure yet what I'd like help with." : "I'd like help \(OnboardingText.list(want))."
    let known = String(tidy(about).prefix(300))
    let me = known.isEmpty ? "" : "About me: \(stop(known))"
    let style = switch talk {
    case .short: "Keep it short"
    case .friendly: "Keep it friendly"
    case .thorough: "Be thorough"
    }
    let check = switch when {
    case .morning: "check in each morning."
    case .evening: "check in each evening."
    case .needed: "only check in when it matters."
    }
    return [greet, help, me, "\(style), and \(check)"].filter { !$0.isEmpty }.joined(separator: " ")
  }

  /** "What I do" from the goals: "Helps with keeping my days on track.", or the plain default. */
  static func role(_ goals: [String]) -> String {
    let want = picked(goals).map(\.want)
    return want.isEmpty ? OnboardingText.noGoalRole : "Helps with \(OnboardingText.list(want))."
  }

  /** Its instructions from Make it yours: the usual start, what it helps with, about the person, how it talks, when it checks in. */
  static func instructions(agent: String, person: String, goals: [String], talk: SetupTalk, when: SetupCheckIn, about: String = "") -> String {
    let who = OnboardingText.first(person).isEmpty ? "them" : OnboardingText.first(person)
    let want = picked(goals).map(\.want)
    let base = OnboardingText.instructions(agent: agent, person: person, role: want.isEmpty ? "" : "help with \(OnboardingText.list(want))")
    let known = String(tidy(about).prefix(500))
    let me = known.isEmpty ? "" : "About \(who), in their words: \"\(known).\""
    let style = switch talk {
    case .short: "Keep messages short: one or two lines."
    case .friendly: "Be warm and friendly, with enough detail to act on."
    case .thorough: "Give full detail, and say what you've already done."
    }
    let check = switch when {
    case .morning: "Each morning, message \(who) with what needs them."
    case .evening: "Each evening, message \(who) with what happened and what needs them."
    case .needed: "Only message \(who) when something matters."
    }
    return [base, me, style, check].filter { !$0.isEmpty }.joined(separator: " ")
  }
}
