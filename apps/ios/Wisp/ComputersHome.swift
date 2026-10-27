import SwiftUI

// The Computers tab: one page for everything agents and people use. Each Wisp device is a group with
// its agents' computers nested under it, then the cloud computers, then your paired phones. It holds
// what the old Devices page did (comp-List.dc.html, comp-AddChooser.dc.html).

/** Where a push inside the Computers tab goes. */
enum ComputersRoute: Hashable {
  case computer(String)
  case device(String)
}

// MARK: pills and states

enum PillTone { case online, working, neutral, warn, bad }

/** The small rounded status word: Online, Working, Ready, Offline. */
struct ComputerPill: View {
  var text: String
  var tone: PillTone = .neutral
  var dot = false

  /** the dot keeps the pure status color; the word uses the deeper (light) or lighter (dark) text color */
  private var dotColor: Color {
    switch tone {
    case .online: Palette.statusOnline
    case .working: Palette.statusWorking
    case .neutral: Palette.statusOffline
    case .warn: Palette.statusNeeds
    case .bad: Palette.statusProblem
    }
  }
  private var fg: Color {
    switch tone {
    case .online: Palette.statusOnlineText
    case .working: Palette.statusWorkingText
    case .neutral: Palette.statusOfflineText
    case .warn: Palette.statusNeedsText
    case .bad: Palette.statusProblemText
    }
  }
  private var bg: Color {
    switch tone {
    case .online: Palette.statusOnline.tint16
    case .working: Palette.statusWorking.tint16
    case .neutral: Palette.statusOffline.tint16
    case .warn: Palette.statusNeeds.tint16
    case .bad: Palette.statusProblem.tint16
    }
  }

  var body: some View {
    HStack(spacing: 6) {
      if dot { Circle().fill(dotColor).frame(width: 7, height: 7) }
      Text(text).font(.system(size: 12, weight: .semibold)).lineLimit(1)
    }
    .foregroundStyle(fg)
    .padding(.horizontal, 10)
    .frame(height: 24)
    .background(Capsule().fill(bg))
    .fixedSize()
  }
}

struct ComputerState {
  var label: String
  var tone: PillTone
  var working = false
}

extension Store {
  /** How a computer is doing, in a word or two (the web's computerState). */
  func state(of c: Computer) -> ComputerState {
    // Connectivity first: offline or paused is gray, working is blue, needs help or anyone in control is amber, ready is green.
    if !c.isOnline || c.status == "offline" { return ComputerState(label: "Offline", tone: .neutral) }
    if c.paused == true { return ComputerState(label: "Paused at the device", tone: .neutral) }
    if c.status == "error" { return ComputerState(label: "Problem", tone: .bad) }
    if c.status == "starting" { return ComputerState(label: "Starting", tone: .working) }
    if isWorking(c) { return ComputerState(label: "Working", tone: .working, working: true) }
    if let who = c.controller { return ComputerState(label: who.id == me?.id ? "You're in control" : "In control", tone: .warn) }
    if c.help != nil { return ComputerState(label: "Needs help", tone: .warn) }
    return c.status == "stopped" ? ComputerState(label: "Stopped", tone: .neutral) : ComputerState(label: "Ready", tone: .online)
  }

  func isWorking(_ c: Computer) -> Bool {
    guard let a = c.activity else { return false }
    let recent = Wire.date(a.at).map { Date().timeIntervalSince($0) < 30 } ?? false
    return recent || c.agentIds.contains { agent($0)?.status == .busy }
  }

  /** What the agent on it is doing, or why it needs you. */
  func doing(_ c: Computer) -> String {
    if let help = c.help { return "Needs you: \(help.request)" }
    if isWorking(c), let a = c.activity { return a.text }
    if let at = c.activity.flatMap({ Wire.date($0.at) }) { return "Idle since \(at.formatted(date: .omitted, time: .shortened))" }
    if c.kind == "device" { return "Agents ask before using it" }
    let names = c.agentIds.compactMap { agent($0)?.name }
    return names.isEmpty ? "No agents yet" : names.joined(separator: ", ")
  }
}

/** A computer's status as a pill. */
struct ComputerStatus: View {
  @Environment(Store.self) private var store
  var computer: Computer
  var body: some View {
    let s = store.state(of: computer)
    ComputerPill(text: s.label, tone: s.tone)
  }
}

// MARK: the page

/** Every computer in one place: devices with their agents' computers, cloud computers, phones. */
struct ComputersView: View {
  @Environment(Store.self) private var store
  @Environment(\.openSettings) private var openSettings
  @State private var path: [ComputersRoute] = []
  @State private var chooser = false
  @State private var pending: AddChoice?
  @State private var addingDevice = false
  @State private var giving = false
  @State private var phones = 0
  @State private var laterHelp: Set<String> = []
  @State private var loadError: String?

  private var devices: [AgentNode] { store.nodes }
  private var cloud: [Computer] { store.computers.filter { c in c.kind == "orgo" || !devices.contains { $0.id == c.nodeId } } }
  private func computers(on node: AgentNode) -> [Computer] { store.computers.filter { $0.nodeId == node.id } }
  private var total: Int { devices.count + (cloud.isEmpty ? 0 : cloud.count) }
  private var online: Int { devices.filter(\.online).count + cloud.filter(\.isOnline).count }
  private var asking: Computer? { store.computers.first { $0.help != nil && !laterHelp.contains($0.id) } }

  var body: some View {
    NavigationStack(path: $path) {
      VStack(spacing: 0) {
        TopBar {
          Button { openSettings() } label: { ProfileCircle() }.buttonStyle(.press).accessibilityIdentifier("profile-button")
        } center: {
          VStack(spacing: 1) {
            Text("Computers").font(.system(size: 20, weight: .bold)).foregroundStyle(Palette.text).accessibilityAddTraits(.isHeader)
            if total > 0 { Text("\(online) of \(total) online").font(.system(size: 13)).foregroundStyle(Palette.faint) }
          }
        } trailing: {
          if store.canManage { CircleButton(symbol: "plus", label: "Add", id: "computers-add") { chooser = true } }
        }
        ScrollView {
          StaggeredStack(spacing: 14) {
            if let c = asking { helpBanner(c) }
            if let loadError { Text(loadError).font(.footnote).foregroundStyle(Palette.red).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4) }
            if devices.isEmpty && store.computers.isEmpty && phones == 0 { empty }
            ForEach(devices) { node in deviceGroup(node) }
            if !cloud.isEmpty { cloudGroup }
            if phones > 0 { phonesCard }
          }
          .padding(.horizontal, 18).padding(.top, 10).padding(.bottom, 30)
        }
        .refreshable { await refresh() }
      }
      .background(Palette.ground.ignoresSafeArea())
      .toolbar(.hidden, for: .navigationBar)
      .navigationDestination(for: ComputersRoute.self) { route in
        switch route {
        case .computer(let id): ComputerDetail(computerId: id)
        case .device(let id): DeviceDetail(nodeId: id)
        }
      }
      .sheet(isPresented: $chooser, onDismiss: {
        switch pending {
        case .device: addingDevice = true
        case .give: giving = true
        case nil: break
        }
        pending = nil
      }) { AddChooserSheet { pending = $0; chooser = false } }
      .sheet(isPresented: $addingDevice, onDismiss: { Task { await refresh() } }) { AddDeviceSheet() }
      .sheet(isPresented: $giving) { AddComputerView { path = [.computer($0.id)] } }
    }
    .tint(Palette.text)
    .task { await poll() }
    .task(id: store.route) {
      // a tapped "needs you on its computer" notification, or a link to a device
      guard store.canViewComputers else { return }
      switch store.route {
      case .computer(let id):
        store.route = nil
        if !store.computers.contains(where: { $0.id == id }) { await store.refreshComputers() }
        path = [.computer(id)]
      case .device(let id):
        store.route = nil
        path = id.map { [.device($0)] } ?? []
      default: break
      }
    }
  }

  private func poll() async {
    var backoff = DevicePollingBackoff()
    while !Task.isCancelled {
      do {
        try await store.refreshNodes()
        loadError = nil
        backoff.succeeded()
      } catch {
        if Task.isCancelled { return }
        loadError = error.localizedDescription
        backoff.failed()
      }
      await loadPhones()
      do { try await Task.sleep(for: .seconds(backoff.interval)) } catch { return }
    }
  }

  private func loadPhones() async {
    struct Push: Decodable { var devices: Int }
    if let p: Push = try? await store.fetch({ try await $0.get("/api/me/push") }) { phones = p.devices }
  }

  private func refresh() async {
    do { try await store.refreshNodes(); loadError = nil } catch { loadError = error.localizedDescription }
    await store.refreshComputers()
    await loadPhones()
  }

  private var empty: some View {
    ContentUnavailableView {
      Label("Give your agents a computer", systemImage: "desktopcomputer")
    } description: {
      Text("Add a device running Wisp, then give an agent a computer on it. You can watch them work and take control anytime.")
    } actions: {
      if store.canManage { Button("Add") { chooser = true }.primaryButton() }
    }
    .padding(.top, 60)
  }

  // MARK: groups

  private func deviceGroup(_ node: AgentNode) -> some View {
    let rows = computers(on: node)
    return VStack(spacing: 0) {
      NavigationLink(value: ComputersRoute.device(node.id)) {
        HStack(spacing: 12) {
          GroupIcon(symbol: "desktopcomputer", dim: !node.online)
          VStack(alignment: .leading, spacing: 2) {
            Text(node.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(node.online ? Palette.text : Palette.muted).lineLimit(1)
            Text(subtitle(node)).font(.system(size: 13)).foregroundStyle(Palette.faint).lineLimit(1)
          }
          Spacer(minLength: 6)
          NodePill(node: node)
        }
        .padding(14)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("device-\(node.id)")
      ForEach(rows) { c in
        Rectangle().fill(Palette.separator).frame(height: 1)
        NavigationLink(value: ComputersRoute.computer(c.id)) { ComputerRow(computer: c) }.buttonStyle(.plain)
      }
    }
    .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
    .clipShape(RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
  }

  private func subtitle(_ node: AgentNode) -> String {
    if node.isUpdating { return "Updating Wisp…" }
    if !node.online { return node.lastSeen == nil ? "Waiting to connect · tap for steps" : "Not reachable · tap to bring it back" }
    let n = store.agents.filter { $0.nodeId == node.id }.count
    var parts = [node.capabilities?.osName ?? "Computer"]
    if node.mine != true, let owner = node.ownerName { parts.append("\(owner)'s") }
    parts.append(n == 0 ? "no agents yet" : "runs \(n) agent\(n == 1 ? "" : "s")")
    return parts.joined(separator: " · ")
  }

  private var cloudGroup: some View {
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        GroupIcon(symbol: "cloud")
        VStack(alignment: .leading, spacing: 2) {
          Text(cloud.count == 1 ? "Cloud computer" : "Cloud computers").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text)
          Text("Hosted for you, keeps running when your devices are off").font(.system(size: 13)).foregroundStyle(Palette.faint).lineLimit(1)
        }
        Spacer(minLength: 6)
      }.padding(14)
      ForEach(cloud) { c in
        Rectangle().fill(Palette.separator).frame(height: 1)
        NavigationLink(value: ComputersRoute.computer(c.id)) { ComputerRow(computer: c) }.buttonStyle(.plain)
      }
    }
    .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
    .clipShape(RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
  }

  private var phonesCard: some View {
    HStack(spacing: 12) {
      GroupIcon(symbol: "iphone")
      VStack(alignment: .leading, spacing: 2) {
        Text(phones == 1 ? "Phone" : "Phones").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text)
        Text("\(phones) paired · get\(phones == 1 ? "s" : "") notifications").font(.system(size: 13)).foregroundStyle(Palette.faint)
      }
      Spacer(minLength: 6)
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
    .accessibilityElement(children: .combine)
  }

  /** An agent asked for help on a computer: open it, or ask me later. */
  private func helpBanner(_ c: Computer) -> some View {
    let who = store.agent(c.help?.agentId ?? "")
    return VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 12) {
        AgentAvatar(agent: who, size: 36, showStatus: false)
        VStack(alignment: .leading, spacing: 3) {
          Text("\(who?.name ?? "An agent") needs you on this computer").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text)
          Text(c.help?.request ?? "").font(.system(size: 13)).foregroundStyle(Palette.muted)
        }
      }
      HStack(spacing: 10) {
        Button { path = [.computer(c.id)] } label: { Text("Open computer").frame(maxWidth: .infinity) }.primaryButton().controlSize(.large)
        Button { laterHelp.insert(c.id) } label: { Text("Later").frame(maxWidth: .infinity) }.secondaryButton().controlSize(.large)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).fill(Palette.card))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.statusNeeds.opacity(0.6)))
    .accessibilityIdentifier("computers-help")
  }
}

/** A device's status: Online, Offline, Paused, Updating. */
struct NodePill: View {
  var node: AgentNode
  var body: some View {
    if node.update?.state == "failed" { ComputerPill(text: "Update failed", tone: .bad) }
    else if node.isUpdating { ComputerPill(text: "Updating", tone: .working) }
    else if node.paused == true { ComputerPill(text: "Paused", tone: .warn) }
    else if node.online { ComputerPill(text: "Online", tone: .online, dot: true) }
    else { ComputerPill(text: "Offline", tone: .neutral) }
  }
}

/** The 40pt rounded icon that starts a group. */
struct GroupIcon: View {
  var symbol: String
  var dim = false
  var body: some View {
    Image(systemName: symbol)
      .font(.system(size: 16, weight: .regular))
      .foregroundStyle(dim ? Palette.statusOffline : Palette.computer)
      .frame(width: 40, height: 40)
      .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill((dim ? Palette.statusOffline : Palette.computer).tint16))
      .accessibilityHidden(true)
  }
}

/** One agent computer inside a group: its screen, who works there and on what, and how it's doing. */
struct ComputerRow: View {
  @Environment(Store.self) private var store
  var computer: Computer

  var body: some View {
    let s = store.state(of: computer)
    HStack(spacing: 12) {
      ScreenThumb(computer: computer, radius: 10).frame(width: 72, height: 48)
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
          if let a = computer.agentIds.first.flatMap({ store.agent($0) }) { AgentAvatar(agent: a, size: 20, showStatus: false) }
          else { Image(systemName: computer.kind == "device" ? "lock" : "display").font(.system(size: 13)).foregroundStyle(Palette.computer) }
          Text(computer.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text).lineLimit(1)
        }
        Text(store.doing(computer)).font(.system(size: 13)).foregroundStyle(computer.help != nil ? Palette.statusNeedsText : Palette.muted).lineLimit(1)
      }
      Spacer(minLength: 6)
      ComputerPill(text: s.label, tone: s.tone)
    }
    .padding(.horizontal, 14)
    .frame(minHeight: 70)
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.statusNeeds, lineWidth: 1.5).opacity(computer.help != nil ? 1 : 0))
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("computer-\(computer.id)")
  }
}

// MARK: the Add chooser

enum AddChoice { case device, give }

/** "Add a device or phone" or "Give an agent a computer" (comp-AddChooser). */
struct AddChooserSheet: View {
  @Environment(\.dismiss) private var dismiss
  var onPick: (AddChoice) -> Void

  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: "Add") { dismiss() }
      VStack(spacing: 14) {
        CardGroup {
          Button { onPick(.device) } label: {
            RowLabel(title: "Add a device or phone", subtitle: "A device is a computer running Wisp, or your phone. Scan a QR code or type a join code.") {
              Image(systemName: "qrcode").font(.system(size: 20)).foregroundStyle(Palette.text).frame(width: 30)
            }.padding(.vertical, 8)
          }.buttonStyle(.plain).accessibilityIdentifier("add-device")
          Button { onPick(.give) } label: {
            RowLabel(title: "Give an agent a computer", subtitle: "A virtual computer on one of your devices, your own screen, or a cloud computer.") {
              Image(systemName: "desktopcomputer").font(.system(size: 20)).foregroundStyle(Palette.text).frame(width: 30)
            }.padding(.vertical, 8)
          }.buttonStyle(.plain).accessibilityIdentifier("add-give")
        }
      }
      .padding(.horizontal, 18).padding(.top, 10)
      Spacer(minLength: 0)
    }
    .background(Palette.sheet.ignoresSafeArea())
    .presentationDetents([.height(320)])
    .presentationBackground(Palette.sheet)
    .presentationCornerRadius(Corner.sheet)
    .presentationDragIndicator(.hidden)
  }
}
