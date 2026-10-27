import SwiftUI

/** Settings → Usage: what agents used, who used it, and the daily limit for work they do on their own. */
struct UsageView: View {
  @Environment(Store.self) private var store
  @State private var range = "7d"
  @State private var report: UsageReport?
  @State private var loadError: String?
  @State private var now = Date()
  @State private var seq = 0

  static let ranges = [("today", "Today"), ("7d", "7 days"), ("30d", "30 days")]

  var body: some View {
    SettingsPage("Usage", id: "usage") {
      SegmentedPicker(options: Self.ranges.map { ($0.0, $0.1) }, selection: $range, label: "Range", id: "usage-range")
      if let r = report, r.range == range {
        if loadError != nil {
          HStack(spacing: 10) {
            Text("Couldn't refresh.").font(.system(size: 13)).foregroundStyle(Palette.red)
            Button("Retry") { Task { await load() } }.font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.blue)
            Spacer()
          }.padding(.horizontal, 6)
        }
        UsageContent(report: r, now: now, range: range)
        UsageLimitCard(current: r.background.dailyTokens, onSaved: { await load() })
      } else if let loadError {
        VStack(alignment: .leading, spacing: 12) {
          Text("Couldn't load usage. \(loadError)").font(.system(size: 13)).foregroundStyle(Palette.red)
          Button { Task { await load() } } label: {
            Text("Retry").font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.text)
              .padding(.horizontal, 14).frame(height: 32)
              .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Palette.hairline))
          }.buttonStyle(.plain).accessibilityIdentifier("usage-retry")
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(16).usageCard()
      } else {
        ProgressView().padding(.top, 30)
      }
    }
    .refreshable { await load() }
    .task(id: range) { await load() }
    .onChange(of: store.backgroundVersion) { _, _ in Task { try? await Task.sleep(for: .milliseconds(800)); await load() } }
    .onChange(of: store.allowance?.todayTokens) { _, _ in Task { await load() } }
    .onChange(of: store.allowance?.dailyTokens) { _, _ in Task { await load() } }
  }

  /** Latest request wins; a slow answer for an old range is dropped. */
  private func load() async {
    seq += 1
    let mine = seq
    let asked = range
    do {
      let r = try await store.fetchUsage(range: asked)
      guard mine == seq else { return }
      report = r
      loadError = nil
      now = Date()
    } catch is CancellationError {
      return
    } catch {
      guard mine == seq else { return }
      loadError = error.localizedDescription
    }
  }
}

extension View {
  fileprivate func usageCard() -> some View {
    background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
  }
}

/** Number helpers shared by the page and its tests. */
enum UsageFormat {
  /** 340k, 1.6M, 2B; small numbers stay as they are */
  static func compact(_ n: Int) -> String {
    if n < 1000 { return String(n) }
    func fmt(_ v: Double, _ unit: String) -> String {
      if v >= 10 { return "\(Int(v.rounded()))\(unit)" }
      let t = (v * 10).rounded() / 10
      return (t == t.rounded() ? String(Int(t)) : String(t)) + unit
    }
    let d = Double(n)
    if d < 999_500 { return fmt(d / 1000, "k") }
    if d < 999_500_000 { return fmt(d / 1_000_000, "M") }
    return fmt(d / 1_000_000_000, "B")
  }

  /** "500000", "500k", "2M", "1.5m" → a number, or nil */
  static func parseTokens(_ text: String) -> Int? {
    var t = text.trimmingCharacters(in: .whitespaces).lowercased().replacingOccurrences(of: " ", with: "")
    var scale = 1.0
    if let last = t.last, "kmb".contains(last) {
      scale = ["k": 1e3, "m": 1e6, "b": 1e9][String(last)]!
      t.removeLast()
    }
    t = t.replacingOccurrences(of: ",", with: ".")
    // "1.000" style thousands separators with no suffix
    if scale == 1, t.range(of: #"^\d{1,3}(\.\d{3})+$"#, options: .regularExpression) != nil { t = t.replacingOccurrences(of: ".", with: "") }
    guard !t.isEmpty, t.range(of: #"^\d+(\.\d+)?$"#, options: .regularExpression) != nil, let v = Double(t) else { return nil }
    let n = (v * scale).rounded()
    return n.isFinite && n < 1e15 ? Int(n) : nil
  }

  static func city(_ tz: String) -> String { (tz.split(separator: "/").last.map(String.init) ?? tz).replacingOccurrences(of: "_", with: " ") }

  static func until(_ iso: String, now: Date) -> String {
    guard let at = Wire.date(iso) else { return "soon" }
    let mins = max(0, Int((at.timeIntervalSince(now) / 60).rounded(.up)))
    return mins >= 60 ? "in \(mins / 60)h \(mins % 60)m" : "in \(mins)m"
  }

  static func delta(total: Int, previous: Int, range: String) -> String {
    let vs = ["today": "yesterday", "7d": "last week", "30d": "last month"][range] ?? "before"
    if previous == 0 { return total == 0 ? "No tokens yet" : "Nothing before, vs \(vs)" }
    let pct = Int((Double(total - previous) / Double(previous) * 100).rounded())
    return "\(pct > 0 ? "+" : pct < 0 ? "−" : "")\(abs(pct))% vs \(vs)"
  }

  /** One label per bar: sparse hours, weekdays, or sparse dates; "" for none. */
  static func labels(_ r: UsageReport) -> [String] {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = TimeZone(identifier: r.tz) ?? .current
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US")
    f.timeZone = cal.timeZone
    let n = r.buckets.count
    return r.buckets.enumerated().map { i, b in
      if r.range == "today" {
        if i % 4 != 0 { return "" }
        return i == 0 ? "12a" : i < 12 ? "\(i)a" : i == 12 ? "12p" : "\(i - 12)p"
      }
      if i == n - 1 { return "Today" }
      guard let d = Wire.date(b.start) else { return "" }
      if r.range == "7d" { f.dateFormat = "EEE"; return f.string(from: d) }
      f.dateFormat = "MMM d"
      return (n - 1 - i) % 5 == 0 ? f.string(from: d) : ""
    }
  }
}

private let chatShade = Palette.blue
private let ownShade = Color(light: 0x0A4FA8, dark: 0x1E5FB8)

private struct UsageContent: View {
  @Environment(Store.self) private var store
  var report: UsageReport
  var now: Date
  var range: String

  var body: some View {
    let t = report.totals
    let bg = report.background
    LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible())], spacing: 10) {
      stat("Tokens", (t.estimated ? "about " : "") + UsageFormat.compact(t.tokens), UsageFormat.delta(total: t.tokens, previous: report.previousTokens, range: range))
      stat("Runs", "\(t.runs)", t.failed > 0 ? "\(t.failed) failed" : "None failed")
      VStack(alignment: .leading, spacing: 3) {
        Text("On their own today").font(.system(size: 12)).foregroundStyle(Palette.muted).lineLimit(1)
        HStack(alignment: .firstTextBaseline, spacing: 4) {
          Text(UsageFormat.compact(bg.todayTokens)).font(.system(size: 20, weight: .semibold)).monospacedDigit()
          if let d = bg.dailyTokens { Text("/ \(UsageFormat.compact(d))").font(.system(size: 13)).foregroundStyle(Palette.faint) }
        }.foregroundStyle(Palette.text).lineLimit(1).minimumScaleFactor(0.7)
        if let d = bg.dailyTokens, d > 0 {
          GeometryReader { g in
            ZStack(alignment: .leading) {
              Capsule().fill(Palette.hairline)
              Capsule().fill(chatShade).frame(width: g.size.width * min(1, Double(bg.todayTokens) / Double(d)))
            }
          }.frame(height: 4).padding(.top, 5).accessibilityHidden(true)
        }
      }
      .frame(maxWidth: .infinity, minHeight: 74, alignment: .topLeading).padding(.horizontal, 14).padding(.vertical, 12).usageCard()
      .accessibilityElement(children: .combine)
      stat("Resets", UsageFormat.until(bg.resetsAt, now: now), "Midnight, \(UsageFormat.city(report.tz))")
    }
    UsageChart(report: report)
    agentsCard
    modelsCard
  }

  private func stat(_ label: String, _ value: String, _ sub: String) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(label).font(.system(size: 12)).foregroundStyle(Palette.muted).lineLimit(1)
      Text(value).font(.system(size: 20, weight: .semibold)).monospacedDigit().foregroundStyle(Palette.text).lineLimit(1).minimumScaleFactor(0.7)
      Text(sub).font(.system(size: 12)).foregroundStyle(Palette.muted).lineLimit(1).minimumScaleFactor(0.8)
    }
    .frame(maxWidth: .infinity, minHeight: 74, alignment: .topLeading).padding(.horizontal, 14).padding(.vertical, 12).usageCard()
    .accessibilityElement(children: .combine)
  }

  private var agentsCard: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        Text("By agent").frame(maxWidth: .infinity, alignment: .leading)
        Text("Runs").frame(width: 38, alignment: .trailing)
        Text("Tokens").frame(width: 52, alignment: .trailing)
        Text("Share").frame(width: 38, alignment: .trailing)
      }
      .font(.system(size: 12)).foregroundStyle(Palette.faint).padding(.horizontal, 14).frame(height: 34)
      Divider().overlay(Palette.separator)
      if report.agents.isEmpty {
        Text("Nothing yet in this time.").font(.system(size: 13)).foregroundStyle(Palette.muted)
          .frame(maxWidth: .infinity, alignment: .leading).padding(14)
      }
      ForEach(report.agents) { use in
        let agent = store.agent(use.agentId)
        HStack(spacing: 8) {
          HStack(spacing: 8) {
            AgentAvatar(agent: agent, size: 22, showStatus: false)
            Text(agent?.name ?? "Deleted agent").font(.system(size: 14)).foregroundStyle(agent == nil ? Palette.muted : Palette.text).lineLimit(1)
          }.frame(maxWidth: .infinity, alignment: .leading)
          Text("\(use.runs)").foregroundStyle(Palette.muted).frame(width: 38, alignment: .trailing)
          Text(UsageFormat.compact(use.tokens)).foregroundStyle(Palette.text).frame(width: 52, alignment: .trailing)
          Text(report.totals.tokens > 0 ? "\(Int((Double(use.tokens) / Double(report.totals.tokens) * 100).rounded()))%" : "0%")
            .foregroundStyle(Palette.muted).frame(width: 38, alignment: .trailing)
        }
        .font(.system(size: 14)).monospacedDigit().padding(.horizontal, 14).frame(height: 42)
        .accessibilityElement(children: .combine)
        if use.id != report.agents.last?.id { Divider().overlay(Palette.separator) }
      }
    }
    .usageCard()
  }

  private var modelsCard: some View {
    let top = max(1, report.models.map(\.tokens).max() ?? 1)
    return VStack(alignment: .leading, spacing: 8) {
      Text("By model").font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.text)
      if report.models.isEmpty { Text("Nothing yet in this time.").font(.system(size: 13)).foregroundStyle(Palette.muted) }
      ForEach(report.models) { m in
        VStack(alignment: .leading, spacing: 5) {
          HStack(spacing: 10) {
            Text(m.model).lineLimit(1).truncationMode(.middle).foregroundStyle(Palette.text)
            Spacer(minLength: 0)
            Text(UsageFormat.compact(m.tokens)).foregroundStyle(Palette.muted).monospacedDigit()
          }.font(.system(size: 13))
          GeometryReader { g in
            ZStack(alignment: .leading) {
              Capsule().fill(Palette.hairline)
              Capsule().fill(chatShade).frame(width: g.size.width * Double(m.tokens) / Double(top))
            }
          }.frame(height: 4).accessibilityHidden(true)
        }.accessibilityElement(children: .combine)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading).padding(14).usageCard()
  }
}

/** Stacked bars: chats and tasks on top of work done on their own, with a dashed limit line on multi-day ranges. */
private struct UsageChart: View {
  var report: UsageReport
  private let height: CGFloat = 160

  var body: some View {
    let r = report
    let limit = r.range != "today" ? r.background.dailyTokens : nil
    let peak = Double(max(1, limit ?? 0, r.buckets.map { $0.chat + $0.background }.max() ?? 0))
    let labels = UsageFormat.labels(r)
    let gap: CGFloat = r.buckets.count <= 7 ? 10 : r.buckets.count <= 24 ? 3 : 2
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text(r.range == "today" ? "Tokens per hour" : "Tokens per day").font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.text)
        Spacer()
      }
      HStack(spacing: 12) {
        legend(chatShade, "Chats and tasks")
        legend(ownShade, "On their own")
      }
      ZStack(alignment: .bottom) {
        HStack(alignment: .bottom, spacing: gap) {
          ForEach(Array(r.buckets.enumerated()), id: \.offset) { _, b in
            VStack(spacing: 0) {
              Spacer(minLength: 0)
              Rectangle().fill(chatShade).frame(height: height * CGFloat(Double(b.chat) / peak))
              Rectangle().fill(ownShade).frame(height: height * CGFloat(Double(b.background) / peak))
            }
            .frame(maxWidth: .infinity).clipShape(UnevenRoundedRectangle(topLeadingRadius: 2, topTrailingRadius: 2))
          }
        }
        if let limit {
          let y = height * CGFloat(Double(limit) / peak)
          VStack(spacing: 2) {
            Spacer(minLength: 0)
            Text("Daily limit for on their own").font(.system(size: 10)).foregroundStyle(Palette.faint).frame(maxWidth: .infinity, alignment: .trailing)
            Rectangle().stroke(Palette.faint.opacity(0.7), style: StrokeStyle(lineWidth: 1, dash: [4, 3])).frame(height: 1)
          }.frame(height: y + 14, alignment: .bottom).frame(maxHeight: .infinity, alignment: .bottom).allowsHitTesting(false)
        }
      }
      .frame(height: height)
      .overlay(alignment: .bottom) { Rectangle().fill(Palette.separator).frame(height: 1) }
      HStack(alignment: .top, spacing: gap) {
        ForEach(Array(labels.enumerated()), id: \.offset) { _, l in
          Color.clear.frame(maxWidth: .infinity, minHeight: 14)
            .overlay { Text(l).font(.system(size: 10)).foregroundStyle(Palette.faint).fixedSize().monospacedDigit() }
        }
      }
    }
    .padding(14).usageCard()
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(r.range == "today" ? "Tokens per hour" : "Tokens per day"), \(UsageFormat.compact(r.totals.tokens)) in total")
  }

  private func legend(_ c: Color, _ text: String) -> some View {
    HStack(spacing: 5) {
      RoundedRectangle(cornerRadius: 2).fill(c).frame(width: 8, height: 8)
      Text(text).font(.system(size: 12)).foregroundStyle(Palette.muted)
    }
  }
}

/** The daily limit for work agents do on their own. */
private struct UsageLimitCard: View {
  @Environment(Store.self) private var store
  var current: Int?
  var onSaved: () async -> Void
  @State private var action = FormAction()
  @State private var custom = false
  @State private var text = ""
  @State private var inputError: String?
  @FocusState private var focused: Bool

  private static let presets: [(String, Int?)] = [("300k", 300_000), ("1M", 1_000_000), ("3M", 3_000_000), ("No limit", nil)]
  private var presetIndex: Int? { Self.presets.firstIndex { $0.1 == current } }
  private var showCustom: Bool { custom || presetIndex == nil }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Daily limit when working on their own").font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.text)
      SegmentedPicker(
        options: Array(Self.presets.indices.map { ($0, Self.presets[$0].0) }) + [(Self.presets.count, "Custom")],
        selection: Binding(get: { showCustom ? Self.presets.count : (presetIndex ?? Self.presets.count) },
                           set: { i in
                             inputError = nil
                             if i == Self.presets.count { custom = true; text = current.map(String.init) ?? ""; focused = true; return }
                             custom = false
                             save(Self.presets[i].1)
                           }),
        label: "Daily limit", id: "usage-limit")
      if showCustom {
        HStack(spacing: 8) {
          Text("Tokens a day").font(.system(size: 13)).foregroundStyle(Palette.muted)
          TextField("500k", text: $text)
            .focused($focused).multilineTextAlignment(.trailing).monospacedDigit()
            .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.done)
            .font(.system(size: 14)).padding(.horizontal, 10).frame(height: 34)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Palette.field))
            .onSubmit(commit).accessibilityLabel("Tokens a day").accessibilityIdentifier("usage-custom")
        }
      }
      if let e = inputError ?? action.error { Text(e).font(.system(size: 12)).foregroundStyle(Palette.red) }
      Text("At 80% agents slow down. At the limit they wait for the reset.").font(.system(size: 12)).foregroundStyle(Palette.faint)
    }
    .frame(maxWidth: .infinity, alignment: .leading).padding(14).usageCard()
    .onChange(of: current) { _, v in if !custom { text = v.map(String.init) ?? "" } }
  }

  private func commit() {
    guard let n = UsageFormat.parseTokens(text), (10_000...1_000_000_000).contains(n) else {
      inputError = "Enter a number from 10k to 1B, like 500k or 2M."
      return
    }
    inputError = nil
    if n != current { save(n) }
  }

  private func save(_ tokens: Int?) {
    action.run {
      try await store.saveAllowance(tokens)
      await onSaved()
    }
  }
}

/** Today's use as one bar, a colored piece per agent. */
struct UsageBar: View {
  @Environment(Store.self) private var store
  var allowance: Allowance
  var body: some View {
    let total = Double(allowance.dailyTokens ?? max(allowance.todayTokens, 1))
    GeometryReader { geo in
      HStack(spacing: 0) {
        ForEach(allowance.agents) { use in
          Rectangle().fill(agentTint(store.agent(use.agentId))).frame(width: geo.size.width * min(1, Double(use.tokens) / total))
        }
        Spacer(minLength: 0)
      }
    }
    .frame(height: 14)
    .background(Color(light: 0xE3E3EA, dark: 0x34343A))
    .clipShape(Capsule())
    .accessibilityHidden(true)
  }
}

/** The agent's ghost color, for bars and dots. */
func agentTint(_ agent: Agent?) -> Color {
  Color(hex: (agent?.settings?.appearance ?? GhostLook.defaultAppearance(agent?.handle ?? "agent")).resolved.color)
}
