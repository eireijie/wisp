import SwiftUI

/** Where a beginner gets unstuck: setup, why a helper is quiet, plain words, and where to report problems (the web's Help page). */
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
    ("Team", "A group of helpers that work on something together. Each channel has its own, in the channel's Team tab."),
    ("Connected app", "A service you link to Wisp, like Gmail, so helpers can use it for you."),
    ("Connection code (token)", "A one-time code that links a computer to this Wisp. It's shown once when you add a device."),
    ("AI tokens", "How AI services measure and charge for work: more text, more tokens."),
  ]

  var body: some View {
    let devices = store.readyDevices
    List {
      setup
      Section {
        ForEach(Readiness.checks(agents: store.agents, devices: devices)) { ReadinessCheckRow(check: $0, store: store, makeHelper: { addingAgent = true }) }
      } header: { Text("My helper isn't answering") } footer: {
        Text("Go down this list. The first item marked “Needs fixing” is usually the reason. This updates by itself.")
      }
      Section {
        ForEach(Self.examples, id: \.self) { Text($0).font(.subheadline) }
      } header: { Text("What can Wisp do?") } footer: {
        Text("Each of these needs a helper set up first, and some need a connected app, like Gmail. Wisp can only do what you connect it to.")
      }
      Section("Words you'll see") {
        ForEach(Self.glossary, id: \.term) { item in
          VStack(alignment: .leading, spacing: 3) {
            Text(item.term).font(.subheadline.weight(.semibold))
            Text(item.meaning).font(.subheadline).foregroundStyle(.secondary)
          }.padding(.vertical, 2).accessibilityElement(children: .combine)
        }
      }
      Section {
        Text("**Simple** shows the everyday parts first, with advanced options a tap away. **Advanced** shows everything, including teams, harness details, VM sizes, tokens and raw files.")
          .font(.subheadline).foregroundStyle(.secondary)
        LabeledContent("You're using", value: store.simple ? "Simple" : "Advanced")
        Button("Switch to \(store.simple ? "Advanced" : "Simple")") {
          action.run { try await store.savePrefs(["experience": AnyEncodable(store.simple ? "advanced" : "simple")]) }
        }.disabled(action.busy)
      } header: { Text("Simple or Advanced") }
      Section {
        Text("Something broken or confusing? Tell us what you were trying to do, what you expected, and what happened instead. Leave out passwords and private details.")
          .font(.subheadline).foregroundStyle(.secondary)
        if let url = URL(string: "\(WispRepo.url)/issues") { Link(destination: url) { Label("Open an issue on GitHub", systemImage: "arrow.up.right.square") } }
      } header: { Text("Report a problem") }
    }
    .listStyle(.insetGrouped)
    .navigationTitle("Help")
    .navigationBarTitleDisplayMode(.inline)
    .task { try? await store.refreshOnboarding() }
    .refreshable { try? await store.refreshOnboarding() }
    .sheet(isPresented: $addingAgent) { AddAgent { _ in } }
    .managementAlert(action)
  }

  /** The setup steps this phone can tell about, from what the hub reports. */
  private var setup: some View {
    let steps = Self.steps(hasHelper: !store.agents.isEmpty, hasDevice: !store.nodes.isEmpty || !(store.onboarding?.devices.isEmpty ?? true), reachable: store.onboarding?.reachable)
    let done = steps.filter(\.done).count
    let next = steps.first { !$0.done }
    return Section {
      ProgressView(value: Double(done), total: Double(steps.count)) { Text("\(done) of \(steps.count) steps done").font(.subheadline) }
      if let next {
        LabeledContent("Next", value: next.title)
        if next.id == "agent", store.canManage { Button("Make a helper") { addingAgent = true } }
        if next.id == "device" { NavigationLink("See devices") { DevicesView() } }
      } else {
        Text("Setup is done. You're ready to go.").foregroundStyle(.secondary)
      }
    } header: { Text("Finish setup") }
  }

  struct Step: Equatable { var id: String; var title: String; var done: Bool }

  static func steps(hasHelper: Bool, hasDevice: Bool, reachable: Bool?) -> [Step] {
    [Step(id: "agent", title: "Make your first agent", done: hasHelper),
     Step(id: "device", title: "Connect a computer for it to work on", done: hasDevice),
     Step(id: "anywhere", title: "Use Wisp away from home", done: reachable != false)]
  }
}

/** One line of "My helper isn't answering": working, needs fixing, or can't tell yet. */
struct ReadinessCheckRow: View {
  var check: Readiness.Check
  var store: Store
  var makeHelper: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: check.status == .ok ? "checkmark.circle" : check.status == .bad ? "exclamationmark.triangle" : "questionmark.circle")
          .foregroundStyle(check.status == .bad ? Color.orange : Color.secondary)
        VStack(alignment: .leading, spacing: 2) {
          Text(check.label).font(.subheadline).foregroundStyle(check.status == .unknown ? .secondary : .primary)
          if check.status == .ok { EmptyView() } else {
            Text(check.status == .bad ? "Needs fixing" : "Can't tell yet").font(.caption).foregroundStyle(.secondary)
          }
          if check.status == .bad, let fix = check.fix { Text(fix).font(.caption).foregroundStyle(.secondary) }
        }
      }
      if check.status == .bad { fixLink }
    }
    .accessibilityElement(children: .contain)
  }

  @ViewBuilder private var fixLink: some View {
    switch check.to {
    case .makeHelper: if store.canManage { Button("Fix this", action: makeHelper).buttonStyle(.borderless) }
    case .chooseDevice(let id), .chooseModel(let id):
      if let a = store.agent(id) { NavigationLink("Fix this") { AgentPage(agent: a) } }
    case .devices: NavigationLink("Fix this") { DevicesView() }
    case nil: EmptyView()
    }
  }
}
