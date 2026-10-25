import SwiftUI

/** A role or a step being edited, pushed from the steps editor or a tap on the chart. */
enum TeamEditTarget: Hashable, Identifiable {
  case role(String), step(String)
  var id: String {
    switch self {
    case .role(let id): "role:\(id)"
    case .step(let id): "step:\(id)"
    }
  }
}

private extension ChannelTeam.Step.Kind {
  var label: String {
    switch self {
    case .do: "Does it"
    case .review: "Reviews"
    case .handOut: "Hands out"
    }
  }
}

private func uid(_ prefix: String) -> String {
  "\(prefix)-\(String((0..<5).map { _ in "abcdefghijklmnopqrstuvwxyz0123456789".randomElement()! }))"
}

// MARK: the template picker

/**
 * How a team works, picked from a template: the templates, then the picked one's roles with an
 * agent for each and its steps in a line. Use it inside a Form.
 */
struct TeamTemplatePicker: View {
  @Environment(Store.self) private var store
  @Binding var team: ChannelTeam
  var onCustomize: () -> Void
  /** a person describes the team in their words; an agent builds it */
  var onDescribe: ((String) -> Void)? = nil
  /** a plain chart instead of roles and steps */
  var onDrawOwn: (() -> Void)? = nil
  var busy = false
  /** over the first section */
  var header: String? = nil
  @State private var own: [TeamTemplate] = []
  @State private var picked: String?
  @State private var describe = ""
  @State private var creatingFor: RoleRef?

  private var templates: [TeamTemplate] { TeamTemplate.builtIn + own }
  private var current: TeamTemplate? { templates.first { $0.id == picked } }

  var body: some View {
    if let onDescribe {
      Section {
        TextField("Or describe it: “Opus plans, GPT pokes holes until it approves, then Opus hands out the work”", text: $describe, axis: .vertical)
          .lineLimit(1...5)
        Button("Have an agent build it", systemImage: "sparkles") { onDescribe(describe.trimmingCharacters(in: .whitespacesAndNewlines)) }
          .disabled(describe.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
      } header: {
        if let header { Text(header) }
      }
    }
    Section {
      ForEach(templates) { t in
        Button { pick(t) } label: {
          HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
              Text(t.name).foregroundStyle(.primary)
              if !t.blurb.isEmpty { Text(t.blurb).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
            Text("\(t.roles.count) roles").font(.caption).foregroundStyle(.secondary)
            Image(systemName: "checkmark").font(.subheadline.weight(.semibold)).opacity(picked == t.id ? 1 : 0)
          }
        }
        .accessibilityAddTraits(picked == t.id ? .isSelected : [])
        .swipeActions {
          if own.contains(where: { $0.id == t.id }) && store.canManage {
            Button("Delete", role: .destructive) {
              Task {
                try? await store.deleteTeamTemplate(t.id)
                own.removeAll { $0.id == t.id }
              }
            }
          }
        }
      }
      if let onDrawOwn {
        Button("Draw who hands work to whom instead") { onDrawOwn() }
      }
    } header: {
      Text(onDescribe == nil ? header ?? "Templates" : "Templates")
    }
    if team.hasSteps {
      Section {
        ForEach(team.roles ?? []) { r in
          RoleAgentPicker(team: $team, roleId: r.id, title: r.name, detail: r.description) { creatingFor = RoleRef(id: r.id) }
        }
        StepSummary(team: team)
      } header: {
        Text(current?.name ?? "Your team")
      } footer: {
        if let problem = team.problem { Text(problem).foregroundStyle(.red) }
      }
      Section {
        Button("Customize steps", systemImage: "slider.horizontal.3") { onCustomize() }
      }
      .sheet(item: $creatingFor) { ref in
        AddAgent { agent in team = team.setting(role: ref.id, agent: agent.id) }
      }
      .task { own = (try? await store.teamTemplates()) ?? own }
    } else {
      // start on the first template so there's always something to look at
      Color.clear.frame(height: 0).listRowBackground(Color.clear)
        .onAppear { if picked == nil, let first = TeamTemplate.builtIn.first { pick(first) } }
    }
  }

  private func pick(_ t: TeamTemplate) {
    picked = t.id
    team = t.filled(with: store.agents, base: team)
  }
}

private struct RoleRef: Identifiable { var id: String }

extension ChannelTeam {
  /** The team with an agent picked for a role, and its chart kept in step. */
  func setting(role id: String, agent: String?) -> ChannelTeam {
    var team = self
    team.roles = roles?.map { r in
      var r = r
      if r.id == id { r.agentId = agent }
      return r
    }
    return team.withChart
  }
}

/** Pick the agent for a role, or make one. */
private struct RoleAgentPicker: View {
  @Environment(Store.self) private var store
  @Binding var team: ChannelTeam
  var roleId: String
  var title: String
  var detail: String? = nil
  var onCreate: (() -> Void)?

  private var role: ChannelTeam.Role? { team.role(roleId) }

  var body: some View {
    Picker(selection: Binding(
      get: { role?.agentId ?? "" },
      set: { value in
        if value == "__new" { onCreate?() } else { team = team.setting(role: roleId, agent: value.isEmpty ? nil : value) }
      }
    )) {
      Text(role?.harness.map { "Pick an agent (\(HarnessChoice.label($0)) fits)" } ?? "Pick an agent").tag("")
      ForEach(store.agents) { a in Text("\(a.name) · \(HarnessChoice.label(a.harness))").tag(a.id) }
      if onCreate != nil { Text("Create an agent…").tag("__new") }
    } label: {
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
        if let detail, !detail.isEmpty { Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
      }
    }
    .pickerStyle(.menu)
    .tint(role?.agentId == nil ? .orange : .secondary)
  }
}

/** The steps as a line: "Lead: Draft a thorough plan → Challenger: Find gaps ↺ max 3 → …". */
private struct StepSummary: View {
  var team: ChannelTeam
  var body: some View {
    let roles = team.roles ?? []
    Text(ChannelTeam.stepOrder(team.steps ?? []).map { s in
      ChannelTeam.stepLabel(s, roles: roles) + (s.kind == .review ? " ↺ max \(s.maxRounds ?? ChannelTeam.defaultRounds)" : "")
    }.joined(separator: "  →  "))
    .font(.footnote)
    .foregroundStyle(.secondary)
  }
}

// MARK: the steps editor

/**
 * A stepped team, editable: the chart of its steps (pinch to zoom, drag to move around, tap a
 * step to edit it), then its roles and its steps in order. Use it inside a Form whose screen
 * pushes `TeamEditForm` for `editing`.
 */
struct TeamStepsEditor: View {
  @Environment(Store.self) private var store
  @Binding var team: ChannelTeam
  @Binding var editing: TeamEditTarget?
  var editable = true
  /** a saved channel, so its team can be saved as a template */
  var channelId: String? = nil
  /** over the chart */
  var header: String? = nil

  var body: some View {
    Section {
      StepChart(team: team, selected: { if case .step(let id) = editing { id } else { nil } }()) { editing = .step($0) }
        .frame(height: 340)
        .listRowInsets(EdgeInsets())
    } header: {
      if let header { Text(header) }
    } footer: {
      if let problem = team.problem { Text(problem).foregroundStyle(.red) }
    }
    Section("Roles") {
      ForEach(team.roles ?? []) { r in
        Button { editing = .role(r.id) } label: { RoleRow(role: r) }
      }
      if editable {
        Button("Add role", systemImage: "plus") {
          let r = ChannelTeam.Role(id: uid("role"), name: "New role", description: "", agentId: nil)
          team.roles = (team.roles ?? []) + [r]
          editing = .role(r.id)
        }
      }
    }
    Section("Steps") {
      ForEach(team.orderedSteps) { s in
        Button { editing = .step(s.id) } label: { StepRow(team: team, step: s) }
      }
      if editable {
        Button("Add step", systemImage: "plus") {
          if let id = team.addingStep(after: ChannelTeam.stepOrder(team.steps ?? []).last?.id) { editing = .step(id) }
        }
      }
    }
    if editable, let channelId {
      Section { SaveAsTemplate(channelId: channelId) }
    }
  }
}

private struct RoleRow: View {
  @Environment(Store.self) private var store
  var role: ChannelTeam.Role
  var body: some View {
    let agent = role.agentId.flatMap { store.agent($0) }
    HStack(spacing: 10) {
      if let agent { AgentAvatar(agent: agent, size: 30, showStatus: false) } else { NobodyCircle(size: 30) }
      VStack(alignment: .leading, spacing: 1) {
        Text(role.name.isEmpty ? "Untitled role" : role.name).foregroundStyle(.primary)
        Text(agent.map { "\($0.name) · \(HarnessChoice.label($0.harness))" } ?? "Nobody yet").font(.caption).foregroundStyle(agent == nil ? .orange : .secondary)
      }
      Spacer()
      Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
    }
  }
}

private struct StepRow: View {
  var team: ChannelTeam
  var step: ChannelTeam.Step
  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: step.kind == .review ? "checkmark.seal" : step.kind == .handOut ? "arrow.triangle.branch" : "circle")
        .foregroundStyle(.secondary)
        .frame(width: 30)
      VStack(alignment: .leading, spacing: 1) {
        Text(step.action.isEmpty ? "Say what it does" : step.action).foregroundStyle(step.action.isEmpty ? .secondary : .primary)
        Text(([team.role(step.roleId)?.name ?? "?"] + (step.kind == .do ? [] : [step.kind.label.lowercased()])).joined(separator: " · "))
          .font(.caption).foregroundStyle(.secondary)
      }
      Spacer()
      Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
    }
  }
}

/** A dashed circle where an agent would be: nobody fills the role yet. */
private struct NobodyCircle: View {
  var size: CGFloat
  var body: some View {
    Circle().strokeBorder(Color.orange, style: StrokeStyle(lineWidth: 1.5, dash: [3, 3])).frame(width: size, height: size)
  }
}

extension ChannelTeam {
  /**
   * A new step right after `after` (or at the end): it takes over where that step led, and
   * everything under it on the chart moves down a row. Returns the new step's id.
   */
  @discardableResult
  mutating func addingStep(after id: String?) -> String? {
    let all = steps ?? []
    let after = all.first { $0.id == id }
    let boxes = chartBoxes
    let below = after.map { a in (boxes.filter { $0.id == a.id || $0.id.hasPrefix("\(a.id):") }.map(\.y).max() ?? a.y) + Self.stepRow } ?? 0
    let s = Step(id: uid("step"), roleId: roles?.first?.id ?? "", kind: .do, action: "", next: after?.next, x: after?.x ?? 0, y: below)
    steps = all.map { x in
      var x = x
      if after != nil && x.y >= below { x.y += Self.stepRow }
      if x.id == after?.id { x.next = s.id }
      return x
    } + [s]
    self = withChart
    return s.id
  }

  /** Take a step out: whatever led to it now leads where it led. */
  mutating func removeStep(_ id: String) {
    let gone = step(id)
    steps = (steps ?? []).filter { $0.id != id }.map { s in
      var s = s
      if s.next == id { s.next = gone?.next }
      if s.sendBackTo == id { s.sendBackTo = nil }
      return s
    }
    self = withChart
  }

  /** Take a role off (only when no step belongs to it): hand-outs stop naming it. */
  mutating func removeRole(_ id: String) {
    roles = (roles ?? []).filter { $0.id != id }
    steps = steps?.map { s in
      var s = s
      s.handTo = s.handTo?.filter { $0 != id }
      if s.reviewBy == id { s.reviewBy = nil }
      return s
    }
    self = withChart
  }
}

/** Save a channel's roles and steps as a template anyone here can start from. */
private struct SaveAsTemplate: View {
  @Environment(Store.self) private var store
  var channelId: String
  @State private var naming = false
  @State private var name = ""
  @State private var saved = false
  @State private var action = FormAction()

  var body: some View {
    Button(saved ? "Saved as a template" : "Save as template", systemImage: saved ? "checkmark" : "square.and.arrow.down") { naming = true }
      .alert("Save as template", isPresented: $naming) {
        TextField("Template name", text: $name)
        Button("Save") {
          let name = name.trimmingCharacters(in: .whitespaces)
          action.run {
            try await store.saveTeamTemplate(channelId: channelId, name: String(name.prefix(60)))
            saved = true
          }
        }.disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
        Button("Cancel", role: .cancel) {}
      }
    InlineError(error: action.error)
  }
}

/** A role or a step, edited on its own screen. Edits go straight into the team. */
struct TeamEditForm: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @Binding var team: ChannelTeam
  @State var target: TeamEditTarget
  var editable = true
  @State private var creating = false

  var body: some View {
    Form {
      switch target {
      case .role(let id):
        if let role = team.role(id) { roleForm(role) }
      case .step(let id):
        if let step = team.step(id) { stepForm(step) }
      }
    }
    .disabled(!editable)
    .navigationTitle({ if case .role(let id) = target { team.role(id)?.name ?? "Role" } else { "Step" } }())
    .navigationBarTitleDisplayMode(.inline)
    .sheet(isPresented: $creating) {
      AddAgent { agent in if case .role(let id) = target { team = team.setting(role: id, agent: agent.id) } }
    }
  }

  // MARK: a role

  @ViewBuilder private func roleForm(_ role: ChannelTeam.Role) -> some View {
    Section("Name") {
      TextField("Name", text: roleText(role.id, \.name, max: 60))
    }
    Section("What this role does") {
      TextField("Every agent on the team reads this", text: roleText(role.id, \.description, max: 4000), axis: .vertical).lineLimit(4...12)
    }
    Section {
      RoleAgentPicker(team: $team, roleId: role.id, title: "Filled by", onCreate: store.canManage ? { creating = true } : nil)
    }
    if editable {
      let inUse = (team.steps ?? []).contains { $0.roleId == role.id }
      Section {
        Button("Remove role", systemImage: "trash", role: .destructive) {
          team.removeRole(role.id)
          dismiss()
        }
        .disabled(inUse)
      }
    }
  }

  private func roleText(_ id: String, _ key: WritableKeyPath<ChannelTeam.Role, String>, max: Int) -> Binding<String> {
    Binding(
      get: { team.role(id)?[keyPath: key] ?? "" },
      set: { value in
        guard let i = team.roles?.firstIndex(where: { $0.id == id }) else { return }
        team.roles![i][keyPath: key] = String(value.prefix(max))
        team = team.withChart
      }
    )
  }

  // MARK: a step

  @ViewBuilder private func stepForm(_ step: ChannelTeam.Step) -> some View {
    let roles = team.roles ?? []
    let others = ChannelTeam.stepOrder(team.steps ?? []).filter { $0.id != step.id }
    Section {
      Picker("Who", selection: stepValue(step, \.roleId)) {
        ForEach(roles) { Text($0.name).tag($0.id) }
      }
      Picker("Kind", selection: Binding(get: { step.kind }, set: { setKind($0, of: step.id) })) {
        ForEach(ChannelTeam.Kind.allCases, id: \.self) { Text($0.label).tag($0) }
      }
      .pickerStyle(.segmented)
    }
    Section("Does what") {
      TextField("e.g. Draft a thorough plan", text: Binding(get: { step.action }, set: { v in update(step.id) { $0.action = String(v.prefix(200)) } }))
    }
    if step.kind == .review {
      Section {
        Picker("Changes go back to", selection: stepValue(step, \.sendBackTo)) {
          Text("Pick a step").tag(String?.none)
          ForEach(others) { Text(ChannelTeam.stepLabel($0, roles: roles)).tag(Optional($0.id)) }
        }
      }
    }
    if step.kind == .handOut {
      Section("Pieces go to") {
        ForEach(roles.filter { $0.id != step.roleId }) { r in
          Toggle(r.name, isOn: Binding(
            get: { step.handTo?.contains(r.id) ?? false },
            set: { on in update(step.id) { s in s.handTo = on ? (s.handTo ?? []) + [r.id] : (s.handTo ?? []).filter { $0 != r.id } } }
          ))
        }
      }
      Section {
        Picker("Each piece is checked by", selection: stepValue(step, \.reviewBy)) {
          Text("Nobody").tag(String?.none)
          ForEach(roles) { Text($0.name).tag(Optional($0.id)) }
        }
      }
    }
    Section {
      if step.kind == .review || (step.kind == .handOut && step.reviewBy != nil) {
        Stepper(value: Binding(get: { step.maxRounds ?? ChannelTeam.defaultRounds }, set: { v in update(step.id) { $0.maxRounds = v } }), in: 1...ChannelTeam.maxRounds) {
          LabeledContent("Rounds before it asks you", value: "\(step.maxRounds ?? ChannelTeam.defaultRounds)")
        }
      }
      Picker(step.kind == .review ? "When approved, next" : "Next", selection: stepValue(step, \.next)) {
        Text("Done: the flow ends here").tag(String?.none)
        ForEach(others) { Text(ChannelTeam.stepLabel($0, roles: roles)).tag(Optional($0.id)) }
      }
    }
    if editable {
      Section {
        Button("Add step after", systemImage: "plus") {
          if let id = team.addingStep(after: step.id) { target = .step(id) }
        }
        Button("Remove step", systemImage: "trash", role: .destructive) {
          team.removeStep(step.id)
          dismiss()
        }
      }
    }
  }

  private func update(_ id: String, _ change: (inout ChannelTeam.Step) -> Void) {
    guard let i = team.steps?.firstIndex(where: { $0.id == id }) else { return }
    change(&team.steps![i])
    team = team.withChart
  }

  private func stepValue<V>(_ step: ChannelTeam.Step, _ key: WritableKeyPath<ChannelTeam.Step, V>) -> Binding<V> where V: Hashable {
    Binding(
      get: { team.step(step.id)?[keyPath: key] ?? step[keyPath: key] },
      set: { v in update(step.id) { $0[keyPath: key] = v } }
    )
  }

  /** A new kind starts with sensible picks: where a review sends work back, who a hand-out hands pieces to. */
  private func setKind(_ kind: ChannelTeam.Kind, of id: String) {
    let roles = team.roles ?? []
    let others = ChannelTeam.stepOrder(team.steps ?? []).filter { $0.id != id }
    update(id) { s in
      s.kind = kind
      if kind == .review && s.sendBackTo == nil {
        s.sendBackTo = others.first?.id
        s.maxRounds = s.maxRounds ?? ChannelTeam.defaultRounds
      }
      if kind == .handOut && (s.handTo ?? []).isEmpty {
        let roleId = s.roleId
        s.handTo = Array(roles.filter { $0.id != roleId }.prefix(2).map(\.id))
      }
    }
  }
}

// MARK: the chart

/**
 * A stepped team's chart: pinch to zoom, drag to move around, tap a step to pick it. Boxes sit
 * where the web's chart puts them, with each hand-out's pieces and checker under it.
 */
struct StepChart: View {
  @Environment(Store.self) private var store
  var team: ChannelTeam
  var selected: String? = nil
  /** steps someone is on right now */
  var active: Set<String> = []
  var onSelect: (String) -> Void

  private struct Viewport: Equatable { var x: CGFloat, y: CGFloat, k: CGFloat }
  @State private var view = Viewport(x: 20, y: 20, k: 1)
  @State private var panStart: Viewport?
  @State private var pinchStart: Viewport?
  @State private var size: CGSize = .zero
  @State private var fitted = false

  private static let minK: CGFloat = 0.3, maxK: CGFloat = 2
  private static func clamp(_ k: CGFloat) -> CGFloat { min(maxK, max(minK, k)) }

  private var boxes: [StepBox] { team.chartBoxes }

  var body: some View {
    let boxes = boxes
    let lines = team.chartLines(boxes)
    GeometryReader { geo in
      ZStack(alignment: .topLeading) {
        Color(.secondarySystemBackground)
        world(boxes, lines)
          .scaleEffect(view.k, anchor: .topLeading)
          .offset(x: view.x, y: view.y)
        if boxes.isEmpty {
          Text("No steps yet.").font(.subheadline).foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
      .clipped()
      .contentShape(Rectangle())
      .gesture(pan.simultaneously(with: pinch))
      .overlay(alignment: .bottomTrailing) { controls(boxes).padding(10) }
      .onAppear {
        size = geo.size
        if !fitted { fit(boxes); fitted = true }
      }
      .onChange(of: geo.size) { _, new in
        size = new
        fit(boxes)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Steps chart")
  }

  /** Everything on the chart, in the chart's own coordinates. */
  private func world(_ boxes: [StepBox], _ lines: [StepLine]) -> some View {
    ZStack(alignment: .topLeading) {
      ForEach(lines) { line in
        let color = tone(line.tone)
        StepCurve(line: line).stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: line.tone == .back ? [6, 5] : []))
        StepArrowhead(line: line).fill(color)
      }
      ForEach(lines.filter { $0.label != nil }) { line in
        Text(line.label!)
          .font(.system(size: 11, weight: .medium))
          .foregroundStyle(tone(line.tone))
          .padding(.horizontal, 5)
          .background(Capsule().fill(Color(.secondarySystemBackground)))
          .fixedSize()
          .frame(width: 260, height: 20)
          .offset(x: line.mid.x - 130, y: line.mid.y - 10)
          .allowsHitTesting(false)
      }
      ForEach(boxes) { box in
        boxView(box).offset(x: box.x, y: box.y)
      }
    }
    .frame(width: 1, height: 1, alignment: .topLeading)
  }

  private func tone(_ t: StepLine.Tone) -> Color {
    switch t {
    case .go: Color.secondary.opacity(0.6)
    case .ok: .green
    case .back: .orange
    }
  }

  @ViewBuilder private func boxView(_ box: StepBox) -> some View {
    let role = team.role(box.roleId)
    let agent = role?.agentId.flatMap { store.agent($0) }
    let step = box.step
    let picked = step != nil && step?.id == selected
    let on = step.map { active.contains($0.id) } ?? false
    let card = HStack(spacing: 8) {
      VStack(alignment: .leading, spacing: 2) {
        Text(((role?.name ?? "?").uppercased()) + (step.map { $0.kind == .do ? "" : " · \($0.kind.label.lowercased())" } ?? ""))
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(.secondary)
          .lineLimit(1)
        Text(step.map { $0.action.isEmpty ? "Say what it does" : $0.action } ?? (box.id.hasSuffix(":check") ? "Checks each piece" : "Builds its piece"))
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(step?.action.isEmpty == true ? .secondary : .primary)
          .lineLimit(1)
      }
      Spacer(minLength: 0)
      if let agent { AgentAvatar(agent: agent, size: 26, showStatus: false) } else { NobodyCircle(size: 24) }
    }
    .padding(.horizontal, 12)
    .frame(width: box.w, height: box.h)
    .background(RoundedRectangle(cornerRadius: Corner.tile, style: .continuous).fill(Color(.systemBackground)))
    .overlay(
      RoundedRectangle(cornerRadius: Corner.tile, style: .continuous)
        .strokeBorder(picked ? Color.accentColor : on ? Color.green : Color(.separator), style: StrokeStyle(lineWidth: picked || on ? 2 : 1, dash: step == nil ? [5, 4] : []))
    )
    if let step {
      Button { onSelect(step.id) } label: { card }
        .buttonStyle(.plain)
        .accessibilityLabel(ChannelTeam.stepLabel(step, roles: team.roles ?? []))
    } else {
      card.accessibilityLabel("\(role?.name ?? "?"): \(box.id.hasSuffix(":check") ? "checks each piece" : "builds its piece")")
    }
  }

  private func controls(_ boxes: [StepBox]) -> some View {
    HStack(spacing: 0) {
      Button { zoom(by: 1 / 1.2) } label: { Image(systemName: "minus").frame(width: 34, height: 32).contentShape(Rectangle()) }
        .accessibilityLabel("Zoom out")
      Text("\(Int((view.k * 100).rounded()))%")
        .font(.caption.monospacedDigit())
        .foregroundStyle(.secondary)
        .frame(width: 44)
      Button { zoom(by: 1.2) } label: { Image(systemName: "plus").frame(width: 34, height: 32).contentShape(Rectangle()) }
        .accessibilityLabel("Zoom in")
      Divider().frame(height: 18)
      Button { withAnimation(.snappy) { fit(boxes) } } label: {
        Label("Fit", systemImage: "arrow.up.left.and.arrow.down.right").font(.caption).padding(.horizontal, 10).frame(height: 32).contentShape(Rectangle())
      }
      .accessibilityLabel("Fit the whole chart")
    }
    .buttonStyle(.plain)
    .glassCapsule()
  }

  // MARK: moving around

  private var pan: some Gesture {
    DragGesture(minimumDistance: 6)
      .onChanged { v in
        guard pinchStart == nil else { return }
        let s = panStart ?? view
        if panStart == nil { panStart = view }
        view = Viewport(x: s.x + v.translation.width, y: s.y + v.translation.height, k: s.k)
      }
      .onEnded { _ in panStart = nil }
  }

  private var pinch: some Gesture {
    MagnifyGesture()
      .onChanged { v in
        let s = pinchStart ?? view
        if pinchStart == nil { pinchStart = view; panStart = nil }
        let k = Self.clamp(s.k * v.magnification)
        let p = v.startLocation
        view = Viewport(x: p.x - (p.x - s.x) * k / s.k, y: p.y - (p.y - s.y) * k / s.k, k: k)
      }
      .onEnded { _ in pinchStart = nil }
  }

  private func zoom(by factor: CGFloat) {
    let p = CGPoint(x: size.width / 2, y: size.height / 2)
    withAnimation(.snappy) {
      let k = Self.clamp(view.k * factor)
      view = Viewport(x: p.x - (p.x - view.x) * k / view.k, y: p.y - (p.y - view.y) * k / view.k, k: k)
    }
  }

  /** The whole chart in view, no bigger than 100%. */
  private func fit(_ boxes: [StepBox]) {
    guard size.width > 0, size.height > 0, !boxes.isEmpty else { return }
    let x0 = boxes.map(\.x).min()! - 40, y0 = boxes.map(\.y).min()! - 40
    let x1 = boxes.map { $0.x + $0.w }.max()! + 120, y1 = boxes.map { $0.y + $0.h }.max()! + 40
    let w = x1 - x0, h = y1 - y0
    let k = Self.clamp(min(size.width / w, size.height / h, 1))
    view = Viewport(x: (size.width - w * k) / 2 - x0 * k, y: (size.height - h * k) / 2 - y0 * k, k: k)
  }
}

private struct StepCurve: Shape {
  var line: StepLine
  func path(in rect: CGRect) -> Path {
    var p = Path()
    p.move(to: CGPoint(x: line.start.x, y: line.start.y))
    p.addCurve(to: CGPoint(x: line.end.x, y: line.end.y), control1: CGPoint(x: line.c1.x, y: line.c1.y), control2: CGPoint(x: line.c2.x, y: line.c2.y))
    return p
  }
}

/** The arrowhead at a line's end, pointing the way the line arrives. */
private struct StepArrowhead: Shape {
  var line: StepLine
  func path(in rect: CGRect) -> Path {
    let from = line.c2 == line.end ? line.start : line.c2
    let angle = atan2(line.end.y - from.y, line.end.x - from.x)
    let tip = CGPoint(x: line.end.x, y: line.end.y)
    var p = Path()
    p.move(to: tip)
    p.addLine(to: CGPoint(x: tip.x - 9 * cos(angle - 0.45), y: tip.y - 9 * sin(angle - 0.45)))
    p.addLine(to: CGPoint(x: tip.x - 9 * cos(angle + 0.45), y: tip.y - 9 * sin(angle + 0.45)))
    p.closeSubpath()
    return p
  }
}

// MARK: a request going through the steps

/**
 * Where a request in a stepped channel is, at the top of its thread: a pill per step (done, on
 * now, still to come) and, when it's waiting on a person, what they can do about it.
 */
struct FlowStrip: View {
  @Environment(Store.self) private var store
  var channelId: String
  var threadId: String
  @State private var flow: TeamFlow?
  @State private var action = FormAction()

  private var team: ChannelTeam? { store.channels.first { $0.id == channelId }?.settings?.team }

  var body: some View {
    VStack(spacing: 0) {
      if let flow, let team, team.hasSteps { strip(flow, team) }
    }
    .task(id: "\(channelId) \(threadId) \(store.flowVersions[channelId] ?? 0)") {
      guard team?.hasSteps == true else { return }
      if let all = try? await store.flows(in: channelId) { flow = all.first { $0.threadId == threadId } }
    }
  }

  private func strip(_ flow: TeamFlow, _ team: ChannelTeam) -> some View {
    let order = ChannelTeam.stepOrder(team.steps ?? [])
    let done = flow.doneSteps
    return VStack(alignment: .leading, spacing: 8) {
      WrapLayout(spacing: 4, lineSpacing: 6) {
        ForEach(Array(order.enumerated()), id: \.element.id) { i, s in
          let now = flow.stepId == s.id && (flow.status == "running" || flow.status == "waiting")
          HStack(spacing: 4) {
            if i > 0 { Image(systemName: "arrow.right").font(.caption2).foregroundStyle(.tertiary) }
            pill(s, team: team, flow: flow, now: now, done: flow.status == "done" || (done.contains(s.id) && !now))
          }
        }
        if flow.status == "failed" { Text("Stopped").font(.caption.weight(.semibold)).foregroundStyle(.red).padding(.leading, 4) }
        // a running request can be stopped too (the hub cancels the work still open)
        if flow.status == "running" {
          Button("Stop", role: .destructive) { decide("stop") }.font(.caption).buttonStyle(.borderless).disabled(action.busy).padding(.leading, 4)
        }
      }
      .padding(.horizontal, 16)
      if flow.status == "waiting", let waiting = flow.waitingFor {
        VStack(alignment: .leading, spacing: 8) {
          Text(waiting.why).font(.footnote).foregroundStyle(.orange)
          HStack(spacing: 8) {
            // the app tint is the text color, so a filled button's label is the background's (as in primaryButton)
            Button("Approve anyway") { decide("approve") }.foregroundStyle(Color(.systemBackground)).buttonStyle(.borderedProminent)
            Button(waiting.options == "rounds" ? "Another round" : "Try again") { decide("retry") }.buttonStyle(.bordered)
            Button("Stop", role: .destructive) { decide("stop") }.buttonStyle(.bordered)
          }
          .controlSize(.small)
          .disabled(action.busy)
          InlineError(error: action.error)
        }
        .padding(.horizontal, 16)
      }
      Divider()
    }
    .padding(.top, 10)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Team steps")
  }

  private func pill(_ s: ChannelTeam.Step, team: ChannelTeam, flow: TeamFlow, now: Bool, done: Bool) -> some View {
    let rounds = flow.rounds[s.id] ?? 0
    let waiting = now && flow.status == "waiting"
    let fg: Color = now ? (waiting ? .orange : Color(.systemBackground)) : done ? .green : .secondary
    let bg: Color = now ? (waiting ? Color.orange.opacity(0.15) : .primary) : done ? Color.green.opacity(0.15) : Color(.tertiarySystemFill)
    return HStack(spacing: 3) {
      Text(s.action.isEmpty ? ChannelTeam.stepLabel(s, roles: team.roles ?? []) : s.action)
      if done { Image(systemName: "checkmark").font(.caption2.weight(.bold)) }
      if rounds > 1 { Text("· round \(rounds)") }
    }
    .font(.caption.weight(.medium))
    .foregroundStyle(fg)
    .padding(.horizontal, 9)
    .padding(.vertical, 4)
    .background(Capsule().fill(bg))
    .accessibilityLabel("\(ChannelTeam.stepLabel(s, roles: team.roles ?? [])), \(now ? (waiting ? "waiting on you" : "on now") : done ? "done" : "to come")")
  }

  private func decide(_ choice: String) {
    guard let id = flow?.id else { return }
    action.run { flow = try await store.decideFlow(id, choice) }
  }
}

/** Views in a row that wraps onto the next line when it runs out of room. */
private struct WrapLayout: Layout {
  var spacing: CGFloat = 4
  var lineSpacing: CGFloat = 6

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let rows = rows(width: proposal.width ?? .infinity, subviews)
    let width = rows.map { $0.width }.max() ?? 0
    let height = rows.map(\.height).reduce(0, +) + lineSpacing * CGFloat(max(rows.count - 1, 0))
    return CGSize(width: width, height: height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var y = bounds.minY
    for row in rows(width: bounds.width, subviews) {
      var x = bounds.minX
      for i in row.items {
        let size = subviews[i].sizeThatFits(.unspecified)
        subviews[i].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: ProposedViewSize(size))
        x += size.width + spacing
      }
      y += row.height + lineSpacing
    }
  }

  private struct Row { var items: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }
  private func rows(width: CGFloat, _ subviews: Subviews) -> [Row] {
    var rows: [Row] = [Row()]
    for (i, view) in subviews.enumerated() {
      let size = view.sizeThatFits(.unspecified)
      if !rows[rows.count - 1].items.isEmpty && rows[rows.count - 1].width + spacing + size.width > width { rows.append(Row()) }
      var row = rows[rows.count - 1]
      row.width += (row.items.isEmpty ? 0 : spacing) + size.width
      row.height = max(row.height, size.height)
      row.items.append(i)
      rows[rows.count - 1] = row
    }
    return rows
  }
}
