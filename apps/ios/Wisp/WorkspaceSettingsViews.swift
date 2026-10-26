import SwiftUI

private let askActions: [(key: String, title: String, detail: String)] = [
  ("send", "Sending email or messages outside Wisp", "Email, texts, Slack, DMs on other sites"),
  ("spend", "Buying or paying for anything", "Orders, subscriptions, upgrades, ads"),
  ("delete", "Deleting files, data or accounts", "Anything that can't be undone"),
  ("post", "Posting publicly", "Social media, reviews, comments, forums"),
  ("signup", "Signing up for new accounts or services", "New logins, free trials, newsletters"),
  ("share", "Sharing files or private information outside Wisp", "Uploads, links, forms with personal details"),
]
private let accessChoices: [(key: String, title: String, detail: String)] = [
  ("read-only", "Read only", "Can look at files, can't change them"),
  ("edit", "Can edit files", "Can change files, can't run commands"),
  ("full", "Full access", "Files and commands on the device"),
]

/** Settings → Agents policy (set-AgentsPolicy.dc.html): the rules every agent here follows. Changes save as you make them. */
struct AgentPolicyView: View {
  @Environment(Store.self) private var store
  @State private var action = FormAction()
  @State private var loaded = false

  private var policy: AgentPolicy? { store.agentPolicy }
  private var canSpawn: Bool { policy?.leadsCreateAgents != nil }
  private var lead: String? { store.agent(store.taskLeadOverride ?? store.taskLead ?? "")?.name }

  var body: some View {
    SettingsPage("Agents", subtitle: "Rules every agent here follows, whichever AI tool runs it.", id: "agent-policy") {
      if !store.isOwner { OwnersOnlyNote() }
      if let policy {
        CardGroup {
          if !store.agents.isEmpty {
            NavigationLink { TeamLeadView() } label: { RowLabel(title: "Team lead", subtitle: "Takes tasks nobody assigned", value: lead) }.accessibilityIdentifier("policy-lead")
          }
          NavigationLink { AskBeforeView() } label: { RowLabel(title: "Ask before", value: "\(policy.askBefore.count) of \(askActions.count)") }.accessibilityIdentifier("policy-ask")
          NavigationLink { NewAgentAccessView() } label: { RowLabel(title: "New agents", value: accessChoices.first { $0.key == policy.defaultAccess }?.title) }.accessibilityIdentifier("policy-access")
        }
        if canSpawn {
          CardLabel("Agents making agents")
          CardGroup {
            ToggleRow(title: "Leads can create agents", subtitle: "A team's lead can add an agent its team is missing",
                      isOn: change(\.leadsCreateAgents, false), id: "policy-leads-create").disabled(!store.isOwner)
            ToggleRow(title: "Those agents can make sub-agents", subtitle: policy.leadsCreateAgents == true ? "Up to 3 levels down" : "Needs “Leads can create agents” on first",
                      isOn: change(\.subAgents, false), id: "policy-sub-agents").disabled(!store.isOwner || policy.leadsCreateAgents != true)
            PickerRow(title: "Most agents made by agents", options: Array(Set([3, 5, 10, 20, 50, policy.maxAgentMade ?? 10])).sorted().map { ($0, "\($0)") }, selection: change(\.maxAgentMade, 10))
              .disabled(!store.isOwner || policy.leadsCreateAgents != true)
          }
          CardHint("Let agents add helpers when the work needs more hands. Both are off until you turn them on.")
        }
        CardLabel("Loop protection")
        CardGroup {
          PickerRow(title: "Hand-offs in a row", subtitle: "Before Wisp stops two agents waking each other", options: Array(Set([2, 3, 4, 5, 6, 8, 10, 15, 20, 30, policy.maxHops])).sorted().map { ($0, "\($0)") },
                    selection: Binding(get: { policy.maxHops }, set: { v in update { $0.maxHops = v } }), id: "policy-hops").disabled(!store.isOwner)
          PickerRow(title: "Agent runs per team per minute", subtitle: "A ceiling on how busy one chat gets", options: Array(Set([5, 6, 10, 20, 40, 60, 100, 200, policy.maxRunsPerMinute])).sorted().map { ($0, "\($0)") },
                    selection: Binding(get: { policy.maxRunsPerMinute }, set: { v in update { $0.maxRunsPerMinute = v } }), id: "policy-runs").disabled(!store.isOwner)
        }
      } else if action.error == nil {
        ProgressView().padding(.top, 30)
      }
      StatusLine(error: action.error)
    }
    .task { await store.refreshAgentPolicyAndLead(into: action) }
  }

  private func change<T>(_ key: WritableKeyPath<AgentPolicy, T?>, _ fallback: T) -> Binding<T> {
    Binding(get: { policy?[keyPath: key] ?? fallback }, set: { v in update { $0[keyPath: key] = v } })
  }

  private func update(_ edit: (inout AgentPolicy) -> Void) {
    guard var next = store.agentPolicy, store.isOwner, !action.busy else { return }
    edit(&next)
    if next.leadsCreateAgents != true { next.subAgents = canSpawn ? false : nil }
    store.agentPolicy = next
    action.run { try await store.saveAgentPolicyOrRestore(next) }
  }
}

extension Store {
  /** Saves the policy; if that fails, shows what the hub still has instead of the unsaved choice. */
  func saveAgentPolicyOrRestore(_ next: AgentPolicy) async throws {
    do { try await saveAgentPolicy(next) }
    catch { try? await refreshAgentPolicy(); throw error }
  }

  func refreshAgentPolicyAndLead(into action: FormAction) async {
    do { try await refreshAgentPolicy() } catch { action.error = error.localizedDescription }
    try? await refreshTaskLead()
  }
}

/** Which actions an agent must ask about first (set-AskBefore.dc.html). */
struct AskBeforeView: View {
  @Environment(Store.self) private var store
  @State private var action = FormAction()

  var body: some View {
    SettingsPage("Ask before", id: "ask-before") {
      if !store.isOwner { OwnersOnlyNote() }
      CardGroup {
        ForEach(askActions, id: \.key) { item in
          ToggleRow(title: item.title, subtitle: item.detail, isOn: Binding(get: { store.agentPolicy?.askBefore.contains(item.key) ?? false }, set: { on in
            guard var next = store.agentPolicy else { return }
            next.askBefore.removeAll { $0 == item.key }
            if on { next.askBefore.append(item.key) }
            store.agentPolicy = next
            action.run { try await store.saveAgentPolicyOrRestore(next) }
          }), id: "ask-\(item.key)")
        }
      }.disabled(!store.isOwner || store.agentPolicy == nil || action.busy)
      CardHint("When an agent is about to do one of these on its own, it asks you first in Inbox and in the chat. You can approve or say not now. If you ask it to do one, it just does it.")
      StatusLine(error: action.error)
    }
    .task { try? await store.refreshAgentPolicy() }
  }
}

/** What a new agent may do on its device (set-NewAgentAccess.dc.html). */
struct NewAgentAccessView: View {
  @Environment(Store.self) private var store
  @State private var action = FormAction()

  var body: some View {
    SettingsPage("New agents", subtitle: "Access on their device.", id: "new-agent-access") {
      if !store.isOwner { OwnersOnlyNote() }
      CardGroup {
        ForEach(accessChoices, id: \.key) { item in
          OptionRow(title: item.title, subtitle: item.detail, selected: store.agentPolicy?.defaultAccess == item.key, id: "access-\(item.key)") {
            guard var next = store.agentPolicy else { return }
            next.defaultAccess = item.key
            store.agentPolicy = next
            action.run { try await store.saveAgentPolicyOrRestore(next) }
          }.disabled(!store.isOwner || action.busy)
        }
      }
      CardHint("What a new agent may do where its AI tool runs directly on a device. Inside its own computer an agent always has full access; the computer is its sandbox.")
      StatusLine(error: action.error)
    }
    .task { try? await store.refreshAgentPolicy() }
  }
}

/** Who takes tasks nobody assigned (set-TeamLead.dc.html). */
struct TeamLeadView: View {
  @Environment(Store.self) private var store
  @State private var action = FormAction()
  private var automatic: Agent? { store.agent(store.taskLead ?? "") }

  var body: some View {
    SettingsPage("Team lead", id: "team-lead") {
      if !store.isOwner { OwnersOnlyNote() }
      CardGroup {
        OptionRow(title: "Automatic", subtitle: automatic.map { "Wisp picks: \($0.name)" } ?? "Wisp picks a team's lead, else the first agent", selected: store.taskLeadOverride == nil, id: "lead-auto") { save(nil) }
        ForEach(store.agents) { agent in
          OptionRow(title: agent.name, subtitle: "@\(agent.handle)", selected: store.taskLeadOverride == agent.id, id: "lead-\(agent.handle)") { save(agent.id) }
        }
      }.disabled(!store.isOwner || action.busy)
      CardHint("The lead takes every task nobody assigned, splits it up and hands the pieces to agents by role.")
      StatusLine(error: action.error)
    }
    .task { try? await store.refreshTaskLead() }
  }

  private func save(_ id: String?) { action.run { try await store.saveLead(id) } }
}

/** Settings → Agent computers: how big new VMs are, and the Orgo cloud-computer key. */
struct ComputerSettingsView: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var settings: ComputerDefaults?
  @State private var size = "medium"
  @State private var idle = 10
  @State private var key = ""
  @State private var saved = false
  @State private var action = FormAction()

  var body: some View {
    SettingsPage("Agent computers", subtitle: "Defaults for the computers agents get.", id: "computers-settings") {
      if !store.isOwner { OwnersOnlyNote() }
      CardLabel("Defaults")
      CardGroup {
        PickerRow(title: "Size of new VMs", options: [("small", "Small: 1 CPU, 2 GB"), ("medium", "Medium: 2 CPUs, 4 GB"), ("large", "Large: 4 CPUs, 8 GB")], selection: $size)
        PickerRow(title: "Give control back after", options: [5, 10, 20, 30, 60, 120, 240].map { ($0, "\($0) minutes") } + (Set([5, 10, 20, 30, 60, 120, 240]).contains(idle) ? [] : [(idle, "\(idle) minutes")]), selection: $idle)
      }.disabled(!store.isOwner || settings == nil || action.busy)
      if store.isOwner {
        Button("Save") { save(["vmSize": AnyEncodable(size), "controlIdleMinutes": AnyEncodable(idle)]) }.buttonStyle(.pill(.primary)).disabled(settings == nil || action.busy)
      }
      CardLabel("Orgo cloud computers")
      CardGroup {
        ValueRow(title: "Status", value: settings?.orgo.configured == true ? "Connected \(settings?.orgo.hint ?? "")" : "Not connected")
        if store.isOwner { FieldRow(title: "API key", text: $key, prompt: "Orgo API key", secure: true, id: "orgo-key") }
      }
      if store.isOwner {
        Button("Save key") { save(["orgoApiKey": AnyEncodable(key)]); key = "" }.buttonStyle(.pill(.secondary)).disabled(key.isEmpty || action.busy)
        if settings?.orgo.configured == true { Button("Disconnect") { save(["orgoApiKey": .null]) }.buttonStyle(.pill(.destructive)).disabled(action.busy) }
      }
      if store.canManage {
        CardLabel("New agents get")
        CardGroup {
          NavigationLink { AgentDefaultsView() } label: {
            RowLabel(title: "AI tool, model and computer", value: store.agentDefaults?.model ?? "Each harness")
          }
        }
      }
      StatusLine(error: action.error, saved: saved ? "Saved." : nil)
    }
    .task { do { settings = try await store.connection().get("/api/settings/computers"); size = settings?.defaults.vmSize ?? "medium"; idle = settings?.defaults.controlIdleMinutes ?? 10 } catch { action.error = error.localizedDescription } }
  }

  private func save(_ body: Fields) {
    action.run { let data = try await store.connection().put("/api/settings/computers", body); settings = try Wire.decoder.decode(ComputerDefaults.self, from: data); saved = true }
  }
}

/** Settings → Connections (set-Connections.dc.html): keys for agents running somewhere else. */
struct ConnectionsSettingsView: View {
  @Environment(Store.self) private var store
  @State private var connections: [AgentConnection]?
  @State private var removing: AgentConnection?
  @State private var action = FormAction()

  private func detail(_ c: AgentConnection, kindName: String) -> String {
    let used = c.lastUsed.flatMap(Wire.date).map { "used \($0.formatted(.relative(presentation: .named)))" } ?? "never used"
    return "\(kindName) · \(used)"
  }

  var body: some View {
    SettingsPage("Connections", subtitle: "Keys for agents running somewhere else. \(store.isOwner ? "You see everyone's." : "You see the ones you made.")", id: "connections") {
      group("Connection tokens", kind: "connection", name: { _ in "wisp-mcp" }, none: "None.", hint: "Made on an agent's Connect tab, for an AI tool that runs elsewhere.")
      group("AI tools on devices", kind: "harness", name: { $0.device ?? "Device" }, none: "None.", hint: "Disconnecting one makes the device get a fresh one next run.")
      StatusLine(error: action.error)
    }
    .task { do { connections = try await store.connection().get("/api/connections") } catch { action.error = error.localizedDescription; connections = [] } }
    .confirmCard(Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), title: "Disconnect this connection?", message: "Whatever uses it stops working.", confirm: "Disconnect") {
      if let connection = removing { action.run { try await store.connection().delete("/api/connections/\(connection.id)"); connections?.removeAll { $0.id == connection.id } } }
    }
  }

  @ViewBuilder private func group(_ title: String, kind: String, name: @escaping (AgentConnection) -> String, none: String, hint: String) -> some View {
    let items = (connections ?? []).filter { $0.kind == kind }
    CardLabel(title)
    if connections == nil { ProgressView() }
    else if items.isEmpty { CardHint(none) }
    else {
      CardGroup {
        ForEach(items) { c in
          HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
              Text(store.agent(c.agentId)?.name ?? "A removed agent").font(.system(size: 17)).foregroundStyle(Palette.text)
              Text(detail(c, kindName: name(c))).font(.system(size: 14)).foregroundStyle(Palette.faint)
            }
            Spacer(minLength: 8)
            if store.canManage { Button("Disconnect") { removing = c }.buttonStyle(.pill(.secondary, small: true)) }
          }.padding(.horizontal, 18).frame(minHeight: 64)
        }
      }
    }
    CardHint(hint)
  }
}

/** Settings → Data and export (set-Data.dc.html). */
struct DataExportView: View {
  @Environment(Store.self) private var store
  @State private var info: ExportInfo?
  @State private var exported: URL?
  @State private var action = FormAction()

  var body: some View {
    SettingsPage("Data and export", subtitle: "Back up your organization, or take a copy of your notes and conversations.", id: "data") {
      CardLabel("Back up everything")
      if let info {
        CardGroup {
          ValueRow(title: "Where the folder is", value: store.nodes.first(where: { $0.online })?.name ?? "The computer Wisp runs on")
          ValueRow(title: "What is inside", value: "\(info.notes ?? 0) notes · \(info.messages ?? 0) messages")
        }
        if let dir = info.dataDir { Text(dir).font(.system(size: 13, design: .monospaced)).foregroundStyle(Palette.faint).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 6) }
        CardHint("\(info.files ?? 0) files and \(info.agents ?? 0) agents too. Copy the whole Wisp folder to a USB drive or cloud folder and you have a full backup. Memory notes live in a different folder if you moved it.")
      } else if !store.isOwner {
        CardHint("Ask an organization owner for the backup folder.")
      }
      CardGroup {
        NavigationLink { HowToBackUpView() } label: { RowLabel(title: "How to back up") }
        NavigationLink { HowToRestoreView() } label: { RowLabel(title: "How to restore") }
        NavigationLink { WhatIsNotInBackupView(memoryNote: movedMemoryNote) } label: { RowLabel(title: "What is not in it", subtitle: "AI tool sign-ins, agent computers, browser-only settings") }
      }
      CardLabel("Download copies")
      CardGroup {
        if store.isOwner {
          Button { export("/api/export/vault.zip", name: "wisp-memory.zip") } label: { RowLabel(title: "Download my notes", subtitle: "Markdown ZIP", chevron: false) }.buttonStyle(.plain).disabled(action.busy)
        }
        Button { export("/api/export/conversations.json", name: "wisp-conversations.json") } label: { RowLabel(title: "Download conversations", subtitle: "JSON", chevron: false) }.buttonStyle(.plain).disabled(action.busy)
      }
      if action.busy { ProgressView() }
      if let exported { ShareLink("Save or share download", item: exported).buttonStyle(.pill(.secondary)) }
      CardHint("Copies to keep or read. They can't restore an organization on their own; the folder backup does.")
      StatusLine(error: action.error)
    }
    .task { if store.isOwner { do { info = try await store.connection().get("/api/settings/data"); try? await store.refreshMemoryStorage() } catch { action.error = error.localizedDescription } } }
  }

  private var movedMemoryNote: String? {
    guard store.isOwner, let memory = store.memoryStorage?.path, let folder = info?.dataDir, !memory.hasPrefix(folder) else { return nil }
    return "The memory folder, because it was moved to a different place: \(memory)"
  }

  private func export(_ path: String, name: String) { action.run { exported = try await store.exportData(path, name: name) } }
}

struct HowToBackUpView: View {
  var body: some View {
    SettingsPage("How to back up", id: "how-to-back-up") {
      StepsCard(steps: ["Quit Wisp on the computer that runs the hub, so the copy is complete.", "Copy the whole folder to a USB drive or a cloud folder.", "Start Wisp again."])
    }
  }
}

struct HowToRestoreView: View {
  var body: some View {
    SettingsPage("How to restore", id: "how-to-restore") {
      StepsCard(steps: ["Install Wisp on the computer, or keep the install you already have.", "Quit Wisp.", "Put your copied folder back in the same place, replacing the folder there.", "If your memory notes were in a separate folder, put that folder back too.", "Start Wisp again. Your devices reconnect by themselves when they are online."])
    }
  }
}

struct WhatIsNotInBackupView: View {
  var memoryNote: String?
  var body: some View {
    SettingsPage("What is not in it", id: "not-in-backup") {
      BulletsCard(points: ["Sign-ins for agent tools (like Claude Code or Codex). Those stay on each device.", "Agents' own computers (VMs). They live on the device that runs them.", "Settings saved only on this iPhone or in a browser, like appearance and notifications."] + (memoryNote.map { [$0] } ?? []))
    }
  }
}

/** Settings → Voice (set-Voice.dc.html): how you talk with your agents out loud. */
struct VoiceSettingsView: View {
  @Environment(Store.self) private var store
  @State private var preferences: VoicePreferences?
  @State private var listen = "device"
  @State private var speak = "device"
  @State private var openai = ""
  @State private var elevenlabs = ""
  @State private var action = FormAction()
  @State private var saved = false

  private var needsOpenAI: Bool { listen == "openai" || speak == "openai" }

  var body: some View {
    SettingsPage("Voice", subtitle: "Talk with your agents out loud. Your microphone is only used when you start a call or a test.", id: "voice") {
      CardGroup {
        PickerRow(title: "Listening", subtitle: "How your speech becomes a chat message", options: [("device", "On this device"), ("openai", "OpenAI (online)")], selection: $listen, id: "voice-listen")
        PickerRow(title: "Speaking", subtitle: "Agents read a short version. The full reply stays in chat", options: [("device", "On this device"), ("openai", "OpenAI (online)"), ("elevenlabs", "ElevenLabs (online)")], selection: $speak, id: "voice-speak")
      }
      if needsOpenAI || speak == "elevenlabs" {
        CardLabel("One more thing")
        CardGroup {
          if needsOpenAI { FieldRow(title: "OpenAI key", subtitle: "OpenAI bills you for it", text: $openai, secure: true, id: "voice-openai") }
          if speak == "elevenlabs" { FieldRow(title: "ElevenLabs key", subtitle: "ElevenLabs bills you for it", text: $elevenlabs, secure: true, id: "voice-elevenlabs") }
        }
        CardHint("Keys stay on your hub and are hidden when shown again. Clear a key and save to remove it.")
      }
      CardGroup {
        NavigationLink { VoiceTryOutView(speak: speak) } label: { RowLabel(title: "Try it out", subtitle: "Microphone and speaker") }.accessibilityIdentifier("voice-try")
        NavigationLink { AgentVoicesView() } label: { RowLabel(title: "Each agent's voice", subtitle: store.agents.prefix(3).map(\.name).joined(separator: ", ")) }.accessibilityIdentifier("voice-agents")
        if !needsOpenAI && speak != "elevenlabs" {
          MoreOptionsRow {
            FieldRow(title: "OpenAI key", text: $openai, secure: true, id: "voice-openai-more")
            FieldRow(title: "ElevenLabs key", text: $elevenlabs, secure: true, id: "voice-elevenlabs-more")
          }
        }
      }
      StatusLine(error: action.error, saved: saved ? "Saved. Your next call will use these settings." : nil)
      Button("Save") {
        action.run {
          let data = try await store.connection().put("/api/voice/settings", VoicePreferences(listen: listen, speak: speak, openaiKey: openai, elevenlabsKey: elevenlabs))
          preferences = try Wire.decoder.decode(VoicePreferences.self, from: data)
          openai = preferences?.openaiKey ?? ""; elevenlabs = preferences?.elevenlabsKey ?? ""; saved = true
        }
      }.buttonStyle(.pill(.primary)).disabled(preferences == nil || action.busy).accessibilityIdentifier("voice-save")
    }
    .task { do { preferences = try await store.connection().get("/api/voice/settings"); listen = preferences?.listen ?? "device"; speak = preferences?.speak ?? "device"; openai = preferences?.openaiKey ?? ""; elevenlabs = preferences?.elevenlabsKey ?? "" } catch { action.error = error.localizedDescription } }
    .onChange(of: listen) { saved = false }
    .onChange(of: speak) { saved = false }
  }
}

/** Each agent's voice: tap one to pick it and hear a sample. */
struct AgentVoicesView: View {
  @Environment(Store.self) private var store
  @State private var editing: Agent?

  var body: some View {
    SettingsPage("Each agent's voice", id: "agent-voices") {
      CardGroup {
        ForEach(store.agents) { agent in
          Button { editing = agent } label: {
            RowLabel(title: agent.name, value: agent.settings?.voice?.device ?? agent.settings?.voice?.openai ?? agent.settings?.voice?.elevenlabs ?? "Default") {
              AgentAvatar(agent: agent, size: 30, showStatus: false)
            }
          }.buttonStyle(.plain)
        }
        if store.agents.isEmpty { RowLabel(title: "No agents yet", chevron: false) }
      }
      CardHint("Every agent can have its own voice. Tap one to pick it and hear a sample.")
    }
    .sheet(item: $editing) { AgentVoiceSheet(agent: $0).environment(store) }
  }
}
