import SwiftUI

private extension Array {
  subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}

/** Signed in, needs a sign-in, or unknown (the device can't tell), from the account a harness shows. */
private func signState(_ s: HarnessSettings) -> (text: String, badge: String?) {
  guard let a = s.currentAccount, let signedIn = a.signedIn else { return (s.currentAccount?.who ?? "Account", nil) }
  return signedIn ? (a.who ?? a.label, "Signed in") : ("Not signed in", "Sign in")
}

/**
 * Settings → Harnesses (h-DesktopHarnesses, laid out for a phone): what runs your agents on each
 * computer, grouped by computer (each device, and each VM), with versions and the agents on each.
 * A device's harness opens its own settings there; the model is picked separately (Settings → Models).
 */
struct HarnessesView: View {
  @Environment(Store.self) private var store
  @State private var computers: [HarnessComputer]?
  @State private var error: String?
  @State private var installOn: String?
  @State private var open: HarnessOpen?

  private var devices: [AgentNode] { store.nodes.filter { $0.mine == true } }

  var body: some View {
    SettingsPage("Harnesses", subtitle: "What runs your agents on each computer. Pick the model separately.", id: "harnesses") {
      if let computers {
        if computers.isEmpty { MarketNote(text: "No computers yet. Connect one from Devices.") }
        ForEach(computers) { computer in
          GroupCaption(title: computer.name, note: computer.isVM ? "VM on \(store.nodes.first { $0.id == computer.nodeId }?.name ?? "a device")" : (computer.online ? "Device" : "Device · offline"))
          if computer.harnesses.isEmpty {
            CardHint(computer.reported ? "No harnesses here yet." : "Not reported yet. Start \(computer.name) to see its harnesses.").padding(.top, 6)
          } else {
            CardGroup {
              ForEach(computer.harnesses) { h in row(computer, h) }
            }
          }
        }
        if store.canManage && !devices.isEmpty {
          AddRow(title: "Add a harness to a computer", id: "harness-install") {
            installOn = (devices.first { $0.online } ?? devices.first)?.id
          }
        }
      } else if let error {
        InlineError(error: error)
      } else {
        ProgressView().frame(maxWidth: .infinity).padding(.top, 30)
      }
    }
    .navigationDestination(item: $open) { HarnessSettingsScreen(deviceId: $0.nodeId, harness: $0.harness) }
    .sheet(item: Binding(get: { installOn.map(HarnessOpen.device) }, set: { installOn = $0?.nodeId })) { InstallHarnessSheet(nodeId: $0.nodeId) }
    .task { try? await store.refreshNodes() }
    .task { await load() }
    .refreshable { await load() }
  }

  private func row(_ computer: HarnessComputer, _ h: HarnessComputer.Harness) -> some View {
    let settable = !computer.isVM && devices.contains { $0.id == computer.nodeId }
    return HStack(spacing: 12) {
      Image(systemName: ModelWords.harnessSymbol(h.id)).font(.system(size: 13)).foregroundStyle(Palette.muted).frame(width: 18)
      Text(h.label).font(.system(size: 15)).lineLimit(1)
      if let v = h.version { Text(v).font(.system(size: 12)).foregroundStyle(Palette.faint).monospacedDigit().lineLimit(1) }
      Spacer(minLength: 8)
      UsedByWisps(users: h.agents)
      if settable {
        Button("Settings") { open = HarnessOpen(nodeId: computer.nodeId, harness: h.id) }
          .font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.text)
          .padding(.horizontal, 12).frame(height: 28).background(Capsule().fill(Palette.control))
          .buttonStyle(.press).disabled(!computer.online)
          .accessibilityIdentifier("harness-\(h.id)")
      }
    }
    .padding(.horizontal, 14).frame(minHeight: 48)
  }

  private func load() async {
    do { computers = try await store.harnessComputers(); error = nil } catch { self.error = error.localizedDescription }
  }
}

private struct HarnessOpen: Hashable, Identifiable {
  var nodeId: String
  var harness: String
  var id: String { "\(nodeId)/\(harness)" }
  static func device(_ id: String) -> HarnessOpen { HarnessOpen(nodeId: id, harness: "") }
}

/** One harness's own settings on one of your devices, read from and written to its config file there. */
struct HarnessSettingsScreen: View {
  @Environment(Store.self) private var store
  var deviceId: String
  var harness: String
  @State private var data: HarnessesResponse?
  @State private var error: String?

  private var device: AgentNode? { store.nodes.first { $0.id == deviceId } }

  var body: some View {
    if let data, let index = data.harnesses.firstIndex(where: { $0.harness == harness }) {
      HarnessDetailView(response: data, settings: Binding(get: { self.data?.harnesses[safe: index] ?? data.harnesses[index] }, set: { replace($0) }), onLoad: { account in try await load(account: account) })
    } else {
      MarketScreen(title: HarnessChoice.label(harness), screenId: "harness") {
        if let device, !device.online {
          MarketNote(text: "\(device.name) is offline. Its harness settings show up when it's back.")
        } else if let error {
          Text(error).font(.footnote).foregroundStyle(Palette.red).padding(.horizontal, 4)
        } else if data != nil {
          MarketNote(text: "\(HarnessChoice.label(harness)) isn't on \(device?.name ?? "this device") anymore.")
        } else {
          HStack { ProgressView(); Text("Reading \(device?.name ?? "the device")'s settings…").foregroundStyle(Palette.muted) }
        }
      }
      .task { await first() }
    }
  }

  private func first() async {
    do { data = try await store.harnessSettings(device: deviceId) } catch { self.error = error.localizedDescription }
  }

  private func replace(_ settings: HarnessSettings) {
    guard var current = data, let i = current.harnesses.firstIndex(where: { $0.harness == settings.harness }) else { return }
    current.harnesses[i] = settings
    data = current
  }

  /** Show the harness as one of its accounts (or again, after a sign-in). */
  private func load(account: String) async throws {
    let response = try await store.harnessSettings(device: deviceId, harness: harness, account: account)
    guard var current = data, let fresh = response.harnesses.first(where: { $0.harness == harness }), let i = current.harnesses.firstIndex(where: { $0.harness == harness }) else { return }
    current.harnesses[i] = fresh
    current = HarnessesResponse(device: current.device, harnesses: current.harnesses, agents: response.agents, catalog: current.catalog)
    data = current
  }
}

// MARK: - One harness

/** One harness: its account, model, reasoning effort, apps, plugins and skills. */
private struct HarnessDetailView: View {
  @Environment(Store.self) private var store
  var response: HarnessesResponse
  @Binding var settings: HarnessSettings
  var onLoad: (String) async throws -> Void
  @State private var busy: String?
  @State private var error: String?
  @State private var note: String?
  @State private var typingModel = false
  @State private var modelText = ""
  @State private var sharing: HarnessSettingItem?
  @State private var wispError: String?

  private var label: String { HarnessChoice.label(settings.harness) }
  private var users: [HarnessesResponse.User] { response.agents.filter { $0.harness == settings.harness } }
  private var catalog: HarnessesResponse.Catalog? { response.catalog?.first { $0.harness == settings.harness } }
  private var device: HarnessesResponse.Device { response.device }

  var body: some View {
    let state = signState(settings)
    MarketScreen(title: label, screenId: "harness", trailing: {
      if let badge = state.badge { MarketPill(text: badge, tone: badge == "Signed in" ? .green : .grey) }
    }) {
      if let problem = settings.error {
        Text(problem).font(.footnote).foregroundStyle(Palette.red).padding(.horizontal, 4)
      } else {
        if settings.fixed?.contains("file") == true {
          Text("\((settings.configPath as NSString).lastPathComponent) has comments in it, so Wisp only shows it. Change it on \(device.name).").font(.system(size: 13)).foregroundStyle(Palette.faint).padding(.horizontal, 4)
        }
        HarnessAccountsBlock(device: device, settings: settings, users: users, onLoad: onLoad)
        modelBlock
        appsBlock
        pluginsBlock
        if !users.isEmpty { HarnessAskBox(agents: store.agents.filter { agent in users.contains { $0.id == agent.id } }, prefix: "In \(label)'s settings on \(device.name): ") }
        if let note { Text(note).font(.system(size: 13)).foregroundStyle(Palette.muted).padding(.horizontal, 4) }
      }
    }
    .sheet(item: $sharing) { skill in ShareHarnessSkill(device: device, settings: settings, skill: skill) { note = $0 } }
    .alert("Model name", isPresented: $typingModel) {
      TextField("Model name", text: $modelText).textInputAutocapitalization(.never).autocorrectionDisabled()
      Button("Save") { let name = modelText.trimmed; if !name.isEmpty { change("model", [HarnessChange(op: "model", model: name)]) } }
      Button("Cancel", role: .cancel) {}
    }
    .task { try? await store.refreshConnectors() }
  }

  // MARK: model

  private var models: [(id: String, label: String)] {
    let known = catalog?.models.map { ($0.id, $0.label) } ?? []
    let extra = (settings.modelChoices ?? []).filter { id in !known.contains { $0.0 == id } }.map { ($0, $0) }
    return known + extra
  }

  private var modelBlock: some View {
    // Hermes lists its models as "provider:model"
    let both = settings.provider != nil && settings.model != nil ? "\(settings.provider!):\(settings.model!)" : nil
    let value = both.flatMap { b in models.contains { $0.id == b } ? b : nil } ?? settings.model ?? ""
    let isKnown = value.isEmpty || models.contains { $0.id == value }
    let shown = models.first { $0.id == value }?.label ?? value
    let efforts = (catalog?.efforts?.isEmpty == false ? catalog?.efforts : nil) ?? ["low", "medium", "high"]
    return VStack(alignment: .leading, spacing: 8) {
      MarketLabel("Model")
      CardGroup {
        MarketRow(title: "Default model", subtitle: settings.model == nil ? "Automatic" : shown) {
          Picker("Default model", selection: Binding(get: { value }, set: { new in
            if new == "\u{0}other" { modelText = settings.model ?? ""; typingModel = true }
            else if !new.isEmpty { change("model", [HarnessChange(op: "model", model: new)]) }
          })) {
            if settings.model == nil {
              Text(catalog?.defaultModel.map { id in "Default (\(models.first { $0.id == id }?.label ?? id))" } ?? "Default").tag("")
            }
            if !isKnown { Text(value).tag(value) }
            ForEach(models, id: \.id) { Text($0.label).tag($0.id) }
            if settings.modelChoices == nil { Text("Other…").tag("\u{0}other") }
          }.pickerStyle(.menu).labelsHidden().tint(Palette.muted).disabled(busy == "model" || settings.modelFixed)
        }
        if let providers = settings.providers {
          MarketRow(title: "Provider") {
            Picker("Provider", selection: Binding(get: { settings.provider ?? "" }, set: { new in
              guard !new.isEmpty else { return }
              var next = settings; next.provider = new
              change("provider", [HarnessChange(op: "provider", provider: new)], optimistic: next)
            })) {
              if settings.provider == nil { Text("Default").tag("") }
              ForEach(providers) { Text($0.id + ($0.signedIn ? "" : " (not signed in)")).tag($0.id) }
            }.pickerStyle(.menu).labelsHidden().tint(Palette.muted).disabled(busy == "provider" || settings.providerFixed)
          }
        }
        if settings.hasEffort {
          VStack(alignment: .leading, spacing: 10) {
            Text("Reasoning effort").font(.system(size: 15, weight: .medium))
            SegPicker(options: efforts.map { ($0, $0.prefix(1).uppercased() + $0.dropFirst()) }, selection: Binding(get: { settings.effort ?? "" }, set: { new in
              var next = settings; next.effort = new
              change("effort", [HarnessChange(op: "effort", effort: new)], optimistic: next)
            }), disabled: busy == "effort" || settings.modelFixed)
            if settings.effort == nil { Text("Not set. \(label) uses its own default.").font(.system(size: 13)).foregroundStyle(Palette.faint) }
          }.padding(.horizontal, 16).padding(.vertical, 14)
        }
      }
      InlineError(error: error)
    }
  }

  // MARK: apps, plugins and skills

  private var appsBlock: some View {
    let ids = users.map(\.id)
    let wisp = store.connectors.filter { $0.kind != "secret" && $0.enabled != false }
    return VStack(alignment: .leading, spacing: 8) {
      MarketLabel("Apps")
      if wisp.isEmpty && settings.apps.isEmpty {
        Text("None yet.").font(.system(size: 13)).foregroundStyle(Palette.muted).padding(.horizontal, 4)
      } else {
        CardGroup {
          if !ids.isEmpty {
            ForEach(wisp) { connector in
              MarketToggleRow(title: connector.name, subtitle: connector.auth?.required == true ? (connector.auth?.signedIn == true ? "Logged in through Wisp" : "Needs logging in, in Wisp") : "Set up in Wisp", isOn: Binding(get: { ids.allSatisfy { connector.agentIds?.contains($0) == true } }, set: { on in attach(connector, ids, on) })) { MarketTile(symbol: "powerplug") }
            }
          }
          ForEach(settings.apps) { app in itemRow(app, note: app.canToggle ? "Set up on this device" : "Set up on this device · changed there", kind: "app") }
        }
      }
      InlineError(error: wispError)
    }
  }

  private var pluginsBlock: some View {
    VStack(alignment: .leading, spacing: 8) {
      MarketLabel("Plugins and skills")
      if settings.plugins.isEmpty && settings.skills.isEmpty {
        Text("None yet.").font(.system(size: 13)).foregroundStyle(Palette.muted).padding(.horizontal, 4)
      } else {
        CardGroup {
          ForEach(settings.plugins) { plugin in itemRow(plugin, note: "Plugin", kind: "plugin") }
          ForEach(settings.skills) { skill in itemRow(skill, note: "Skill", kind: "skill", share: { sharing = skill }) }
        }
      }
    }
  }

  private func itemRow(_ item: HarnessSettingItem, note: String, kind: String, share: (() -> Void)? = nil) -> some View {
    HStack(spacing: 14) {
      MarketTile(symbol: kind == "app" ? "powerplug" : kind == "plugin" ? "puzzlepiece" : "wand.and.stars")
      VStack(alignment: .leading, spacing: 2) {
        Text(item.name).font(.system(size: 15, weight: .medium)).lineLimit(1)
        Text(note).font(.system(size: 13)).foregroundStyle(Palette.faint).lineLimit(1)
      }
      Spacer(minLength: 8)
      if let share { Button { share() } label: { Label("Share", systemImage: "square.and.arrow.up").font(.system(size: 13)).foregroundStyle(Palette.muted) }.buttonStyle(.plain) }
      Toggle(item.name, isOn: Binding(get: { item.enabled }, set: { on in toggle(kind, item, on) })).labelsHidden().tint(Palette.blue)
        .disabled(busy == "\(kind):\(item.id)" || !item.canToggle)
    }.padding(.horizontal, 16).padding(.vertical, 10).frame(minHeight: 64)
  }

  // MARK: changes

  private func change(_ key: String, _ changes: [HarnessChange], optimistic: HarnessSettings? = nil) {
    guard busy == nil else { return }
    let before = settings
    busy = key; error = nil
    if let optimistic { settings = optimistic }
    Task {
      defer { busy = nil }
      do { settings = try await store.changeHarness(device: device.id, harness: before.harness, account: before.account, changes) }
      catch { settings = before; self.error = error.localizedDescription }
    }
  }

  private func toggle(_ kind: String, _ item: HarnessSettingItem, _ enabled: Bool) {
    var next = settings
    func flip(_ list: inout [HarnessSettingItem]) { if let i = list.firstIndex(where: { $0.id == item.id }) { list[i].enabled = enabled } }
    switch kind { case "app": flip(&next.apps); case "plugin": flip(&next.plugins); default: flip(&next.skills) }
    change("\(kind):\(item.id)", [HarnessChange(op: "toggle", kind: kind, id: item.id, enabled: enabled)], optimistic: next)
  }

  private func attach(_ connector: AppConnector, _ ids: [String], _ on: Bool) {
    wispError = nil
    Task {
      do { try await store.attachConnector(connector, agentIds: ids, on: on) } catch { wispError = error.localizedDescription; try? await store.refreshConnectors() }
    }
  }
}

/** Ask the agent that uses this harness to change something, in its DM. */
private struct HarnessAskBox: View {
  @Environment(Store.self) private var store
  var agents: [Agent]
  var prefix: String
  @State private var text = ""
  @State private var action = FormAction()
  private var agent: Agent? { agents.first { $0.status != .offline } ?? agents.first }

  var body: some View {
    if let agent {
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 10) {
          TextField("Ask \(agent.name) to change anything here", text: $text, axis: .vertical).lineLimit(1...4).submitLabel(.send).onSubmit(send).accessibilityIdentifier("ask-agent-field")
          Button(action: send) {
            Image(systemName: "arrow.up").font(.system(size: 15, weight: .bold)).foregroundStyle(Color(.systemBackground)).frame(width: 34, height: 34).background(Circle().fill(Palette.text))
          }.buttonStyle(.plain).disabled(action.busy || text.trimmed.isEmpty).opacity(text.trimmed.isEmpty ? 0.4 : 1).accessibilityLabel("Send")
        }
        .padding(.leading, 18).padding(.trailing, 8).padding(.vertical, 8)
        .background(Palette.control, in: Capsule()).overlay(Capsule().strokeBorder(Palette.hairline))
        InlineError(error: action.error)
      }
    }
  }

  private func send() {
    guard let agent, !text.trimmed.isEmpty else { return }
    let message = prefix + text.trimmed
    action.run { try await store.ask(agent, message); text = "" }
  }
}

// MARK: - Accounts

private struct HarnessAccountsBlock: View {
  @Environment(Store.self) private var store
  var device: HarnessesResponse.Device
  var settings: HarnessSettings
  var users: [HarnessesResponse.User]
  var onLoad: (String) async throws -> Void
  @State private var naming: Naming?
  @State private var name = ""
  @State private var signingIn: HarnessAccount?
  @State private var removing = false
  @State private var more = false
  @State private var error: String?
  enum Naming { case add, rename }

  private var label: String { HarnessChoice.label(settings.harness) }
  private var current: HarnessAccount? { settings.currentAccount }
  private func act(_ body: Fields) async throws -> Data { try await store.harnessAccount(device: device.id, harness: settings.harness, body) }
  private func run(_ work: @escaping () async throws -> Void) {
    error = nil
    Task { do { try await work() } catch { self.error = error.localizedDescription } }
  }
  private func usedBy(_ id: String) -> [String] { users.filter { (settings.agentAccounts[$0.id] ?? "default") == id }.map(\.name) }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      MarketLabel("Account")
      CardGroup {
        ForEach(settings.accounts) { account in
          let shown = account.id == current?.id
          let who = usedBy(account.id)
          Button { if settings.accounts.count > 1 && !shown { run { try await onLoad(account.id) } } } label: {
            MarketRow(symbol: "person.crop.circle", title: account.who ?? account.label, subtitle: who.isEmpty ? (account.signedIn == false ? "Not signed in" : shown && settings.accounts.count > 1 ? "Showing now" : "Not used by an agent yet") : "Used by \(ShelfLogic.sentence(who))") {
              if account.signedIn == true { MarketPill(text: "Signed in", tone: .green) } else if account.signedIn == false { MarketPill(text: "Sign in") }
            }
          }.buttonStyle(.plain)
        }
        if settings.multiAccount {
          Button { name = ""; naming = .add } label: { MarketRow(symbol: "plus", title: "Add account") }.buttonStyle(.plain)
        }
        if let current {
          Button { signingIn = current } label: { MarketRow(symbol: "arrow.right.to.line", title: current.signedIn == true ? "Sign in again" : "Sign in") }.buttonStyle(.plain).accessibilityIdentifier("harness-sign-in")
        }
      }
      if settings.accounts.count > 1 || current?.isDefault == false {
        Button { withAnimation { more.toggle() } } label: {
          Label("More options: who uses which account, rename", systemImage: more ? "chevron.down" : "chevron.right").font(.system(size: 13)).foregroundStyle(Palette.muted)
        }.padding(.horizontal, 4)
        if more { moreOptions }
      }
      InlineError(error: error)
    }
    .alert(naming == .rename ? "Rename account" : "Add account", isPresented: Binding(get: { naming != nil }, set: { if !$0 { naming = nil } })) {
      TextField("Name, like \"Work \(label)\"", text: $name)
      Button(naming == .rename ? "Rename" : "Add") {
        let text = name.trimmed, mode = naming
        guard !text.isEmpty else { return }
        run {
          if mode == .rename, let current {
            _ = try await act(["op": AnyEncodable("rename"), "account": AnyEncodable(current.id), "label": AnyEncodable(text)])
            try await onLoad(current.id)
          } else {
            let data = try await act(["op": AnyEncodable("add"), "label": AnyEncodable(text)])
            struct Added: Decodable { var id: String }
            let added = try Wire.decoder.decode(Added.self, from: data)
            try await onLoad(added.id)
            signingIn = settings.accounts.first { $0.id == added.id } ?? HarnessAccount(id: added.id, label: text, isDefault: false, signedIn: false)
          }
        }
      }
      Button("Cancel", role: .cancel) {}
    }
    .confirmationDialog("Stop using this account? Its sign-in stays on \(device.name).", isPresented: $removing, titleVisibility: .visible) {
      Button("Stop using it", role: .destructive) {
        if let current { run { _ = try await act(["op": AnyEncodable("remove"), "account": AnyEncodable(current.id)]); try await onLoad("default") } }
      }
    }
    .sheet(item: $signingIn) { account in
      HarnessSignInSheet(device: device, settings: settings, account: account) { run { try await onLoad(account.id) } }
    }
  }

  @ViewBuilder private var moreOptions: some View {
    if settings.accounts.count > 1 {
      CardGroup {
        ForEach(users) { user in
          MarketRow(title: "\(user.name) uses") {
            Picker("\(user.name) uses", selection: Binding(get: { settings.agentAccounts[user.id] ?? "default" }, set: { id in
              run {
                _ = try await act(["op": AnyEncodable("assign"), "agentId": AnyEncodable(user.id), "account": id == "default" ? .null : AnyEncodable(id)])
                try await onLoad(settings.account)
              }
            })) { ForEach(settings.accounts) { Text($0.label).tag($0.id) } }.pickerStyle(.menu).labelsHidden().tint(Palette.muted)
          }
        }
      }
    }
    if let current, !current.isDefault {
      CardGroup {
        Button { name = current.label; naming = .rename } label: { MarketRow(symbol: "pencil", title: "Rename", subtitle: current.label) }.buttonStyle(.plain)
        Button { removing = true } label: { MarketRow(symbol: "person.badge.minus", title: "Stop using it", subtitle: "Agents go back to the default account", danger: true) }.buttonStyle(.plain)
      }
    }
  }
}

/** Signing an account in without the device's terminal: Wisp shows the link and code the harness prints. */
private struct HarnessSignInSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  var device: HarnessesResponse.Device
  var settings: HarnessSettings
  var account: HarnessAccount
  var onDone: () -> Void
  @State private var provider = ""
  @State private var login: HarnessLogin?
  @State private var manual: String?
  @State private var code = ""
  @State private var error: String?
  @State private var started = false

  private var label: String { HarnessChoice.label(settings.harness) }
  private var perProvider: Bool { settings.harness == "hermes" }
  private func act(_ body: Fields) async throws -> Data { try await store.harnessAccount(device: device.id, harness: settings.harness, body) }

  var body: some View {
    MarketSheet(title: "Sign in to \(label)\(account.isDefault ? "" : " · \(account.label)")", busy: login?.status == "running") {
      if perProvider && !started {
        CardGroup {
          MarketRow(title: "Provider") {
            Picker("Provider", selection: $provider) { ForEach(settings.providers ?? []) { Text($0.id).tag($0.id) } }.pickerStyle(.menu).labelsHidden().tint(Palette.muted)
          }
        }
        MarketPrimaryButton(title: "Continue", disabled: provider.isEmpty) { Task { await start() } }
      }
      if let manual {
        MarketNote(text: "\(label) signs in on its own screen. On \(device.name), run:")
        Text(manual).font(.system(size: 13, design: .monospaced)).textSelection(.enabled).padding(14).frame(maxWidth: .infinity, alignment: .leading)
          .background(Palette.control, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        Button("Copy command") { UIPasteboard.general.string = manual }.secondaryButton()
      }
      if login?.status == "running" { steps }
      if login?.status == "done" { Label("Signed in.", systemImage: "checkmark.circle").foregroundStyle(Palette.statusOnline).padding(.horizontal, 4) }
      if login?.status == "failed" {
        Text(login?.error ?? "The sign-in didn't finish.").font(.footnote).foregroundStyle(Palette.red).padding(.horizontal, 4)
        Button("Try again") { login = nil; if perProvider { started = false } else { Task { await start() } } }.secondaryButton()
      }
      InlineError(error: error)
      if login?.status == "done" || manual != nil { MarketPrimaryButton(title: "Done") { close() } }
      else if login?.url != nil && login?.code == nil && login?.status == "running" {
        HStack(spacing: 10) {
          Button { close() } label: { Text("Cancel").frame(maxWidth: .infinity) }.secondaryButton()
          Button { send() } label: { Text("Send").frame(maxWidth: .infinity) }.primaryButton().disabled(code.trimmed.isEmpty)
        }
      } else if login?.status == "running" { Button { close() } label: { Text("Cancel").frame(maxWidth: .infinity) }.secondaryButton() }
    }
    .task {
      provider = settings.provider ?? settings.providers?.first?.id ?? ""
      if !perProvider { await start() }
    }
    .task(id: login?.id) { await poll() }
  }

  private func step(_ n: Int, _ title: String, @ViewBuilder _ detail: () -> some View = { EmptyView() }, @ViewBuilder trailing: () -> some View = { EmptyView() }) -> some View {
    HStack(alignment: .top, spacing: 14) {
      Text("\(n)").font(.system(size: 15, weight: .semibold)).frame(width: 32, height: 32).background(Circle().fill(MarketColor.chip))
      VStack(alignment: .leading, spacing: 8) { Text(title).font(.system(size: 15, weight: .medium)); detail() }
      Spacer(minLength: 8)
      trailing()
    }.padding(.horizontal, 16).padding(.vertical, 14)
  }

  @ViewBuilder private var steps: some View {
    CardGroup {
      if let url = login?.url.flatMap(URL.init(string:)) {
        step(1, "Open the sign-in page", trailing: { AddButton(title: "Open") { openURL(url) } })
      } else {
        step(1, "Open the sign-in page", { HStack { ProgressView(); Text("Starting \(label)'s sign-in on \(device.name)…").font(.system(size: 13)).foregroundStyle(Palette.muted) } })
      }
      if let value = login?.code {
        step(2, "Enter this code there", { Text(value).font(.system(size: 22, weight: .semibold, design: .monospaced)).textSelection(.enabled) }, trailing: {
          CircleButton(symbol: "doc.on.doc", label: "Copy code", size: 44) { UIPasteboard.general.string = value }
        })
      } else if login?.url != nil {
        step(2, "Paste the code the page gives you", { MarketField(label: nil, placeholder: "Paste it here", text: $code, plain: true) })
      }
    }
    Text("Wisp passes the code to \(label) on \(device.name). Your password stays with the harness.").font(.system(size: 13)).foregroundStyle(Palette.faint).padding(.horizontal, 4)
    HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Waiting for you to finish signing in").font(.footnote).foregroundStyle(Palette.muted) }.padding(.horizontal, 4)
  }

  private func start() async {
    error = nil; started = true
    do {
      var body: Fields = ["op": AnyEncodable("login"), "account": AnyEncodable(account.id)]
      if perProvider { body["provider"] = AnyEncodable(provider) }
      let data = try await act(body)
      let result = try Wire.decoder.decode(HarnessLogin.self, from: data)
      if let command = result.manual { manual = command } else { login = result }
    } catch { self.error = error.localizedDescription }
  }

  private func poll() async {
    guard let id = login?.id, login?.status == "running" else { return }
    while !Task.isCancelled {
      do { try await Task.sleep(for: .seconds(1.5)) } catch { return }
      guard let data = try? await act(["op": AnyEncodable("login_status"), "loginId": AnyEncodable(id)]), let next = try? Wire.decoder.decode(HarnessLogin.self, from: data) else { continue }
      login = next
      if next.status == "done" { onDone() }
      if next.status != "running" { return }
    }
  }

  private func send() {
    guard let id = login?.id, !code.trimmed.isEmpty else { return }
    let text = code.trimmed
    Task {
      do {
        let data = try await act(["op": AnyEncodable("login_input"), "loginId": AnyEncodable(id), "text": AnyEncodable(text)])
        login = try Wire.decoder.decode(HarnessLogin.self, from: data); code = ""
      } catch { self.error = error.localizedDescription }
    }
  }

  private func close() {
    if login?.status == "running", let id = login?.id {
      Task { _ = try? await act(["op": AnyEncodable("login_cancel"), "loginId": AnyEncodable(id)]) }
    }
    dismiss()
  }
}

/** Copy one of a harness's skills into Wisp's skills, for the agents you pick. */
private struct ShareHarnessSkill: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var device: HarnessesResponse.Device
  var settings: HarnessSettings
  var skill: HarnessSettingItem
  var shared: (String) -> Void
  @State private var picked: Set<String> = []
  @State private var action = FormAction()

  var body: some View {
    MarketSheet(title: "Share \(skill.name)", busy: action.busy) {
      CardGroup {
        ForEach(store.agents) { agent in
          MarketToggleRow(title: agent.name, subtitle: HarnessChoice.label(agent.harness), isOn: Binding(get: { picked.contains(agent.id) }, set: { if $0 { picked.insert(agent.id) } else { picked.remove(agent.id) } })) { AgentAvatar(agent: agent, size: 30, showStatus: false) }
        }
      }
      InlineError(error: action.error)
      MarketPrimaryButton(title: "Share", busy: action.busy) { share() }
    }
  }

  private func share() {
    action.run {
      let file = try await store.harnessSkill(device: device.id, harness: settings.harness, account: settings.account, id: skill.id)
      try await store.saveSkill(nil, ["name": AnyEncodable(String(file.name.prefix(80))), "description": AnyEncodable(String(file.description.prefix(500))), "content": AnyEncodable(file.content), "agentIds": AnyEncodable(Array(picked))])
      let count = picked.count
      shared("\(skill.name) is in Skills now" + (count == 0 ? "." : count == 1 ? " and 1 agent has it." : " and \(count) agents have it."))
      dismiss()
    }
  }
}

// MARK: - Install a harness

/** Install a harness on a device through Wisp (npm ones), and see what's already there. */
struct InstallHarnessSheet: View {
  @Environment(Store.self) private var store
  var nodeId: String
  @State private var installing: String?
  @State private var output: String?
  @State private var action = FormAction()
  private var node: AgentNode? { store.nodes.first { $0.id == nodeId } }
  private let installable = ["claude-code", "codex", "gemini", "opencode", "kimi", "qwen", "openclaw"]

  var body: some View {
    MarketSheet(title: "Install a harness", subtitle: node.map { "On \($0.name)" }, busy: action.busy) {
      CardGroup {
        ForEach(HarnessChoice.all.filter { $0.protocolName != "mcp" }) { h in
          let have = node?.harnesses?.first { $0.id == h.id }
          MarketRow(symbol: "terminal", title: h.label, subtitle: have == nil ? "Not on this device" : (have?.version).map { "Version \($0)" } ?? "Installed") {
            if have != nil { MarketPill(text: "Installed", tone: .green) }
            else if installable.contains(h.id) { AddButton(title: "Install") { installing = h.id }.disabled(node?.online != true || action.busy) }
          }
        }
      }
      Text("Wisp installs it on that computer and asks you before it runs anything. Others use their own installer there.").font(.system(size: 13)).foregroundStyle(Palette.faint).padding(.horizontal, 4)
      if action.busy { HStack { ProgressView(); Text("Working on the device…").font(.footnote).foregroundStyle(Palette.muted) } }
      if let output { Text(output).font(.caption).textSelection(.enabled).padding(.horizontal, 4) }
      InlineError(error: action.error)
      Button { action.run { try await store.refreshDevice(nodeId) } } label: { Label("Refresh", systemImage: "arrow.clockwise").font(.system(size: 13)).foregroundStyle(Palette.muted) }.buttonStyle(.plain).padding(.horizontal, 4).disabled(node?.online != true || action.busy)
    }
    .confirmationDialog("Install this harness on \(node?.name ?? "the device")?", isPresented: Binding(get: { installing != nil }, set: { if !$0 { installing = nil } }), titleVisibility: .visible) {
      Button("Install") { if let harness = installing { action.run { output = try await store.installHarness(harness, node: nodeId) } } }
    }
  }
}
