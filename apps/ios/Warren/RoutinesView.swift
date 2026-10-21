import SwiftUI

struct RoutinesView: View {
  @Environment(Store.self) private var store
  var agent: Agent
  @State private var creating = false
  @State private var editing: Routine?
  @State private var deleting: Routine?
  @State private var action = FormAction()
  @State private var chat: Channel?
  private var routines: [Routine] { store.routines.filter { $0.agentId == agent.id } }
  var body: some View {
    List {
      Section {
        Text("A routine is something your helper does on a schedule, like dinner ideas every Monday.")
        Text("Teach a task by doing it once while your helper watches on the computer, or write the steps here.").font(.footnote).foregroundStyle(.secondary)
      }
      if routines.isEmpty { Text("No routines yet.").foregroundStyle(.secondary) }
      ForEach(routines) { routine in
        Section {
          Text(routine.name).font(.headline)
          RoutineSchedule(routine: routine)
          Text(routine.enabled == false ? "Off" : "On").font(.caption).foregroundStyle(.secondary)
          if let value = routine.lastRunAt, let date = Wire.date(value) { Text("Last requested \(date, format: .relative(presentation: .named))").font(.caption) }
          if let value = routine.lastCompletedAt, let date = Wire.date(value) { Text("Last completed \(date, format: .relative(presentation: .named))").font(.caption) }
          NavigationLink("Steps") { NoteView(path: routine.notePath) }
          if store.canManage {
            Button("Edit routine") { editing = routine }
            Button("Run now") {
              action.run {
                let run = try await store.runRoutine(routine.id)
                chat = store.channels.first { $0.id == run.channelId }
              }
            }.disabled(action.busy || routine.status != "ready")
            Button("Delete routine", role: .destructive) { deleting = routine }
          }
        }
      }
      InlineError(error: action.error)
    }.sectionScreen("Routines", id: "routines")
      .toolbar { if store.canManage { Button("Write a routine", systemImage: "plus") { creating = true } } }
      .sheet(isPresented: $creating) { RoutineEditor(agent: agent) }
      .sheet(item: $editing) { RoutineEditor(agent: agent, routine: $0) }
      .navigationDestination(item: $chat) { ChannelView(channel: $0) }
      .task { do { try await store.refreshRoutines() } catch { action.error = error.localizedDescription } }
      .confirmationDialog("Delete this routine? Its steps stay in memory.", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
        Button("Delete routine", role: .destructive) { if let routine = deleting { action.run { try await store.deleteRoutine(routine.id) } } }
      }
  }
}

struct RoutineEditor: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var agent: Agent
  var routine: Routine?
  @State private var name = ""
  @State private var result = ""
  @State private var steps = ""
  @State private var schedule = ""
  @State private var timezone = TimeZone.current.identifier
  @State private var channel = ""
  @State private var enabled = true
  @State private var loaded = false
  @State private var action = FormAction()
  private var guided: Bool { store.simple && routine == nil }
  var body: some View {
    EditorSheet(title: routine == nil ? "New routine for \(agent.name)" : "Edit routine", action: action, valid: loaded && (guided ? !result.trimmed.isEmpty : !name.trimmed.isEmpty) && name.count <= 80 && steps.count <= 50_000 && (schedule.isEmpty || schedule.split(separator: " ").count == 5), save: {
      action.run {
        let title = GuideText.routineName(name, goal: result)
        var fields: Fields = ["name": AnyEncodable(title), "schedule": .nullable(schedule), "timezone": AnyEncodable(timezone), "channelId": .nullable(channel)]
        if routine == nil { fields["agentId"] = AnyEncodable(agent.id) } else { fields["enabled"] = AnyEncodable(enabled) }
        let content = guided ? GuideText.routineSteps(goal: result, steps: steps) : steps
        try await store.saveRoutine(routine, fields: fields, steps: content); dismiss()
      }
    }) {
      if guided { TextField("What should happen?", text: $result, axis: .vertical).lineLimit(3...8) }
      TextField("Name", text: $name)
      TextField(guided ? "Steps (optional)" : "Steps", text: $steps, axis: .vertical).lineLimit(5...15)
      if loaded { ScheduleFields(schedule: $schedule, timezone: timezone) }
      if routine != nil { Toggle("On", isOn: $enabled) }
      TechnicalDetails(title: "Advanced") {
        Picker("Time zone", selection: $timezone) { ForEach(TimeZone.knownTimeZoneIdentifiers, id: \.self) { Text($0).tag($0) } }
        Picker("Post in", selection: $channel) {
          Text("Direct message").tag("")
          ForEach(store.channels) { Text(store.title(of: $0)).tag($0.id) }
        }
      }
    }.task {
      guard !loaded else { return }
      if let routine {
        name = routine.name; schedule = routine.schedule ?? ""; timezone = routine.timezone ?? "UTC"; enabled = routine.enabled ?? true; channel = routine.channelId ?? ""
        do { steps = try await store.readNote(routine.notePath).content ?? ""; loaded = true } catch { action.error = error.localizedDescription }
      } else { loaded = true }
    }
  }
}

