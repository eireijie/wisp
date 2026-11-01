import SwiftUI

/**
 * Settings → Models (h-DesktopAccounts, laid out for a phone): the model connections you've made,
 * with how much of each plan is left and which agents use it, then the providers not connected yet.
 */
struct ModelsSettingsView: View {
  @Environment(Store.self) private var store
  @State private var connections: [ModelConnection]?
  @State private var providers: [ModelProviderInfo] = []
  @State private var error: String?
  @State private var connecting: String?
  @State private var picking = false

  private var notConnected: [ModelProviderInfo] {
    let have = Set((connections ?? []).map(\.provider))
    return providers.filter { !have.contains($0.id) }
  }

  var body: some View {
    SettingsPage(title: "Models", subtitle: "Connect once with a sign-in or a key. Every agent can use them, in any harness.", id: "models", trailing: {
      Menu {
        ForEach(providers) { p in Button(p.label) { connecting = p.id } }
      } label: { CircleLabel(symbol: "plus") }
        .accessibilityLabel("Connect a model").accessibilityIdentifier("models-connect")
    }) {
      if let connections {
        if !connections.isEmpty {
          CardGroup {
            ForEach(Array(connections.enumerated()), id: \.element.id) { i, c in
              NavigationLink { ConnectionDetailView(connection: c) } label: { ConnectionRow(connection: c) }
                .buttonStyle(.pressRow)
                .rowEntrance(i)
                .accessibilityIdentifier("connection-\(c.provider)")
            }
          }
        }
        if !notConnected.isEmpty {
          GroupCaption(title: "Not connected")
          CardGroup {
            ForEach(notConnected) { p in
              HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 1) {
                  Text(p.label).font(.system(size: 15, weight: .medium))
                  Text(p.canSignIn ? "Sign in or API key" : "API key").font(.system(size: 12)).foregroundStyle(Palette.faint)
                }
                Spacer()
                Button("Connect") { connecting = p.id }
                  .font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.text)
                  .padding(.horizontal, 12).frame(height: 28).background(Capsule().fill(Palette.control))
                  .buttonStyle(.press).accessibilityIdentifier("connect-\(p.id)")
              }
              .padding(.horizontal, 14).frame(minHeight: 52)
            }
          }
        }
      } else if let error {
        InlineError(error: error)
      } else {
        ProgressView().frame(maxWidth: .infinity).padding(.top, 30)
      }
    }
    .navigationDestination(item: $connecting) { p in
      ConnectProviderView(provider: p) { _ in connecting = nil; Task { await load() } }
    }
    .task(id: store.modelsVersion) { await load() }
    .refreshable { await load() }
  }

  private func load() async {
    do {
      async let list = store.modelConnections()
      async let all = store.modelProviders()
      let (c, p) = try await (list, all)
      connections = c; providers = p.providers; error = nil
    } catch { self.error = error.localizedDescription }
  }
}

/** One connection: its name, how it's connected, how much of the plan is left, and who uses it. */
private struct ConnectionRow: View {
  var connection: ModelConnection

  var body: some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 4) {
        Text(connection.label).font(.system(size: 15, weight: .medium)).foregroundStyle(Palette.text).lineLimit(1)
        Text(ModelWords.connectionDetail(connection)).font(.system(size: 12)).foregroundStyle(Palette.faint).lineLimit(1)
        if let usage = connection.usage {
          HStack(spacing: 8) {
            ThinBar(fraction: 1 - usage.usedFraction, color: PlanColor.of(usage)).frame(maxWidth: 140)
            Text("\(ModelWords.percentLeft(usage))% left").font(.system(size: 12)).foregroundStyle(Palette.faint).monospacedDigit()
          }.padding(.top, 2)
        }
        if let problem = connection.lastError {
          Text(problem).font(.system(size: 12)).foregroundStyle(Palette.red).lineLimit(2)
        }
      }
      Spacer(minLength: 8)
      UsedByWisps(users: connection.usedBy ?? [])
      Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.faint)
    }
    .padding(.horizontal, 14).padding(.vertical, 10)
    .contentShape(Rectangle())
  }
}

enum PlanColor {
  static func of(_ usage: PlanUsage) -> Color {
    let left = 1 - usage.usedFraction
    return left < 0.15 ? Palette.statusProblem : left < 0.35 ? Palette.statusNeeds : Palette.statusWorking
  }
}

/** The wisps of the agents on a connection (or harness), overlapped, three at most. */
struct UsedByWisps: View {
  @Environment(Store.self) private var store
  var users: [ModelConnection.User]
  var body: some View {
    let agents = users.compactMap { store.agent($0.id) }
    if !agents.isEmpty {
      HStack(spacing: -6) {
        ForEach(agents.prefix(3)) { AgentAvatar(agent: $0, size: 22, showStatus: false) }
        if agents.count > 3 { Text("+\(agents.count - 3)").font(.system(size: 11)).foregroundStyle(Palette.faint).padding(.leading, 8) }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Used by \(agents.map(\.name).joined(separator: ", "))")
    }
  }
}

/** Manage one connection: what it is, its plan windows, who uses it, rename and remove. */
struct ConnectionDetailView: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var connection: ModelConnection
  @State private var current: ModelConnection?
  @State private var renaming = false
  @State private var name = ""
  @State private var removing = false
  @State private var action = FormAction()

  private var c: ModelConnection { current ?? connection }

  var body: some View {
    SettingsPage(c.label, id: "connection") {
      CardGroup {
        ValueRow(title: "Provider", value: ModelWords.provider(c.provider))
        ValueRow(title: "Connected with", value: c.isSignIn ? "Sign-in" : (c.keyHint.map { "Key ····\($0)" } ?? "API key"))
        if let account = c.account { ValueRow(title: "Account", value: account) }
        if let plan = c.plan { ValueRow(title: "Plan", value: plan) }
      }
      if let usage = c.usage {
        CardLabel("Plan left")
        CardGroup {
          ForEach(usage.windows ?? [PlanUsage.Window(window: usage.window, usedFraction: usage.usedFraction, resetsAt: usage.resetsAt)], id: \.window) { w in
            let u = PlanUsage(window: w.window, usedFraction: w.usedFraction, resetsAt: w.resetsAt)
            VStack(alignment: .leading, spacing: 6) {
              HStack {
                Text(w.window.prefix(1).uppercased() + w.window.dropFirst()).font(.system(size: 15))
                Spacer()
                Text(ModelWords.planLine(u)).font(.system(size: 12)).foregroundStyle(Palette.faint).monospacedDigit()
              }
              ThinBar(fraction: 1 - w.usedFraction, color: PlanColor.of(u))
            }.padding(.horizontal, 14).padding(.vertical, 12)
          }
        }
      }
      let users = c.usedBy ?? []
      CardLabel("Agents on it")
      if users.isEmpty {
        CardHint("No agents yet. Pick it from an agent's Model in a chat.")
      } else {
        CardGroup {
          ForEach(users, id: \.id) { u in
            HStack(spacing: 10) {
              AgentAvatar(agent: store.agent(u.id), size: 26, showStatus: false)
              Text(u.name).font(.system(size: 15))
              Spacer()
              if let a = store.agent(u.id) { Text(HarnessChoice.label(a.harness)).font(.system(size: 13)).foregroundStyle(Palette.faint) }
            }.padding(.horizontal, 14).frame(minHeight: 46)
          }
        }
      }
      if let harnesses = c.harnesses, !harnesses.isEmpty {
        CardHint("Works in \(ShelfLogic.sentence(harnesses.map(HarnessChoice.label))).")
      }
      if let problem = c.lastError { Text(problem).font(.system(size: 13)).foregroundStyle(Palette.red).padding(.horizontal, 6) }
      if c.mine != false {
        CardGroup {
          Button { name = c.label; renaming = true } label: { RowLabel(title: "Rename", chevron: false) }.buttonStyle(.pressRow).accessibilityIdentifier("connection-rename")
          Button { removing = true } label: { RowLabel(title: "Remove", chevron: false, tint: Palette.red) }.buttonStyle(.pressRow).accessibilityIdentifier("connection-remove")
        }
      }
      InlineError(error: action.error)
    }
    .alert("Rename", isPresented: $renaming) {
      TextField("Name", text: $name)
      Button("Save") {
        let value = name.trimmed
        guard !value.isEmpty else { return }
        action.run { current = try await store.renameConnection(c.id, label: value) }
      }
      Button("Cancel", role: .cancel) {}
    }
    .confirmationDialog("Remove \(c.label)? Agents on it go back to their computer's own sign-in.", isPresented: $removing, titleVisibility: .visible) {
      Button("Remove", role: .destructive) { action.run { try await store.removeConnection(c.id); dismiss() } }
    }
  }
}
