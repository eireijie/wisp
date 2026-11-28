import SwiftUI

/**
 * The first run on the phone (2026-11-26 canvas "Bubble AI onboarding flow", iPhone board), right
 * after pairing with a Bubble AI nobody has made an agent on yet: Your agent → How it starts → Which
 * AI app, then for Advanced, Make it yours, then its chat, where the picks are the person's first
 * message and the agent answers with the apps it suggests connecting (round 7). Like the web's Stage.tsx, it is
 * one stage that stays put while only the page under it changes: the progress line along the top,
 * Back, and the agent's own bubble, which travels from where it sat on one page to where it sits on
 * the next (each page marks the spot with an ObSlot) and resizes on the way, with one small squash.
 * Its eyes follow your finger anywhere on the screen and it leans a little towards it.
 *
 * The agent is made when "Your agent" is continued, so "Set up later" or closing the app later
 * always leaves a real agent. It can be closed for later from the first page; the Inbox still
 * offers to make an agent.
 */
struct OnboardingFlow: View {
  @Environment(Store.self) private var store
  var workspaceId: String
  /** the flow is over: open this chat (nil: there's no agent yet) */
  var onFinish: (_ channelId: String?) -> Void
  enum Step: String, CaseIterable { case agent, start, ai, yours, away }
  @State private var step = Step.agent
  @State private var forward = true
  @State private var stage = HostStage()
  @State private var loaded = false
  @State private var look = OnboardingLook.agent(color: OnboardingText.colors[0], shape: "classic")
  @State private var busy = false
  @State private var agentId: String?
  @State private var path = SetupPath.advanced
  @State private var goals = SetupGoals.start
  @State private var about = ""
  @State private var talk = SetupTalk.friendly
  @State private var checkIn = SetupCheckIn.morning
  /** its AI answered: the first run's own extras (a morning plan) can switch on at the end */
  @State private var answered = false
  /** the hub has no address that works away from home and the person can turn one on: the last page is Tailscale (board 16) */
  @State private var needsAway = false
  @ReduceMotion private var reduceMotion

  private var agent: Agent? { agentId.flatMap { store.agent($0) } }
  private var name: String { agent?.name ?? "your agent" }
  private var person: String { store.me?.preferredName ?? store.me?.name ?? "" }
  private var steps: [Step] { (path == .advanced ? [.agent, .start, .ai, .yours] : [.agent, .start, .ai]) + (needsAway ? [.away] : []) }
  private var progress: Double { Double((steps.firstIndex(of: step) ?? 0) + 1) / Double(steps.count + 1) }
  private var backTo: Step? {
    guard !busy else { return nil }
    switch step {
    case .agent: return nil
    case .start: return .agent
    case .ai: return .start
    // once its AI has answered, its chat is open: there's no going back to choose again
    case .yours: return answered ? nil : .ai
    // the first message has gone: nothing before this to change
    case .away: return nil
    }
  }

  /** the bubble shows the agent as it is once it exists, the look being picked before */
  private var bubbleLook: GhostLook { step == .agent ? look : agent?.settings?.appearance ?? look }
  private var tapBubble: (() -> Void)? {
    guard step == .agent, !busy else { return nil }
    return { nextShape() }
  }

  var body: some View {
    ZStack(alignment: .topLeading) {
      Palette.ground.ignoresSafeArea()
      ZStack {
        if loaded {
          page.environment(\.obPage, step.rawValue).id(step).transition(slide)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      TravellingBubble(page: step.rawValue, look: bubbleLook, seed: agentId ?? "host", mood: busy ? GhostMood.working : GhostMood.awake, onTap: tapBubble)
      chrome
    }
    .coordinateSpace(.named(ObStage.space))
    .environment(stage)
    .tint(Palette.text)
    .onAppear(perform: load)
    .accessibilityIdentifier("onboarding")
  }

  // MARK: the pages

  @ViewBuilder private var page: some View {
    switch step {
    case .agent:
      OnboardingAgentStep(workspaceId: workspaceId, look: $look, onBusy: { busy = $0 }) { id in
        agentId = id
        go(.start)
      }
    case .start:
      OnboardingStartStep(name: name, path: $path) {
        OnboardingAnswers.save(workspaceId) { $0.path = path.rawValue }
        // an owner's choice: it sets what the organization has switched on
        if store.role == "owner" { let f = path.features; Task { try? await store.setFeatures(f) } }
        let p = path.rawValue
        Task { try? await store.savePrefs(["experience": AnyEncodable(p)]) }
        go(.ai)
      }
    case .ai:
      if let agentId {
        OnboardingAIStep(workspaceId: workspaceId, agentId: agentId, onBusy: { busy = $0 }) { ok in
          answered = ok
          if path == .advanced { go(.yours) } else { Task { await afterLastPage() } }
        }
      }
    case .yours:
      OnboardingYoursStep(name: name, person: person, look: agent?.settings?.appearance ?? look, goals: $goals, about: $about, talk: $talk, checkIn: $checkIn, busy: busy) {
        Task { await saveYours() }
      }
    case .away:
      OnboardingAwayStep { Task { await finish() } }
    }
  }

  /** The progress line, and Back (Close on the first page). */
  private var chrome: some View {
    VStack(alignment: .leading, spacing: 8) {
      GeometryReader { g in
        Capsule().fill(Palette.text).frame(width: g.size.width * progress, height: 3)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(Capsule().fill(Palette.hairline))
          .animation(Motion.pick(.spring(response: 0.7, dampingFraction: 0.9), reduceMotion), value: progress)
      }
      .frame(height: 3)
      .accessibilityElement()
      .accessibilityLabel("Step \((steps.firstIndex(of: step) ?? 0) + 1) of \(steps.count)")
      ZStack(alignment: .leading) {
        if let backTo {
          CircleButton(symbol: "chevron.left", label: "Back", size: 36, id: "ob-back") { go(backTo) }.transition(.opacity)
        } else if step == .agent, agentId == nil, !busy {
          CircleButton(symbol: "xmark", label: "Close", size: 36, id: "ob-close") { Task { await finish() } }.transition(.opacity)
        }
      }
      .padding(.leading, 16)
    }
    .animation(Motion.pick(Motion.fade, reduceMotion), value: backTo)
  }

  /** The new page slides in from the side it's headed and fades; the one before slides away. */
  private var slide: AnyTransition {
    reduceMotion ? .opacity : .asymmetric(insertion: .offset(x: forward ? 40 : -40).combined(with: .opacity),
                                          removal: .offset(x: forward ? -40 : 40).combined(with: .opacity))
  }

  private func go(_ next: Step) {
    forward = (Step.allCases.firstIndex(of: next) ?? 0) >= (Step.allCases.firstIndex(of: step) ?? 0)
    withAnimation(Motion.pick(.spring(response: 0.5, dampingFraction: 0.9), reduceMotion)) { step = next }
  }

  /** Tapping the bubble on "Your agent": the next shape, with a hop. */
  private func nextShape() {
    let i = OnboardingText.shapes.firstIndex(of: look.shape ?? "classic") ?? 0
    let shape = OnboardingText.shapes[(i + 1) % OnboardingText.shapes.count]
    look = OnboardingLook.agent(color: look.color, shape: shape)
    stage.react(.hop)
  }

  // MARK: moving on

  /** After the last of the usual pages: Tailscale when this Bubble AI is only reachable at home, else its chat. */
  private func afterLastPage() async {
    if needsAway { go(.away) } else { await finish() }
  }

  /** Owners only (they're the ones who can turn it on), and never for a Cloud server, which has its own address. */
  private func checkAway() async {
    guard store.isOwner, let info = try? await store.reach() else { return }
    needsAway = OnboardingAway.needed(info)
  }

  private func load() {
    guard !loaded else { return }
    Task { await checkAway() }
    let saved = OnboardingAnswers.load(workspaceId)
    if let id = saved.agentId, store.agent(id) != nil { agentId = id }
    if let p = saved.path.flatMap(SetupPath.init(rawValue:)) { path = p }
    // picks saved by an older first run (Email, Calendar…) aren't these: start from the usual two
    if let g = saved.goals?.filter({ id in SetupGoals.all.contains { $0.id == id } }), !g.isEmpty { goals = g }
    talk = saved.talk.flatMap(SetupTalk.init(rawValue:)) ?? talk
    checkIn = saved.checkIn.flatMap(SetupCheckIn.init(rawValue:)) ?? checkIn
    if let draft = saved.agentDraft { look = OnboardingLook.agent(color: draft.color, shape: draft.shape) }
    // after leaving mid-way, pick up at the first page not done yet
    step = agentId == nil ? .agent : saved.path == nil ? .start : .ai
    loaded = true
  }

  /**
   * Make it yours: the agent's instructions say what was picked, then the picks go to it as the
   * person's first message (POST /api/agents/:id/setup-picks, sent once) and it answers in its chat
   * with the apps it suggests connecting, Composio always among them. No goal → app lists here.
   */
  private func saveYours() async {
    guard let agent else { return }
    busy = true
    OnboardingAnswers.save(workspaceId) { $0.goals = goals; $0.talk = talk.rawValue; $0.checkIn = checkIn.rawValue }
    let instructions = SetupGoals.instructions(agent: agent.name, person: person, goals: goals, talk: talk, when: checkIn, about: about)
    _ = try? await store.updateAgent(agent.id, ["instructions": AnyEncodable(instructions), "settings": AnyEncodable(["role": AnyEncodable(SetupGoals.role(goals))] as Fields)])
    // the message they saw on the right is the one that goes, word for word
    let text = SetupGoals.introMessage(agent: agent.name, person: person, goals: goals, about: about, talk: talk, when: checkIn)
    try? await store.sendSetupPicks(agent.id, text: text, goals: goals)
    busy = false
    await afterLastPage()
  }

  /** The end: its chat opens (Show me around follows there). Closed before an agent exists: nothing opens. */
  private func finish() async {
    busy = true
    var channelId: String?
    if let agentId {
      for _ in 0..<8 {
        await store.refreshChannels()
        channelId = store.dmChannel(of: agentId)?.id
        if channelId != nil { break }
        try? await Task.sleep(for: .seconds(1))
      }
      if answered { await switchOnRecommended(agentId, channelId: channelId) }
    }
    OnboardingAnswers.save(workspaceId) { $0.closed = true }
    busy = false
    onFinish(channelId)
  }

  /** Once it can answer: one morning plan from what it helps with, only when there's something to build it from. Runs once. */
  private func switchOnRecommended(_ agentId: String, channelId: String?) async {
    guard !OnboardingAnswers.load(workspaceId).setupDone else { return }
    if path == .advanced, checkIn == .morning, let plan = OnboardingText.morningPlan(person: person, role: SetupGoals.role(goals)) {
      if store.role == "owner", !store.features.routines {
        var next = store.features
        next.routines = true
        try? await store.setFeatures(next)
      }
      let fields: Fields = ["agentId": AnyEncodable(agentId), "name": AnyEncodable(plan.name), "schedule": AnyEncodable(plan.schedule),
                            "timezone": AnyEncodable(TimeZone.current.identifier), "channelId": channelId.map { AnyEncodable($0) } ?? .null]
      try? await store.saveRoutine(nil, fields: fields, steps: plan.steps)
    }
    OnboardingAnswers.save(workspaceId) { $0.setupDone = true }
  }
}

/**
 * The stage's one bubble. It is drawn big once and scaled to each page's slot, so travelling and
 * resizing are one move: a spring from the old slot to the new one, with a squash on the way.
 * Scrolling a page moves it with the page, without a spring.
 */
private struct TravellingBubble: View {
  @Environment(HostStage.self) private var stage
  var page: String
  var look: GhostLook
  var seed: String
  var mood: GhostMood
  var onTap: (() -> Void)?
  static let drawn: CGFloat = 180
  @State private var at: CGRect?
  @State private var placedOn: String?
  @State private var hops = 0
  @State private var travelUntil = Date.distantPast
  @State private var lean = Lean()
  @ReduceMotion private var reduceMotion

  var body: some View {
    let target = stage.slots[page]
    ZStack {
      if let at {
        TimelineView(.animation(paused: reduceMotion)) { ctx in
          HostGhost(look: look, size: Self.drawn, mood: mood)
            .rotationEffect(.degrees(reduceMotion ? 0 : lean.tilt(ctx.date, x: at.midX)), anchor: .bottom)
        }
        .keyframeAnimator(initialValue: Squash(), trigger: hops) { content, s in
          content.scaleEffect(x: s.x, y: s.y)
        } keyframes: { _ in
          KeyframeTrack(\.x) {
            CubicKeyframe(1.07, duration: 0.2)
            CubicKeyframe(0.95, duration: 0.29)
            CubicKeyframe(1, duration: 0.33)
          }
          KeyframeTrack(\.y) {
            CubicKeyframe(0.93, duration: 0.2)
            CubicKeyframe(1.05, duration: 0.29)
            CubicKeyframe(1, duration: 0.33)
          }
        }
        .frame(width: Self.drawn, height: Self.drawn)
        .scaleEffect(at.width / Self.drawn)
        .frame(width: at.width, height: at.height)
        .contentShape(Circle())
        .onTapGesture { onTap?() }
        .allowsHitTesting(onTap != nil)
        .accessibilityElement()
        .accessibilityLabel("Another shape")
        .accessibilityAddTraits(.isButton)
        .accessibilityHidden(onTap == nil)
        .accessibilityAction { onTap?() }
        .accessibilityIdentifier("ob-bubble")
        .position(x: at.midX, y: at.midY)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .onChange(of: target, initial: true) { _, new in place(new) }
  }

  private func place(_ new: CGRect?) {
    guard let new, new.width > 1 else { return }
    let arriving = placedOn != page
    if arriving {
      travelUntil = .now.addingTimeInterval(0.9)
      if at != nil, !reduceMotion { hops += 1 }
      placedOn = page
    }
    if at == nil || reduceMotion || (!arriving && Date.now > travelUntil) {
      var t = Transaction(animation: nil)
      t.disablesAnimations = true
      withTransaction(t) { at = new }
    } else {
      withAnimation(.spring(response: 0.8, dampingFraction: 0.86)) { at = new }
    }
  }

  struct Squash { var x: CGFloat = 1; var y: CGFloat = 1 }

  /** A slight lean towards the finger, eased; upright again when it lifts. */
  final class Lean {
    var value: Double = 0
    var last: Date?
    func tilt(_ now: Date, x: CGFloat) -> Double {
      let width = UIScreen.main.bounds.width
      let target = BubbleTouch.point.map { max(-1, min(1, Double(($0.x - x) / max(120, width / 2)))) * 6 } ?? 0
      let dt = min(0.1, last.map { now.timeIntervalSince($0) } ?? 0.016)
      last = now
      value += (target - value) * (1 - exp(-dt / 0.18))
      return value
    }
  }
}
