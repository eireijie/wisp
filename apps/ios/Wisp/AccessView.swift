import SwiftUI

/** What turning on Tailscale did: the hub's new state, a page to open (install or sign in), and whether it's ready. */
struct TailscaleOutcome {
  var info: ReachInfo
  var open: URL?
  var ready: Bool
}

extension Store {
  /** Moves Tailscale one step toward working, the same steps the web takes; `publicAccess` also turns Funnel on. */
  func enableTailscale(publicAccess: Bool = false) async throws -> TailscaleOutcome {
    var info = try await reach(fresh: true)
    if info.tailscale.state == "missing" { return TailscaleOutcome(info: info, open: info.download.flatMap(URL.init(string:)), ready: false) }
    if info.tailscale.state == "needs-login" {
      info = try await tailscale("login")
      return TailscaleOutcome(info: info, open: info.tailscale.authUrl.flatMap(URL.init(string:)), ready: false)
    }
    if info.tailscale.state == "stopped" { info = try await tailscale("up") }
    if info.tailscale.state == "error" { throw API.Failure(status: 0, message: info.tailscale.error ?? "Tailscale couldn't connect; try again.") }
    guard info.tailscale.state == "running" else { return TailscaleOutcome(info: info, open: nil, ready: false) }
    if info.tailscale.serving != true { info = try await tailscale("serve") }
    if publicAccess && info.tailscale.funnel != true { info = try await tailscale("funnel") }
    if let problem = info.tailscale.error { throw API.Failure(status: 0, message: problem) }
    return TailscaleOutcome(info: info, open: nil, ready: publicAccess ? info.connectorOrigin != nil : info.publicUrl != nil)
  }

  /** Turns "away from home" off the way it was turned on. */
  func turnAwayOff(_ info: ReachInfo) async throws -> ReachInfo {
    if info.cloudflareRunning { return try await stopCloudflare() }
    if info.tailscale.serving == true {
      if info.tailscale.funnel == true { _ = try await tailscale("unfunnel") }
      return try await tailscale("unserve")
    }
    throw API.Failure(status: 0, message: "This Wisp already uses a public address.")
  }
}

/** Use Wisp from anywhere: Tailscale steps and status, or a Cloudflare tunnel. Owners only. */
struct AccessView: View {
  @Environment(Store.self) private var store
  @Environment(\.openURL) private var openURL
  @State private var info: ReachInfo?
  @State private var failed = false
  @State private var choice = "tailscale"
  @State private var token = ""
  @State private var hint: String?
  @State private var action = FormAction()

  var body: some View {
    List {
      if !store.isOwner {
        Section { Text("Your Wisp's owner can turn this on.").foregroundStyle(.secondary) }
      }
      if let info {
        Section("Away from home") {
          LabeledContent("Status", value: info.summary)
          if let address = info.publicUrl ?? info.cloudflare?.url { Text(address).font(.footnote.monospaced()).textSelection(.enabled) }
          if let lan = info.lan?.first { LabeledContent("At home") { Text(lan).font(.footnote.monospaced()).textSelection(.enabled) } }
        }
        if store.isOwner {
          if info.awayOn {
            Section {
              Button("Turn off", role: .destructive) { run { self.info = try await store.turnAwayOff(info); hint = "Away from home is off." } }.disabled(action.busy)
            } footer: { Text("Devices and phones that used the away address stop reaching this Wisp until you turn it back on.") }
          } else {
            setup(info)
          }
        }
      } else if failed {
        Section { Text("Away from home isn't available yet. Update Wisp on the computer it runs on.").foregroundStyle(.secondary) }
      } else {
        Section { HStack { ProgressView(); Text("Checking…").foregroundStyle(.secondary) } }
      }
      if let hint { Section { Text(hint).font(.footnote) } }
      InlineError(error: action.error)
    }.sectionScreen("Access", id: "access")
      .task { await watch() }
  }

  @ViewBuilder private func setup(_ info: ReachInfo) -> some View {
    let signedIn = info.tailscale.state == "running"
    Section {
      Picker("How", selection: $choice) {
        Text("Tailscale (best)").tag("tailscale")
        Text("Cloudflare").tag("cloudflare")
      }.pickerStyle(.segmented)
      if choice == "tailscale" {
        Text(signedIn ? "Already on this \(info.computerName). Nothing to set up." : "Free. Wisp helps you install it, then sign in.").font(.footnote)
        tailscaleSteps(info)
        Button("Turn it on") { run { try await turnOnTailscale() } }.disabled(action.busy)
      } else {
        Text("Needs a domain you own. Paste the setup code Cloudflare gives you for a tunnel.").font(.footnote)
        SecureField("Cloudflare setup code", text: $token).textContentType(.password).textInputAutocapitalization(.never).autocorrectionDisabled()
        if let problem = info.cloudflare?.error { Text(problem).font(.footnote).foregroundStyle(.red) }
        Button("Turn it on") {
          run {
            let next = try await store.startCloudflare(token: token.trimmed)
            self.info = next; token = ""
            hint = next.awayOn ? "Away from home is on." : "Cloudflare is connecting…"
          }
        }.disabled(action.busy || token.trimmed.count < 20)
      }
    } header: { Text("Turn it on") } footer: {
      Text("Then anyone on your Wisp can open it from any Wi-Fi or cell data. Only people signed in can see anything.")
    }
  }

  /** the steps Tailscale still needs, in plain words */
  @ViewBuilder private func tailscaleSteps(_ info: ReachInfo) -> some View {
    switch info.tailscale.state {
    case "missing":
      Label("Install Tailscale on this \(info.computerName)", systemImage: "1.circle")
      if let url = info.download.flatMap(URL.init(string:)) { Button("Install Tailscale") { openURL(url) } }
    case "needs-login":
      Label("Sign in to Tailscale", systemImage: "2.circle")
      if let url = info.tailscale.authUrl.flatMap(URL.init(string:)) { Button("Open the Tailscale sign-in page") { openURL(url) } }
    case "stopped", "starting":
      Label("Tailscale is \(info.tailscale.state == "starting" ? "starting" : "off"); turning it on connects it", systemImage: "2.circle")
    case "error":
      Label(info.tailscale.error ?? "Tailscale couldn't connect.", systemImage: "exclamationmark.triangle").foregroundStyle(.red)
    default:
      Label("Tailscale is running", systemImage: "checkmark.circle").foregroundStyle(.green)
    }
  }

  private func turnOnTailscale() async throws {
    let outcome = try await store.enableTailscale()
    info = outcome.info
    if let url = outcome.open { openURL(url) }
    hint = outcome.ready ? "Away from home is on." : "Finish setting up Tailscale, then choose Turn it on again."
  }

  private func run(_ work: @escaping @MainActor () async throws -> Void) {
    hint = nil
    action.run(work)
  }

  /** the address and Tailscale status, kept fresh while this page is open */
  private func watch() async {
    while !Task.isCancelled {
      do { info = try await store.reach(); failed = false } catch { if info == nil { failed = true } }
      do { try await Task.sleep(for: .seconds(3)) } catch { return }
    }
  }
}

/** Settings → Away from home and apps: away-from-home status, and the apps (ChatGPT, Grok, Claude) connected to agents. Devices are on the Computers tab. */
struct DevicesSettingsView: View {
  @Environment(Store.self) private var store
  @Environment(\.openURL) private var openURL
  @State private var info: ReachInfo?
  @State private var clients: [McpClient]?
  @State private var removing: McpClient?
  @State private var hint: String?
  @State private var hintURL: URL?
  @State private var action = FormAction()

  var body: some View {
    List {
      Section("Away from home") {
        if store.isOwner {
          NavigationLink { AccessView() } label: { LabeledContent("Away from home", value: info?.summary ?? "") }
        } else {
          LabeledContent("Away from home", value: info?.summary ?? "—")
        }
      }
      if store.isOwner { apps }
      if let hint { Section { Text(hint).font(.footnote); if let hintURL { Button("Open Tailscale") { openURL(hintURL) } } } }
      InlineError(error: action.error)
    }.sectionScreen("Away from home and apps", id: "devices-settings")
      .task { try? await store.refreshNodes(); await watch() }
      .confirmationDialog("Disconnect \(removing?.name ?? "this app")? It stops reaching your agents.", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
        Button("Disconnect", role: .destructive) {
          if let client = removing { action.run { try await store.disconnectMcp(client.id); clients?.removeAll { $0.id == client.id } } }
        }
      }
  }

  @ViewBuilder private var apps: some View {
    let origin = info?.connectorOrigin
    Section {
      Toggle("Grok, ChatGPT and Claude", isOn: Binding(get: { origin != nil }, set: { on in toggle(on) })).disabled(action.busy || info == nil)
      if let origin {
        Text("\(origin)/mcp").font(.footnote.monospaced()).textSelection(.enabled)
        Button("Copy address") { UIPasteboard.general.string = "\(origin)/mcp" }
        Text("In Grok: Connectors, Add custom connector, paste.").font(.footnote).foregroundStyle(.secondary)
      }
    } header: { Text("Apps") } footer: { Text("Talk to your agents from their apps.") }
    if let clients {
      Section("Connected apps") {
        if clients.isEmpty { Text("No apps connected yet.").foregroundStyle(.secondary) }
        ForEach(clients) { client in
          HStack {
            VStack(alignment: .leading, spacing: 2) {
              Text(client.name)
              if let agent = client.agentName { Text("acts as \(agent)").font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
            Button("Disconnect", role: .destructive) { removing = client }.buttonStyle(.bordered).controlSize(.small).disabled(action.busy)
          }
        }
      }
    }
  }

  private func toggle(_ on: Bool) {
    hint = nil; hintURL = nil
    action.run {
      if on {
        let outcome = try await store.enableTailscale(publicAccess: true)
        info = outcome.info
        if !outcome.ready { hint = "Finish setting up Tailscale, then turn this on again."; hintURL = outcome.open }
      } else if info?.tailscale.funnel == true {
        info = try await store.tailscale("unfunnel")
      } else if info?.cloudflareRunning == true {
        info = try await store.stopCloudflare()
      } else {
        throw API.Failure(status: 0, message: "This Wisp uses a public address; disconnect apps below to remove their access.")
      }
    }
  }

  private func watch() async {
    while !Task.isCancelled {
      info = try? await store.reach()
      if store.isOwner { clients = (try? await store.mcpClients()) ?? clients }
      do { try await Task.sleep(for: .seconds(5)) } catch { return }
    }
  }
}
