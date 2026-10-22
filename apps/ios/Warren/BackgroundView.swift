import SwiftUI

/**
 * An agent working in the background for you: it checks in on its own and writes to you only when
 * something needs you. The settings read as one sentence; each underlined word opens a picker.
 * Anything else is under More, or you just tell the agent.
 */
struct BackgroundView: View {
  @Environment(Store.self) private var store
  var agent: Agent
  @State private var catalog: AgentModels.Catalog?
  @State private var picking: Word?
  @State private var showMore = false
  @State private var action = FormAction()

  enum Word: String, Identifiable { case focus, pace, quiet; var id: String { rawValue } }
  static let paces: [(minutes: Int, label: String)] = [(15, "every 15 minutes"), (30, "every 30 minutes"), (60, "every hour"), (120, "every 2 hours"), (240, "every 4 hours")]
  static let caps = [6, 12, 24, 48, 96]

  private var state: AgentBackground? { store.backgrounds[agent.id] }
  private var work: BackgroundWork? { state?.background }
  private var canEdit: Bool { store.canManage && state != nil && state?.notAllowed == nil }
  private var on: Bool { work?.enabled == true }
  private var every: Int { work?.everyMinutes ?? 60 }
  private var quietStart: String { work?.quietStart ?? "22:00" }
  private var quietEnd: String { work?.quietEnd ?? "07:00" }
  private var watching: String {
    let f = (work?.focus ?? "").trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: ". "))
    return f.isEmpty ? "everything it can reach" : f
  }
  private var paceText: String { Self.paces.first { $0.minutes == every }?.label ?? "every \(every) minutes" }
  private var quietText: String { quietStart == quietEnd ? "never" : "\(Self.clock(quietStart))–\(Self.clock(quietEnd))" }

  var body: some View {
    Form {
      if state == nil {
        ProgressView()
      } else if let reason = state?.notAllowed {
        Text("\(reason).").foregroundStyle(.secondary)
      } else {
        Section {
          Toggle("Work in the background for you", isOn: Binding(get: { on }, set: { v in save(["enabled": AnyEncodable(v)]) }))
            .font(.body.weight(.semibold)).disabled(!canEdit || action.busy)
            .accessibilityIdentifier("background-toggle")
        }
        Section {
          sentence
          if let work, on || work.lastAt != nil { status(work) }
        }
        if let a = store.allowance {
          Section {
            NavigationLink { UsageView() } label: { allowanceRow(a) }
          }
        }
        if let followups = state?.followups, !followups.isEmpty {
          Section("Coming up") {
            ForEach(followups) { f in
              HStack(spacing: 12) {
                if let date = Wire.date(f.dueAt) { Text(Self.at(date)).font(.footnote.weight(.bold)).foregroundStyle(.secondary).frame(width: 86, alignment: .leading) }
                Text(f.note).lineLimit(2)
                Spacer(minLength: 0)
                if f.userId == nil || f.userId == store.me?.id || store.isOwner {
                  Button { action.run { try await store.cancelFollowup(f, agentId: agent.id) } } label: { Image(systemName: "xmark") }
                    .buttonStyle(.borderless).foregroundStyle(.secondary).accessibilityLabel("Cancel this follow-up")
                }
              }
            }
          }
        }
        Section {
          DisclosureGroup("More", isExpanded: $showMore) { more }
            .accessibilityIdentifier("background-more")
        } footer: {
          Text("Or just tell \(agent.name), like \u{201C}check less on weekends\u{201D}.")
        }
      }
      InlineError(error: action.error)
    }
    .sectionScreen("Background", id: "background")
    .sheet(item: $picking) { word in
      NavigationStack { picker(word) }.presentationDetents([.medium, .large])
    }
    .environment(\.openURL, OpenURLAction { url in
      if canEdit, let word = Word(rawValue: url.host() ?? "") { picking = word }
      return .handled
    })
    .task {
      do {
        try await store.refreshBackground(agent.id)
        try? await store.refreshAllowance()
        catalog = try await store.agentModels(agent.id).catalog
      } catch { action.error = error.localizedDescription }
    }
  }

  // MARK: the sentence

  private var sentence: some View {
    var s = AttributedString("While you're away, \(agent.name) checks ")
    s += link(watching, .focus)
    s += AttributedString(" ")
    s += link(paceText, .pace)
    s += AttributedString(", stays quiet ")
    s += link(quietText, .quiet)
    s += AttributedString(", and messages you when something needs you.")
    return Text(s)
      .font(.title3.weight(.semibold))
      .lineSpacing(7)
      .foregroundStyle(on ? .primary : .secondary)
      .padding(.vertical, 8)
      .accessibilityIdentifier("background-sentence")
  }

  private func link(_ text: String, _ word: Word) -> AttributedString {
    var s = AttributedString(text)
    s.link = URL(string: "warren-background://\(word.rawValue)")
    s.font = .title3.weight(.heavy)
    s.underlineStyle = .single
    s.foregroundColor = on ? .primary : .secondary
    return s
  }

  @ViewBuilder private func picker(_ word: Word) -> some View {
    switch word {
    case .focus: FocusPicker(initial: work?.focus ?? "") { text in save(["focus": AnyEncodable(text)]) }
    case .pace:
      List(Self.paces, id: \.minutes) { pace in
        Button { save(["everyMinutes": AnyEncodable(pace.minutes)]); picking = nil } label: {
          HStack { Text(pace.label).foregroundStyle(.primary); Spacer(); if pace.minutes == every { Image(systemName: "checkmark") } }
        }
      }.navigationTitle("How often").navigationBarTitleDisplayMode(.inline)
    case .quiet:
      QuietPicker(start: quietStart, end: quietEnd, timezoneSet: store.me?.timezone != nil) { patch in save(patch) } done: { picking = nil }
    }
  }

  // MARK: status, allowance, more

  private func status(_ work: BackgroundWork) -> some View {
    HStack(spacing: 12) {
      Group {
        if work.checking == true {
          Text(store.agent(agent.id)?.status == .offline ? "Waiting for its device" : "Checking now")
        } else if let last = work.lastAt.flatMap(Wire.date) {
          Text("Checked \(last, format: .relative(presentation: .named))\(work.lastNote.map { $0.isEmpty ? "" : ": \($0)" } ?? "")")
        } else {
          Text("Hasn't checked yet")
        }
      }
      .font(.subheadline).foregroundStyle(.secondary).lineLimit(3)
      Spacer(minLength: 0)
      Button { action.run { try await store.checkBackground(agent.id) } } label: { Label("Check now", systemImage: "arrow.clockwise") }
        .secondaryButton().controlSize(.small).disabled(action.busy || work.checking == true || !canEdit)
    }
  }

  private func allowanceRow(_ a: Allowance) -> some View {
    let mine = a.agents.first { $0.agentId == agent.id }
    let share = a.dailyTokens.flatMap { daily in mine.map { Int((Double($0.tokens) / Double(daily) * 100).rounded()) } }
    return HStack(spacing: 12) {
      Capsule().fill(Color(.tertiarySystemFill)).frame(width: 70, height: 8)
        .overlay(alignment: .leading) { Capsule().fill(agentTint(agent)).frame(width: 70 * min(1, Double(share ?? 0) / 100)) }
      Text(share.map { "\(agent.name) used \($0)% of today's allowance" } ?? mine.map { "\(agent.name) used \(Allowance.text($0.tokens)) today" } ?? "\(agent.name) hasn't used any of today's allowance")
        .font(.subheadline.weight(.semibold))
    }
  }

  @ViewBuilder private var more: some View {
    let models = catalog?.models ?? []
    let chosen = models.first { $0.id == (work?.model ?? agent.model) }
    let efforts = chosen?.efforts ?? catalog?.efforts ?? []
    Picker("Model for checks", selection: Binding(get: { work?.model ?? "" }, set: { save(["model": .nullable($0), "effort": .null]) })) {
      Text("\(agent.name)'s own").tag("")
      ForEach(models) { Text($0.label).tag($0.id) }
      if let m = work?.model, !models.contains(where: { $0.id == m }) { Text(m).tag(m) }
    }.disabled(!canEdit)
    if !efforts.isEmpty || work?.effort != nil {
      Picker("Effort", selection: Binding(get: { work?.effort ?? "" }, set: { save(["effort": .nullable($0)]) })) {
        Text("Default").tag("")
        ForEach(efforts, id: \.self) { Text($0.capitalized).tag($0) }
        if let e = work?.effort, !efforts.contains(e) { Text(e).tag(e) }
      }.disabled(!canEdit)
    }
    let cap = work == nil ? state?.defaultDailyCap ?? 24 : work?.dailyCap ?? 0
    Picker("Most checks a day", selection: Binding(get: { cap }, set: { save(["dailyCap": $0 == 0 ? .null : AnyEncodable($0)]) })) {
      ForEach(Array(Set(Self.caps + (cap > 0 ? [cap] : []))).sorted(), id: \.self) { Text("\($0) a day").tag($0) }
      Text("No limit").tag(0)
    }.disabled(!canEdit)
    if let sources = state?.sources, !sources.isEmpty {
      ForEach(Array(sources.enumerated()), id: \.offset) { _, source in
        Label(source.name, systemImage: source.kind == "app" ? "app" : source.kind == "computer" ? "desktopcomputer" : "folder")
      }
    }
    NavigationLink("Connect an app") { ConnectorsView() }
    if let usage = state?.usage { Text(Self.usageLine(usage, cap: work?.dailyCap)).font(.footnote).foregroundStyle(.secondary) }
  }

  private func save(_ patch: Fields) {
    action.run { try await store.saveBackground(agent.id, patch) }
  }

  // MARK: text

  /** "10pm", "7:30am" */
  static func clock(_ hhmm: String) -> String {
    let p = hhmm.split(separator: ":").compactMap { Int($0) }
    guard p.count == 2 else { return hhmm }
    return "\(p[0] % 12 == 0 ? 12 : p[0] % 12)\(p[1] > 0 ? String(format: ":%02d", p[1]) : "")\(p[0] < 12 ? "am" : "pm")"
  }

  static func at(_ date: Date) -> String {
    date.formatted(Calendar.current.isDateInToday(date) ? .dateTime.hour().minute() : .dateTime.weekday(.abbreviated).hour().minute())
  }

  /** "Last check: 38k tokens · Today: 410k · 3 of 24 checks today" */
  static func usageLine(_ usage: BackgroundUsage, cap: Int?) -> String {
    var parts: [String] = []
    if let n = usage.lastTokens { parts.append("Last check: \(Allowance.text(n)) tokens") }
    if let n = usage.todayTokens { parts.append("Today: \(Allowance.text(n))") }
    if let n = usage.weekTokens { parts.append("This week: \(Allowance.text(n))") }
    if parts.isEmpty { parts.append("Token use isn't reported") }
    if let checks = usage.checksToday, checks > 0 { parts.append("\(checks)\(cap.map { " of \($0)" } ?? "") \(checks == 1 && cap == nil ? "check" : "checks") today") }
    return parts.joined(separator: " · ")
  }
}

/** What to keep an eye on, in the person's own words. */
private struct FocusPicker: View {
  var initial: String
  var save: (String) -> Void
  @State private var text = ""
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    Form {
      TextField("Everything it can reach. Or: my inbox and calendar, anything from my landlord.", text: $text, axis: .vertical)
        .lineLimit(3...8).accessibilityLabel("What to keep an eye on")
    }
    .navigationTitle("What it checks").navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .confirmationAction) {
        Button("Save") { save(text); dismiss() }.disabled(text.count > 2000)
      }
    }
    .onAppear { text = initial }
  }
}

/** Quiet hours: two times, or none. */
private struct QuietPicker: View {
  var start: String
  var end: String
  var timezoneSet: Bool
  var save: (Fields) -> Void
  var done: () -> Void
  var body: some View {
    Form {
      DatePicker("From", selection: time(start) { save(["quietStart": AnyEncodable($0)]) }, displayedComponents: .hourAndMinute)
      DatePicker("To", selection: time(end) { save(["quietEnd": AnyEncodable($0)]) }, displayedComponents: .hourAndMinute)
      Button { save(["quietEnd": AnyEncodable(start)]); done() } label: {
        HStack { Text("No quiet hours").foregroundStyle(.primary); Spacer(); if start == end { Image(systemName: "checkmark") } }
      }
      if !timezoneSet { NavigationLink("Set your time zone (now UTC)") { ProfileSettingsView() } }
    }
    .navigationTitle("Quiet hours").navigationBarTitleDisplayMode(.inline)
    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done", action: done) } }
  }

  private func time(_ hhmm: String, _ set: @escaping (String) -> Void) -> Binding<Date> {
    Binding(get: {
      let p = hhmm.split(separator: ":").compactMap { Int($0) }
      return Calendar.current.date(bySettingHour: p.first ?? 0, minute: p.count > 1 ? p[1] : 0, second: 0, of: .now) ?? .now
    }, set: { date in
      let c = Calendar.current.dateComponents([.hour, .minute], from: date)
      set(String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0))
    })
  }
}
