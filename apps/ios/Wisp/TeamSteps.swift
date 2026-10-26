import SwiftUI

// The team flowchart builder on the phone: a vertical flow with steps that run at the same time
// side by side, a "How it works" tab written from the chart, and sheets for each step.

extension Palette {
  /** a number badge or small chip on a card */
  static let badge = Color(light: 0x000000, lightAlpha: 0.07, dark: 0xFFFFFF, darkAlpha: 0.10)
}

struct StepRef: Identifiable, Hashable { var id: String }

/** Where "Add a step" puts the new step. */
struct AddRequest: Identifiable {
  let id = UUID()
  /** between these steps (empty `from` = at the start, empty `to` = at the end) */
  var from: [String]
  var to: [String]
  /** or just after this step, chosen in the sheet */
  var after: String?
  var between: Bool
}

extension ChannelTeam.Step {
  /** The line and icon a card shows for steps that aren't plain agent steps. */
  var kindMark: (symbol: String, text: String)? {
    switch kind {
    case .do: nil
    case .review: ("arrow.triangle.2.circlepath", "Repeats until approved")
    case .ask: ("person.crop.circle.badge.checkmark", "Asks you")
    case .handoff: ("arrow.up.forward.square", "Hands off")
    case .branch: ("arrow.triangle.branch", "If / else")
    case .handOut: ("square.split.2x2", "Splits the work")
    case .custom: ("slider.horizontal.3", "Custom")
    }
  }

  static func kindName(_ kind: Kind) -> String {
    switch kind {
    case .do: "Agent"
    case .review: "Repeat until approved"
    case .handOut: "Split the work"
    case .ask: "Ask me"
    case .handoff: "Hand off to a team"
    case .branch: "If / else"
    case .custom: "Custom"
    }
  }
}

// MARK: the builder

struct TeamBuilder: View {
  enum Tab { case steps, how }

  @Environment(Store.self) private var store
  @Binding var team: ChannelTeam
  var name: String
  /** the team's channel once it exists (to save it as a template) */
  var channelId: String? = nil
  /** the template saves the team as the hub has it, so not while there are changes that aren't saved */
  var canSaveTemplate = true
  var saving = false
  /** what the hub said when saving didn't work */
  var error: String? = nil
  var onBack: () -> Void
  var onDone: () -> Void
  @State private var tab = Tab.steps
  @State private var editing: StepRef?
  @State private var adding: AddRequest?
  @State private var reordering = false
  @State private var templates = false
  @State private var naming = false
  @State private var templateName = ""
  @State private var action = FormAction()
  @State private var savedTemplate = false

  private var steps: [ChannelTeam.Step] { team.steps ?? [] }
  private var problems: [String] { team.stepsProblems }

  var body: some View {
    ZStack {
      Palette.ground.ignoresSafeArea()
      VStack(spacing: 0) {
        topBar.managementAlert(action)
        if steps.isEmpty { emptyState } else if tab == .steps { canvas } else { TeamHowList(team: team) { tab = .steps } }
      }
      if saving { SavingOverlay() }
    }
    .navigationBarHidden(true)
    .sheet(item: $editing) { ref in
      StepEditor(team: $team, stepId: ref.id, channelId: channelId) { editing = nil }
        .presentationDetents([.large]).presentationDragIndicator(.visible).presentationBackground(Palette.sheet).presentationCornerRadius(Corner.sheet)
    }
    .sheet(item: $adding) { request in
      AddStepSheet(team: team, request: request) { kind, anchor in add(kind, request: request, anchor: anchor) }
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible).presentationBackground(Palette.sheet).presentationCornerRadius(Corner.sheet)
    }
    .sheet(isPresented: $reordering) {
      ReorderSteps(team: $team) { reordering = false }
        .presentationDetents([.large]).presentationDragIndicator(.visible).presentationBackground(Palette.sheet).presentationCornerRadius(Corner.sheet)
    }
    .sheet(isPresented: $templates) {
      TemplateBrowser(title: "Start from a template", onClose: { templates = false }) { template in
        templates = false
        team = template.team(agents: store.agents, base: team)
      }
      .presentationDetents([.large]).presentationDragIndicator(.visible).presentationBackground(Palette.sheet).presentationCornerRadius(Corner.sheet)
    }
    .alert("Save as template", isPresented: $naming) {
      TextField("Template name", text: $templateName)
      Button("Save") {
        let clean = String(templateName.trimmingCharacters(in: .whitespaces).prefix(60))
        guard let channelId, !clean.isEmpty else { return }
        savedTemplate = false
        action.run { try await store.saveTeamTemplate(channelId: channelId, name: clean); savedTemplate = true }
      }
      Button("Cancel", role: .cancel) {}
    } message: { Text("Anyone here can start a team from it. Who does each step is left out.") }
  }

  // MARK: top

  private var topBar: some View {
    VStack(spacing: 4) {
      TopBar {
        CircleButton(symbol: "chevron.left", label: "Back", id: "builder-back", action: onBack)
      } center: {
        HStack(spacing: 0) {
          tabButton("Steps", .steps)
          tabButton("How it works", .how)
        }
        .padding(4)
        .glassPill()
      } trailing: {
        CircleButton(symbol: "checkmark", label: "Done", id: "builder-done") { if problems.isEmpty && !steps.isEmpty { onDone() } }
          .opacity(problems.isEmpty && !steps.isEmpty ? 1 : 0.4)
          .disabled(saving)
      }
      HStack {
        Text(savedTemplate ? "Saved as a template" : name).font(.system(size: 15)).foregroundStyle(Palette.muted).lineLimit(1)
        Spacer()
        if !steps.isEmpty {
          Menu {
            Button("Reorder steps", systemImage: "arrow.up.arrow.down") { reordering = true }
            Button("Start from a template", systemImage: "square.grid.2x2") { templates = true }
            if channelId != nil && canSaveTemplate { Button("Save as template", systemImage: "square.and.arrow.down") { naming = true } }
          } label: {
            HStack(spacing: 4) {
              Text("\(steps.count) \(steps.count == 1 ? "step" : "steps")")
              Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold))
            }
            .font(.system(size: 15)).foregroundStyle(Palette.muted)
            .frame(minHeight: 44)
          }
          .accessibilityIdentifier("builder-more")
        }
      }
      .padding(.horizontal, 28)
    }
  }

  private func tabButton(_ title: String, _ value: Tab) -> some View {
    Button { withAnimation(.snappy(duration: 0.2)) { tab = value } } label: {
      Text(title).font(.system(size: 17, weight: .semibold))
        .foregroundStyle(tab == value ? Palette.text : Palette.muted)
        .padding(.horizontal, 18).frame(height: 44)
        .background { if tab == value { Capsule().fill(Palette.badge) } }
        .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier(value == .steps ? "builder-tab-steps" : "builder-tab-how")
    .accessibilityAddTraits(tab == value ? .isSelected : [])
  }

  // MARK: states

  private var emptyState: some View {
    VStack(spacing: 14) {
      Spacer()
      Image(systemName: "point.3.connected.trianglepath.dotted").font(.system(size: 34)).foregroundStyle(Palette.faint)
      Text("No steps yet").font(.system(size: 22, weight: .semibold)).foregroundStyle(Palette.text)
      Text("A step is an agent doing one thing. Add more and join them up.")
        .font(.system(size: 16)).foregroundStyle(Palette.muted).multilineTextAlignment(.center).padding(.horizontal, 40)
      Button { adding = AddRequest(from: [], to: [], after: nil, between: false) } label: {
        Label("Add a step", systemImage: "plus").frame(maxWidth: .infinity)
      }
      .primaryButton().padding(.horizontal, 40).padding(.top, 8)
      .accessibilityIdentifier("builder-add-first")
      Button("Or start from a template") { templates = true }
        .font(.system(size: 16)).foregroundStyle(Palette.muted).frame(minHeight: 44)
        .accessibilityIdentifier("builder-templates")
      Spacer(); Spacer()
    }
    .frame(maxWidth: .infinity)
  }

  // MARK: the flow

  private var canvas: some View {
    let rows = ChannelTeam.stepRows(steps)
    return ScrollView {
      VStack(spacing: 0) {
        if !problems.isEmpty || error != nil { problemBanner.padding(.bottom, 16) }
        Chip(symbol: "bubble.left", text: "A message comes in")
        ForEach(Array(rows.enumerated()), id: \.offset) { i, row in
          let before = i == 0 ? 0 : rows[i - 1].count
          Connector(from: before, to: row.count, plus: row.count == 1) {
            adding = AddRequest(from: i == 0 ? [] : rows[i - 1].map(\.id), to: row.map(\.id), after: nil, between: true)
          }
          HStack(alignment: .top, spacing: 10) {
            ForEach(row) { s in
              StepCard(team: team, step: s, wide: row.count == 1, problem: team.problem(of: s)) { editing = StepRef(id: s.id) } onGrip: { reordering = true }
            }
          }
          .padding(.horizontal, 18)
        }
        Connector(from: rows.last?.count ?? 0, to: 0, plus: true) {
          adding = AddRequest(from: rows.last?.map(\.id) ?? [], to: [], after: nil, between: true)
        }
        Chip(symbol: "flag", text: "Done")
        Button { adding = AddRequest(from: [], to: [], after: ChannelTeam.stepOrder(steps).last?.id, between: false) } label: {
          Label("Add a step", systemImage: "plus").frame(maxWidth: .infinity)
        }
        .primaryButton().padding(.horizontal, 60).padding(.top, 28).padding(.bottom, 40)
        .accessibilityIdentifier("builder-add")
      }
      .padding(.top, 8)
    }
    .scrollIndicators(.hidden)
  }

  private var problemBanner: some View {
    VStack(alignment: .leading, spacing: 6) {
      Label(error != nil ? "Couldn't save" : "\(problems.count) \(problems.count == 1 ? "thing" : "things") to fix", systemImage: "exclamationmark.circle")
        .font(.system(size: 16, weight: .semibold)).foregroundStyle(Palette.red)
      ForEach(error.map { [$0] } ?? problems, id: \.self) { p in
        Text(p).font(.system(size: 15)).foregroundStyle(Palette.text).fixedSize(horizontal: false, vertical: true)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(16)
    .background(Palette.red.opacity(0.12), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    .padding(.horizontal, 18)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("builder-problems")
  }

  // MARK: adding

  private func add(_ kind: AddKind, request: AddRequest, anchor: String?) {
    // between two rows, "after" is the row above (the sheet's own pick only applies to "Add a step")
    let anchor = anchor ?? request.after ?? request.from.last
    let fresh = newStep(kind, anchor: anchor)
    var next = team
    switch kind {
    case .beside:
      next = next.inserting(fresh, beside: anchor)
    default:
      if request.between {
        next = next.insertingBetween(fresh, from: request.from, to: request.to)
      } else if anchor != nil {
        next = next.inserting(fresh, after: anchor)
      } else {
        next = next.inserting(fresh, atEnd: !steps.isEmpty)
      }
    }
    team = next
    adding = nil
    // straight to the new step, to say what it does
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { editing = StepRef(id: fresh.id) }
  }

  /** A new step of this kind with sensible words in it. */
  private func newStep(_ kind: AddKind, anchor: String?) -> ChannelTeam.Step {
    let id = team.freeStepId()
    let anchorStep = team.step(anchor)
    let agent = anchorStep.flatMap { team.agentId(of: $0) } ?? steps.compactMap { team.agentId(of: $0) }.last ?? store.agents.first?.id
    switch kind {
    case .agent, .beside: return .init(id: id, kind: .do, action: "New step", agentId: agent)
    case .review: return .init(id: id, kind: .review, action: "Check the work", sendBackTo: anchor, maxRounds: ChannelTeam.defaultRounds, agentId: agent)
    case .ask: return .init(id: id, kind: .ask, action: "Approve before it goes on", notifyPhone: true)
    case .handoff: return .init(id: id, kind: .handoff, action: "Hand off the work", waitForReply: true)
    case .branch: return .init(id: id, kind: .branch, action: "Decide where to go", maxRounds: ChannelTeam.defaultRounds, agentId: agent)
    case .custom: return .init(id: id, kind: .custom, action: "Custom step", agentId: agent)
    case .handOut: return .init(id: id, kind: .handOut, action: "Split the work", maxRounds: ChannelTeam.defaultRounds, handTo: [], agentId: agent)
    }
  }
}

extension ChannelTeam {
  /** Put a step in between: what `from` led to in `to` now goes through it. Empty `from` = a new start; empty `to` = the end. */
  func insertingBetween(_ step: Step, from: [String], to: [String]) -> ChannelTeam {
    var new = step
    new.inputs = []; new.nexts = []; new.next = nil
    var team = appending(new)
    let live = to.filter { self.step($0) != nil }
    // what leads into `to` is what goes through the new step (not just the row drawn above it, which can miss a join's other inputs)
    var sources = from
    if !live.isEmpty && !from.isEmpty {
      sources = []
      for b in live { for i in self.step(b)?.inputIds ?? [] where !sources.contains(i) { sources.append(i) } }
    }
    for a in sources {
      guard let src = self.step(a) else { continue }
      // an if/else's Yes and No live on the step, so cutting its arrow clears them: they go to the new step instead
      let arms = live.flatMap { Array(src.arms(to: $0)) }
      for b in live { team = team.disconnecting(a, b) }
      team = team.connecting(a, new.id, arms: arms)
    }
    for b in live { team = team.connecting(new.id, b) }
    return team
  }
}

// MARK: pieces of the flow

private struct Chip: View {
  var symbol: String
  var text: String
  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: symbol).font(.system(size: 13))
      Text(text).font(.system(size: 15))
    }
    .foregroundStyle(Palette.muted)
    .padding(.horizontal, 14).frame(height: 36)
    .background(Capsule().fill(Palette.card))
    .overlay(Capsule().strokeBorder(Palette.hairline))
    .accessibilityElement(children: .combine)
  }
}

/** The lines between two rows of steps, with a plus to put a step there (or "At the same time" where they split). */
private struct Connector: View {
  var from: Int
  var to: Int
  var plus: Bool
  var add: () -> Void

  var body: some View {
    let tall = from > 1 || to > 1
    ZStack {
      Canvas { context, size in
        let line = Palette.faint.opacity(0.55)
        var path = Path()
        let mid = size.width / 2
        let h = size.height
        func columns(_ n: Int) -> [CGFloat] { n <= 1 ? [mid] : (0..<n).map { (CGFloat($0) + 0.5) / CGFloat(n) * (size.width - 36) + 18 } }
        if from > 1 {
          for x in columns(from) { path.move(to: CGPoint(x: x, y: 0)); path.addLine(to: CGPoint(x: x, y: h * 0.28)); path.addLine(to: CGPoint(x: mid, y: h * 0.28)) }
        } else if from == 1 { path.move(to: CGPoint(x: mid, y: 0)); path.addLine(to: CGPoint(x: mid, y: h * 0.5)) }
        if to > 1 {
          for x in columns(to) { path.move(to: CGPoint(x: mid, y: h * 0.72)); path.addLine(to: CGPoint(x: x, y: h * 0.72)); path.addLine(to: CGPoint(x: x, y: h)) }
          path.move(to: CGPoint(x: mid, y: h * 0.28)); path.addLine(to: CGPoint(x: mid, y: h * 0.72))
        } else if to == 1 { path.move(to: CGPoint(x: mid, y: h * 0.5)); path.addLine(to: CGPoint(x: mid, y: h)) }
        context.stroke(path, with: .color(line), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
      }
      if to > 1 {
        Chip(symbol: "arrow.triangle.branch", text: "At the same time").scaleEffect(0.9)
      } else if plus {
        Button(action: add) {
          Image(systemName: "plus").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text)
            .frame(width: 34, height: 34).glassCircle()
        }
        .buttonStyle(.plain)
        .frame(width: 44, height: 44)
        .accessibilityLabel("Add a step here")
        .accessibilityIdentifier("builder-plus")
      }
    }
    .frame(height: tall ? 76 : 60)
  }
}

private struct StepCard: View {
  @Environment(Store.self) private var store
  var team: ChannelTeam
  var step: ChannelTeam.Step
  var wide: Bool
  var problem: String?
  var open: () -> Void
  var onGrip: () -> Void

  private var agent: Agent? { team.agentId(of: step).flatMap { store.agent($0) } }
  private var number: Int { team.number(of: step.id) }
  private var title: String { step.action.trimmingCharacters(in: .whitespaces).isEmpty ? "Untitled step" : step.action }

  var body: some View {
    Button(action: open) {
      HStack(alignment: .center, spacing: 14) {
        if wide { visual(size: 44) }
        VStack(alignment: .leading, spacing: 6) {
          HStack(spacing: 8) {
            Text("\(number)").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.muted)
              .frame(width: 24, height: 24).background(Circle().fill(Palette.badge))
            if let mark = step.kindMark {
              Label(mark.text, systemImage: mark.symbol).labelStyle(CompactLabel()).font(.system(size: 14)).foregroundStyle(Palette.muted).lineLimit(1)
            }
            Spacer(minLength: 0)
            if !wide {
              Button(action: onGrip) { Image(systemName: "circle.grid.2x3.fill").font(.system(size: 13)).foregroundStyle(Palette.faint).frame(width: 30, height: 30) }
                .buttonStyle(.plain).accessibilityLabel("Reorder steps")
            }
          }
          Text(title).font(.system(size: wide ? 19 : 17, weight: .semibold)).foregroundStyle(Palette.text)
            .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
          HStack(spacing: 8) {
            if !wide { visual(size: 22) }
            Text(who).font(.system(size: 15)).foregroundStyle(problem != nil && agent == nil && step.needsAgent ? Palette.red : Palette.muted).lineLimit(1)
            if step.inputIds.count > 0 {
              Text("Uses \(FlowWords.join(step.inputIds.map { String(team.number(of: $0)) }))")
                .font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.muted)
                .padding(.horizontal, 10).frame(height: 28).background(Capsule().fill(Palette.badge))
                .lineLimit(1)
            }
          }
          if let note = loopNote {
            Label(note, systemImage: "arrow.uturn.backward").labelStyle(CompactLabel()).font(.system(size: 13)).foregroundStyle(Palette.muted)
              .fixedSize(horizontal: false, vertical: true)
          }
          if let problem, !(agent == nil && step.needsAgent) {
            Text(problem).font(.system(size: 13)).foregroundStyle(Palette.red).fixedSize(horizontal: false, vertical: true)
          }
        }
        if wide {
          Button(action: onGrip) { Image(systemName: "circle.grid.2x3.fill").font(.system(size: 14)).foregroundStyle(Palette.faint).frame(width: 36, height: 44) }
            .buttonStyle(.plain).accessibilityLabel("Reorder steps")
        }
      }
      .padding(.horizontal, 16).padding(.vertical, 14)
      .frame(maxWidth: .infinity, minHeight: 84, alignment: .leading)
      .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
      .overlay { if problem != nil { RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.red.opacity(0.6), lineWidth: 1.5) } }
      .contentShape(RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Step \(number), \(title), \(who)")
    .accessibilityHint("Edit this step")
    .accessibilityIdentifier("step-card")
  }

  private var who: String {
    switch step.kind {
    case .ask: return "You"
    case .handoff: return step.handoffTo.flatMap { id in store.channels.first { $0.id == id }?.name }.map { "Team \($0)" } ?? "Pick a team"
    case .branch where step.rule != nil: return "A simple rule"
    default: return agent?.name ?? "Pick an agent"
    }
  }

  @ViewBuilder private func visual(size: CGFloat) -> some View {
    switch step.kind {
    case .ask:
      Text(initials).font(.system(size: size * 0.34, weight: .semibold)).foregroundStyle(Palette.muted)
        .frame(width: size, height: size).background(Circle().fill(Palette.badge))
    case .handoff:
      Image(systemName: "arrow.up.forward.square").font(.system(size: size * 0.45)).foregroundStyle(Palette.muted)
        .frame(width: size, height: size).background(Circle().fill(Palette.badge))
    case .branch where step.rule != nil:
      Image(systemName: "arrow.triangle.branch").font(.system(size: size * 0.45)).foregroundStyle(Palette.muted)
        .frame(width: size, height: size).background(Circle().fill(Palette.badge))
    default:
      if let agent { AgentAvatar(agent: agent, size: size, showStatus: false) }
      else { Image(systemName: "questionmark.circle").font(.system(size: size * 0.6)).foregroundStyle(Palette.faint).frame(width: size, height: size) }
    }
  }

  private var initials: String {
    let name = store.me?.preferredName ?? store.me?.name ?? ""
    let letters = name.split(separator: " ").prefix(2).compactMap { $0.first }
    return letters.isEmpty ? "You" : String(letters).uppercased()
  }

  /** where a repeat, ask-me or if/else sends work */
  private var loopNote: String? {
    switch step.kind {
    case .review:
      guard let b = step.sendBackTo, !b.isEmpty else { return nil }
      return "Sends back to step \(team.number(of: b)), up to \(step.maxRounds ?? ChannelTeam.defaultRounds) rounds"
    case .ask:
      guard let b = step.sendBackTo, !b.isEmpty else { return nil }
      return "Changes go back to step \(team.number(of: b))"
    case .branch:
      let yes = (step.ifTrue ?? "").isEmpty ? "the end" : "step \(team.number(of: step.ifTrue))"
      let no = (step.ifFalse ?? "").isEmpty ? "the end" : "step \(team.number(of: step.ifFalse))"
      return "Yes: \(yes). No: \(no)"
    default: return nil
    }
  }
}

/** A label whose icon sits close to its text. */
struct CompactLabel: LabelStyle {
  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: 5) { configuration.icon.font(.system(size: 12)); configuration.title }
  }
}

// MARK: how it works

/** The "How it works" tab: one plain line per step, written from the chart. */
struct TeamHowList: View {
  @Environment(Store.self) private var store
  var team: ChannelTeam
  var onEdit: (() -> Void)?
  @State private var copied = false

  var body: some View {
    let lines = team.flowLines(store)
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        Text("Made from your steps").font(.system(size: 15)).foregroundStyle(Palette.muted)
        ForEach(lines) { line in TeamHowLine(team: team, line: line) }
        Text("This is written from the chart. Change a step and it changes here.")
          .font(.system(size: 14)).foregroundStyle(Palette.faint).padding(.top, 4)
        HStack(spacing: 12) {
          Button {
            UIPasteboard.general.string = lines.map { "\($0.n). \($0.text)" }.joined(separator: "\n")
            copied = true
          } label: { Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc").frame(maxWidth: .infinity) }
            .secondaryButton().controlSize(.large)
          if let onEdit {
            Button(action: onEdit) { Label("Edit steps", systemImage: "square.and.pencil").frame(maxWidth: .infinity) }
              .secondaryButton().controlSize(.large)
          }
        }
        .padding(.top, 6)
      }
      .padding(.horizontal, 24).padding(.top, 12).padding(.bottom, 40)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

struct TeamHowLine: View {
  @Environment(Store.self) private var store
  var team: ChannelTeam
  var line: FlowLine
  var size: CGFloat = 30

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Text("\(line.n)").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.muted)
        .frame(width: 24, height: 24).background(Circle().fill(Palette.badge)).padding(.top, 4)
      who
      (Text(line.together ? "At the same time, " : "").foregroundColor(Palette.muted)
        + Text(line.together ? line.who : FlowWords.capitalized(line.who)).bold().foregroundColor(Palette.text)
        + Text(" \(line.rest).").foregroundColor(Palette.muted))
        .font(.system(size: 17)).fixedSize(horizontal: false, vertical: true).padding(.top, 4)
      Spacer(minLength: 0)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(line.n). \(line.text)")
  }

  @ViewBuilder private var who: some View {
    let step = team.step(line.stepId)
    if let step, step.kind == .ask {
      Image(systemName: "person.crop.circle").font(.system(size: size * 0.7)).foregroundStyle(Palette.muted).frame(width: size, height: size)
    } else if let step, step.kind == .handoff {
      Image(systemName: "arrow.up.forward.square").font(.system(size: size * 0.55)).foregroundStyle(Palette.muted).frame(width: size, height: size)
    } else if let step, let agent = team.agentId(of: step).flatMap({ store.agent($0) }) {
      AgentAvatar(agent: agent, size: size, showStatus: false)
    } else {
      Image(systemName: "questionmark.circle").font(.system(size: size * 0.6)).foregroundStyle(Palette.faint).frame(width: size, height: size)
    }
  }
}

extension ChannelTeam {
  /** The plain lines for this team with the names of its agents and teams filled in. */
  @MainActor func flowLines(_ store: Store) -> [FlowLine] {
    describeFlow(nameOf: { id in id.flatMap { store.agent($0)?.name } ?? "Someone" },
      teamName: { id in store.channels.first { $0.id == id }?.name ?? "another" })
  }
}

// MARK: reorder

/** Drag steps into a new order. A moved step leaves its place and follows the step above it. */
struct ReorderSteps: View {
  @Environment(Store.self) private var store
  @Binding var team: ChannelTeam
  var close: () -> Void
  @State private var order: [String] = []

  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: "Reorder", close: close)
      Text("Drag to reorder").font(.system(size: 15)).foregroundStyle(Palette.muted).padding(.bottom, 6)
      List {
        ForEach(order, id: \.self) { id in
          if let step = team.step(id) {
            HStack(spacing: 12) {
              Text("\(team.number(of: id))").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.muted)
                .frame(width: 26, height: 26).background(Circle().fill(Palette.badge))
              VStack(alignment: .leading, spacing: 2) {
                Text(step.action.isEmpty ? "Untitled step" : step.action).font(.system(size: 17, weight: .semibold)).foregroundStyle(Palette.text)
                Text(step.kindMark?.text ?? team.agentId(of: step).flatMap { store.agent($0)?.name } ?? "").font(.system(size: 14)).foregroundStyle(Palette.muted)
              }
              Spacer()
            }
            .listRowBackground(Palette.card)
            .frame(minHeight: 48)
          }
        }
        .onMove { from, to in
          var next = order
          let moved = from.map { next[$0] }
          next.move(fromOffsets: from, toOffset: to)
          order = next
          for id in moved {
            let i = next.firstIndex(of: id) ?? 0
            team = team.moving(id, after: i == 0 ? nil : next[i - 1])
          }
          // the list stays as dragged; numbers follow the chart
        }
      }
      .environment(\.editMode, .constant(.active))
      .groundBackground(Palette.sheet)
    }
    .background(Palette.sheet.ignoresSafeArea())
    .onAppear { order = team.listOrder }
  }
}

/** "Saving: telling the team how it works" over a screen. */
struct SavingOverlay: View {
  var body: some View {
    ZStack {
      Color.black.opacity(0.35).ignoresSafeArea()
      VStack(spacing: 10) {
        ProgressView()
        Text("Saving").font(.system(size: 17, weight: .semibold)).foregroundStyle(Palette.text)
        Text("Telling the team how it works").font(.system(size: 14)).foregroundStyle(Palette.muted)
      }
      .padding(28).background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("saving-overlay")
  }
}
