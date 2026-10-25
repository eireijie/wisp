import SwiftUI

/**
 * Each harness's own settings on one of your devices, read from and written to its config file
 * there: accounts, model, apps, plugins and skills. Agents can change the same things when asked.
 */
struct HarnessesView: View {
  @Environment(Store.self) private var store
  @State private var deviceId: String?
  @State private var data: HarnessesResponse?
  @State private var tab = ""
  @State private var loading = false
  @State private var error: String?

  private var mine: [AgentNode] { store.nodes.filter { $0.mine == true } }
  private var device: AgentNode? { mine.first { $0.id == deviceId } ?? mine.first { $0.online } ?? mine.first }
  private var currentIndex: Int? {
    guard let data else { return nil }
    return data.harnesses.firstIndex { $0.harness == tab } ?? (data.harnesses.isEmpty ? nil : 0)
  }

  var body: some View {
    List {
      if mine.isEmpty {
        Section { Text("No devices of yours yet. Connect one from Devices.").foregroundStyle(.secondary) }
      } else {
        if mine.count > 1 {
          Section {
            Picker("Device", selection: Binding(get: { device?.id ?? "" }, set: { deviceId = $0 })) {
              ForEach(mine) { Text($0.name + ($0.online ? "" : " (offline)")).tag($0.id) }
            }
          }
        }
        if let device, !device.online {
          Section { Text("\(device.name) is offline. Its harness settings show up when it's back.").foregroundStyle(.secondary) }
        } else if let error {
          Section { Text(error).foregroundStyle(.red).font(.footnote) }
        } else if let data, let index = currentIndex {
          Section {
            Picker("Harness", selection: Binding(get: { data.harnesses[index].harness }, set: { tab = $0 })) {
              ForEach(data.harnesses, id: \.harness) { Text(HarnessChoice.label($0.harness)).tag($0.harness) }
            }
          }
          HarnessPanel(response: data, settings: Binding(get: { self.data?.harnesses[safe: index] ?? data.harnesses[index] }, set: { replace($0) }), onLoad: { account in try await load(harness: data.harnesses[index].harness, account: account) })
            .id("\(data.device.id):\(data.harnesses[index].harness)")
        } else if data != nil {
          Section { Text("No harnesses on \(device?.name ?? "this device") yet. Install one from the device's page.").foregroundStyle(.secondary) }
        } else if loading {
          Section { HStack { ProgressView(); Text("Reading \(device?.name ?? "the device")'s harnesses…").foregroundStyle(.secondary) } }
        }
      }
    }.sectionScreen("Harnesses", id: "harnesses")
      .task { try? await store.refreshNodes() }
      .task(id: "\(device?.id ?? "")\(device?.online == true)") { await first() }
      .refreshable { await first() }
  }

  private func first() async {
    data = nil; error = nil
    guard let device, device.online else { return }
    loading = true
    defer { loading = false }
    do { data = try await store.harnessSettings(device: device.id) } catch { self.error = error.localizedDescription }
  }

  private func replace(_ settings: HarnessSettings) {
    guard var current = data, let i = current.harnesses.firstIndex(where: { $0.harness == settings.harness }) else { return }
    current.harnesses[i] = settings
    data = current
  }

  /** Show one harness as one of its accounts (or again, after a sign-in). */
  private func load(harness: String, account: String) async throws {
    guard let device else { return }
    let response = try await store.harnessSettings(device: device.id, harness: harness, account: account)
    guard var current = data, let fresh = response.harnesses.first(where: { $0.harness == harness }), let i = current.harnesses.firstIndex(where: { $0.harness == harness }) else { return }
    current.harnesses[i] = fresh
    current = HarnessesResponse(device: current.device, harnesses: current.harnesses, agents: response.agents, catalog: current.catalog)
    data = current
  }
}

private extension Array {
  subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}

/** The panel for one harness: sections that sit in the page's list. */
private struct HarnessPanel: View {
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
    if let problem = settings.error {
      Section { Text(problem).foregroundStyle(.red).font(.footnote) }
    } else {
      Section {
        Text("On \(device.name)" + (users.isEmpty ? "" : " · used by \(users.map(\.name).joined(separator: ", "))")).foregroundStyle(.secondary)
        if settings.fixed?.contains("file") == true {
          Text("\((settings.configPath as NSString).lastPathComponent) has comments in it, so Wisp only shows it. Change it on \(device.name).").font(.footnote)
        }
      } header: { Text(label) }
      if settings.multiAccount || settings.accounts.count > 1 {
        HarnessAccountsSection(device: device, settings: settings, users: users, onLoad: onLoad)
      }
      Section {
        modelRow
        if let providers = settings.providers {
          Picker("Provider", selection: Binding(get: { settings.provider ?? "" }, set: { new in
            guard !new.isEmpty else { return }
            var next = settings; next.provider = new
            change("provider", [HarnessChange(op: "provider", provider: new)], optimistic: next)
          })) {
            if settings.provider == nil { Text("Default").tag("") }
            ForEach(providers) { Text($0.id + ($0.signedIn ? "" : " (not signed in)")).tag($0.id) }
          }.disabled(busy == "provider" || settings.providerFixed)
        }
        if let error { Text(error).font(.footnote).foregroundStyle(.red) }
      }
      appsSection
      Section("Plugins and skills") {
        if settings.plugins.isEmpty && settings.skills.isEmpty { Text("None yet.").foregroundStyle(.secondary) }
        ForEach(settings.plugins) { plugin in
          itemRow(plugin, note: plugin.description.map { "\(label) plugin · \($0)" } ?? "\(label) plugin", kind: "plugin")
        }
        ForEach(settings.skills) { skill in
          itemRow(skill, note: skill.description.map { "Skill · \($0)" } ?? "Skill", kind: "skill", share: { sharing = skill })
        }
        if let note { Text(note).font(.footnote).foregroundStyle(.secondary) }
      }
      if !users.isEmpty {
        AskAgentSection(placeholder: "Ask {name} to change anything here", prefix: "In \(label)'s settings on \(device.name): ", agents: store.agents.filter { agent in users.contains { $0.id == agent.id } })
      }
    }
  }

  // MARK: model

  private var models: [(id: String, label: String)] {
    let known = catalog?.models.map { ($0.id, $0.label) } ?? []
    let extra = (settings.modelChoices ?? []).filter { id in !known.contains { $0.0 == id } }.map { ($0, $0) }
    return known + extra
  }

  @ViewBuilder private var modelRow: some View {
    // Hermes lists its models as "provider:model"
    let both = settings.provider != nil && settings.model != nil ? "\(settings.provider!):\(settings.model!)" : nil
    let value = both.flatMap { b in models.contains { $0.id == b } ? b : nil } ?? settings.model ?? ""
    let isKnown = value.isEmpty || models.contains { $0.id == value }
    Picker("Model", selection: Binding(get: { value }, set: { new in
      if new == "\u{0}other" { modelText = settings.model ?? ""; typingModel = true }
      else if !new.isEmpty { change("model", [HarnessChange(op: "model", model: new)]) }
    })) {
      if settings.model == nil {
        Text(catalog?.defaultModel.map { id in "Default (\(models.first { $0.id == id }?.label ?? id))" } ?? "Default").tag("")
      }
      if !isKnown { Text(value).tag(value) }
      ForEach(models, id: \.id) { Text($0.label).tag($0.id) }
      if settings.modelChoices == nil { Text("Other…").tag("\u{0}other") }
    }.disabled(busy == "model" || settings.modelFixed)
      .alert("Model name", isPresented: $typingModel) {
        TextField("Model name", text: $modelText).textInputAutocapitalization(.never).autocorrectionDisabled()
        Button("Save") { let name = modelText.trimmed; if !name.isEmpty { change("model", [HarnessChange(op: "model", model: name)]) } }
        Button("Cancel", role: .cancel) {}
      }
  }

  // MARK: apps

  @ViewBuilder private var appsSection: some View {
    let ids = users.map(\.id)
    let wisp = store.connectors.filter { $0.kind != "secret" && $0.enabled != false }
    Section("Apps") {
      if wisp.isEmpty && settings.apps.isEmpty { Text("None yet.").foregroundStyle(.secondary) }
      if !ids.isEmpty {
        ForEach(wisp) { connector in
          Toggle(isOn: Binding(get: { ids.allSatisfy { connector.agentIds?.contains($0) == true } }, set: { on in attach(connector, ids, on) })) {
            VStack(alignment: .leading, spacing: 2) {
              Text(connector.name)
              Text(connector.auth?.required == true ? (connector.auth?.signedIn == true ? "Logged in through Wisp" : "Needs logging in, in Wisp") : "Set up in Wisp").font(.caption).foregroundStyle(.secondary)
            }
          }
        }
      }
      ForEach(settings.apps) { app in
        itemRow(app, note: app.canToggle ? "Set up on this device" : "Set up on this device · changed there", kind: "app")
      }
      if let wispError { Text(wispError).font(.footnote).foregroundStyle(.red) }
    }.task { try? await store.refreshConnectors() }
      .sheet(item: $sharing) { skill in
        ShareSkillView(device: device, settings: settings, skill: skill) { note = $0 }
      }
  }

  private func itemRow(_ item: HarnessSettingItem, note: String, kind: String, share: (() -> Void)? = nil) -> some View {
    HStack {
      VStack(alignment: .leading, spacing: 2) {
        Text(item.name)
        Text(note).font(.caption).foregroundStyle(.secondary).lineLimit(2)
      }
      Spacer(minLength: 8)
      if let share { Button("Share", action: share).buttonStyle(.bordered).controlSize(.small) }
      Toggle(item.name, isOn: Binding(get: { item.enabled }, set: { on in toggle(kind, item, on) })).labelsHidden()
        .disabled(busy == "\(kind):\(item.id)" || !item.canToggle)
    }
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

// MARK: - Accounts

private struct HarnessAccountsSection: View {
  @Environment(Store.self) private var store
  var device: HarnessesResponse.Device
  var settings: HarnessSettings
  var users: [HarnessesResponse.User]
  var onLoad: (String) async throws -> Void
  @State private var naming: Naming?
  @State private var name = ""
  @State private var signingIn: HarnessAccount?
  @State private var removing = false
  @State private var error: String?
  enum Naming { case add, rename }

  private var label: String { HarnessChoice.label(settings.harness) }
  private func act(_ body: Fields) async throws -> Data { try await store.harnessAccount(device: device.id, harness: settings.harness, body) }
  private func run(_ work: @escaping () async throws -> Void) {
    error = nil
    Task { do { try await work() } catch { self.error = error.localizedDescription } }
  }

  var body: some View {
    let current = settings.currentAccount
    Section("Account") {
      Picker("Account", selection: Binding(get: { settings.account }, set: { id in run { try await onLoad(id) } })) {
        ForEach(settings.accounts) { Text($0.label).tag($0.id) }
      }
      if let who = current?.who, current?.signedIn == true { Text("Signed in as \(who)").font(.footnote).foregroundStyle(.secondary) }
      if current?.signedIn == true { Label("Signed in", systemImage: "checkmark.circle").foregroundStyle(.green) }
      if current?.signedIn == false, let current { Button("Sign in") { signingIn = current } }
      Menu("More for this account") {
        if settings.multiAccount { Button("Add account", systemImage: "plus") { name = ""; naming = .add } }
        if current?.signedIn != false, let current { Button(current.signedIn == true ? "Sign in again" : "Sign in") { signingIn = current } }
        if let current, !current.isDefault {
          Button("Rename") { name = current.label; naming = .rename }
          Button("Stop using it", role: .destructive) { removing = true }
        }
      }
      if settings.accounts.count > 1 {
        ForEach(users) { user in
          Picker("\(user.name) uses", selection: Binding(get: { settings.agentAccounts[user.id] ?? "default" }, set: { id in
            run {
              _ = try await act(["op": AnyEncodable("assign"), "agentId": AnyEncodable(user.id), "account": id == "default" ? .null : AnyEncodable(id)])
              try await onLoad(settings.account)
            }
          })) { ForEach(settings.accounts) { Text($0.label).tag($0.id) } }
        }
      }
      if let error { Text(error).font(.footnote).foregroundStyle(.red) }
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
      HarnessSignInView(device: device, settings: settings, account: account) { run { try await onLoad(account.id) } }
    }
  }

  private var current: HarnessAccount? { settings.currentAccount }
}

/** Signing an account in without the device's terminal: Wisp shows the link and code the harness prints. */
private struct HarnessSignInView: View {
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
    NavigationStack {
      Form {
        if perProvider && !started {
          Picker("Provider", selection: $provider) { ForEach(settings.providers ?? []) { Text($0.id).tag($0.id) } }
          Button("Continue") { Task { await start() } }.disabled(provider.isEmpty)
        }
        if let manual {
          Section { Text("\(label) signs in on its own screen. On \(device.name), run:"); Text(manual).font(.caption.monospaced()).textSelection(.enabled); Button("Copy command") { UIPasteboard.general.string = manual } }
        }
        if login?.status == "running" {
          Section {
            if let url = login?.url.flatMap(URL.init(string:)) {
              Button("Open the sign-in page", systemImage: "safari") { openURL(url) }
            } else {
              HStack { ProgressView(); Text("Starting \(label)'s sign-in on \(device.name)…") }
            }
            if let value = login?.code {
              LabeledContent("Enter this code there") { Text(value).font(.title3.monospaced().weight(.semibold)).textSelection(.enabled) }
              Button("Copy code") { UIPasteboard.general.string = value }
            }
            if login?.url != nil && login?.code == nil {
              TextField("Paste the code the page gives you", text: $code).textInputAutocapitalization(.never).autocorrectionDisabled()
              Button("Send") { send() }.disabled(code.trimmed.isEmpty)
            }
            HStack { ProgressView(); Text("Waiting for you to finish signing in").font(.footnote).foregroundStyle(.secondary) }
          }
        }
        if login?.status == "done" { Label("Signed in.", systemImage: "checkmark.circle").foregroundStyle(.green) }
        if login?.status == "failed" {
          Text(login?.error ?? "The sign-in didn't finish.").foregroundStyle(.red).font(.footnote)
          Button("Try again") { login = nil; if perProvider { started = false } else { Task { await start() } } }
        }
        if let error { Text(error).foregroundStyle(.red).font(.footnote) }
      }.navigationTitle("Sign in \(label)\(account.isDefault ? "" : " · \(account.label)")").navigationBarTitleDisplayMode(.inline)
        .toolbar { Button(login?.status == "done" || manual != nil ? "Done" : "Cancel") { close() } }
        .task {
          provider = settings.provider ?? settings.providers?.first?.id ?? ""
          if !perProvider { await start() }
        }
        .task(id: login?.id) { await poll() }
    }.interactiveDismissDisabled(login?.status == "running")
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
private struct ShareSkillView: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var device: HarnessesResponse.Device
  var settings: HarnessSettings
  var skill: HarnessSettingItem
  var shared: (String) -> Void
  @State private var picked: Set<String> = []
  @State private var action = FormAction()

  init(device: HarnessesResponse.Device, settings: HarnessSettings, skill: HarnessSettingItem, shared: @escaping (String) -> Void) {
    self.device = device; self.settings = settings; self.skill = skill; self.shared = shared
  }

  var body: some View {
    NavigationStack {
      Form {
        Section("Give it to") {
          ForEach(store.agents) { agent in
            Toggle(isOn: Binding(get: { picked.contains(agent.id) }, set: { if $0 { picked.insert(agent.id) } else { picked.remove(agent.id) } })) {
              VStack(alignment: .leading) { Text(agent.name); Text(HarnessChoice.label(agent.harness)).font(.caption).foregroundStyle(.secondary) }
            }
          }
        }
        InlineError(error: action.error)
      }.navigationTitle("Share \(skill.name)").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
          ToolbarItem(placement: .confirmationAction) { Button("Share") { share() }.disabled(action.busy) }
        }
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
