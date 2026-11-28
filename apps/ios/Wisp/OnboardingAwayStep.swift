import SwiftUI

/** When the first run asks about Tailscale, and how far along it is. Pure, so it can be tested. */
enum OnboardingAway {
  /** Only when Bubble AI has no away-from-home address yet. A Cloud server already has one, so it never asks. */
  static func needed(_ info: ReachInfo) -> Bool { !info.awayOn }

  struct Ticks: Equatable {
    var installed: Bool
    var signedIn: Bool
    /** its .ts.net address, once it's on */
    var address: String?
  }

  static func ticks(_ info: ReachInfo) -> Ticks {
    let state = info.tailscale.state
    let installed = state != "missing"
    let signedIn = installed && state != "needs-login"
    let on = signedIn && state == "running" && info.tailscale.serving == true
    let host = info.tailscale.dnsName.map { $0.hasSuffix(".") ? String($0.dropLast()) : $0 }
    return Ticks(installed: installed, signedIn: signedIn, address: on ? (host ?? info.publicUrl.flatMap { URL(string: $0)?.host }) : nil)
  }
}

/**
 * Use Bubble AI away from home (board 16): the last first-run page when Bubble AI is only reachable
 * on the home network. Three ticks that fill in by themselves as each part finishes (install on the
 * computer, sign in on Tailscale's own page, turn on the address). "Only at home for now" skips it;
 * it stays under Settings → Away from home.
 */
struct OnboardingAwayStep: View {
  @Environment(Store.self) private var store
  @Environment(\.openURL) private var openURL
  var onDone: () -> Void
  @State private var info: ReachInfo?
  @State private var action = FormAction()

  private var ticks: OnboardingAway.Ticks? { info.map(OnboardingAway.ticks) }
  private var computer: String { info?.computerName ?? "computer" }

  var body: some View {
    ObScreen(top: 56) {
      VStack(spacing: 0) {
        ObSlot(size: 56)
        Text("Use Bubble AI away from home").obTitle(23).padding(.top, 12)
        Text("Tailscale gives your agents a private address your phone can reach from anywhere.")
          .font(.system(size: 14)).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.top, 4)

        VStack(spacing: 0) {
          tick(done: ticks?.installed == true, title: "Install Tailscale on this \(computer)",
               detail: ticks?.installed == true ? "Found it" : "Get it from tailscale.com on the \(computer)", id: "away-install")
          Rectangle().fill(Palette.separator).frame(height: 1).padding(.leading, 48)
          tick(done: ticks?.signedIn == true, title: "Sign in to Tailscale", detail: "Opens Tailscale's own page", id: "away-signin") {
            if ticks?.installed == true, ticks?.signedIn != true {
              Button("Sign in") { signIn() }.buttonStyle(.pill(.secondary, small: true)).disabled(action.busy)
                .accessibilityIdentifier("away-signin-button")
            }
          }
          Rectangle().fill(Palette.separator).frame(height: 1).padding(.leading, 48)
          tick(done: ticks?.address != nil, title: "Turn on your address", detail: ticks?.address ?? "A private .ts.net address", mono: ticks?.address != nil, id: "away-address") {
            if ticks?.signedIn == true, ticks?.address == nil {
              Button("Turn on") { turnOn() }.buttonStyle(.pill(.secondary, small: true)).disabled(action.busy)
                .accessibilityIdentifier("away-on-button")
            }
          }
        }
        .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
        .padding(.top, 22)

        Text("Put Tailscale on your phone too, with the same account.")
          .font(.system(size: 13)).foregroundStyle(Palette.muted)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.top, 12).padding(.horizontal, 4)
        StatusLine(error: action.error).padding(.top, 8)
      }
    } bottom: {
      Button { onDone() } label: { Text("Continue") }
        .buttonStyle(ObWide()).disabled(ticks?.address == nil).opacity(ticks?.address == nil ? 0.5 : 1)
        .accessibilityIdentifier("away-continue")
      Button("Only at home for now") { onDone() }.buttonStyle(ObQuiet()).accessibilityIdentifier("away-skip")
    }
    .task { await watch() }
  }

  private func tick<Trailing: View>(done: Bool, title: String, detail: String, mono: Bool = false, id: String, @ViewBuilder trailing: () -> Trailing = { EmptyView() }) -> some View {
    HStack(spacing: 12) {
      Image(systemName: done ? "checkmark.circle.fill" : "circle")
        .font(.system(size: 20)).foregroundStyle(done ? Palette.statusOnline : Palette.faint)
        .frame(width: 24)
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 15, weight: .medium)).foregroundStyle(Palette.text)
        Text(detail).font(.system(size: 13, design: mono ? .monospaced : .default)).foregroundStyle(Palette.faint).lineLimit(1).truncationMode(.middle)
      }
      Spacer(minLength: 8)
      trailing()
    }
    .padding(.horizontal, 12).frame(minHeight: 60)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("\(title), \(done ? "done" : "not yet")")
    .accessibilityIdentifier(id)
  }

  private func signIn() {
    action.run {
      let next = try await store.tailscale("login")
      info = next
      if let url = next.tailscale.authUrl.flatMap(URL.init(string:)) { openURL(url) }
    }
  }

  private func turnOn() {
    action.run {
      let outcome = try await store.enableTailscale()
      info = outcome.info
      if let url = outcome.open { openURL(url) }
    }
  }

  /** the ticks fill in by themselves: the hub is asked again every two seconds while this page is open */
  private func watch() async {
    while !Task.isCancelled {
      if let next = try? await store.reach(fresh: info == nil) { info = next }
      do { try await Task.sleep(for: .seconds(2)) } catch { return }
    }
  }
}
