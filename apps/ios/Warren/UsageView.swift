import SwiftUI

/** Settings → Usage: one daily allowance for everything your agents do on their own, and who used what today. */
struct UsageView: View {
  @Environment(Store.self) private var store
  @State private var action = FormAction()

  var body: some View {
    Form {
      if let a = store.allowance {
        Section {
          VStack(alignment: .leading, spacing: 14) {
            Text("Agents working on their own can use up to").font(.title3.weight(.semibold))
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
              ForEach(Allowance.levels, id: \.label) { level in
                let on = a.dailyTokens == level.tokens
                Button { action.run { try await store.saveAllowance(level.tokens) } } label: {
                  Text(level.tokens.map { "\(level.label) · \(Allowance.text($0))" } ?? level.label)
                    .font(.callout.weight(.bold))
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .foregroundStyle(on ? Color(.systemBackground) : .primary)
                    .background(Capsule().fill(on ? Color.primary : Color(.tertiarySystemFill)))
                }
                .buttonStyle(.plain)
                .disabled(action.busy)
                .accessibilityAddTraits(on ? .isSelected : [])
                .accessibilityIdentifier("allowance-\(level.label)")
              }
            }
            if let custom = a.dailyTokens, !Allowance.levels.contains(where: { $0.tokens == custom }) {
              Text(Allowance.text(custom)).font(.callout.weight(.bold)).padding(.horizontal, 16).frame(minHeight: 44)
                .foregroundStyle(Color(.systemBackground)).background(Capsule().fill(Color.primary))
            }
            Text("tokens a day.").font(.title3.weight(.semibold))
          }.padding(.vertical, 6)
        }
        Section {
          UsageBar(allowance: a).padding(.vertical, 6)
          if a.agents.isEmpty {
            Text("Nothing yet today.").foregroundStyle(.secondary)
          }
          ForEach(a.agents) { use in
            HStack(spacing: 12) {
              AgentAvatar(agent: store.agent(use.agentId), size: 26, showStatus: false)
              Text(store.agent(use.agentId)?.name ?? "An agent").font(.body.weight(.semibold)).lineLimit(1)
              Spacer()
              Text("\(use.checks) \(use.checks == 1 ? "check" : "checks")").font(.subheadline).foregroundStyle(.secondary)
              Text(Allowance.text(use.tokens)).font(.body.weight(.bold)).frame(minWidth: 44, alignment: .trailing)
            }
          }
        } header: {
          HStack {
            Text("Today")
            Spacer()
            Text("\(a.estimated == true ? "about " : "")\(Allowance.text(a.todayTokens))\(a.dailyTokens.map { " of \(Allowance.text($0))" } ?? "")")
          }
        } footer: {
          Text("Near the limit, agents check half as often. At the limit, they wait until tomorrow.")
        }
      } else if action.error == nil {
        ProgressView()
      }
      InlineError(error: action.error)
    }
    .sectionScreen("Usage", id: "usage")
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
    .background(Color(.tertiarySystemFill))
    .clipShape(Capsule())
    .accessibilityHidden(true)
  }
}

/** The agent's ghost color, for bars and dots. */
func agentTint(_ agent: Agent?) -> Color {
  Color(hex: (agent?.settings?.appearance ?? GhostLook.defaultAppearance(agent?.handle ?? "agent")).resolved.color)
}
