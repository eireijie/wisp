import SwiftUI

struct RoutineSchedule: View {
  var routine: Routine
  @State private var next: Date?
  private var timezone: String { routine.timezone ?? "UTC" }
  private var identity: String { "\(routine.schedule ?? ""):\(timezone):\(routine.enabled ?? true):\(routine.status ?? "")" }
  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(routine.schedule.map { describeCron($0) + (timezone == TimeZone.current.identifier ? "" : " (\(timezone))") } ?? "When someone runs it").font(.subheadline)
      if let next { Text("Next \(next, format: .dateTime.weekday(.abbreviated).hour().minute())").font(.caption).foregroundStyle(.secondary) }
    }.task(id: identity) {
      next = nil
      guard let schedule = routine.schedule, routine.enabled != false, routine.status == "ready" else { return }
      let zone = timezone
      let date = await Task.detached { CronSchedule(schedule)?.nextRun(timezone: zone) }.value
      if !Task.isCancelled { next = date }
    }
  }
}

struct ScheduleFields: View {
  @Environment(Store.self) private var store
  @Binding var schedule: String
  var timezone: String
  @State private var preset = "none"
  @State private var time = Calendar.current.date(from: DateComponents(year: 2001, month: 1, day: 1, hour: 9))!
  @State private var day = 1
  @State private var custom = "0 9 * * 1-5"
  @State private var startedCustom = false
  @State private var loaded = false
  private let presets = [("none", "Only when someone runs it"), ("daily", "Every day"), ("weekdays", "Every weekday"), ("weekly", "Every week"), ("hourly", "Every hour"), ("custom", "Custom (cron)")]
  var body: some View {
    Section {
      Picker("How often", selection: $preset) {
        ForEach(presets, id: \.0) { Text($0.1).tag($0.0) }
      }
      if preset == "weekly" { Picker("Day", selection: $day) { ForEach(0..<7) { Text(Calendar.current.weekdaySymbols[$0]).tag($0) } } }
      if ["daily", "weekdays", "weekly"].contains(preset) { DatePicker("Time", selection: $time, displayedComponents: .hourAndMinute) }
      if preset == "custom" { customInput }
    } header: { Text("Schedule") } footer: {
      Text(schedule.isEmpty ? "Run it from here, or ask the agent in chat." : "\(describeCron(schedule)), in \(timezone).")
    }
    .onAppear {
      guard !loaded else { return }
      let parts = schedule.split(separator: " ").map(String.init)
      if schedule.isEmpty { preset = "none" }
      else if schedule == "0 * * * *" { preset = "hourly" }
      else if parts.count == 5, let m = Int(parts[0]), let h = Int(parts[1]), (0...59).contains(m), (0...23).contains(h), parts[2] == "*", parts[3] == "*" {
        time = Calendar.current.date(from: DateComponents(year: 2001, month: 1, day: 1, hour: h, minute: m)) ?? time
        if parts[4] == "*" { preset = "daily" } else if parts[4] == "1-5" { preset = "weekdays" } else if let d = Int(parts[4]), (0...7).contains(d) { preset = "weekly"; day = d % 7 } else { preset = "custom" }
      } else { preset = "custom" }
      startedCustom = preset == "custom"
      if !schedule.isEmpty { custom = schedule }
      loaded = true
    }
    .onChange(of: preset) { update() }.onChange(of: time) { update() }.onChange(of: day) { update() }
  }
  private var customInput: some View {
    TextField("Custom schedule (cron)", text: Binding(get: { custom }, set: { custom = $0; preset = "custom"; update() })).textInputAutocapitalization(.never).autocorrectionDisabled()
  }
  private func update() {
    guard loaded else { return }
    let hour = Calendar.current.component(.hour, from: time), minute = Calendar.current.component(.minute, from: time)
    switch preset {
    case "none": schedule = ""
    case "hourly": schedule = "0 * * * *"
    case "daily": schedule = "\(minute) \(hour) * * *"
    case "weekdays": schedule = "\(minute) \(hour) * * 1-5"
    case "weekly": schedule = "\(minute) \(hour) * * \(day)"
    default: schedule = custom.trimmed
    }
  }
}
