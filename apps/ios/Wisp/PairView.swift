import SwiftUI
import VisionKit

/** Signed out: connect to Wisp on your computer by scanning the QR code in Settings → Mobile (or pasting its link). */
struct PairView: View {
  @Environment(Store.self) private var store
  @State private var step: Step = .start
  @State private var scanning = false
  @State private var pasting = false
  @State private var pasted = ""
  @State private var last: PairLink?
  @State private var work: Task<Void, Never>?

  enum Step: Equatable {
    case start
    case connecting
    case code(String, workspace: String?)
    /** the computer said no, or the code ran out */
    case denied(String)
    /** couldn't reach the computer, or the code wasn't a Wisp one */
    case failed(String, unreachable: Bool)
  }

  var body: some View {
    Group {
      switch step {
      case .start: start
      case .connecting: connecting
      case .code(let code, let workspace): check(code, workspace: workspace)
      case .denied(let message): denied(message)
      case .failed(let message, let unreachable): failed(message, unreachable: unreachable)
      }
    }
    .sheet(isPresented: $scanning) {
      QRScanner(found: { text in
        scanning = false
        use(text)
      }, failed: { message in
        scanning = false
        step = .failed(message, unreachable: false)
      })
      .ignoresSafeArea()
      .overlay(alignment: .topLeading) {
        CircleButton(symbol: "xmark", label: "Close") { scanning = false }.padding()
      }
    }
    .sheet(isPresented: $pasting) { pasteSheet }
    // a code scanned with the Camera app opens Wisp with the link
    .onChange(of: store.pendingPair, initial: true) { _, link in
      guard let link else { return }
      store.pendingPair = nil
      pair(link)
    }
    .onDisappear { work?.cancel() }
  }

  // MARK: the screens

  private var start: some View {
    AuthPage {
      VStack(spacing: 26) {
        AuthHero(title: "Connect to Wisp", subtitle: "Point your camera at the code on your computer.", ghost: false)
        if let message = store.sessionMessage {
          Text(message).font(.callout).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
        }
        scannerFrame
        DisclosureGroup {
          VStack(alignment: .leading, spacing: 16) {
            StepRow(n: 1, title: "Open Wisp on your computer", text: "Go to Settings → Mobile and click Start pairing.")
            StepRow(n: 2, title: "Scan the QR code", text: "Your phone needs to be on the same Wi-Fi, unless your Wisp is set up to be reached from anywhere.")
            StepRow(n: 3, title: "Check the code", text: "Confirm on your computer that both show the same six digits.")
          }
          .padding(.top, 12)
        } label: {
          Text("Where do I find the code?").font(.system(size: 15, weight: .medium)).foregroundStyle(Palette.muted)
        }
        .tint(Palette.muted)
        if !QRScanner.available {
          Text("This device can't scan codes. On your computer, click **Copy pairing link** and paste it here.")
            .font(.footnote)
            .foregroundStyle(Palette.muted)
            .multilineTextAlignment(.center)
        }
        Text("Don't have Wisp on a computer yet? Get it free at github.com/\(WispRepo.github).")
          .font(.footnote)
          .foregroundStyle(Palette.faint)
          .multilineTextAlignment(.center)
          .padding(.bottom, 120)
      }
    } bottom: {
      AuthButton(title: "Scan QR code", symbol: "qrcode.viewfinder", id: "pair-scan") { scanning = true }
        .disabled(!QRScanner.available)
      AuthButton(title: "Paste a pairing link", symbol: "doc.on.clipboard", primary: false, id: "pair-paste") { pasting = true }
    }
  }

  /** The viewfinder: four corners around a code. */
  private var scannerFrame: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 36, style: .continuous).fill(Color(light: 0xE6E6EC, dark: 0x0C0C0E))
      RoundedRectangle(cornerRadius: 36, style: .continuous).strokeBorder(Palette.hairline)
      Image(systemName: "qrcode").font(.system(size: 92, weight: .ultraLight)).foregroundStyle(Palette.faint.opacity(0.6))
      ForEach(0..<4, id: \.self) { i in
        ScannerCorner()
          .stroke(Palette.text, style: StrokeStyle(lineWidth: 4, lineCap: .round))
          .frame(width: 44, height: 44)
          .rotationEffect(.degrees(Double(i) * 90))
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: [.topLeading, .topTrailing, .bottomTrailing, .bottomLeading][i])
          .padding(22)
      }
    }
    .frame(width: 268, height: 268)
    .accessibilityHidden(true)
  }

  private var connecting: some View {
    AuthPage(back: ("xmark", "Cancel", cancel)) {
      VStack(spacing: 22) {
        AuthHero(title: "Finding your computer", subtitle: "Looking on this Wi-Fi. Wisp needs to be running on it.")
        ProgressView().controlSize(.large)
      }
      .padding(.top, 44)
    } bottom: {
      AuthButton(title: "Cancel", primary: false, action: cancel)
    }
  }

  private func check(_ code: String, workspace: String?) -> some View {
    AuthPage(back: ("xmark", "Cancel", cancel)) {
      VStack(spacing: 18) {
        AuthHero(title: "Check the code", subtitle: "Your computer should show this same code. If it does, click Yes, pair it there.")
        CodeCard(code: code).padding(.top, 6)
        WaitingLine(text: "Waiting for you to confirm in \(workspace ?? "Wisp") on your computer…")
      }
      .padding(.top, 44)
    } bottom: {
      AuthButton(title: "That isn't the code", primary: false, id: "pair-wrong-code", action: cancel)
    }
  }

  private func denied(_ message: String) -> some View {
    AuthPage {
      AuthHero(title: "Not approved", subtitle: message)
        .padding(.top, 70)
    } bottom: {
      // a code the computer turned down is used up: ask for a new one
      AuthButton(title: "Try again", id: "pair-retry", action: cancel)
      AuthLinkButton(title: "Use a different link") {
        cancel()
        pasting = true
      }
    }
  }

  private func failed(_ message: String, unreachable: Bool) -> some View {
    AuthPage {
      AuthHero(title: unreachable ? "Can't reach your Wisp" : "That didn't work", subtitle: message)
        .padding(.top, 70)
    } bottom: {
      AuthButton(title: "Try again", id: "pair-retry", action: retry)
      AuthLinkButton(title: "Scan a different code", action: cancel)
    }
  }

  private var pasteSheet: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        CircleButton(symbol: "xmark", label: "Close") { pasting = false }
        Spacer()
      }
      Text("Paste a pairing link").font(.system(size: 28, weight: .bold)).foregroundStyle(Palette.text).padding(.top, 18)
      Text("In Wisp on your computer: Settings → Mobile → Start pairing → Copy pairing link. Then paste it here.")
        .font(.system(size: 16)).foregroundStyle(Palette.muted).lineSpacing(3).padding(.top, 8)
      VStack(alignment: .leading, spacing: 7) {
        Text("Pairing link").font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.muted).padding(.leading, 6)
        TextField(text: $pasted, prompt: Text(verbatim: "wisp://pair?…")) { Text("Pairing link") }
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .keyboardType(.URL)
          .font(.system(size: 17))
          .padding(.horizontal, 18)
          .frame(height: 56)
          .background(Palette.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
          .accessibilityIdentifier("pair-link-field")
      }
      .padding(.top, 22)
      AuthButton(title: "Paste from clipboard", symbol: "doc.on.clipboard", primary: false) {
        if let text = UIPasteboard.general.string { pasted = text }
      }
      .padding(.top, 14)
      Spacer(minLength: 16)
      AuthButton(title: "Connect", id: "pair-connect") {
        let text = pasted
        pasted = ""
        pasting = false
        use(text)
      }
      .disabled(pasted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
    .padding(.horizontal, 22)
    .padding(.top, 18)
    .padding(.bottom, 18)
    .background(Palette.sheet.ignoresSafeArea())
    .presentationDetents([.large])
    .presentationCornerRadius(Corner.sheet)
  }

  // MARK: pairing

  private func use(_ text: String) {
    guard let link = PairLink(text) else {
      step = .failed("That isn't a Wisp pairing code. Scan the code in Wisp → Settings → Mobile.", unreachable: false)
      return
    }
    pair(link)
  }

  private func pair(_ link: PairLink) {
    work?.cancel()
    last = link
    step = .connecting
    work = Task {
      do {
        guard let hub = await Pairing.reachable(link.addresses) else {
          throw Pairing.Failure(message: "Check that your computer is on and Wisp is running, and that this phone is on the same Wi-Fi. If you're away from home, Away from home needs to be on.", unreachable: true)
        }
        let claimed = try await Pairing.claim(link, at: hub)
        step = .code(claimed.code, workspace: claimed.workspaceName)
        let token = try await Pairing.waitForConfirm(link, at: hub)
        try await store.adopt(hub: hub, token: token)
      } catch is CancellationError {
      } catch let failure as Pairing.Failure {
        step = failure.denied ? .denied(failure.message) : .failed(failure.message, unreachable: failure.unreachable)
      } catch {
        step = .failed(error.localizedDescription, unreachable: false)
      }
    }
  }

  /** Ask again with the same code; one that has run out needs a new one from the computer. */
  private func retry() {
    if let last { pair(last) } else { step = .start }
  }

  private func cancel() {
    work?.cancel()
    step = .start
  }
}

/** One corner of the viewfinder. */
private struct ScannerCorner: Shape {
  func path(in rect: CGRect) -> Path {
    var p = Path()
    p.move(to: CGPoint(x: rect.minX, y: rect.maxY))
    p.addLine(to: CGPoint(x: rect.minX, y: rect.minY + 14))
    p.addQuadCurve(to: CGPoint(x: rect.minX + 14, y: rect.minY), control: CGPoint(x: rect.minX, y: rect.minY))
    p.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
    return p
  }
}

private struct StepRow: View {
  var n: Int
  var title: String
  var text: String

  var body: some View {
    HStack(alignment: .top, spacing: 14) {
      Text("\(n)")
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(Palette.text)
        .frame(width: 32, height: 32)
        .background(Circle().strokeBorder(Palette.hairline))
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.text)
        Text(text).font(.subheadline).foregroundStyle(Palette.muted)
      }
      Spacer(minLength: 0)
    }
  }
}

/** The camera, reading QR codes (VisionKit's live scanner). */
struct QRScanner: UIViewControllerRepresentable {
  var found: (String) -> Void
  var failed: (String) -> Void

  @MainActor static var available: Bool { DataScannerViewController.isSupported && DataScannerViewController.isAvailable }

  func makeUIViewController(context: Context) -> DataScannerViewController {
    let vc = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, isHighlightingEnabled: true)
    vc.delegate = context.coordinator
    do { try vc.startScanning() }
    catch {
      // Report after presentation so the pairing screen can dismiss the scanner and show the error.
      Task { @MainActor in failed("Couldn't start the camera. Check camera access in Settings, or paste a pairing link.") }
    }
    return vc
  }

  func updateUIViewController(_ vc: DataScannerViewController, context: Context) {}

  func makeCoordinator() -> Coordinator { Coordinator(found: found, failed: failed) }

  final class Coordinator: NSObject, DataScannerViewControllerDelegate {
    let found: (String) -> Void
    let failed: (String) -> Void
    private var done = false
    init(found: @escaping (String) -> Void, failed: @escaping (String) -> Void) { self.found = found; self.failed = failed }

    func dataScanner(_ scanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
      guard !done else { return }
      done = true
      scanner.stopScanning()
      failed("Couldn't use the camera. Check camera access in Settings, or paste a pairing link.")
    }

    func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
      guard !done else { return }
      for case .barcode(let code) in items {
        guard let text = code.payloadStringValue, PairLink(text) != nil else { continue }
        done = true
        scanner.stopScanning()
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        found(text)
        return
      }
    }
  }
}
