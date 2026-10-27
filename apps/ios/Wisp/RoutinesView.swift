import SwiftUI

/**
 * Routines (agent-Routines.dc.html): what an agent does on a schedule. Tap one to run it now, see
 * its steps, edit it, pause it or delete it. The + opens the new routine sheet.
 */
struct RoutinesView: View {
  @Environment(Store.self) private var store
  var agent: Agent
  @State private var creating = false
  @State private var editing: Routine?
  @State private var deleting: Routine?
  @State private var acting: Routine?
  @State private var steps: String?
  @State private var action = FormAction()
  @State private var chat: Channel?
  private var routines: [Routine] { store.routines.filter { $0.agentId == agent.id } }

  var body: some View {
    AgentFrame(title: "Routines", subtitle: agent.name, trailing: {
      if store.canManage { CircleButton(symbol: "plus", label: "New routine", id: "routine-new") { creating = true } }
    }) {
      if routines.isEmpty {
        AgentCard {
          Text("No routines yet.").font(.system(size: 15)).foregroundStyle(Palette.text)
          Text("A routine is something \(agent.name) does on a schedule, like dinner ideas every Monday. Write the steps, or teach it by doing the task once on its computer.")
            .font(.system(size: 13)).foregroundStyle(Palette.faint)
        }
      } else {
        CardGroup {
          ForEach(routines) { routine in
            Button { acting = routine } label: { row(routine) }.buttonStyle(.plain).accessibilityIdentifier("routine-row")
          }
        }
        CardCaption("Tap a routine to run it now, edit it, pause it or delete it.")
      }
      AgentError(text: action.error)
    }
    .sheet(isPresented: $creating) { RoutineEditor(agent: agent) }
    .sheet(item: $editing) { RoutineEditor(agent: agent, routine: $0) }
    .navigationDestination(item: $chat) { ChannelView(channel: $0) }
    .navigationDestination(item: $steps) { NoteView(path: $0) }
    .task { do { try await store.refreshRoutines() } catch { action.error = error.localizedDescription } }
    .confirmationDialog(acting?.name ?? "", isPresented: Binding(get: { acting != nil }, set: { if !$0 { acting = nil } }), titleVisibility: .visible, presenting: acting) { routine in
      if store.canManage {
        Button("Run now") {
          action.run {
            let run = try await store.runRoutine(routine.id)
            chat = store.channels.first { $0.id == run.channelId }
          }
        }.disabled(routine.status != "ready")
      }
      Button("Steps") { steps = routine.notePath }
      if store.canManage {
        Button("Edit") { editing = routine }
        Button(routine.enabled == false ? "Resume" : "Pause") {
          action.run { try await store.setRoutine(routine.id, ["enabled": AnyEncodable(routine.enabled == false)]) }
        }
        Button("Delete routine", role: .destructive) { deleting = routine }
      }
    }
    .confirmationDialog("Delete this routine? Its steps stay in memory.", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
      Button("Delete routine", role: .destructive) { if let routine = deleting { action.run { try await store.deleteRoutine(routine.id) } } }
    }
  }

  private func row(_ routine: Routine) -> some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 3) {
        Text(routine.name).font(.system(size: 15)).foregroundStyle(Palette.text).multilineTextAlignment(.leading)
        Text(RoutineWords.when(routine, channel: routine.channelId.flatMap { id in store.channels.first { $0.id == id }.map { store.title(of: $0) } }))
          .font(.system(size: 13)).foregroundStyle(Palette.faint).multilineTextAlignment(.leading)
        if routine.enabled == false && routine.schedule != nil { Text("Only when someone runs it").font(.system(size: 13)).foregroundStyle(Palette.faint) }
        else if let last = routine.lastCompletedAt.flatMap(Wire.date) { Text("Last done \(last, format: .relative(presentation: .named))").font(.system(size: 13)).foregroundStyle(Palette.faint) }
      }
      Spacer(minLength: 8)
      if let badge = RoutineWords.badge(routine) {
        Text(badge).font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.muted)
          .padding(.horizontal, 10).frame(height: 24).background(Capsule().fill(Palette.muted.opacity(0.16)))
      }
      Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.faint)
    }
    .padding(.horizontal, 18).padding(.vertical, 10).frame(minHeight: 68).contentShape(Rectangle())
  }
}

/** The new routine / edit routine sheet (agent-RoutineNew.dc.html). */
struct RoutineEditor: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var agent: Agent
  var routine: Routine?
  @State private var name = ""
  @State private var result = ""
  @State private var steps = ""
  @State private var draft = ScheduleDraft(cron: "")
  @State private var timezone = TimeZone.current.identifier
  @State private var channel = ""
  @State private var enabled = true
  @State private var loaded = false
  @State private var teachRoute: String?
  @State private var action = FormAction()

  private var schedule: String { draft.cron }
  private var valid: Bool {
    loaded && (routine != nil ? !name.trimmed.isEmpty : !(result.trimmed.isEmpty && name.trimmed.isEmpty)) && name.count <= 80 && steps.count <= 50_000 &&
    (schedule.isEmpty || schedule.split(separator: " ").count == 5)
  }
  private var computer: Computer? { store.computers.first { $0.id == agent.computerId } }

  var body: some View {
    NavigationStack {
      AgentFrame(title: routine == nil ? "New routine" : "Edit routine", close: true) {
        if routine == nil {
          FieldCard(label: "What should happen?", text: $result, prompt: "Summarize what shipped this week and draft the release notes.", lines: 3...8)
        }
        FieldCard(label: "Name", text: $name, prompt: routine == nil ? "Weekly release notes" : "Name")
        CardCaption("Schedule")
        CardGroup {
          menuRow("Repeat", value: draft.repeatMode.label) {
            ForEach(ScheduleDraft.Repeat.allCases.filter { $0 != .custom }, id: \.self) { mode in Button(mode.label) { draft.repeatMode = mode } }
            Button("Custom (cron)") { draft.repeatMode = .custom }
          }
          if draft.repeatMode == .weekly {
            menuRow("Day", value: Calendar.current.weekdaySymbols[draft.day % 7]) {
              ForEach(0..<7, id: \.self) { d in Button(Calendar.current.weekdaySymbols[d]) { draft.day = d } }
            }
          }
          if draft.showsTime {
            DatePicker(selection: Binding(get: { draft.time }, set: { draft.time = $0 }), displayedComponents: .hourAndMinute) {
              Text("Time").font(.system(size: 15)).foregroundStyle(Palette.text)
            }.padding(.horizontal, 18).frame(minHeight: 54)
          }
          if draft.repeatMode == .custom {
            FieldCard(label: "Custom schedule (cron)", text: $draft.custom, prompt: "0 9 * * 1-5", monospaced: true, lowercase: true)
          }
          menuRow("Post in", value: channel.isEmpty ? "Direct message" : store.channels.first { $0.id == channel }.map { store.title(of: $0) } ?? "A team") {
            Button("Direct message") { channel = "" }
            ForEach(store.channels.filter { !$0.isDM && $0.archivedAt == nil }) { ch in Button(store.title(of: ch)) { channel = ch.id } }
          }
          if routine == nil, store.features.teach, store.canViewComputers, let computer {
            Button { teachRoute = computer.id } label: {
              RowLabel(title: "Teach it instead", leading: { rowIcon("hand.point.up.left") })
            }.buttonStyle(.plain).accessibilityIdentifier("routine-teach")
          }
        }
        CardCaption(schedule.isEmpty ? "Run it from here, or ask \(agent.name) in chat." : "\(describeCron(schedule)), in \(timezone).")
        DisclosureGroup("More options") {
          VStack(alignment: .leading, spacing: 12) {
            FieldCard(label: routine == nil ? "Steps (optional)" : "Steps", text: $steps, prompt: "Write the steps in your own words", lines: 5...15)
            menuRow("Time zone", value: timezone) {
              Picker("Time zone", selection: $timezone) { ForEach(TimeZone.knownTimeZoneIdentifiers, id: \.self) { Text($0).tag($0) } }
            }.background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
            if routine != nil {
              CardGroup { SwitchRow(title: "On", isOn: $enabled) }
            }
          }.padding(.top, 8)
        }
        .tint(Palette.muted).font(.system(size: 15)).foregroundStyle(Palette.text).padding(.horizontal, 18)
        AgentError(text: action.error)
        PillButton(title: "Save routine", busy: action.busy, id: "routine-save") { save() }.disabled(!valid || action.busy)
      }
      .navigationDestination(item: $teachRoute) { ComputerDetail(computerId: $0) }
    }
    .agentSheet()
    .interactiveDismissDisabled(action.busy)
    .task {
      guard !loaded else { return }
      if let routine {
        name = routine.name; draft = ScheduleDraft(cron: routine.schedule ?? ""); timezone = routine.timezone ?? "UTC"; enabled = routine.enabled ?? true; channel = routine.channelId ?? ""
        do { steps = try await store.readNote(routine.notePath).content ?? ""; loaded = true } catch { action.error = error.localizedDescription }
      } else { loaded = true }
    }
  }

  private func menuRow<Items: View>(_ title: String, value: String, @ViewBuilder _ items: () -> Items) -> some View {
    Menu {
      items()
    } label: {
      HStack {
        Text(title).font(.system(size: 15)).foregroundStyle(Palette.text)
        Spacer(minLength: 8)
        Text(value).font(.system(size: 15)).foregroundStyle(Palette.faint).lineLimit(1)
        Image(systemName: "chevron.up.chevron.down").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.faint)
      }
      .padding(.horizontal, 18).frame(minHeight: 54).contentShape(Rectangle())
    }
  }

  private func save() {
    action.run {
      let title = GuideText.routineName(name, goal: result)
      var fields: Fields = ["name": AnyEncodable(title), "schedule": .nullable(schedule), "timezone": AnyEncodable(timezone), "channelId": .nullable(channel)]
      if routine == nil { fields["agentId"] = AnyEncodable(agent.id) } else { fields["enabled"] = AnyEncodable(enabled) }
      let guided = routine == nil && !result.trimmed.isEmpty
      let content = guided ? GuideText.routineSteps(goal: result, steps: steps) : steps
      try await store.saveRoutine(routine, fields: fields, steps: content); dismiss()
    }
  }
}

/** The schedule on the new routine sheet: how often, which day, what time; turned into a cron expression and back. */
struct ScheduleDraft: Equatable {
  enum Repeat: String, CaseIterable {
    case none, hourly, daily, weekdays, weekly, custom
    var label: String {
      switch self {
      case .none: "Never"
      case .hourly: "Every hour"
      case .daily: "Every day"
      case .weekdays: "Every weekday"
      case .weekly: "Every week"
      case .custom: "Custom (cron)"
      }
    }
  }

  var repeatMode: Repeat = .none
  var hour = 9
  var minute = 0
  /** 0 is Sunday */
  var day = 1
  var custom = "0 9 * * 1-5"

  init(cron: String) {
    let parts = cron.split(separator: " ").map(String.init)
    if cron.isEmpty { repeatMode = .none; return }
    custom = cron
    if cron == "0 * * * *" { repeatMode = .hourly; return }
    guard parts.count == 5, let m = Int(parts[0]), let h = Int(parts[1]), (0...59).contains(m), (0...23).contains(h), parts[2] == "*", parts[3] == "*" else { repeatMode = .custom; return }
    minute = m; hour = h
    if parts[4] == "*" { repeatMode = .daily }
    else if parts[4] == "1-5" { repeatMode = .weekdays }
    else if let d = Int(parts[4]), (0...7).contains(d) { repeatMode = .weekly; day = d % 7 }
    else { repeatMode = .custom }
  }

  var showsTime: Bool { [.daily, .weekdays, .weekly].contains(repeatMode) }

  var time: Date {
    get { Calendar.current.date(from: DateComponents(year: 2001, month: 1, day: 1, hour: hour, minute: minute)) ?? .now }
    set { hour = Calendar.current.component(.hour, from: newValue); minute = Calendar.current.component(.minute, from: newValue) }
  }

  var cron: String {
    switch repeatMode {
    case .none: ""
    case .hourly: "0 * * * *"
    case .daily: "\(minute) \(hour) * * *"
    case .weekdays: "\(minute) \(hour) * * 1-5"
    case .weekly: "\(minute) \(hour) * * \(day)"
    case .custom: custom.trimmed
    }
  }
}

extension Store {
  /** Change a routine's schedule or switch without touching its steps. */
  func setRoutine(_ id: String, _ fields: Fields) async throws {
    let _: Routine = try await fetch { try await $0.patch("/api/routines/\(id)", fields) }
    try await refreshRoutines()
  }
}

/** A routine in words for its row. */
enum RoutineWords {
  static func when(_ routine: Routine, channel: String?) -> String {
    let schedule = routine.schedule.map { describeCron($0) } ?? "Only when someone runs it"
    return schedule + " · " + (channel.map { "posts in \($0)" } ?? "posts here")
  }

  static func badge(_ routine: Routine) -> String? {
    if routine.enabled == false { return "Paused" }
    switch routine.status {
    case nil, "ready": return nil
    case "learning": return "Learning"
    case let other?: return other.prefix(1).uppercased() + other.dropFirst()
    }
  }
}
