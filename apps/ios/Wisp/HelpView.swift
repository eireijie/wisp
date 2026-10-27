import SwiftUI

/** Where a beginner gets unstuck (set-Help.dc.html): setup, why a helper is quiet, plain words, and where to report problems. */
struct HelpView: View {
  @Environment(Store.self) private var store
  @State private var addingAgent = false
  @State private var action = FormAction()

  static let examples = [
    "Plan your meals for the week and write the shopping list.",
    "Draft a polite message or email for you to check and send.",
    "Summarize a long document into a few clear points.",
    "Keep notes on what matters to you, so you don't repeat yourself.",
    "Check a website and tell you what changed.",
    "Help sort your inbox, once you connect Gmail.",
  ]

  static let glossary: [(term: String, meaning: String)] = [
    ("Agent (helper)", "An AI helper you give work to, like a teammate. It has a name, remembers things, and works on a device."),
    ("Harness", "The AI program a helper runs on, like Claude Code or Codex. You pick it once when you make a helper."),
    ("Device", "A computer of yours with Wisp installed. Helpers do their work there."),
    ("Computer", "A desktop a helper can see and use, either a virtual one on your device or your own screen."),
    ("Memory", "Notes Wisp keeps about you and your work, so helpers don't need to be told twice. You can read and fix them."),
    ("Skill", "Something a helper has learned how to do, like a recipe it can follow again."),
    ("Routine", "A job a helper does on its own, on a schedule or when something happens."),
    ("Team", "A group of helpers that work on something together. Each team has its own, in the team's details."),
    ("Connected app", "A service you link to Wisp, like Gmail, so helpers can use it for you."),
    ("Connection code (token)", "A one-time code that links a computer to this Wisp. It's shown once when you add a device."),
    ("AI tokens", "How AI services measure and charge for work: more text, more tokens."),
  ]

  var body: some View {
    let devices = store.readyDevices
    let steps = Self.steps(hasHelper: !store.agents.isEmpty, hasDevice: !store.nodes.isEmpty || !(store.onboarding?.devices.isEmpty ?? true), reachable: store.onboarding?.reachable)
    let done = steps.filter(\.done).count
    let next = steps.first { !$0.done }
    SettingsPage("Help", id: "help") {
      CardLabel("Finish setup")
      VStack(alignment: .leading, spacing: 12) {
        HStack {
          Text(next == nil ? "Setup is done" : "\(done) of \(steps.count)").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text)
          Spacer()
        }
        ProgressView(value: Double(done), total: Double(steps.count)).tint(Palette.statusOnline)
        ForEach(steps, id: \.id) { step in
          HStack(spacing: 10) {
            Image(systemName: step.done ? "checkmark.circle.fill" : "circle").foregroundStyle(step.done ? Palette.statusOnline : Palette.faint)
            Text(step.title).font(.system(size: 15)).foregroundStyle(step.done ? Palette.muted : Palette.text)
            Spacer(minLength: 0)
          }.accessibilityElement(children: .combine)
        }
        if let next {
          if next.id == "agent", store.canManage { Button("Next: make a helper") { addingAgent = true }.buttonStyle(.pill(.primary)) }
          if next.id == "device" { Button { store.route = .device(id: nil) } label: { Text("Next: see computers").frame(maxWidth: .infinity) }.buttonStyle(.pill(.primary)) }
          if next.id == "anywhere", store.isOwner { NavigationLink { AccessView() } label: { Text("Next: use Wisp away from home").frame(maxWidth: .infinity) }.buttonStyle(.pill(.primary)) }
        }
      }
      .padding(18).frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
      CardLabel("My agent isn't answering")
      CardGroup {
        ForEach(Readiness.checks(agents: store.agents, devices: devices)) { ReadinessCheckRow(check: $0, store: store, makeHelper: { addingAgent = true }) }
      }
      CardHint("Go down this list. The first item marked “Needs fixing” is usually the reason. This updates by itself.")
      CardGroup {
        NavigationLink { HelpExamplesView() } label: { RowLabel(title: "What can Wisp do?") }.accessibilityIdentifier("help-examples")
        NavigationLink { HelpWordsView() } label: { RowLabel(title: "Words you'll see") }.accessibilityIdentifier("help-words")
        if let url = URL(string: "\(WispRepo.url)/issues") {
          Link(destination: url) { RowLabel(title: "Report a problem", subtitle: "Open an issue on GitHub", chevron: false) }.accessibilityIdentifier("help-report")
        }
      }
      CardHint("Something broken or confusing? Tell us what you were trying to do, what you expected, and what happened instead. Leave out passwords and private details.")
    }
    .task { try? await store.refreshOnboarding() }
    .sheet(isPresented: $addingAgent) { AddAgent { _ in } }
    .managementAlert(action)
  }

  struct Step: Equatable { var id: String; var title: String; var done: Bool }

  static func steps(hasHelper: Bool, hasDevice: Bool, reachable: Bool?) -> [Step] {
    [Step(id: "agent", title: "Make your first agent", done: hasHelper),
     Step(id: "device", title: "Connect a computer for it to work on", done: hasDevice),
     Step(id: "anywhere", title: "Use Wisp away from home", done: reachable != false)]
  }
}

struct HelpExamplesView: View {
  var body: some View {
    SettingsPage("What can Wisp do?", id: "help-examples-page") {
      BulletsCard(points: HelpView.examples)
      CardHint("Each of these needs a helper set up first, and some need a connected app, like Gmail. Wisp can only do what you connect it to.")
    }
  }
}

struct HelpWordsView: View {
  var body: some View {
    SettingsPage("Words you'll see", id: "help-words-page") {
      CardGroup {
        ForEach(HelpView.glossary, id: \.term) { item in
          VStack(alignment: .leading, spacing: 4) {
            Text(item.term).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text)
            Text(item.meaning).font(.system(size: 15)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
          }
          .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 18).padding(.vertical, 14)
          .accessibilityElement(children: .combine)
        }
      }
    }
  }
}

/** One line of "My agent isn't answering": fine, needs fixing, or can't tell yet. */
struct ReadinessCheckRow: View {
  var check: Readiness.Check
  var store: Store
  var makeHelper: () -> Void

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text(check.label).font(.system(size: 15)).foregroundStyle(check.status == .unknown ? Palette.muted : Palette.text)
        Text(check.status == .ok ? "Fine" : check.status == .bad ? "Needs fixing" : "Can't tell yet")
          .font(.system(size: 13)).foregroundStyle(check.status == .ok ? Palette.statusOnline : check.status == .bad ? Palette.red : Palette.faint)
        if check.status == .bad, let fix = check.fix { Text(fix).font(.system(size: 13)).foregroundStyle(Palette.faint).fixedSize(horizontal: false, vertical: true) }
      }
      Spacer(minLength: 8)
      if check.status == .bad { fixLink }
    }
    .padding(.horizontal, 18).padding(.vertical, 12).frame(minHeight: 62)
    .accessibilityElement(children: .contain)
  }

  @ViewBuilder private var fixLink: some View {
    switch check.to {
    case .makeHelper: if store.canManage { Button("Fix this", action: makeHelper).buttonStyle(.pill(.secondary, small: true)) }
    case .chooseDevice(let id), .chooseModel(let id):
      if let a = store.agent(id) { NavigationLink { AgentPage(agent: a) } label: { Text("Fix this") }.buttonStyle(.pill(.secondary, small: true)) }
    case .devices: Button { store.route = .device(id: nil) } label: { Text("Fix this") }.buttonStyle(.pill(.secondary, small: true))
    case nil: EmptyView()
    }
  }
}
