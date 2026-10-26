import SwiftUI

// The sheets of the builder: add a step, and edit one (each kind has its own fields).

enum AddKind: CaseIterable {
  case agent, beside, review, ask, handoff, branch, custom, handOut
}

private func uid(_ prefix: String) -> String {
  "\(prefix)-\(String((0..<5).map { _ in "abcdefghijklmnopqrstuvwxyz0123456789".randomElement()! }))"
}

// MARK: add a step

struct AddStepSheet: View {
  var team: ChannelTeam
  var request: AddRequest
  var onPick: (AddKind, String?) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var anchor: String?

  private var steps: [ChannelTeam.Step] { team.orderedSteps }
  private var empty: Bool { steps.isEmpty }

  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: "Add a step") { dismiss() }
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          if !request.between && !empty {
            HStack {
              Text("After").font(.system(size: 17)).foregroundStyle(Palette.muted)
              Menu {
                ForEach(steps) { s in Button("\(team.number(of: s.id)). \(s.action.isEmpty ? "Untitled step" : s.action)") { anchor = s.id } }
              } label: {
                HStack(spacing: 6) {
                  Text(team.step(anchor).map { $0.action.isEmpty ? "Untitled step" : $0.action } ?? "").font(.system(size: 17, weight: .semibold)).foregroundStyle(Palette.text).lineLimit(1)
                  Image(systemName: "chevron.up.chevron.down").font(.system(size: 12)).foregroundStyle(Palette.faint)
                }
                .padding(.horizontal, 14).frame(height: 44).glassPill()
              }
              .accessibilityIdentifier("add-after")
              Spacer()
            }
            .padding(.horizontal, 18)
          }
          CardGroup {
            ForEach(kinds, id: \.self) { kind in
              Button { onPick(kind, anchor) } label: {
                RowLabel(title: title(kind), subtitle: blurb(kind), chevron: false) {
                  Image(systemName: symbol(kind)).font(.system(size: 18)).foregroundStyle(Palette.muted).frame(width: 28)
                }
              }
              .buttonStyle(.plain)
              .accessibilityIdentifier("add-\(String(describing: kind))")
            }
          }
          .padding(.horizontal, 18)
        }
        .padding(.top, 6).padding(.bottom, 30)
      }
    }
    .background(Palette.sheet.ignoresSafeArea())
    .onAppear { anchor = request.between ? nil : (request.after ?? steps.last?.id) }
  }

  private var kinds: [AddKind] {
    empty ? [.agent, .custom, .handOut] : request.between && request.from.isEmpty ? [.agent, .ask, .handoff, .branch, .custom, .handOut]
      : [.agent, .beside, .review, .ask, .handoff, .branch, .custom, .handOut]
  }

  private func title(_ k: AddKind) -> String {
    switch k {
    case .agent: "Agent step"
    case .beside: "Side by side"
    case .review: "Repeat until approved"
    case .ask: "Ask me"
    case .handoff: "Hand off to another team"
    case .branch: "If / else"
    case .custom: "Fully custom"
    case .handOut: "Split the work"
    }
  }

  private func blurb(_ k: AddKind) -> String {
    switch k {
    case .agent: "An agent does one thing."
    case .beside: "Runs at the same time as the step above."
    case .review: "A checker sends it back, up to a limit."
    case .ask: "Waits for your yes."
    case .handoff: "Another team takes it from here."
    case .branch: "Go one way or the other."
    case .custom: "Write your own rules."
    case .handOut: "An agent hands pieces to others."
    }
  }

  private func symbol(_ k: AddKind) -> String {
    switch k {
    case .agent: "person.crop.circle"
    case .beside: "arrow.triangle.branch"
    case .review: "arrow.triangle.2.circlepath"
    case .ask: "person.crop.circle.badge.checkmark"
    case .handoff: "arrow.up.forward.square"
    case .branch: "arrow.triangle.swap"
    case .custom: "slider.horizontal.3"
    case .handOut: "square.split.2x2"
    }
  }
}

// MARK: building blocks

/** A caption over a card, and a note under it. */
private struct Field<Content: View>: View {
  var title: String
  var note: String? = nil
  @ViewBuilder var content: Content
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title).font(.system(size: 15)).foregroundStyle(Palette.muted).padding(.horizontal, 18)
      content
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
      if let note { Text(note).font(.system(size: 14)).foregroundStyle(Palette.faint).padding(.horizontal, 18) }
    }
  }
}

private struct AgentMenu: View {
  @Environment(Store.self) private var store
  @Binding var selection: String?
  var body: some View {
    Menu {
      ForEach(store.agents) { a in Button(a.name) { selection = a.id } }
      if store.agents.isEmpty { Text("Add an agent first") }
    } label: {
      HStack(spacing: 12) {
        if let a = selection.flatMap({ store.agent($0) }) {
          AgentAvatar(agent: a, size: 30, showStatus: false)
          Text(a.name).font(.system(size: 17)).foregroundStyle(Palette.text)
        } else {
          Image(systemName: "questionmark.circle").font(.system(size: 22)).foregroundStyle(Palette.faint).frame(width: 30, height: 30)
          Text("Pick an agent").font(.system(size: 17)).foregroundStyle(Palette.red)
        }
        Spacer()
        Image(systemName: "chevron.up.chevron.down").font(.system(size: 13)).foregroundStyle(Palette.faint)
      }
      .padding(.horizontal, 18).frame(minHeight: 56).contentShape(Rectangle())
    }
    .accessibilityIdentifier("step-agent")
  }
}

private struct TextRow: View {
  var placeholder: String
  @Binding var text: String
  var id: String
  /** what the hub accepts */
  var limit = 200
  var body: some View {
    TextField(placeholder, text: Binding(get: { text }, set: { text = String($0.prefix(limit)) }), axis: .vertical)
      .font(.system(size: 17)).foregroundStyle(Palette.text)
      .padding(.horizontal, 18).frame(minHeight: 56)
      .accessibilityIdentifier(id)
  }
}

private struct BigText: View {
  var placeholder: String
  @Binding var text: String
  var id: String
  var limit = 8000
  var body: some View {
    TextField(placeholder, text: Binding(get: { text }, set: { text = String($0.prefix(limit)) }), axis: .vertical)
      .lineLimit(4...14)
      .font(.system(size: 17)).foregroundStyle(Palette.text)
      .padding(18).frame(minHeight: 120, alignment: .topLeading)
      .accessibilityIdentifier(id)
  }
}

/** A step picked from a list ("Step 1 · Draft a plan"), with an optional "nowhere". */
private struct StepMenu: View {
  var team: ChannelTeam
  var candidates: [ChannelTeam.Step]
  @Binding var selection: String?
  var none: String?
  var id: String
  var body: some View {
    Menu {
      if let none { Button(none) { selection = nil } }
      ForEach(candidates) { s in Button("Step \(team.number(of: s.id)) · \(s.action.isEmpty ? "Untitled step" : s.action)") { selection = s.id } }
    } label: {
      HStack {
        Text(label).font(.system(size: 17)).foregroundStyle(selection == nil && none == nil ? Palette.red : Palette.text).lineLimit(1)
        Spacer()
        Image(systemName: "chevron.up.chevron.down").font(.system(size: 13)).foregroundStyle(Palette.faint)
      }
      .padding(.horizontal, 18).frame(minHeight: 56).contentShape(Rectangle())
    }
    .accessibilityIdentifier(id)
  }

  private var label: String {
    if let s = team.step(selection) { return "Step \(team.number(of: s.id)) · \(s.action.isEmpty ? "Untitled step" : s.action)" }
    return none ?? "Pick a step"
  }
}

private struct RoundsRow: View {
  @Binding var rounds: Int
  var body: some View {
    Stepper(value: $rounds, in: 1...ChannelTeam.maxRounds) {
      HStack {
        Text("Most rounds").font(.system(size: 17)).foregroundStyle(Palette.text)
        Spacer()
        Text("\(rounds) \(rounds == 1 ? "round" : "rounds")").font(.system(size: 17)).foregroundStyle(Palette.faint)
      }
    }
    .padding(.horizontal, 18).frame(minHeight: 56)
    .accessibilityIdentifier("step-rounds")
  }
}

// MARK: edit a step

struct StepEditor: View {
  @Environment(Store.self) private var store
  @Binding var team: ChannelTeam
  var stepId: String
  /** the team's own channel, once it exists (a team can't hand work to itself) */
  var channelId: String? = nil
  var close: () -> Void
  @State private var confirmDelete = false

  private var step: ChannelTeam.Step? { team.step(stepId) }

  var body: some View {
    VStack(spacing: 0) {
      header
      if let step {
        ScrollView {
          VStack(alignment: .leading, spacing: 22) {
            switch step.kind {
            case .do, .custom: agentStep(step)
            case .review: repeatStep(step)
            case .ask: askStep(step)
            case .handoff: handoffStep(step)
            case .branch: ifStep(step)
            case .handOut: splitStep(step)
            }
            Button(role: .destructive) { confirmDelete = true } label: {
              Label("Delete step", systemImage: "trash").font(.system(size: 17)).foregroundStyle(Palette.red)
                .frame(maxWidth: .infinity, minHeight: 54)
                .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("step-delete")
          }
          .padding(.horizontal, 18).padding(.top, 8).padding(.bottom, 40)
        }
        .scrollDismissesKeyboard(.interactively)
      } else {
        Spacer()
      }
    }
    .background(Palette.sheet.ignoresSafeArea())
    .confirmationDialog("Delete this step?", isPresented: $confirmDelete, titleVisibility: .visible) {
      Button("Delete step", role: .destructive) {
        team = team.removingStep(stepId)
        close()
      }
    } message: { Text("What led to it will lead to what came after it.") }
  }

  private var header: some View {
    ZStack {
      Text(step.map { $0.kind == .do || $0.kind == .custom ? "Step \(team.number(of: stepId))" : ChannelTeam.Step.kindName($0.kind) } ?? "Step")
        .font(.system(size: 19, weight: .semibold)).foregroundStyle(Palette.text)
      HStack {
        Spacer()
        Button("Done", action: close).secondaryButton().controlSize(.large).accessibilityIdentifier("step-done")
      }
    }
    .padding(.horizontal, 18).padding(.top, 16).padding(.bottom, 10)
  }

  // MARK: bindings

  private func bind<T>(_ key: WritableKeyPath<ChannelTeam.Step, T>, _ fallback: T) -> Binding<T> {
    Binding(get: { step?[keyPath: key] ?? fallback }, set: { v in team = team.updating(stepId) { $0[keyPath: key] = v } })
  }
  private func text(_ key: WritableKeyPath<ChannelTeam.Step, String?>) -> Binding<String> {
    Binding(get: { step?[keyPath: key] ?? "" }, set: { v in team = team.updating(stepId) { $0[keyPath: key] = v } })
  }
  private func optional(_ key: WritableKeyPath<ChannelTeam.Step, String?>) -> Binding<String?> {
    Binding(get: { let v = step?[keyPath: key]; return v?.isEmpty == false ? v : nil }, set: { v in team = team.updating(stepId) { $0[keyPath: key] = v } })
  }
  private var title: Binding<String> { Binding(get: { step?.action ?? "" }, set: { v in team = team.updating(stepId) { $0.action = v } }) }
  private var agent: Binding<String?> {
    Binding(get: { step.flatMap { team.agentId(of: $0) } }, set: { v in team = team.updating(stepId) { $0.agentId = v } })
  }
  private var rounds: Binding<Int> {
    Binding(get: { step?.maxRounds ?? ChannelTeam.defaultRounds }, set: { v in team = team.updating(stepId) { $0.maxRounds = v } })
  }

  /** the steps before this one, where work can go back to */
  private var earlier: [ChannelTeam.Step] {
    team.orderedSteps.filter { $0.id != stepId && ChannelTeam.stepsAfter(team.steps ?? [], $0.id).contains(stepId) }
  }

  // MARK: agent and custom

  @ViewBuilder private func agentStep(_ step: ChannelTeam.Step) -> some View {
    Field(title: "Who does it") { AgentMenu(selection: agent) }
    Field(title: "Title") { TextRow(placeholder: "What is this step called?", text: title, id: "step-title") }
    Field(title: step.kind == .custom ? "What it does (its rules)" : "What it does") {
      BigText(placeholder: "Tell the agent what to do here.", text: text(\.prompt), id: "step-prompt")
    }
    inputsField(step, title: "Uses the result of")
    whenField(step)
  }

  // MARK: repeat

  @ViewBuilder private func repeatStep(_ step: ChannelTeam.Step) -> some View {
    Field(title: "Title") { TextRow(placeholder: "e.g. Check the plan", text: title, id: "step-title") }
    Field(title: "Checked by") { AgentMenu(selection: agent) }
    Field(title: "What it does") {
      BigText(placeholder: "Read the work. Find what's wrong. Send it back with a short list, or approve it.", text: text(\.prompt), id: "step-prompt")
    }
    Field(title: "Sends it back to") {
      StepMenu(team: team, candidates: earlier, selection: optional(\.sendBackTo), none: nil, id: "step-sendback")
    }
    Field(title: "Limit", note: "After \(step.maxRounds ?? ChannelTeam.defaultRounds) rounds it asks you instead of going round again.") {
      RoundsRow(rounds: rounds)
    }
    inputsField(step, title: "Uses the result of")
    whenField(step)
  }

  // MARK: ask me

  @ViewBuilder private func askStep(_ step: ChannelTeam.Step) -> some View {
    Field(title: "Title") { TextRow(placeholder: "e.g. Approve before it ships", text: title, id: "step-title") }
    Field(title: "What you see") { BigText(placeholder: "What should you see with the question?", text: text(\.show), id: "step-show", limit: 2000) }
    inputsField(step, title: "Shows the result of")
    Field(title: "If you ask for changes") {
      StepMenu(team: team, candidates: earlier, selection: optional(\.sendBackTo), none: "Nowhere: it stops", id: "step-sendback")
    }
    Field(title: "Tell me") {
      Toggle("Tell me on my phone", isOn: bind(\.notifyPhone, false).wrapped(true))
        .font(.system(size: 17)).padding(.horizontal, 18).frame(minHeight: 56)
        .accessibilityIdentifier("step-notify")
    }
  }

  // MARK: hand off

  @ViewBuilder private func handoffStep(_ step: ChannelTeam.Step) -> some View {
    // not this team itself: the hub can't hand work to the team that is running it
    let teams = store.channels.filter { $0.kind == "channel" && $0.archivedAt == nil && $0.id != channelId }
    let target = teams.first { $0.id == step.handoffTo }
    Field(title: "Title") { TextRow(placeholder: "e.g. Tell support", text: title, id: "step-title") }
    Field(title: "Hand off to", note: teams.isEmpty ? "There are no other teams yet." : nil) {
      CardGroupInline {
        ForEach(teams) { t in
          Button { team = team.updating(stepId) { $0.handoffTo = t.id; if t.settings?.team?.hasSteps != true { $0.waitForReply = false } } } label: {
            HStack(spacing: 12) {
              Image(systemName: "person.2").font(.system(size: 17)).foregroundStyle(Palette.muted).frame(width: 28)
              Text(t.name).font(.system(size: 17)).foregroundStyle(Palette.text)
              Spacer()
              if step.handoffTo == t.id { Image(systemName: "checkmark").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.blue) }
            }
            .padding(.horizontal, 18).frame(minHeight: 54).contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityIdentifier("handoff-team")
        }
      }
    }
    Field(title: "What it does") { BigText(placeholder: "Tell them what to do with it.", text: text(\.prompt), id: "step-prompt") }
    // only a team with steps starts its own request that can be waited on; a plain team takes the work and that's all
    if target == nil || target?.settings?.team?.hasSteps == true {
      Field(title: "Wait for their answer", note: step.waitForReply == true ? "The next step gets what they send back." : nil) {
        Toggle("Wait for their answer", isOn: bind(\.waitForReply, false).wrapped(false))
          .font(.system(size: 17)).padding(.horizontal, 18).frame(minHeight: 56)
          .accessibilityIdentifier("step-wait")
      }
    }
    inputsField(step, title: "Hands over the result of")
    whenField(step)
  }

  // MARK: if / else

  @ViewBuilder private func ifStep(_ step: ChannelTeam.Step) -> some View {
    let others = team.orderedSteps.filter { $0.id != stepId }
    Field(title: "Title") { TextRow(placeholder: "e.g. Did the tests pass?", text: title, id: "step-title") }
    inputsField(step, title: "Look at")
    Field(title: "If") {
      VStack(alignment: .leading, spacing: 0) {
        Picker("How it decides", selection: Binding(get: { step.rule == nil }, set: { agentDecides in
          team = team.updating(stepId) { $0.rule = agentDecides ? nil : ChannelTeam.Step.Rule(op: .contains, value: "") }
        })) {
          Text("An agent decides").tag(true)
          Text("A simple rule").tag(false)
        }
        .pickerStyle(.segmented).padding(14)
        if let rule = step.rule {
          HStack {
            Text("The result").font(.system(size: 17)).foregroundStyle(Palette.muted)
            Menu {
              ForEach(ChannelTeam.Step.Rule.Op.allCases, id: \.self) { op in Button(op.label) { setRule(op: op) } }
            } label: {
              HStack(spacing: 4) { Text(rule.op.label); Image(systemName: "chevron.up.chevron.down").font(.system(size: 11)) }
                .font(.system(size: 17)).foregroundStyle(Palette.blue).frame(minHeight: 44)
            }
            Spacer()
          }
          .padding(.horizontal, 18)
          TextRow(placeholder: "the words to look for", text: Binding(get: { rule.value }, set: { setRule(value: $0) }), id: "step-rule-value", limit: 500)
        } else {
          TextRow(placeholder: "e.g. every test passed", text: text(\.condition), id: "step-condition", limit: 500)
        }
      }
    }
    if step.rule == nil {
      Field(title: "Decided by", note: "An agent reads the result and answers yes or no.") { AgentMenu(selection: agent) }
    }
    Field(title: "Then go to") {
      VStack(spacing: 0) {
        HStack {
          Text("Yes").font(.system(size: 17, weight: .semibold)).foregroundStyle(Palette.text).frame(width: 44, alignment: .leading)
          StepMenu(team: team, candidates: others, selection: branchTarget(yes: true), none: "The end", id: "step-yes")
        }
        .padding(.leading, 18)
        Rectangle().fill(Palette.separator).frame(height: 1).padding(.leading, 18)
        HStack {
          Text("No").font(.system(size: 17, weight: .semibold)).foregroundStyle(Palette.text).frame(width: 44, alignment: .leading)
          StepMenu(team: team, candidates: others, selection: branchTarget(yes: false), none: "The end", id: "step-no")
        }
        .padding(.leading, 18)
      }
    }
    if loops(step) {
      Field(title: "Limit", note: "Going back to an earlier step is a loop. After this many rounds it asks you.") { RoundsRow(rounds: rounds) }
    }
  }

  private func loops(_ step: ChannelTeam.Step) -> Bool {
    [step.ifTrue, step.ifFalse].compactMap { $0 }.contains { t in !t.isEmpty && ChannelTeam.stepGraph(team.steps ?? []).back[stepId]?.contains(t) == true }
  }

  private func setRule(op: ChannelTeam.Step.Rule.Op? = nil, value: String? = nil) {
    team = team.updating(stepId) { s in
      let old = s.rule ?? ChannelTeam.Step.Rule(op: .contains, value: "")
      s.rule = ChannelTeam.Step.Rule(op: op ?? old.op, value: value ?? old.value)
    }
  }

  /** Where yes or no goes. Changing it also takes the old arrow off both ends. */
  private func branchTarget(yes: Bool) -> Binding<String?> {
    Binding(get: { let v = yes ? step?.ifTrue : step?.ifFalse; return v?.isEmpty == false ? v : nil }, set: { new in
      guard let s = step else { return }
      var next = team
      let keepOther = yes ? s.ifFalse : s.ifTrue
      if let old = yes ? s.ifTrue : s.ifFalse, !old.isEmpty { next = next.disconnecting(stepId, old) }
      next = next.updating(stepId) { b in
        if yes { b.ifTrue = new; b.ifFalse = keepOther } else { b.ifFalse = new; b.ifTrue = keepOther }
      }
      team = next
    })
  }

  // MARK: split the work

  @ViewBuilder private func splitStep(_ step: ChannelTeam.Step) -> some View {
    Field(title: "Who hands it out") { AgentMenu(selection: agent) }
    Field(title: "Title") { TextRow(placeholder: "e.g. Hand out the pieces", text: title, id: "step-title") }
    Field(title: "What it does") { BigText(placeholder: "Split the work into pieces and say who gets each one.", text: text(\.prompt), id: "step-prompt") }
    Field(title: "Pieces go to", note: "Each role is one kind of worker. Pick who fills it.") {
      VStack(spacing: 0) {
        ForEach(Array((team.roles ?? []).enumerated()), id: \.element.id) { i, role in
          if i > 0 { Rectangle().fill(Palette.separator).frame(height: 1).padding(.leading, 18) }
          roleRow(role, step: step)
        }
        Button { addRole(to: step) } label: {
          Label("Add a role", systemImage: "plus").font(.system(size: 17)).foregroundStyle(Palette.text).frame(maxWidth: .infinity, minHeight: 54, alignment: .leading).padding(.horizontal, 18)
        }
        .buttonStyle(.plain)
      }
    }
    Field(title: "Each piece is checked by") {
      Menu {
        Button("Nobody") { team = team.updating(stepId) { $0.reviewBy = nil } }
        ForEach(team.roles ?? []) { r in Button(r.name) { team = team.updating(stepId) { $0.reviewBy = r.id } } }
      } label: {
        HStack {
          Text(team.role(step.reviewBy)?.name ?? "Nobody").font(.system(size: 17)).foregroundStyle(Palette.text)
          Spacer()
          Image(systemName: "chevron.up.chevron.down").font(.system(size: 13)).foregroundStyle(Palette.faint)
        }
        .padding(.horizontal, 18).frame(minHeight: 56).contentShape(Rectangle())
      }
    }
    Field(title: "Limit", note: "How many times a piece can go back before it asks you.") { RoundsRow(rounds: rounds) }
    inputsField(step, title: "Uses the result of")
  }

  @ViewBuilder private func roleRow(_ role: ChannelTeam.Role, step: ChannelTeam.Step) -> some View {
    let on = (step.handTo ?? []).contains(role.id)
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 12) {
        Button {
          team = team.updating(stepId) { s in
            var to = s.handTo ?? []
            if on { to.removeAll { $0 == role.id } } else { to.append(role.id) }
            s.handTo = to
          }
        } label: {
          Image(systemName: on ? "checkmark.circle.fill" : "circle").font(.system(size: 22)).foregroundStyle(on ? Palette.blue : Palette.faint).frame(width: 44, height: 44)
        }
        .buttonStyle(.plain).accessibilityLabel("\(role.name), \(on ? "on" : "off")")
        TextField("Role name", text: roleBinding(role.id, \.name)).font(.system(size: 17)).foregroundStyle(Palette.text)
        Menu {
          ForEach(store.agents) { a in Button(a.name) { setRole(role.id) { $0.agentId = a.id } } }
        } label: {
          HStack(spacing: 6) {
            if let a = role.agentId.flatMap({ store.agent($0) }) { AgentAvatar(agent: a, size: 24, showStatus: false); Text(a.name).foregroundStyle(Palette.muted) }
            else { Text("Pick an agent").foregroundStyle(Palette.red) }
          }
          .font(.system(size: 15)).frame(minHeight: 44)
        }
      }
      TextField("What this role does", text: roleBinding(role.id, \.description), axis: .vertical).lineLimit(1...4)
        .font(.system(size: 15)).foregroundStyle(Palette.muted).padding(.leading, 56)
    }
    .padding(.horizontal, 12).padding(.vertical, 6)
  }

  private func roleBinding(_ id: String, _ key: WritableKeyPath<ChannelTeam.Role, String>) -> Binding<String> {
    Binding(get: { team.role(id)?[keyPath: key] ?? "" }, set: { v in setRole(id) { $0[keyPath: key] = String(v.prefix(key == \.name ? 60 : 4000)) } })
  }

  private func setRole(_ id: String, _ change: (inout ChannelTeam.Role) -> Void) {
    var next = team
    next.roles = team.roles?.map { r in var r = r; if r.id == id { change(&r) }; return r }
    team = next
  }

  private func addRole(to step: ChannelTeam.Step) {
    var next = team
    let role = ChannelTeam.Role(id: uid("role"), name: "New role", description: "", agentId: store.agents.first?.id)
    next.roles = (team.roles ?? []) + [role]
    team = next.updating(stepId) { $0.handTo = ($0.handTo ?? []) + [role.id] }
  }

  // MARK: shared fields

  /** which steps' results this one gets (and waits for) */
  @ViewBuilder private func inputsField(_ step: ChannelTeam.Step, title: String) -> some View {
    let options = team.possibleInputs(for: stepId)
    if !options.isEmpty {
      Field(title: title) {
        VStack(spacing: 0) {
          ForEach(Array(options.enumerated()), id: \.element.id) { i, s in
            if i > 0 { Rectangle().fill(Palette.separator).frame(height: 1).padding(.leading, 18) }
            let on = step.inputIds.contains(s.id)
            Button {
              var ids = step.inputIds
              if on { ids.removeAll { $0 == s.id } } else { ids.append(s.id) }
              team = team.setting(inputs: ids, of: stepId)
            } label: {
              HStack(spacing: 12) {
                Text("\(team.number(of: s.id))").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.muted)
                  .frame(width: 26, height: 26).background(Circle().fill(Palette.badge))
                Text(s.action.isEmpty ? "Untitled step" : s.action).font(.system(size: 17)).foregroundStyle(Palette.text).lineLimit(1)
                Spacer()
                Image(systemName: on ? "checkmark.circle.fill" : "circle").font(.system(size: 22)).foregroundStyle(on ? Palette.blue : Palette.faint)
              }
              .padding(.horizontal, 18).frame(minHeight: 54).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Step \(team.number(of: s.id)), \(s.action), \(on ? "used" : "not used")")
            .accessibilityIdentifier("step-input")
          }
        }
      }
    }
  }

  /** when it runs: after the steps it uses, or with another step */
  @ViewBuilder private func whenField(_ step: ChannelTeam.Step) -> some View {
    let others = team.orderedSteps.filter { $0.id != stepId && !ChannelTeam.stepsAfter(team.steps ?? [], stepId).contains($0.id) }
    Field(title: "When it runs", note: step.inputIds.count > 1 ? "A step with two inputs waits for both." : nil) {
      Menu {
        if step.inputIds.isEmpty, let last = others.last {
          Button("When its inputs are ready") { team = team.setting(inputs: [last.id], of: stepId) }
        } else {
          Button("When its inputs are ready") {}.disabled(true)
        }
        Menu("At the same time as another step") {
          ForEach(others) { s in
            Button("\(team.number(of: s.id)). \(s.action.isEmpty ? "Untitled step" : s.action)") { startTogether(with: s) }
          }
        }
        Button("After I say go") { addGate(.ask) }
        Button("Only if") { addGate(.branch) }
      } label: {
        HStack {
          Text(whenText(step)).font(.system(size: 17)).foregroundStyle(Palette.text).multilineTextAlignment(.leading)
          Spacer()
          Image(systemName: "chevron.up.chevron.down").font(.system(size: 13)).foregroundStyle(Palette.faint)
        }
        .padding(.horizontal, 18).frame(minHeight: 56).contentShape(Rectangle())
      }
      .accessibilityIdentifier("step-when")
    }
  }

  private func whenText(_ step: ChannelTeam.Step) -> String {
    let ids = step.inputIds.map { team.number(of: $0) }.sorted()
    switch ids.count {
    case 0: return "At the start, with the first steps"
    case 1: return "After step \(ids[0]) finishes"
    default: return "After steps \(FlowWords.join(ids.map(String.init))) finish"
    }
  }

  /** Run with `other`: wait for what it waits for. */
  private func startTogether(with other: ChannelTeam.Step) {
    team = team.setting(inputs: other.inputIds, of: stepId)
  }

  /** "After I say go" / "Only if": a new ask-me or if/else step goes just before this one. */
  private func addGate(_ kind: ChannelTeam.Step.Kind) {
    let id = team.freeStepId()
    let gate: ChannelTeam.Step = kind == .ask
      ? .init(id: id, kind: .ask, action: "Say go", notifyPhone: true)
      : .init(id: id, kind: .branch, action: "Should it run?", maxRounds: ChannelTeam.defaultRounds, agentId: store.agents.first?.id, ifTrue: stepId)
    team = team.inserting(gate, before: stepId)
  }
}

private extension Binding where Value == Bool? {
  /** an optional flag as a plain switch (nil reads as `fallback`) */
  func wrapped(_ fallback: Bool) -> Binding<Bool> {
    Binding<Bool>(get: { wrappedValue ?? fallback }, set: { wrappedValue = $0 })
  }
}

/** Rows in a card without a second card behind them. */
private struct CardGroupInline<Content: View>: View {
  @ViewBuilder var content: Content
  var body: some View {
    VStack(spacing: 0) {
      Group(subviews: content) { subviews in
        ForEach(subviews.indices, id: \.self) { i in
          if i > 0 { Rectangle().fill(Palette.separator).frame(height: 1).padding(.leading, 18) }
          subviews[i]
        }
      }
    }
  }
}
