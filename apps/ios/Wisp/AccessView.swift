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

/** Settings → Access (set-Access.dc.html): use Wisp away from home with Tailscale or a Cloudflare tunnel. Owners only. */
struct AccessView: View {
  @Environment(Store.self) private var store
  @Environment(\.openURL) private var openURL
  @State private var info: ReachInfo?
  @State private var clients: [McpClient]?
  @State private var removing: McpClient?
  @State private var failed = false
  @State private var choice = "tailscale"
  @State private var token = ""
  @State private var hint: String?
  @State private var hintURL: URL?
  @State private var turningOff = false
  @State private var action = FormAction()

  var body: some View {
    SettingsPage("Access", subtitle: "Use Wisp away from home.", id: "access") {
      if !store.isOwner { CardHint("Your Wisp's owner can turn this on.") }
      if let info {
        CardLabel("Away from home")
        CardGroup {
          RowLabel(title: info.awayOn ? "Reachable from anywhere" : "Only at home for now", subtitle: info.publicUrl ?? info.cloudflare?.url ?? info.lan?.first, value: info.awayOn ? "On" : "Off", chevron: false)
          RowLabel(title: "Tailscale", subtitle: info.tailscale.state == "running" ? (info.tailscale.tailnet.map { "Signed in on \($0)" } ?? "Running") : nil, value: tailscaleStatus(info), chevron: false)
          RowLabel(title: "Cloudflare", subtitle: info.cloudflareRunning ? nil : "Paste a setup code to use it instead", value: info.cloudflareRunning ? "Connected" : "Not set up", chevron: false)
        }
        if store.isOwner {
          if info.awayOn {
            Button("Turn off") { turningOff = true }.buttonStyle(.pill(.destructive)).disabled(action.busy)
            CardHint("At home, Wisp works on your Wi-Fi without either. Turning this off keeps it that way. Devices and phones that used the away address stop reaching this Wisp until you turn it back on.")
          } else {
            setup(info)
          }
        }
        if store.isOwner { apps }
      } else if failed {
        CardHint("Away from home isn't available yet. Update Wisp on the computer it runs on.")
      } else {
        HStack { ProgressView(); Text("Checking…").foregroundStyle(Palette.muted) }
      }
      if let hint { CardHint(hint); if let hintURL { Button("Open Tailscale") { openURL(hintURL) }.buttonStyle(.pill(.secondary, small: true)) } }
      StatusLine(error: action.error)
    }
    .task { await watch() }
    .confirmCard($turningOff, title: "Turn off away from home?", message: "Devices and phones that used the away address stop reaching this Wisp until you turn it back on.", confirm: "Turn off") {
      if let info { run { self.info = try await store.turnAwayOff(info); hint = "Away from home is off." } }
    }
    .confirmCard(Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), title: "Disconnect \(removing?.name ?? "this app")?", message: "It stops reaching your agents.", confirm: "Disconnect") {
      if let client = removing { action.run { try await store.disconnectMcp(client.id); clients?.removeAll { $0.id == client.id } } }
    }
  }

  private func tailscaleStatus(_ info: ReachInfo) -> String {
    switch info.tailscale.state {
    case "running": return info.tailscale.serving == true ? "On" : "Connected"
    case "missing": return "Not installed"
    case "needs-login": return "Sign in"
    default: return "Off"
    }
  }

  @ViewBuilder private func setup(_ info: ReachInfo) -> some View {
    let signedIn = info.tailscale.state == "running"
    CardLabel("Turn it on")
    SegmentedPicker(options: [("tailscale", "Tailscale (best)"), ("cloudflare", "Cloudflare")], selection: $choice, label: "How", id: "access-how")
    if choice == "tailscale" {
      CardHint(signedIn ? "Already on this \(info.computerName). Nothing to set up." : "Free. Wisp helps you install it, then sign in.")
      tailscaleSteps(info)
      Button("Turn it on") { run { try await turnOnTailscale() } }.buttonStyle(.pill(.primary)).disabled(action.busy).accessibilityIdentifier("access-on")
    } else {
      CardHint("Needs a domain you own. Paste the setup code Cloudflare gives you for a tunnel.")
      CardGroup { FieldRow(title: "Setup code", text: $token, prompt: "Cloudflare setup code", secure: true, id: "access-cloudflare") }
      if let problem = info.cloudflare?.error { StatusLine(error: problem) }
      Button("Turn it on") {
        run {
          let next = try await store.startCloudflare(token: token.trimmed)
          self.info = next; token = ""
          hint = next.awayOn ? "Away from home is on." : "Cloudflare is connecting…"
        }
      }.buttonStyle(.pill(.primary)).disabled(action.busy || token.trimmed.count < 20)
    }
    CardHint("Then anyone on your Wisp can open it from any Wi-Fi or cell data. Only people signed in can see anything.")
  }

  /** the steps Tailscale still needs, in plain words */
  @ViewBuilder private func tailscaleSteps(_ info: ReachInfo) -> some View {
    switch info.tailscale.state {
    case "missing":
      CardGroup {
        RowLabel(title: "Install Tailscale on this \(info.computerName)", chevron: false) { Image(systemName: "1.circle").foregroundStyle(Palette.muted) }
        if let url = info.download.flatMap(URL.init(string:)) { Button { openURL(url) } label: { RowLabel(title: "Install Tailscale") }.buttonStyle(.plain) }
      }
    case "needs-login":
      CardGroup {
        RowLabel(title: "Sign in to Tailscale", chevron: false) { Image(systemName: "2.circle").foregroundStyle(Palette.muted) }
        if let url = info.tailscale.authUrl.flatMap(URL.init(string:)) { Button { openURL(url) } label: { RowLabel(title: "Open the Tailscale sign-in page") }.buttonStyle(.plain) }
      }
    case "stopped", "starting":
      CardGroup { RowLabel(title: "Tailscale is \(info.tailscale.state == "starting" ? "starting" : "off"); turning it on connects it", chevron: false) { Image(systemName: "2.circle").foregroundStyle(Palette.muted) } }
    case "error":
      StatusLine(error: info.tailscale.error ?? "Tailscale couldn't connect.")
    default:
      CardGroup { RowLabel(title: "Tailscale is running", chevron: false) { Image(systemName: "checkmark.circle").foregroundStyle(Palette.green) } }
    }
  }

  @ViewBuilder private var apps: some View {
    let origin = info?.connectorOrigin
    CardLabel("Grok, ChatGPT and Claude")
    CardGroup {
      ToggleRow(title: "Talk to your agents from their apps", isOn: Binding(get: { origin != nil }, set: { on in toggle(on) }), id: "access-apps").disabled(action.busy || info == nil)
      if let origin {
        VStack(alignment: .leading, spacing: 4) {
          Text("Remote address").font(.system(size: 14)).foregroundStyle(Palette.faint)
          Text("\(origin)/mcp").font(.system(size: 14, design: .monospaced)).foregroundStyle(Palette.text).textSelection(.enabled)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 18).padding(.vertical, 12)
        Button { UIPasteboard.general.string = "\(origin)/mcp" } label: { RowLabel(title: "Copy address", chevron: false) }.buttonStyle(.plain)
      }
    }
    if origin != nil { CardHint("In Grok: Connectors, Add custom connector, paste.") }
    if let clients {
      CardLabel("Connected apps")
      CardGroup {
        if clients.isEmpty { RowLabel(title: "No apps connected yet.", chevron: false) }
        ForEach(clients) { client in
          HStack {
            VStack(alignment: .leading, spacing: 2) {
              Text(client.name).font(.system(size: 17)).foregroundStyle(Palette.text)
              if let agent = client.agentName { Text("acts as \(agent)").font(.system(size: 14)).foregroundStyle(Palette.faint) }
            }
            Spacer()
            Button("Disconnect") { removing = client }.buttonStyle(.pill(.secondary, small: true)).disabled(action.busy)
          }.padding(.horizontal, 18).frame(minHeight: 62)
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

  /** the address, Tailscale status and connected apps, kept fresh while this page is open */
  private func watch() async {
    while !Task.isCancelled {
      do { info = try await store.reach(); failed = false } catch { if info == nil { failed = true } }
      if store.isOwner { clients = (try? await store.mcpClients()) ?? clients }
      do { try await Task.sleep(for: .seconds(3)) } catch { return }
    }
  }
}

/** Settings → Away from home: away-from-home status. Devices are on the Computers tab. */
struct DevicesSettingsView: View {
  @Environment(Store.self) private var store
  @State private var info: ReachInfo?

  var body: some View {
    SettingsPage("Away from home", id: "devices-settings") {
      CardGroup {
        if store.isOwner {
          NavigationLink { AccessView() } label: { RowLabel(title: "Away from home", value: info?.summary) }
        } else {
          ValueRow(title: "Away from home", value: info?.summary ?? "—")
        }
      }
    }
    .task { try? await store.refreshNodes(); info = try? await store.reach() }
  }
}
