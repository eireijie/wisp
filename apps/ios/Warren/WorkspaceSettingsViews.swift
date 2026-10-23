import SwiftUI

struct AgentPolicyView: View {
  @Environment(Store.self) private var store
  @State private var ask: Set<String> = []
  @State private var hops = 6
  @State private var runs = 20
  @State private var access = "edit"
  @State private var leadsCreate = false
  @State private var subAgents = false
  @State private var maxMade = 10
  /** whether this hub knows about agents making agents */
  @State private var canSpawn = false
  @State private var loaded = false
  @State private var saved = false
  @State private var action = FormAction()
  private let actions = [("send", "Sending email or messages outside Warren"), ("spend", "Buying or paying for anything"), ("delete", "Deleting files, data or accounts"), ("post", "Posting publicly"), ("signup", "Signing up for new accounts or services"), ("share", "Sharing files or private information outside Warren")]
  var body: some View {
    Form {
      Section("Ask before") {
        Text("Checked actions need your OK. If you explicitly ask a helper to do it, it just does it. If it decides on its own, it asks first.").font(.footnote)
        ForEach(actions, id: \.0) { key, title in Toggle(title, isOn: Binding(get: { ask.contains(key) }, set: { if $0 { ask.insert(key) } else { ask.remove(key) } })) }
      }.disabled(!store.isOwner || !loaded)
      Section("New agents") {
        Picker("Access on their device", selection: $access) { Text("Read only").tag("read-only"); Text("Edit").tag("edit"); Text("Full access").tag("full") }
      }.disabled(!store.isOwner || !loaded)
      if canSpawn {
        Section {
          Toggle(isOn: $leadsCreate) {
            VStack(alignment: .leading, spacing: 2) {
              Text("Leads can create agents")
              Text("A channel's lead can create an agent its team is missing. It joins the team chart under the lead.").font(.caption).foregroundStyle(.secondary)
            }
          }
          Toggle(isOn: $subAgents) {
            VStack(alignment: .leading, spacing: 2) {
              Text("Those agents can make sub-agents")
              Text(leadsCreate ? "An agent a lead made can make sub-agents for pieces of its own work, up to 3 levels down." : "Needs “Leads can create agents” on first.").font(.caption).foregroundStyle(.secondary)
            }
          }.disabled(!leadsCreate)
          Picker("Most agents made by agents", selection: $maxMade) {
            ForEach(Array(Set([3, 5, 10, 20, 50, maxMade])).sorted(), id: \.self) { Text("\($0)").tag($0) }
          }.disabled(!leadsCreate)
        } header: { Text("Agents making agents") } footer: {
          Text("Let agents add helpers when the work needs more hands. Both are off until you turn them on.")
        }.disabled(!store.isOwner || !loaded)
      }
      Section("Loop protection") {
        Stepper("Hand-offs in a row: \(hops)", value: $hops, in: 1...30)
        Stepper("Agent runs per channel per minute: \(runs)", value: $runs, in: 1...200)
      }.disabled(!store.isOwner || !loaded)
      if store.isOwner { Button("Save") { action.run { try await store.saveAgentPolicy(AgentPolicy(askBefore: ask.sorted(), maxHops: hops, maxRunsPerMinute: runs, defaultAccess: access,
        leadsCreateAgents: canSpawn ? leadsCreate : nil, subAgents: canSpawn ? subAgents : nil, maxAgentMade: canSpawn ? maxMade : nil)); saved = true } }.disabled(action.busy || !loaded) }
      else { Text("Only owners can change these settings.").font(.footnote) }
      if saved { Text("Saved.").foregroundStyle(.green) }
      InlineError(error: action.error)
    }.navigationTitle("Agents")
      .task { do { try await store.refreshAgentPolicy(); if let policy = store.agentPolicy { ask = Set(policy.askBefore); hops = policy.maxHops; runs = policy.maxRunsPerMinute; access = policy.defaultAccess
        canSpawn = policy.leadsCreateAgents != nil; leadsCreate = policy.leadsCreateAgents ?? false; subAgents = policy.subAgents ?? false; maxMade = policy.maxAgentMade ?? 10
        loaded = true } } catch { action.error = error.localizedDescription } }
  }
}

struct ComputerSettingsView: View {
  @Environment(Store.self) private var store
  @State private var settings: ComputerDefaults?
  @State private var size = "medium"
  @State private var idle = 10
  @State private var key = ""
  @State private var saved = false
  @State private var action = FormAction()
  var body: some View {
    Form {
      Section("Defaults") {
        Picker("Size of new VMs", selection: $size) { Text("Small: 1 CPU, 2 GB").tag("small"); Text("Medium: 2 CPUs, 4 GB").tag("medium"); Text("Large: 4 CPUs, 8 GB").tag("large") }
        Stepper("Give control back after \(idle) minutes", value: $idle, in: 1...240)
        if store.isOwner { Button("Save") { save(["vmSize": AnyEncodable(size), "controlIdleMinutes": AnyEncodable(idle)]) } }
      }.disabled(!store.isOwner || settings == nil || action.busy)
      Section("Orgo cloud computers") {
        Text(settings?.orgo.configured == true ? "Connected \(settings?.orgo.hint ?? "")" : "Not connected")
        if store.isOwner {
          SecureField("Orgo API key", text: $key)
          Button("Save key") { save(["orgoApiKey": AnyEncodable(key)]); key = "" }.disabled(key.isEmpty || action.busy)
          if settings?.orgo.configured == true { Button("Disconnect", role: .destructive) { save(["orgoApiKey": .null]) }.disabled(action.busy) }
        }
      }
      if saved { Text("Saved.").foregroundStyle(.green) }
      InlineError(error: action.error)
    }.navigationTitle("Computers")
      .task { do { settings = try await store.connection().get("/api/settings/computers"); size = settings?.defaults.vmSize ?? "medium"; idle = settings?.defaults.controlIdleMinutes ?? 10 } catch { action.error = error.localizedDescription } }
  }
  private func save(_ body: Fields) {
    action.run { let data = try await store.connection().put("/api/settings/computers", body); settings = try Wire.decoder.decode(ComputerDefaults.self, from: data); saved = true }
  }
}

struct ConnectionsSettingsView: View {
  @Environment(Store.self) private var store
  @State private var connections: [AgentConnection] = []
  @State private var removing: AgentConnection?
  @State private var action = FormAction()
  var body: some View {
    List {
      Text("Keys that let agents running somewhere else reach this hub. \(store.isOwner ? "You see everyone's." : "You see the ones you made.")").font(.footnote)
      ForEach(connections) { connection in
        VStack(alignment: .leading) {
          Text(store.agent(connection.agentId)?.name ?? "Removed agent")
          Text(connection.device ?? connection.kind ?? "Connection").font(.caption)
          if store.canManage { Button("Disconnect", role: .destructive) { removing = connection } }
        }
      }
      InlineError(error: action.error)
    }.navigationTitle("Connections")
      .task { do { connections = try await store.connection().get("/api/connections") } catch { action.error = error.localizedDescription } }
      .confirmationDialog("Disconnect this connection?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
        Button("Disconnect", role: .destructive) { if let connection = removing { action.run { try await store.connection().delete("/api/connections/\(connection.id)"); connections.removeAll { $0.id == connection.id } } } }
      }
  }
}

struct DataExportView: View {
  @Environment(Store.self) private var store
  @State private var info: ExportInfo?
  @State private var exported: URL?
  @State private var action = FormAction()
  var body: some View {
    List {
      Section("Back up everything") {
        Text("One folder on the computer that runs the Warren hub holds everything for this organization. Copy that folder on the computer for a full backup.")
        if let info { Text(info.dataDir ?? "").textSelection(.enabled); Text("\(info.notes ?? 0) notes, \(info.messages ?? 0) messages, \(info.files ?? 0) files and \(info.agents ?? 0) agents.").font(.footnote) }
        else if !store.isOwner { Text("Ask an organization owner for the backup folder.").font(.footnote) }
      }
      Section("Download copies") {
        Text("These downloads are copies to keep or read. They can't restore an organization on their own. The folder backup does.").font(.footnote)
        if store.isOwner { Button("Download my notes (Markdown ZIP)") { export("/api/export/vault.zip", name: "warren-memory.zip") }.disabled(action.busy) }
        Button("Download conversations (JSON, for developers)") { export("/api/export/conversations.json", name: "warren-conversations.json") }.disabled(action.busy)
        if let exported { ShareLink("Save or share download", item: exported) }
        if action.busy { ProgressView() }
      }
      InlineError(error: action.error)
    }.navigationTitle("Data & export")
      .task { if store.isOwner { do { info = try await store.connection().get("/api/settings/data") } catch { action.error = error.localizedDescription } } }
  }
  private func export(_ path: String, name: String) { action.run { exported = try await store.exportData(path, name: name) } }
}

struct VoiceSettingsView: View {
  @Environment(Store.self) private var store
  @State private var preferences: VoicePreferences?
  @State private var listen = "device"
  @State private var speak = "device"
  @State private var openai = ""
  @State private var elevenlabs = ""
  @State private var action = FormAction()
  @State private var saved = false
  var body: some View {
    Form {
      Section("Your voice choices") {
        Picker("Listening", selection: $listen) { Text("On this device").tag("device"); Text("OpenAI (online)").tag("openai") }
        Picker("Speaking", selection: $speak) { Text("On this device").tag("device"); Text("OpenAI (online)").tag("openai"); Text("ElevenLabs (online)").tag("elevenlabs") }
        Text("These settings belong to you. Voice calls and microphone tests are available in Warren on the computer.").font(.footnote)
      }
      TechnicalDetails(title: "API keys") { SecureField("OpenAI key", text: $openai); SecureField("ElevenLabs key", text: $elevenlabs); Text("Keys stay on your hub and are hidden when shown again. Clear a key and save to remove it. Online voice providers bill you separately.").font(.footnote) }
      Button("Save") {
        action.run {
          let data = try await store.connection().put("/api/voice/settings", VoicePreferences(listen: listen, speak: speak, openaiKey: openai, elevenlabsKey: elevenlabs))
          preferences = try Wire.decoder.decode(VoicePreferences.self, from: data)
          openai = preferences?.openaiKey ?? ""; elevenlabs = preferences?.elevenlabsKey ?? ""; saved = true
        }
      }.disabled(preferences == nil || action.busy)
      if saved { Text("Saved. Your next call will use these settings.") }
      InlineError(error: action.error)
    }.navigationTitle("Voice")
      .task { do { preferences = try await store.connection().get("/api/voice/settings"); listen = preferences?.listen ?? "device"; speak = preferences?.speak ?? "device"; openai = preferences?.openaiKey ?? ""; elevenlabs = preferences?.elevenlabsKey ?? "" } catch { action.error = error.localizedDescription } }
  }
}
