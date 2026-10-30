import SwiftUI

/**
 * An agent working in the background for you (agent-Background.dc.html): it checks in on its own
 * and writes to you only when something needs you. A switch, how often, quiet hours and the most
 * checks a day; what's coming up and what it can see; model and usage under More options.
 * Anything else, you just tell the agent.
 */
struct BackgroundView: View {
  @Environment(Store.self) private var store
  var agent: Agent
  @State private var catalog: AgentModels.Catalog?
  @State private var action = FormAction()
  @State private var reminding: ReminderTarget?
  @ReduceMotion private var reduceMotion

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
    return f.isEmpty ? "Everything it can reach" : f.prefix(1).uppercased() + f.dropFirst()
  }
  private var paceText: String {
    let text = Self.paces.first { $0.minutes == every }?.label ?? "every \(every) minutes"
    return text.prefix(1).uppercased() + text.dropFirst()
  }
  private var quietText: String { Self.quiet(quietStart, quietEnd) }
  private var cap: Int { work == nil ? state?.defaultDailyCap ?? 24 : work?.dailyCap ?? 0 }

  var body: some View {
    AgentFrame(title: "Background", subtitle: agent.name) {
      if state == nil {
        ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
      } else if let reason = state?.notAllowed {
        AgentCard { Text("\(reason).").font(.system(size: 15)).foregroundStyle(Palette.muted) }
      } else {
        CardGroup {
          SwitchRow(title: "Work in the background for you",
                    isOn: Binding(get: { on }, set: { v in save(["enabled": AnyEncodable(v)]) }), id: "background-toggle")
            .disabled(!canEdit || action.busy)
        }
        keepingTrack
        CardCaption("Check in")
        CardGroup {
          // yours alone (not the agent's settings), so anyone it answers can turn it off
          SwitchRow(title: "Check back when a chat stops", subtitle: "Once or twice, then lets it go",
                    isOn: Binding(get: { state?.checkback ?? true }, set: { v in action.run { try await store.setCheckback(agent.id, enabled: v) } }), id: "background-checkback")
            .disabled(action.busy)
          Group {
          NavigationLink { focusPage } label: { RowLabel(title: "What it checks", value: watching) }
            .buttonStyle(.plain).accessibilityIdentifier("background-focus")
          NavigationLink { pacePage } label: { RowLabel(title: "How often", value: paceText) }
            .buttonStyle(.plain).accessibilityIdentifier("background-pace")
          NavigationLink { quietPage } label: { RowLabel(title: "Quiet hours", value: quietText) }
            .buttonStyle(.plain).accessibilityIdentifier("background-quiet")
          Menu {
            ForEach(Array(Set(Self.caps + (cap > 0 ? [cap] : []))).sorted(), id: \.self) { n in
              Button("\(n) a day") { save(["dailyCap": AnyEncodable(n)]) }
            }
            Button("No limit") { save(["dailyCap": .null]) }
          } label: {
            RowLabel(title: "Most checks a day", value: cap == 0 ? "No limit" : "\(cap)", chevron: true)
          }.disabled(!canEdit).accessibilityIdentifier("background-cap")
          }
          .disabled(!canEdit || action.busy)
        }
        today
        if let sources = state?.sources, !sources.isEmpty {
          CardGroup {
            RowLabel(title: "Can see", value: sources.map(\.name).joined(separator: ", "), chevron: false, leading: { rowIcon("eye") })
          }
        }
        CardGroup {
          NavigationLink { morePage } label: { RowLabel(title: "More options") }
            .buttonStyle(.plain).accessibilityIdentifier("background-more")
        }
        if let work, on || work.lastAt != nil {
          CardCaption(statusText(work))
        }
        PillButton(title: "Check now", kind: .secondary, busy: work?.checking == true, id: "background-check") {
          action.run { try await store.checkBackground(agent.id) }
        }.disabled(action.busy || work?.checking == true || !canEdit)
        CardCaption("Or just tell \(agent.name), like \u{201C}check less on weekends\u{201D}.")
      }
      AgentError(text: action.error)
    }
    .task {
      do {
        try await store.refreshBackground(agent.id)
        try? await store.refreshAllowance()
        catalog = try await store.agentModels(agent.id).catalog
      } catch { action.error = error.localizedDescription }
    }
  }

  // MARK: keeping track (loops-Track.dc.html)

  /** What it will come back to and the chats that wait on you; a reminder opens the reminder sheet, a chat opens the chat. */
  @ViewBuilder private var keepingTrack: some View {
    let rows = Loops.trackRows(followups: state?.followups ?? [], loops: state?.loops ?? [], agent: agent)
    if !rows.isEmpty {
      CardCaption("Keeping track · \(rows.count)")
      CardGroup {
        ForEach(rows) { row in
          if let reminder = row.reminder {
            Button { reminding = reminder } label: { trackRow(row) }
              .buttonStyle(.pressRow).accessibilityIdentifier("track-row")
          } else if let channel = row.channelId.flatMap({ id in store.channels.first { $0.id == id } }) {
            NavigationLink { ChannelView(channel: channel) } label: { trackRow(row) }
              .buttonStyle(.pressRow).accessibilityIdentifier("track-row")
          } else {
            trackRow(row, chevron: false)
          }
        }
      }
      .animation(Motion.pick(Motion.soft, reduceMotion), value: rows.map(\.id))
      .sheet(item: $reminding) { ReminderSheet(target: $0) }
    }
  }

  private func trackRow(_ row: Loops.TrackRow, chevron: Bool = true) -> some View {
    let tint = row.onPerson ? Palette.statusNeeds : Palette.blue
    return HStack(spacing: 12) {
      Image(systemName: row.onPerson ? "bubble.left" : "clock")
        .font(.system(size: 13, weight: .medium)).foregroundStyle(tint)
        .frame(width: 28, height: 28)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(tint.tint16))
        .accessibilityLabel(row.onPerson ? "On you" : "On \(agent.name)")
      VStack(alignment: .leading, spacing: 2) {
        Text(row.title).font(.system(size: 15)).foregroundStyle(Palette.text).lineLimit(2).multilineTextAlignment(.leading)
        Text(row.subtitle).font(.system(size: 13)).foregroundStyle(Palette.faint).lineLimit(1)
      }
      Spacer(minLength: 8)
      if chevron { Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.faint) }
    }
    .padding(.horizontal, 14).padding(.vertical, 8).frame(minHeight: 56)
    .contentShape(Rectangle())
  }

  // MARK: today

  @ViewBuilder private var today: some View {
    let usage = state?.usage
    if let checks = usage?.checksToday, checks > 0 {
      CardCaption("Today")
      CardGroup {
        RowLabel(title: "Checked \(checks) \(checks == 1 ? "time" : "times") today", chevron: false)
      }
    }
  }

  private func statusText(_ work: BackgroundWork) -> String {
    if work.checking == true { return store.agent(agent.id)?.status == .offline ? "Waiting for its device" : "Checking now" }
    // why the next check waits, when the hub stretched it
    let why = work.nextReason == "nothing to watch yet" || work.nextReason == "quiet lately" ? " · \(work.nextReason!)" : ""
    if let last = work.lastAt.flatMap(Wire.date) {
      return "Checked " + last.formatted(.relative(presentation: .named)) + why + (work.lastNote.map { $0.isEmpty ? "" : ": \($0)" } ?? "")
    }
    return "Hasn't checked yet" + why
  }

  // MARK: pages

  private var focusPage: some View { FocusPage(agent: agent, initial: work?.focus ?? "") { text in save(["focus": AnyEncodable(text)]) } }

  private var pacePage: some View {
    AgentFrame(title: "How often", subtitle: agent.name) {
      CardGroup {
        ForEach(Self.paces, id: \.minutes) { pace in
          ChoiceRow(title: pace.label.prefix(1).uppercased() + pace.label.dropFirst(), selected: pace.minutes == every) { save(["everyMinutes": AnyEncodable(pace.minutes)]) }
        }
      }.disabled(!canEdit || action.busy)
    }
  }

  private var quietPage: some View {
    QuietPage(agent: agent, start: quietStart, end: quietEnd, timezoneSet: store.me?.timezone != nil) { patch in save(patch) }
  }

  private var morePage: some View {
    AgentFrame(title: "More options", subtitle: agent.name) {
      let models = catalog?.models ?? []
      let chosen = models.first { $0.id == (work?.model ?? agent.model) }
      let efforts = chosen?.efforts ?? catalog?.efforts ?? []
      CardGroup {
        menuRow("Model for checks", value: work?.model.flatMap { id in models.first { $0.id == id }?.label ?? id } ?? "\(agent.name)'s own") {
          Button("\(agent.name)'s own") { save(["model": .null, "effort": .null]) }
          ForEach(models) { m in Button(m.label) { save(["model": AnyEncodable(m.id), "effort": .null]) } }
        }
        if !efforts.isEmpty || work?.effort != nil {
          menuRow("Effort", value: AgentLine.effort(work?.effort ?? "")) {
            Button("Default") { save(["effort": .null]) }
            ForEach(efforts, id: \.self) { e in Button(AgentLine.effort(e)) { save(["effort": AnyEncodable(e)]) } }
          }
        }
        NavigationLink { ConnectorsView() } label: { RowLabel(title: "Connect an app") }.buttonStyle(.plain)
        if let a = store.allowance {
          NavigationLink { UsageView() } label: { allowanceRow(a) }.buttonStyle(.plain)
        }
      }.disabled(!canEdit || action.busy)
      if let usage = state?.usage { CardCaption(Self.usageLine(usage, cap: work?.dailyCap)) }
      AgentError(text: action.error)
    }
  }

  private func menuRow<Items: View>(_ title: String, value: String, @ViewBuilder _ items: () -> Items) -> some View {
    Menu { items() } label: {
      HStack {
        Text(title).font(.system(size: 15)).foregroundStyle(Palette.text)
        Spacer(minLength: 8)
        Text(value).font(.system(size: 15)).foregroundStyle(Palette.faint).lineLimit(1)
        Image(systemName: "chevron.up.chevron.down").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.faint)
      }.padding(.horizontal, 18).frame(minHeight: 54).contentShape(Rectangle())
    }
  }

  private func allowanceRow(_ a: Allowance) -> some View {
    let mine = a.agents.first { $0.agentId == agent.id }
    let share = a.dailyTokens.flatMap { daily in mine.map { Int((Double($0.tokens) / Double(daily) * 100).rounded()) } }
    return HStack(spacing: 12) {
      Capsule().fill(Palette.separator).frame(width: 70, height: 8)
        .overlay(alignment: .leading) { Capsule().fill(agentTint(agent)).frame(width: 70 * min(1, Double(share ?? 0) / 100)) }
      Text(share.map { "\(agent.name) used \($0)% of today's allowance" } ?? mine.map { "\(agent.name) used \(Allowance.text($0.tokens)) today" } ?? "\(agent.name) hasn't used any of today's allowance")
        .font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text).multilineTextAlignment(.leading)
      Spacer(minLength: 0)
    }.padding(.horizontal, 18).frame(minHeight: 60)
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

  /** "10 PM", "7:30 AM" */
  static func clockLong(_ hhmm: String) -> String {
    clock(hhmm).replacingOccurrences(of: "am", with: " AM").replacingOccurrences(of: "pm", with: " PM")
  }

  /** "10 PM to 7 AM", or "Never" when the two times are the same */
  static func quiet(_ start: String, _ end: String) -> String {
    start == end ? "Never" : "\(clockLong(start)) to \(clockLong(end))"
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
private struct FocusPage: View {
  var agent: Agent
  var initial: String
  var save: (String) -> Void
  @State private var text = ""
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    AgentFrame(title: "What it checks", subtitle: agent.name) {
      FieldCard(label: "What to keep an eye on", text: $text, prompt: "Everything it can reach. Or: my inbox and calendar, anything from my landlord.", lines: 3...8)
      PillButton(title: "Save") { save(text); dismiss() }.disabled(text.count > 2000)
    }
    .onAppear { text = initial }
  }
}

/** Quiet hours: two times, or none. */
private struct QuietPage: View {
  var agent: Agent
  var start: String
  var end: String
  var timezoneSet: Bool
  var save: (Fields) -> Void

  var body: some View {
    AgentFrame(title: "Quiet hours", subtitle: agent.name) {
      CardGroup {
        DatePicker(selection: time(start) { save(["quietStart": AnyEncodable($0)]) }, displayedComponents: .hourAndMinute) {
          Text("From").font(.system(size: 15)).foregroundStyle(Palette.text)
        }.padding(.horizontal, 18).frame(minHeight: 54)
        DatePicker(selection: time(end) { save(["quietEnd": AnyEncodable($0)]) }, displayedComponents: .hourAndMinute) {
          Text("To").font(.system(size: 15)).foregroundStyle(Palette.text)
        }.padding(.horizontal, 18).frame(minHeight: 54)
        ChoiceRow(title: "No quiet hours", selected: start == end) { save(["quietEnd": AnyEncodable(start)]) }
      }
      if !timezoneSet {
        CardGroup { NavigationLink { ProfileSettingsView() } label: { RowLabel(title: "Set your time zone", subtitle: "It's UTC for now") }.buttonStyle(.plain) }
      }
    }
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
