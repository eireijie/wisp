import SwiftUI
import VisionKit

/** Signed out: connect to Wisp on your computer by scanning the QR code in Settings → Mobile. */
struct PairView: View {
  @Environment(Store.self) private var store
  @State private var step: Step = .start
  @State private var scanning = false
  @State private var pasting = false
  @State private var pasted = ""
  @State private var work: Task<Void, Never>?

  enum Step: Equatable {
    case start
    case connecting
    case code(String, workspace: String?)
    case failed(String)
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 28) {
        VStack(alignment: .leading, spacing: 14) {
          Image("Mark")
            .resizable()
            .frame(width: 64, height: 64)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
          Text("Connect to Wisp")
            .font(.largeTitle.bold())
          Text("Wisp runs on your computer. Pair this phone with it to chat with your agents and watch their computers from your phone.")
            .foregroundStyle(.secondary)
        }
        .padding(.top, 48)

        if let message = store.sessionMessage {
          Text(message).font(.callout).foregroundStyle(.secondary)
        }
        switch step {
        case .start, .failed:
          instructions
          if case .failed(let msg) = step {
            Label(msg, systemImage: "exclamationmark.circle")
              .font(.callout)
              .foregroundStyle(.red)
          }
          VStack(spacing: 12) {
            Button {
              scanning = true
            } label: {
              Label("Scan QR code", systemImage: "qrcode.viewfinder")
                .fontWeight(.semibold)
                .frame(maxWidth: .infinity, minHeight: 34)
            }
            .primaryButton()
            .disabled(!QRScanner.available)

            Button("Paste a pairing link instead") { pasting = true }
              .font(.subheadline)
          }
          if !QRScanner.available {
            Text("This device can't scan codes. On your computer, click **Copy pairing link** and paste it here.")
              .font(.footnote)
              .foregroundStyle(.secondary)
          }

        case .connecting:
          HStack(spacing: 12) {
            ProgressView()
            Text("Finding your computer…").foregroundStyle(.secondary)
          }

        case .code(let code, let workspace):
          VStack(alignment: .leading, spacing: 16) {
            Text("Check the code")
              .font(.title3.bold())
            Text(code)
              .font(.system(size: 44, weight: .semibold, design: .monospaced))
              .tracking(6)
              .accessibilityLabel(code.map(String.init).joined(separator: " "))
            Text("Make sure your computer shows the same six digits, then click **Yes, pair it** there.")
              .foregroundStyle(.secondary)
            HStack(spacing: 10) {
              ProgressView()
              Text("Waiting for you to confirm in \(workspace ?? "Wisp") on your computer…")
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
            Button("Cancel", role: .cancel) { cancel() }
          }
        }

        Text("Don't have Wisp on a computer yet? Get it free at github.com/\(WispRepo.github).")
          .font(.footnote)
          .foregroundStyle(.secondary)
      }
      .padding(.horizontal, 24)
      .frame(maxWidth: 480)
      .frame(maxWidth: .infinity)
    }
    .sheet(isPresented: $scanning) {
      QRScanner(found: { text in
        scanning = false
        use(text)
      }, failed: { message in
        scanning = false
        step = .failed(message)
      })
      .ignoresSafeArea()
      .overlay(alignment: .topTrailing) {
        Button("Close") { scanning = false }
          .secondaryButton()
          .padding()
      }
    }
    .alert("Paste pairing link", isPresented: $pasting) {
      TextField(text: $pasted, prompt: Text(verbatim: "wisp://pair?…")) { Text("Pairing link") }
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
      Button("Connect") { use(pasted) }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("In Wisp on your computer: Settings → Mobile → Start pairing → Copy pairing link.")
    }
    // a code scanned with the Camera app opens Wisp with the link
    .onChange(of: store.pendingPair, initial: true) { _, link in
      guard let link else { return }
      store.pendingPair = nil
      pair(link)
    }
    .onDisappear { work?.cancel() }
  }

  private var instructions: some View {
    VStack(alignment: .leading, spacing: 16) {
      StepRow(n: 1, title: "Open Wisp on your computer", text: "Go to Settings → Mobile and click Start pairing.")
      StepRow(n: 2, title: "Scan the QR code", text: "Your phone needs to be on the same Wi-Fi, unless your Wisp is set up to be reached from anywhere.")
      StepRow(n: 3, title: "Check the code", text: "Confirm on your computer that both show the same six digits.")
    }
  }

  private func use(_ text: String) {
    guard let link = PairLink(text) else {
      step = .failed("That isn't a Wisp pairing code. Scan the code in Wisp → Settings → Mobile.")
      return
    }
    pair(link)
  }

  private func pair(_ link: PairLink) {
    work?.cancel()
    step = .connecting
    work = Task {
      do {
        guard let hub = await Pairing.reachable(link.addresses) else {
          throw Pairing.Failure(message: "Couldn't reach your computer. Make sure this phone is on the same Wi-Fi as it, then try again.")
        }
        let claimed = try await Pairing.claim(link, at: hub)
        step = .code(claimed.code, workspace: claimed.workspaceName)
        let token = try await Pairing.waitForConfirm(link, at: hub)
        try await store.adopt(hub: hub, token: token)
      } catch is CancellationError {
      } catch {
        step = .failed(error.localizedDescription)
      }
    }
  }

  private func cancel() {
    work?.cancel()
    step = .start
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
        .frame(width: 32, height: 32)
        .background(Circle().strokeBorder(Color(.separator)))
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.subheadline.weight(.semibold))
        Text(text).font(.subheadline).foregroundStyle(.secondary)
      }
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
