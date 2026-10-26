import SwiftUI

/** All settings: the web's list of sections as grouped cards (You, Workspace, Agents, Devices, More). */
struct NativeSettingsView: View {
  @Environment(Store.self) private var store

  private var guest: Bool { store.role == "guest" }

  var body: some View {
    SettingsPage("Settings", id: "settings") {
      CardLabel("You")
      CardGroup {
        NavigationLink { ProfileSettingsView() } label: { RowLabel(title: "Profile") }.accessibilityIdentifier("settings-profile")
        NavigationLink { NotificationSettingsView() } label: { RowLabel(title: "Notifications") }.accessibilityIdentifier("settings-notifications")
        NavigationLink { AppearanceSettingsView() } label: { RowLabel(title: "Appearance") }.accessibilityIdentifier("settings-appearance")
        NavigationLink { PreferencesView() } label: { RowLabel(title: "App behavior") }.accessibilityIdentifier("settings-behavior")
        if store.features.voice && !guest { NavigationLink { VoiceSettingsView() } label: { RowLabel(title: "Voice") }.accessibilityIdentifier("settings-voice") }
        NavigationLink { SecuritySettingsView() } label: { RowLabel(title: "Security") }.accessibilityIdentifier("settings-security")
      }
      if !guest {
        CardLabel("Workspace")
        CardGroup {
          NavigationLink { WorkspaceSettingsView() } label: { RowLabel(title: "Workspace") }.accessibilityIdentifier("settings-workspace")
          if store.features.invite || store.members.count > 1 {
            NavigationLink { PeopleSettingsView() } label: { RowLabel(title: "People") }.accessibilityIdentifier("settings-people")
          }
          NavigationLink { UsageView() } label: { RowLabel(title: "Usage") }.accessibilityIdentifier("settings-usage")
          NavigationLink { FeaturesView() } label: { RowLabel(title: "Mods") }.accessibilityIdentifier("settings-mods")
        }
      }
      if store.canManage {
        CardLabel("Agents")
        CardGroup {
          NavigationLink { AgentPolicyView() } label: { RowLabel(title: "Agents policy") }.accessibilityIdentifier("settings-agents")
          NavigationLink { AgentDefaultsView() } label: { RowLabel(title: "Agent defaults") }.accessibilityIdentifier("settings-agent-defaults")
          NavigationLink { ConnectionsSettingsView() } label: { RowLabel(title: "Connections") }.accessibilityIdentifier("settings-connections")
          NavigationLink { MemoryView() } label: { RowLabel(title: "Memory") }.accessibilityIdentifier("settings-memory")
          NavigationLink { MemoryStorageView() } label: { RowLabel(title: "Memory storage") }.accessibilityIdentifier("settings-memory-storage")
          NavigationLink { HarnessesView() } label: { RowLabel(title: "AI tool settings") }.accessibilityIdentifier("settings-harnesses")
          NavigationLink { LoginsView() } label: { RowLabel(title: "Logins") }.accessibilityIdentifier("settings-logins")
          NavigationLink { AgentRuntimesView() } label: { RowLabel(title: "Agent runtimes") }.accessibilityIdentifier("settings-runtimes")
        }
      }
      if !guest {
        CardLabel("Devices")
        CardGroup {
          NavigationLink { ComputersView() } label: { RowLabel(title: "Computers and devices") }.accessibilityIdentifier("settings-computers")
          NavigationLink { DevicesSettingsView() } label: { RowLabel(title: "Away from home") }.accessibilityIdentifier("settings-devices")
          if store.canManage { NavigationLink { ComputerSettingsView() } label: { RowLabel(title: "Agent computers") }.accessibilityIdentifier("settings-agent-computers") }
          if store.isOwner { NavigationLink { AccessView() } label: { RowLabel(title: "Access") }.accessibilityIdentifier("settings-access") }
          NavigationLink { MobileSettingsView() } label: { RowLabel(title: "Mobile") }.accessibilityIdentifier("settings-mobile")
          NavigationLink { InboxView() } label: { RowLabel(title: "Approvals") }.accessibilityIdentifier("settings-approvals")
        }
      }
      CardLabel("More")
      CardGroup {
        if !guest { NavigationLink { DataExportView() } label: { RowLabel(title: "Data and export") }.accessibilityIdentifier("settings-data") }
        NavigationLink { UpdatesView() } label: { RowLabel(title: "About") }.accessibilityIdentifier("settings-about")
        NavigationLink { HelpView() } label: { RowLabel(title: "Help") }.accessibilityIdentifier("settings-help")
      }
      CardHint("Wisp is free and open source (Apache-2.0).")
    }
  }
}

/** Settings → App behavior (set-AppBehavior.dc.html): how sending, the clock and replies work, on every device. */
struct PreferencesView: View {
  @Environment(Store.self) private var store
  @State private var action = FormAction()

  private var send: Binding<String> { pref("sendWith", store.prefs?.sendWith ?? "enter") }
  private var clock: Binding<String> { pref("clock", store.prefs?.clock ?? "auto") }
  private var tools: Binding<String> { pref("toolCalls", store.prefs?.toolCalls ?? "collapsed") }

  var body: some View {
    SettingsPage("App behavior", id: "behavior") {
      CardLabel("Sending a message")
      CardGroup {
        OptionRow(title: "Enter sends", subtitle: "Shift-Enter adds a new line", selected: send.wrappedValue == "enter", id: "send-enter") { send.wrappedValue = "enter" }
        OptionRow(title: "Cmd-Enter sends", subtitle: "Enter adds a new line", selected: send.wrappedValue == "mod-enter", id: "send-mod") { send.wrappedValue = "mod-enter" }
      }
      CardLabel("Clock")
      SegmentedPicker(options: [("auto", "Automatic"), ("12h", "12-hour"), ("24h", "24-hour")], selection: clock, label: "Clock", id: "clock")
      CardLabel("Replies")
      CardGroup {
        ToggleRow(title: "Show the tools agents used", subtitle: "Lines like “Searched the web, read 6 pages” under a reply",
                  isOn: Binding(get: { tools.wrappedValue != "hidden" }, set: { tools.wrappedValue = $0 ? "collapsed" : "hidden" }), id: "show-tools")
        MoreOptionsRow {
          VStack(alignment: .leading, spacing: 10) {
            Text("Tools agents used").font(.system(size: 17)).foregroundStyle(Palette.text)
            SegmentedPicker(options: [("collapsed", "Collapsed"), ("expanded", "Open"), ("hidden", "Hidden")], selection: tools, label: "Tools agents used", id: "tools")
          }.padding(.horizontal, 18).padding(.vertical, 12)
        }
      }
      CardHint("These preferences also apply when you use Wisp on the web. The iPhone uses its native keyboard.")
      StatusLine(error: action.error)
    }
  }

  private func pref(_ key: String, _ value: String) -> Binding<String> {
    Binding(get: { value }, set: { new in action.run { try await store.savePrefs([key: AnyEncodable(new)]) } })
  }
}

/** Settings → Workspace (set-Workspace.dc.html), with the way to delete the organization. */
struct WorkspaceSettingsView: View {
  @Environment(Store.self) private var store
  @State private var name = ""
  @State private var saved = false
  @State private var action = FormAction()

  private var current: OrgSummary? { store.orgList.first(where: { store.isCurrent($0) }) }
  private var roleName: String { store.role == "owner" ? "Owner" : store.role == "guest" ? "Guest" : "Member" }

  var body: some View {
    SettingsPage("Workspace", subtitle: "The organization everyone here shares.", id: "workspace") {
      if !store.isOwner { OwnersOnlyNote() }
      CardGroup {
        FieldRow(title: "Organization name", text: $name, id: "workspace-name").disabled(!store.isOwner)
        ValueRow(title: "Hub address", value: store.api?.base.host() ?? store.api?.base.absoluteString ?? "")
        ValueRow(title: "Your role", value: roleName)
      }
      CardGroup {
        ValueRow(title: "Live updates", value: store.connected ? "Connected" : "Reconnecting")
        ValueRow(title: "People and agents", value: "\(store.members.count) · \(store.agents.count)")
      }
      if store.canManage {
        AskAgentCard(placeholder: "Ask {name} to change anything")
        RecentChangesCard()
      }
      StatusLine(error: action.error, saved: saved ? "Saved." : nil)
      if store.isOwner {
        Button("Save changes") { action.run { try await store.renameWorkspace(name.trimmed); saved = true } }
          .buttonStyle(.pill(.primary)).disabled(action.busy || name.trimmed.isEmpty || name.count > 60 || name.trimmed == store.workspace?.name)
          .accessibilityIdentifier("workspace-save")
        deleteSection
      }
    }
    .onAppear { name = store.workspace?.name ?? "" }
    .onChange(of: name) { saved = false }
    .task { await store.refreshOrgs() }
  }

  @ViewBuilder private var deleteSection: some View {
    if let org = current {
      CardLabel("Delete organization")
      CardHint("Removes its agents, teams, messages, devices, computers and memory for everyone in it. This can't be undone.")
      if org.canDelete == true {
        NavigationLink { DeleteOrgView(org: org) } label: { Text("Delete organization").frame(maxWidth: .infinity) }
          .buttonStyle(.pill(.destructive)).accessibilityIdentifier("workspace-delete")
      } else {
        CardHint(store.orgList.count > 1 ? "This is the first organization on this Wisp, so it can't be deleted." : "Your only organization can't be deleted. Make or join another one first.")
      }
    }
  }
}

/** Type the organization's name to delete it (set-DeleteOrg.dc.html). */
struct DeleteOrgView: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var org: OrgSummary
  @State private var typed = ""
  @State private var action = FormAction()

  var body: some View {
    SettingsPage("Delete \(org.name)?", id: "delete-org") {
      Text("This removes its agents, teams, messages, devices, computers and memory for everyone in it. It can't be undone.")
        .font(.system(size: 15)).foregroundStyle(Palette.muted).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 6)
      CardGroup { FieldRow(title: "Type the name", text: $typed, prompt: org.name, id: "delete-org-name") }
      CardHint("Type \(org.name) to confirm.")
      StatusLine(error: action.error)
      Button("Delete organization") { action.run { try await store.deleteOrg(org, typed: typed.trimmed) } }
        .buttonStyle(.pill(.danger)).disabled(action.busy || typed.trimmed != org.name).accessibilityIdentifier("delete-org-confirm")
      Button("Cancel") { dismiss() }.buttonStyle(.pill(.ghost))
    }
  }
}

/** Settings → Mobile (set-Mobile.dc.html): pair another phone with this Wisp by scanning a QR code, then matching a code. */
struct MobileSettingsView: View {
  @Environment(Store.self) private var store
  @State private var started: Started?
  @State private var pairing: PairState?
  @State private var qr: UIImage?
  @State private var action = FormAction()
  @State private var gone = false

  struct PairState: Decodable { var id: String; var state: String; var code: String?; var deviceName: String?; var platform: String? }
  struct Started: Decodable { var id: String; var state: String; var code: String?; var deviceName: String?; var platform: String?; var addresses: [String]?; var link: String }

  private var phone: String { pairing?.deviceName ?? (pairing?.platform == "android" ? "your Android phone" : "your iPhone") }

  var body: some View {
    SettingsPage("Mobile", subtitle: "Point your camera here to join your Wisp.", id: "mobile") {
      VStack(spacing: 14) {
        switch pairing?.state {
        case "waiting":
          if let qr { Image(uiImage: qr).interpolation(.none).resizable().scaledToFit().frame(width: 220, height: 220).padding(10).background(Color.white, in: RoundedRectangle(cornerRadius: 18)).accessibilityLabel("QR code to scan with the Wisp app on your phone") }
          Text("Point your camera here. It gets the app and joins.").font(.system(size: 15)).foregroundStyle(Palette.text).multilineTextAlignment(.center)
          Text("The code expires in 5 minutes.").font(.system(size: 13)).foregroundStyle(Palette.faint)
          if let hint = reachHint { Text(hint).font(.system(size: 13)).foregroundStyle(Palette.faint).multilineTextAlignment(.center) }
        case "claimed":
          Text("Code on \(phone)").font(.system(size: 13)).foregroundStyle(Palette.faint)
          Text(pairing?.code ?? "").font(.system(size: 44, weight: .semibold, design: .monospaced)).foregroundStyle(Palette.text).tracking(6)
            .accessibilityLabel((pairing?.code ?? "").map(String.init).joined(separator: " "))
          Text("Does \(phone) show the same six digits?").font(.system(size: 15)).foregroundStyle(Palette.text)
        case "approved":
          Image(systemName: "checkmark.circle").font(.system(size: 44)).foregroundStyle(Palette.green)
          Text("Paired. \(phone) is signed in.").font(.system(size: 15)).foregroundStyle(Palette.text)
        case "expired", "rejected":
          Text(pairing?.state == "expired" ? "The code expired." : "Pairing was cancelled.").font(.system(size: 15)).foregroundStyle(Palette.muted)
        default:
          if action.busy { ProgressView() } else if !gone { Text("Start pairing to show a QR code for your phone.").font(.system(size: 15)).foregroundStyle(Palette.muted) }
        }
      }
      .frame(maxWidth: .infinity).padding(20).background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
      StatusLine(error: action.error)
      switch pairing?.state {
      case "claimed":
        Button("Yes, pair it") { confirm() }.buttonStyle(.pill(.primary)).disabled(action.busy)
        Button("No, cancel") { cancel() }.buttonStyle(.pill(.ghost))
        CardHint("If the digits don't match on your phone, cancel and start again.")
      case "waiting":
        Button("Make a new code") { start() }.buttonStyle(.pill(.secondary)).disabled(action.busy)
      case "approved":
        Button("Pair another phone") { start() }.buttonStyle(.pill(.secondary)).disabled(action.busy)
      default:
        Button(pairing == nil ? "Start pairing" : "Start again") { start() }.buttonStyle(.pill(.primary)).disabled(action.busy).accessibilityIdentifier("mobile-start")
      }
    }
    .onAppear { start() }
    .onDisappear { gone = true; endPairing() }
    .task(id: pairing?.id) { await follow() }
  }

  private var reachHint: String? {
    guard let addresses = started?.addresses else { return nil }
    if addresses.isEmpty { return "Connect this computer to Wi-Fi and start again." }
    let local = addresses.allSatisfy { $0.range(of: #"^http://(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.)"#, options: .regularExpression) != nil }
    return local ? "Your phone needs to be on the same Wi-Fi as this device, or signed in to Tailscale." : "Your phone can reach this Wisp from anywhere."
  }

  private func start() {
    endPairing()
    pairing = nil; qr = nil
    action.run {
      let s: Started = try await store.connection().post("/api/pair", ["origin": store.api?.base.absoluteString ?? ""])
      started = s
      pairing = PairState(id: s.id, state: s.state, code: s.code, deviceName: s.deviceName, platform: s.platform)
      qr = QRImage.make(s.link)
    }
  }

  private func endPairing() {
    guard let id = pairing?.id, pairing?.state == "waiting" || pairing?.state == "claimed" else { return }
    let api = try? store.connection()
    Task { _ = try? await api?.raw("POST", "/api/pair/\(id)/cancel", body: Empty()) }
  }

  private func confirm() {
    guard let id = pairing?.id else { return }
    action.run { pairing = try await store.connection().post("/api/pair/\(id)/confirm", Empty()) }
  }

  private func cancel() {
    guard let id = pairing?.id else { return }
    action.run { _ = try await store.connection().raw("POST", "/api/pair/\(id)/cancel", body: Empty()); pairing?.state = "rejected" }
  }

  /** follow the pairing while a phone might scan it or the codes are being checked */
  private func follow() async {
    while !Task.isCancelled, let id = pairing?.id, pairing?.state == "waiting" || pairing?.state == "claimed" {
      do { try await Task.sleep(for: .seconds(1.5)) } catch { return }
      if let next: PairState = try? await store.connection().get("/api/pair/\(id)"), next.id == pairing?.id { pairing = next }
      else if pairing?.state == "waiting" { pairing?.state = "expired" }
    }
  }
}

/** A QR code as an image. */
enum QRImage {
  static func make(_ text: String) -> UIImage? {
    guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
    filter.setValue(Data(text.utf8), forKey: "inputMessage")
    filter.setValue("M", forKey: "inputCorrectionLevel")
    guard let image = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
          let cg = CIContext().createCGImage(image, from: image.extent) else { return nil }
    return UIImage(cgImage: cg)
  }
}
