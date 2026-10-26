import SwiftUI
import CoreImage.CIFilterBuiltins

// "Add a device or phone": a phone scans a QR code and checks a code; another computer picks Join my
// Wisp and pastes a link, or runs one command (comp-AddDevice.dc.html, comp-AddDeviceComputer.dc.html).

struct DevicePollingBackoff {
  private(set) var interval = 5
  mutating func succeeded() { interval = 5 }
  mutating func failed() { interval = min(interval * 2, 30) }
}

struct PairInfo: Decodable {
  var id: String
  var state: String // waiting | claimed | approved | rejected | expired
  var code: String?
  var deviceName: String?
}
private struct PairStarted: Decodable { var id: String; var state: String; var code: String?; var deviceName: String?; var link: String; var addresses: [String]? }

enum QRCode {
  static func image(_ text: String) -> UIImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"
    guard let out = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)),
          let cg = CIContext().createCGImage(out, from: out.extent) else { return nil }
    return UIImage(cgImage: cg)
  }
}

struct AddDeviceSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var tab = 0

  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: "Add a device or phone") { dismiss() }
      Picker("What to add", selection: $tab) { Text("Phone").tag(0); Text("Computer").tag(1) }
        .pickerStyle(.segmented).padding(.horizontal, 18).padding(.bottom, 10)
      ScrollView {
        VStack(spacing: 14) {
          if tab == 0 { PhonePairing() } else { ComputerJoin() }
        }.padding(.horizontal, 18).padding(.top, 4).padding(.bottom, 20)
      }
      Button { dismiss() } label: { Text("Done").frame(maxWidth: .infinity) }.primaryButton()
        .padding(.horizontal, 18).padding(.bottom, 14).accessibilityIdentifier("add-device-done")
    }
    .background(Palette.sheet.ignoresSafeArea())
    .presentationBackground(Palette.sheet)
    .presentationCornerRadius(Corner.sheet)
    .presentationDragIndicator(.hidden)
  }
}

/** A QR code for the Wisp app on a phone, then the code both screens show. */
private struct PhonePairing: View {
  @Environment(Store.self) private var store
  @State private var link: String?
  @State private var pairing: PairInfo?
  @State private var qr: UIImage?
  @State private var action = FormAction()
  @State private var copied = false

  var body: some View {
    VStack(spacing: 16) {
      if let qr {
        Image(uiImage: qr).interpolation(.none).resizable().scaledToFit()
          .frame(width: 210, height: 210).padding(12)
          .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Color.white))
          .accessibilityLabel("QR code to scan with the Wisp app on your phone")
      } else if action.busy { ProgressView().frame(height: 210) }
      switch pairing?.state {
      case "claimed", "approved":
        VStack(spacing: 8) {
          Text(pairing?.state == "approved" ? "Phone added" : "Check the code").font(.system(size: 17, weight: .semibold)).foregroundStyle(Palette.text)
          if let code = pairing?.code { Text(code).font(.system(size: 36, weight: .semibold, design: .monospaced)).foregroundStyle(Palette.text).tracking(4).accessibilityIdentifier("pair-code") }
          if pairing?.state == "claimed" {
            Text("Make sure these digits match on your phone, then confirm.").font(.system(size: 14)).foregroundStyle(Palette.faint).multilineTextAlignment(.center)
            HStack(spacing: 10) {
              Button(role: .destructive) { cancel() } label: { Text("Not mine").frame(maxWidth: .infinity) }.secondaryButton().controlSize(.large)
              Button { confirm() } label: { Text("It matches").frame(maxWidth: .infinity) }.primaryButton().controlSize(.large)
            }.disabled(action.busy)
          }
        }
        .frame(maxWidth: .infinity).padding(16).background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
      case "expired", "rejected":
        Text(pairing?.state == "expired" ? "The code expired." : "Pairing was cancelled.").font(.system(size: 14)).foregroundStyle(Palette.faint)
        Button { start() } label: { Text("Start again").frame(maxWidth: .infinity) }.secondaryButton().controlSize(.large)
      default:
        Text("Open Wisp on your phone, tap Scan QR code and point it here.").font(.system(size: 15)).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
      }
      if let link, pairing?.state == "waiting" {
        Button { UIPasteboard.general.string = link; copied = true; Task { try? await Task.sleep(for: .seconds(1.5)); copied = false } } label: {
          Label(copied ? "Copied" : "Copy link", systemImage: copied ? "checkmark" : "doc.on.doc").frame(maxWidth: .infinity)
        }.secondaryButton().controlSize(.large)
        Text("These only work on this Wi-Fi unless Away from home is on.").font(.system(size: 13)).foregroundStyle(Palette.faint).multilineTextAlignment(.center)
      }
      InlineError(error: action.error)
    }
    .task { start() }
    .task(id: pairing?.id) { await follow() }
    .onDisappear {
      guard let id = pairing?.id, pairing?.state == "waiting" || pairing?.state == "claimed" else { return }
      Task { let _: Empty? = try? await store.fetch { try await $0.post("/api/pair/\(id)/cancel", Empty()) } }
    }
  }

  private func start() {
    action.run {
      let origin = store.api?.base.absoluteString ?? ""
      let s: PairStarted = try await store.fetch { try await $0.post("/api/pair", ["origin": origin]) }
      link = s.link
      pairing = PairInfo(id: s.id, state: s.state, code: s.code, deviceName: s.deviceName)
      qr = QRCode.image(s.link)
    }
  }

  /** Follow the pairing while a phone might scan it or the codes are being checked. */
  private func follow() async {
    guard let id = pairing?.id else { return }
    while !Task.isCancelled, pairing?.state == "waiting" || pairing?.state == "claimed" {
      do { try await Task.sleep(for: .seconds(1.5)) } catch { return }
      do { pairing = try await store.fetch { try await $0.get("/api/pair/\(id)") } }
      catch { if !Task.isCancelled { pairing?.state = "expired" } }
    }
  }

  private func confirm() {
    guard let id = pairing?.id else { return }
    action.run { pairing = try await store.fetch { try await $0.post("/api/pair/\(id)/confirm", Empty()) } }
  }

  private func cancel() {
    guard let id = pairing?.id else { return }
    action.run {
      let _: Empty = try await store.fetch { try await $0.post("/api/pair/\(id)/cancel", Empty()) }
      pairing?.state = "rejected"
    }
  }
}

/** Another computer: install Wisp, pick Join my Wisp, paste the link (or run one command). */
private struct ComputerJoin: View {
  @Environment(Store.self) private var store
  @State private var invite: JoinInvite?
  @State private var joinAction = FormAction()
  @State private var copied = false
  @State private var more = false
  @State private var name = ""
  @State private var token: String?
  @State private var tokenAction = FormAction()
  private var expired: Bool { invite.flatMap { Wire.date($0.expiresAt) }.map { $0 <= Date() } ?? false }

  var body: some View {
    VStack(spacing: 14) {
      CardGroup {
        step(1, "Install Wisp on the other computer")
        step(2, "Pick Join my Wisp")
        step(3, "Paste this link or type the code")
      }
      if store.isOwner {
        VStack(alignment: .leading, spacing: 8) {
          CardCaption("Join link")
          VStack(alignment: .leading, spacing: 10) {
            if let invite, !expired {
              Text(invite.url).font(.system(size: 14, design: .monospaced)).foregroundStyle(Palette.text).textSelection(.enabled).lineLimit(3)
              if let date = Wire.date(invite.expiresAt) { Text("Works once, until \(date, format: .dateTime.month().day().hour().minute()).").font(.system(size: 13)).foregroundStyle(Palette.faint) }
              HStack(spacing: 10) {
                Button { UIPasteboard.general.string = invite.url; copied = true; Task { try? await Task.sleep(for: .seconds(1.5)); copied = false } } label: {
                  Label(copied ? "Copied" : "Copy link", systemImage: copied ? "checkmark" : "doc.on.doc").frame(maxWidth: .infinity)
                }.primaryButton().controlSize(.large)
                ShareLink(item: invite.url) { Image(systemName: "square.and.arrow.up") }.secondaryButton().controlSize(.large)
              }
              if let url = URL(string: invite.url), url.scheme != "https" { Text("This link only works on the same Wi-Fi. To add a computer somewhere else, turn on Away from home in Settings, then make a new link.").font(.system(size: 13)).foregroundStyle(Palette.faint) }
            }
            if joinAction.busy { HStack { ProgressView(); Text("Making a join link…").foregroundStyle(Palette.muted) } }
            if !joinAction.busy && (invite == nil || expired) { Button(expired ? "Make a new link" : "Try again", action: make).secondaryButton().controlSize(.large) }
            InlineError(error: joinAction.error)
          }
          .padding(14).frame(maxWidth: .infinity, alignment: .leading)
          .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
        }
      } else {
        Text("Ask your Wisp's owner for a join link.").font(.system(size: 14)).foregroundStyle(Palette.faint)
      }
      if store.canManage { command }
    }
    .task { if store.isOwner && invite == nil { make() } }
  }

  private func step(_ n: Int, _ text: String) -> some View {
    HStack(spacing: 12) {
      Text("\(n)").font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.muted)
        .frame(width: 28, height: 28).background(Circle().fill(Palette.control)).overlay(Circle().strokeBorder(Palette.hairline))
      Text(text).font(.system(size: 16)).foregroundStyle(Palette.text)
      Spacer(minLength: 0)
    }.padding(.horizontal, 18).frame(minHeight: 54)
  }

  private func make() { joinAction.run { invite = try await store.makeJoinInvite() } }

  /** The other way in: one command that installs Wisp and connects it with a key. */
  @ViewBuilder private var command: some View {
    DisclosureGroup(isExpanded: $more) {
      VStack(alignment: .leading, spacing: 10) {
        if let token, let hub = store.api?.base.absoluteString {
          Text("On \(name), run this once. It installs Wisp if it isn't there yet and keeps the device connected.").font(.system(size: 14)).foregroundStyle(Palette.muted)
          ForEach(Self.commands(hub: hub, token: token, name: name), id: \.0) { title, command in
            VStack(alignment: .leading, spacing: 6) {
              Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.faint)
              Text(command).font(.system(size: 12, design: .monospaced)).foregroundStyle(Palette.text).textSelection(.enabled)
              ShareLink("Share instructions", item: command).font(.system(size: 14))
            }
          }
        } else {
          TextField("Device name", text: $name)
            .padding(.horizontal, 14).frame(height: 46).background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Palette.field))
          Button { tokenAction.run { token = try await store.addDevice(name.trimmed) } } label: { Text("Add a device").frame(maxWidth: .infinity) }
            .secondaryButton().controlSize(.large).disabled(tokenAction.busy || name.trimmed.isEmpty || name.count > 80)
        }
        InlineError(error: tokenAction.error)
      }.padding(.top, 10)
    } label: {
      Text("Set it up with a command instead").font(.system(size: 15)).foregroundStyle(Palette.muted)
    }
    .tint(Palette.muted)
    .padding(.horizontal, 4)
    .accessibilityIdentifier("add-device-command")
  }

  static func commands(hub: String, token: String, name: String) -> [(String, String)] { ComputerJoinCommands.make(hub: hub, token: token, name: name) }
}

/** The commands that install Wisp on another computer and connect it with a key. */
enum ComputerJoinCommands {
  static func make(hub: String, token: String, name: String) -> [(String, String)] {
    let origin = hub.hasSuffix("/") ? String(hub.dropLast()) : hub
    let shName = "'" + name.replacingOccurrences(of: "'", with: "'\\''") + "'"
    let psName = "'" + name.replacingOccurrences(of: "'", with: "''") + "'"
    return [("Mac / Linux", "curl -fsSL \(origin)/install.sh | bash -s -- --hub \(origin) --token \(token) --name \(shName)"), ("Windows", "& ([scriptblock]::Create((irm \(origin)/install.ps1))) -Hub \(origin) -Token \(token) -Name \(psName)"), ("Already installed", "wisp node start --hub \(origin) --token \(token) --name \(shName)")]
  }
}
