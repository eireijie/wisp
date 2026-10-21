import SwiftUI

struct BackgroundView: View {
  @Environment(Store.self) private var store
  var agent: Agent
  @State private var enabled = false
  @State private var every = 60
  @State private var focus = ""
  @State private var quietStart = "22:00"
  @State private var quietEnd = "07:00"
  @State private var cap = 24
  @State private var model = ""
  @State private var effort = ""
  @State private var catalog: AgentModels.Catalog?
  @State private var loaded = false
  @State private var saved = false
  @State private var action = FormAction()
  private var state: AgentBackground? { store.backgrounds[agent.id] }
  private var canEdit: Bool { store.canManage && state?.notAllowed == nil && loaded }
  private var timeValid: Bool { [quietStart, quietEnd].allSatisfy { $0.range(of: "^([01]\\d|2[0-3]):[0-5]\\d$", options: .regularExpression) != nil } }
  var body: some View {
    Form {
      Section {
        Text("\(agent.name) keeps an eye on everything it can reach for you, on its own. It writes to you only when something needs you, with the work done and ready for your OK.")
        if let reason = state?.notAllowed { Text(reason).foregroundStyle(.secondary) }
        Toggle("Work in the background for you", isOn: $enabled).disabled(!canEdit)
        Text("Each check uses your AI account like a normal message, so your AI provider may charge for each one. The daily limit counts checks, not money.").font(.footnote).foregroundStyle(.secondary)
      }
      Section {
        Stepper("How often: every \(every) minutes", value: $every, in: 10...1440, step: 5)
        Stepper(cap == 0 ? "Most checks a day: No limit" : "Most checks a day: \(cap)", value: $cap, in: 0...1000)
        LabeledContent("Quiet hours start") { TextField("HH:MM", text: $quietStart).multilineTextAlignment(.trailing).accessibilityLabel("Quiet hours start") }
        LabeledContent("Quiet hours end") { TextField("HH:MM", text: $quietEnd).multilineTextAlignment(.trailing).accessibilityLabel("Quiet hours end") }
        VStack(alignment: .leading) {
          Text("What to keep an eye on").font(.subheadline).foregroundStyle(.secondary)
          TextField("Optional focus", text: $focus, axis: .vertical).lineLimit(3...8).accessibilityLabel("What to keep an eye on")
        }
        TechnicalDetails(title: "Model for checks") {
          Picker("Model for background checks", selection: $model) {
            Text("\(agent.name)'s own model").tag("")
            ForEach(catalog?.models ?? []) { Text($0.label).tag($0.id) }
            if !model.isEmpty && !(catalog?.models.contains { $0.id == model } ?? false) { Text(model).tag(model) }
          }
          TextField("Reasoning effort (blank for default)", text: $effort).textInputAutocapitalization(.never)
        }
      }.disabled(!canEdit || action.busy)
      if canEdit {
        Button("Save") {
          action.run {
            try await store.saveBackground(agent.id, ["enabled": AnyEncodable(enabled), "everyMinutes": AnyEncodable(every), "focus": AnyEncodable(focus), "quietStart": AnyEncodable(quietStart), "quietEnd": AnyEncodable(quietEnd), "model": .nullable(model), "effort": .nullable(effort), "dailyCap": cap == 0 ? .null : AnyEncodable(cap)])
            saved = true
          }
        }.disabled(action.busy || !timeValid || focus.count > 2000)
        Button("Check now") { action.run { try await store.checkBackground(agent.id) } }.disabled(action.busy || state?.background?.checking == true)
      }
      if saved { Text("Saved.").foregroundStyle(.green) }
      if let work = state?.background {
        if let next = work.nextAt, let date = Wire.date(next) { LabeledContent("Next check") { Text(date, format: .dateTime.month().day().hour().minute()) } }
        if let reason = work.nextReason, !reason.isEmpty { Text(reason).font(.footnote) }
        if let note = work.lastNote, !note.isEmpty { Text(note).font(.footnote) }
      }
      if let usage = state?.usage {
        Section("Usage") {
          Text("\(usage.checksToday ?? 0) checks today")
          if let tokens = usage.todayTokens { Text("Today: \(tokens) tokens") }
          if usage.capReached == true { Text("Reached for today: regular checks resume tomorrow.") }
        }
      }
      Section("What it can see") {
        ForEach(Array((state?.sources ?? []).enumerated()), id: \.offset) { _, source in LabeledContent(source.name, value: source.detail ?? source.kind) }
        NavigationLink("Connect more apps") { ConnectorsView() }
      }
      Section("Follow-ups") {
        if state?.followups?.isEmpty != false { Text("None. Ask it to remind you of something, or to check back on something later, and it sets one.").foregroundStyle(.secondary) }
        ForEach(state?.followups ?? []) { followup in
          VStack(alignment: .leading) {
            Text(followup.note)
            if let date = Wire.date(followup.dueAt) { Text(date, format: .dateTime.month().day().hour().minute()).font(.caption) }
            if followup.userId == nil || followup.userId == store.me?.id || store.isOwner {
              Button("Cancel this follow-up", role: .destructive) { action.run { try await store.cancelFollowup(followup, agentId: agent.id) } }.disabled(action.busy)
            }
          }
        }
      }
      InlineError(error: action.error)
    }.sectionScreen("Background", id: "background")
      .task {
        do {
          try await store.refreshBackground(agent.id)
          let work = state?.background
          enabled = work?.enabled ?? false; every = work?.everyMinutes ?? 60; focus = work?.focus ?? ""
          quietStart = work?.quietStart ?? "22:00"; quietEnd = work?.quietEnd ?? "07:00"
          cap = work == nil ? state?.defaultDailyCap ?? 24 : work?.dailyCap ?? 0
          model = work?.model ?? ""; effort = work?.effort ?? ""; loaded = true
          catalog = try await store.agentModels(agent.id).catalog
        } catch { action.error = error.localizedDescription }
      }
  }
}
