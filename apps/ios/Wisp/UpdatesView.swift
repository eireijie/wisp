import SwiftUI

enum WispRepo {
  static let github = "eireijie/wisp"
  static let url = "https://github.com/\(github)"
}

struct UpdatesView: View {
  @Environment(Store.self) private var store
  @State private var info: HubUpdate?
  @State private var confirming = false
  @State private var action = FormAction()
  private var updating: Bool { ["updating", "restarting"].contains(info?.update?.state ?? "") }
  var body: some View {
    List {
      Section("Updates") {
        if let version = info?.version?.commit { LabeledContent("This hub runs Wisp", value: version) }
        if let value = info?.version?.date, let date = Wire.date(value) { LabeledContent("Version date") { Text(date, format: .dateTime.year().month().day()) } }
        Text(info?.check?.reason ?? "Which version of Wisp this hub runs, and what's new.")
        Button("Check now") { action.run { info = try await store.connection().post("/api/updates/check", Empty()) } }.disabled(action.busy || updating)
        if info?.check?.canUpdate == true && store.isOwner { Button("Update hub") { confirming = true }.disabled(action.busy || updating) }
        if updating { ProgressView(info?.update?.state == "restarting" ? "Restarting…" : "Updating…") }
        if let message = info?.update?.message, !message.isEmpty { Text(message) }
        ForEach(info?.check?.changes ?? [], id: \.self) { Text($0).font(.caption) }
        if let lines = info?.update?.log, !lines.isEmpty { TechnicalDetails(title: "Update log") { Text(lines.joined(separator: "\n")).font(.caption.monospaced()).textSelection(.enabled) } }
      }
      Section("About") {
        Text("Wisp is free and open source (Apache-2.0). Your data stays on this hub.")
        if let url = URL(string: WispRepo.url) { Link("Source code", destination: url) }
      }
      InlineError(error: action.error)
    }.navigationTitle("Updates & about")
      .task {
        do { info = try await store.connection().get("/api/updates") } catch { action.error = error.localizedDescription }
      }
      .task(id: updating) {
        guard updating else { return }
        while !Task.isCancelled {
          do { try await Task.sleep(for: .seconds(3)); info = try await store.connection().get("/api/updates"); action.error = nil }
          catch { if !Task.isCancelled { action.error = "Wisp is restarting. It will reconnect when the hub is back." } }
        }
      }
      .confirmationDialog("Update and restart the hub? Everyone will briefly disconnect.", isPresented: $confirming, titleVisibility: .visible) {
        Button("Update hub") {
          action.run {
            let result: HubUpdate = try await store.connection().post("/api/updates/hub", Empty())
            info?.update = result.update
          }
        }
      }
  }
}

struct AgentRuntimesView: View {
  @Environment(Store.self) private var store
  @State private var action = FormAction()
  var body: some View {
    List {
      Text("The AI tools (like Claude Code or Codex) each of your devices can run for agents. Most people set this up once.").font(.subheadline)
      Section("On this device") {
        ForEach(store.nodes.filter(\.usable)) { node in NavigationLink(node.name) { DeviceDetail(node: node) } }
        if !store.nodes.contains(where: \.usable) { Text("Connect a device first.") }
      }
      Section("Inside your agents' VMs") {
        Text("Every VM comes with these. Sign each in once per VM, on the agent's Computer tab.").font(.footnote)
        ForEach(["claude-code", "codex", "hermes", "kimi"], id: \.self) { Text(HarnessChoice.label($0)) }
      }
      Section("Connect from anywhere") {
        Text("Agents that run somewhere Wisp doesn't start them join through wisp-mcp. Add the agent, then make a connection token on its Connect tab on the computer.").font(.footnote)
        ForEach(HarnessChoice.all.filter { $0.protocolName == "mcp" }) { Text($0.label) }
      }
      InlineError(error: action.error)
    }.navigationTitle("Agent runtimes")
      .task { do { try await store.refreshNodes() } catch { action.error = error.localizedDescription } }
  }
}
