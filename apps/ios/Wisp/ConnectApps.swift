import SwiftUI

/**
 * Connect apps (0.1.6, web round 8 / board "Apps", on the phone): the marketplace opens as a sheet
 * titled "Connect apps" from a pill at the bottom of the chat list. The pieces here are shared by
 * that sheet (MarketplaceView), the agent's connect card under its reply (round 7) and the pill.
 */

// MARK: one-tap connect

/**
 * Connecting catalog apps with one tap: the hub makes the connector and hands back the app's own
 * sign-in page, which opens in the system's sign-in sheet; then the connector is watched until it's
 * signed in, says why not, or the sheet is closed. Nothing here sees a password.
 */
@MainActor
@Observable
final class AppConnecting {
  enum State: Equatable { case idle, out, on, failed(String) }
  private(set) var states: [String: State] = [:]
  @ObservationIgnored private let browser = SignInBrowser()
  @ObservationIgnored private var tries: [String: Int] = [:]

  func state(_ id: String) -> State { states[id] ?? .idle }
  func mark(_ id: String, _ s: State) { states[id] = s }

  func connect(_ catalogId: String, name: String, store: Store) async {
    let n = (tries[catalogId] ?? 0) + 1
    tries[catalogId] = n
    states[catalogId] = .out
    do {
      let start = try await store.connectApps([catalogId])
      var error: String?
      if start.signedIn != true, let page = BrowserPage(start.url) {
        browser.open(page.url)
        error = await waitForSignIn(start.connectors.map(\.id), store: store)
        browser.close()
      } else if start.signedIn != true, start.url != nil {
        error = "\(name) sent back a sign-in page this phone can't open."
      }
      guard tries[catalogId] == n else { return }
      if let error {
        // a connector left half made would sit in the list saying it's off
        for c in start.connectors where store.connectors.first(where: { $0.id == c.id })?.auth?.signedIn != true { try? await store.deleteConnector(c.id) }
        states[catalogId] = .failed(error)
      } else {
        states[catalogId] = .on
      }
    } catch {
      if tries[catalogId] == n { states[catalogId] = .failed(error.localizedDescription) }
    }
  }

  func cancel(_ id: String) {
    tries[id] = (tries[id] ?? 0) + 1
    browser.close()
    states[id] = .idle
  }

  /** nil: signed in */
  private func waitForSignIn(_ ids: [String], store: Store) async -> String? {
    let until = Date().addingTimeInterval(5 * 60)
    var closedChecks = 0
    while Date() < until {
      try? await Task.sleep(for: .milliseconds(1500))
      if Task.isCancelled { return "The sign-in didn't finish. Try again." }
      guard (try? await store.refreshConnectors()) != nil else { continue }
      let last = store.connectors.filter { ids.contains($0.id) }
      if !last.isEmpty, last.allSatisfy({ $0.auth?.signedIn == true }) { return nil }
      if let failed = last.first(where: { $0.auth?.error != nil }) { return failed.auth?.error }
      if browser.closed {
        closedChecks += 1
        if closedChecks >= 2 { break }
      }
    }
    return "The sign-in didn't finish. Try again."
  }
}

extension Store {
  /** An app from the catalog is connected: added, on, and signed in when it needs to be. */
  func isConnected(catalogId: String) -> Bool {
    connectors.contains { $0.catalogId == catalogId && $0.enabled != false && ($0.auth.map { $0.required != true || $0.signedIn == true } ?? true) }
  }
}

// MARK: row pieces (ConnectParts.tsx)

/** The soft pill at a row's right: Connect, Add, View. */
struct GoPill: View {
  var title: String
  var busy = false
  var action: () -> Void
  var body: some View {
    Button(action: action) { GoPillLabel(title: title, busy: busy) }
    .buttonStyle(.press)
    .disabled(busy)
    .accessibilityLabel(title)
  }
}

/** GoPill's look, for a pill that opens a page (a NavigationLink). */
struct GoPillLabel: View {
  var title: String
  var busy = false
  var body: some View {
    Group {
      if busy { ProgressView().controlSize(.mini) } else { Text(title) }
    }
    .font(.system(size: 13.5, weight: .medium)).foregroundStyle(Palette.text)
    .padding(.horizontal, 14).frame(height: 30)
    .background(Capsule().fill(Color(light: 0x000000, lightAlpha: 0.06, dark: 0xFFFFFF, darkAlpha: 0.09)))
    .contentShape(Capsule())
  }
}

/** "✓ Connected", "✓ Added", "✓ On": what a row says once it's in. */
struct DoneMark: View {
  var word: String
  var body: some View {
    HStack(spacing: 5) {
      Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold))
      Text(word)
    }
    .font(.system(size: 13.5)).foregroundStyle(Palette.muted)
    .accessibilityElement(children: .ignore).accessibilityLabel(word)
  }
}

/** "Recommended": the mark beside Composio's name. */
struct RecommendedMark: View {
  var body: some View {
    Text("Recommended").font(.system(size: 11.5, weight: .semibold)).foregroundStyle(ObTint.wisp)
      .padding(.horizontal, 7).padding(.vertical, 2)
      .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(ObTint.wisp.opacity(0.14)))
      .fixedSize()
  }
}

/** One app, skill or mod: a 42pt tile, its name (with a Recommended mark), one line of what it does, and at the right what to do or that it's in. */
struct ConnectRowView<Tile: View, Trailing: View>: View {
  var name: String
  var recommended = false
  var desc: String?
  @ViewBuilder var tile: Tile
  @ViewBuilder var trailing: Trailing

  var body: some View {
    HStack(spacing: 12) {
      tile
      VStack(alignment: .leading, spacing: 1) {
        HStack(spacing: 6) {
          Text(name).font(.system(size: 15, weight: .medium)).foregroundStyle(Palette.text).lineLimit(1)
          if recommended { RecommendedMark() }
        }
        if let desc, !desc.isEmpty {
          Text(desc).font(.system(size: 13)).foregroundStyle(Palette.muted).lineLimit(1)
        }
      }
      Spacer(minLength: 8)
      trailing
    }
    .frame(minHeight: 60)
    .contentShape(Rectangle())
  }
}

// MARK: topics (appTopics in ConnectParts.tsx)

enum AppTopic: String, CaseIterable {
  case productivity, communication, passwords, developer, design, money, mods

  var label: String {
    switch self {
    case .productivity: "Productivity"
    case .communication: "Communication"
    case .passwords: "Password managers"
    case .developer: "Developer tools"
    case .design: "Design and media"
    case .money: "Money"
    case .mods: "Mods"
    }
  }
  /** the ones under More */
  static let more: [AppTopic] = [.passwords, .developer, .design, .money, .mods]

  /** A shelf for an app from its name, then what it says it does (appCategory in packages/core/src/shop.ts). */
  static func category(_ name: String, _ description: String?) -> String? {
    let words: [(String, String)] = [
      ("Email and calendar", #"\b(e-?mail|gmail|outlook|inbox|calendars?|meetings?|zoom|calendly|imap|caldav)\b"#),
      ("Chat", #"\b(slack|discord|telegram|whatsapp|microsoft teams|sms|chat|messag(es|ing))\b"#),
      ("Tasks", #"\b(todoist|asana|trello|monday\.com|clickup|to-?dos?|task (lists?|manag\w*)|project management)\b"#),
      ("Design", #"\b(figma|canva|design|webflow|wix|framer|sketch|images?|videos?|sanity|cms|speech|voice|audio|music)\b"#),
      ("Finance", #"\b(payments?|stripe|paypal|invoic\w*|billing|accounting|banking|quickbooks|xero|finance)\b"#),
      ("Sales", #"\b(crm|sales|leads|hubspot|salesforce|pipedrive|marketing|pandadoc|proposals?)\b"#),
      ("Docs and notes", #"\b(notion|docs|documents?|notes|wiki|confluence|knowledge base|google drive|dropbox)\b"#),
      ("Developer", #"\b(github|gitlab|git|code|deploy\w*|vercel|cloudflare|pull requests?|sentry|monitoring|grafana|pagerduty|linear|jira|playwright|api testing|postman|developers?)\b"#),
      ("Data", #"\b(database|sql|postgres\w*|supabase|neon|mongo\w*|redis|analytics|amplitude|warehouse|airtable|spreadsheets?|sheets)\b"#),
      ("Research", #"\b(search|research|scrap\w*|crawl\w*|perplexity|exa|papers?|news)\b"#),
      ("Automation", #"\b(zapier|automat\w*|workflows?|n8n|make\.com)\b"#),
    ]
    for text in [name, description ?? ""] {
      for (cat, re) in words where text.range(of: re, options: [.regularExpression, .caseInsensitive]) != nil { return cat }
    }
    return nil
  }

  /** The shelf a built-in app sits on (BUILT_IN_SHELF). */
  static func builtInCategory(_ c: AppConnector) -> String? {
    if c.recommended != nil { return "Automation" }
    switch c.category {
    case "Code", "Utilities", "Cloud keys": return "Developer"
    case "Chat & docs": return category(c.name, c.description) ?? "Docs and notes"
    case "Work tracking": return "Tasks"
    case "Data": return "Data"
    case "Web & browser": return "Research"
    case "Payments": return "Finance"
    default: return nil
    }
  }

  /** The topics an app is on. */
  static func of(name: String, description: String?, category: String?) -> [AppTopic] {
    if name.range(of: #"\b(1password|bitwarden|lastpass|dashlane|keeper|proton ?pass|keepass\w*|passwords?)\b"#, options: [.regularExpression, .caseInsensitive]) != nil { return [.passwords] }
    switch category {
    case "Email and calendar":
      return "\(name) \(description ?? "")".range(of: #"\b(e-?mail|gmail|outlook|inbox|imap)\b"#, options: [.regularExpression, .caseInsensitive]) != nil ? [.communication] : [.productivity]
    case "Chat": return [.communication]
    case "Tasks", "Docs and notes", "Data", "Research", "Automation": return [.productivity]
    case "Developer": return [.developer]
    case "Design": return [.design]
    case "Finance", "Sales": return [.money]
    default: return []
    }
  }
}

// MARK: the agent's picks (latestPicks)

enum AgentPicks {
  /** The latest apps an agent suggested (a "connect" part), and who: the chat on screen first, then the others loaded. */
  static func latest(_ messages: [String: [Message]], first: String?) -> (agentId: String?, apps: [ConnectSuggestion])? {
    let lists = (first.flatMap { messages[$0] }.map { [$0] } ?? []) + messages.filter { $0.key != first }.map(\.value)
    for list in lists {
      for m in list.reversed() {
        for p in m.parts { if case .connect(let apps) = p, !apps.isEmpty { return (m.author.kind == .agent ? m.author.id : nil, apps) } }
      }
    }
    return nil
  }
}

// MARK: the card under an agent's reply

/**
 * The apps an agent suggests connecting (a "connect" message part, hub setup-picks.ts): each with its
 * reason and a one-tap Connect that opens the app's own sign-in page and says when it's done.
 * Composio, always recommended, carries a "Recommended" mark.
 */
struct ConnectCard: View {
  @Environment(Store.self) private var store
  var apps: [ConnectSuggestion]
  @State private var connecting = AppConnecting()

  var body: some View {
    VStack(spacing: 0) {
      ForEach(Array(apps.enumerated()), id: \.element.id) { i, a in
        if i > 0 { Rectangle().fill(Palette.separator).frame(height: 0.5).padding(.leading, 60) }
        row(a)
      }
    }
    .padding(.horizontal, 14).padding(.vertical, 2)
    .frame(maxWidth: 420, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Palette.card))
    .accessibilityElement(children: .contain).accessibilityLabel("Apps to connect")
    .accessibilityIdentifier("connect-card")
    .task {
      try? await store.refreshConnectors()
      for a in apps where store.isConnected(catalogId: a.id) { connecting.mark(a.id, .on) }
    }
  }

  private func row(_ a: ConnectSuggestion) -> some View {
    let state = connecting.state(a.id)
    let failed: String? = if case .failed(let why) = state { why } else { nil }
    // an app hub (Composio) that's on but has nothing picked inside it yet (board 16)
    let hub = store.connectors.first { $0.catalogId == a.id && $0.noAppsPicked }
    let empty = state == .on && hub != nil
    return HStack(spacing: 12) {
      if a.recommended == true { LineTile(symbol: "square.stack.3d.up", size: 36) } else { AppTile(name: a.name, ids: [a.id], size: 36) }
      VStack(alignment: .leading, spacing: 2) {
        // on a phone the mark goes under the name rather than cutting it short
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 6) { name(a); if a.recommended == true { RecommendedMark() } }
          VStack(alignment: .leading, spacing: 2) { name(a); if a.recommended == true { RecommendedMark() } }
        }
        if empty {
          // connected, but it reaches nothing until apps are picked on Composio's own page
          Text("No apps picked yet").font(.system(size: 13)).foregroundStyle(Palette.muted)
            .fixedSize(horizontal: false, vertical: true)
        } else {
          Text(failed ?? a.why).font(.system(size: 13)).foregroundStyle(failed == nil ? Palette.muted : Palette.red)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: 6)
      switch state {
      case .on:
        if empty, let hub { PickAppsButton(connector: hub) } else { DoneMark(word: "Connected").foregroundStyle(Palette.statusOnline) }
      case .out:
        HStack(spacing: 6) {
          ProgressView().controlSize(.small).accessibilityLabel("Finish signing in")
          Button("Cancel") { connecting.cancel(a.id) }.font(.system(size: 13)).foregroundStyle(Palette.muted).buttonStyle(.plain)
        }
      case .idle, .failed:
        GoPill(title: failed == nil ? "Connect" : "Try again") { Task { await connecting.connect(a.id, name: a.name, store: store) } }
          .disabled(!store.canManage)
          .accessibilityLabel("\(failed == nil ? "Connect" : "Try again") \(a.name)")
      }
    }
    .padding(.vertical, 10)
  }

  private func name(_ a: ConnectSuggestion) -> some View {
    Text(a.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text).lineLimit(2).fixedSize(horizontal: false, vertical: true)
  }
}

/** The Connect apps sheet: the marketplace in its own stack, so its pages open inside it. */
struct ConnectAppsSheet: View {
  var start: MarketSection = .all
  var body: some View {
    NavigationStack {
      MarketplaceView(start: start, inSheet: true)
        .chatDestinations()
    }
    .presentationDragIndicator(.hidden)
  }
}

/**
 * "Pick apps" (board 16): opens the app hub's own page (Composio's) where the person picks which apps
 * it reaches. Back in Bubble AI, it asks the hub again, so the card stops saying "No apps picked yet".
 */
struct PickAppsButton: View {
  @Environment(Store.self) private var store
  @Environment(\.openURL) private var openURL
  @Environment(\.scenePhase) private var scenePhase
  var connector: AppConnector
  @State private var away = false

  var body: some View {
    if let url = connector.linkedApps?.pickUrl.flatMap(URL.init(string:)) {
      GoPill(title: "Pick apps") { away = true; openURL(url) }
        .accessibilityLabel("Pick apps in \(connector.name)")
        .accessibilityIdentifier("pick-apps")
        .onChange(of: scenePhase) { _, phase in
          guard phase == .active, away else { return }
          away = false
          Task { await store.recheckLinkedApps(connector.id) }
        }
    }
  }
}
