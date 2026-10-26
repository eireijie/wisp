import SwiftUI

/** Settings → Usage (set-Usage.dc.html): one daily allowance for everything your agents do on their own, and who used what today. */
struct UsageView: View {
  @Environment(Store.self) private var store
  @State private var action = FormAction()

  var body: some View {
    SettingsPage("Usage", id: "usage") {
      if let a = store.allowance {
        CardLabel("Agents working on their own can use up to")
        SegmentedPicker(options: Allowance.levels.indices.map { ($0, Allowance.levels[$0].label) },
                        selection: Binding(get: { Allowance.levels.firstIndex { $0.tokens == a.dailyTokens } ?? -1 },
                                           set: { i in action.run { try await store.saveAllowance(Allowance.levels[i].tokens) } }),
                        label: "Daily allowance", id: "allowance")
        if let custom = a.dailyTokens, !Allowance.levels.contains(where: { $0.tokens == custom }) {
          CardHint("Set to \(Allowance.text(custom)) tokens a day.")
        } else if let level = Allowance.levels.first(where: { $0.tokens == a.dailyTokens }) {
          CardHint(level.tokens.map { "\(level.label) is \(Allowance.text($0)) tokens a day, shared by everyone in \(store.workspace?.name ?? "this organization")." } ?? "No limit: agents use what the work needs.")
        }
        VStack(alignment: .leading, spacing: 12) {
          HStack(alignment: .firstTextBaseline) {
            Text("Today").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text)
            Spacer()
            Text("\(a.estimated == true ? "about " : "")\(Allowance.text(a.todayTokens))\(a.dailyTokens.map { " of \(Allowance.text($0))" } ?? "")")
              .font(.system(size: 13)).foregroundStyle(Palette.faint)
          }
          UsageBar(allowance: a)
        }
        .padding(.horizontal, 18).padding(.vertical, 16)
        .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
        if a.agents.isEmpty {
          CardHint("Nothing yet today.")
        } else {
          CardGroup {
            ForEach(a.agents) { use in
              HStack(spacing: 12) {
                AgentAvatar(agent: store.agent(use.agentId), size: 28, showStatus: false)
                Text(store.agent(use.agentId)?.name ?? "An agent").font(.system(size: 15)).foregroundStyle(Palette.text).lineLimit(1)
                Spacer()
                Text("\(use.checks) \(use.checks == 1 ? "check" : "checks")").font(.system(size: 13)).foregroundStyle(Palette.faint)
                Text(Allowance.text(use.tokens)).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text).frame(minWidth: 48, alignment: .trailing)
              }.padding(.horizontal, 18).frame(minHeight: 54)
            }
          }
        }
        CardHint("Near the limit, agents check half as often. At the limit, they wait until tomorrow.")
      } else if action.error == nil {
        ProgressView().padding(.top, 30)
      }
      StatusLine(error: action.error)
    }
    .task { do { try await store.refreshAllowance() } catch { action.error = error.localizedDescription } }
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
