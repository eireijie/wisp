import SwiftUI

/**
 * What floats over the top of every tab: "Reconnecting…" when live updates drop (core-Offline),
 * "Wisp was updated" when the hub got a new version (core-UpdatedBanner), and a sync error.
 */
struct AppBanners: View {
  @Environment(Store.self) private var store
  /** the connection has been down long enough to say so (a blip at launch isn't worth a banner) */
  @State private var offline = false
  @State private var dismissedUpdate = false
  /** a sheet or full-screen page is up: the banners belong to the main screens, so they stay out of its way */
  @State private var covered = false
  @ReduceMotion private var reduceMotion
  private var slide: AnyTransition { reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity) }

  var body: some View {
    VStack(spacing: 10) {
      if offline && !store.connected { ReconnectingPill().transition(slide) }
      if store.hubUpdated && !dismissedUpdate {
        UpdatedBanner { dismissedUpdate = true } reload: { Task { await store.reloadAfterUpdate(); dismissedUpdate = false } }
          .transition(slide)
      }
      if let error = store.syncError {
        Text(error).font(.system(size: 13)).foregroundStyle(Palette.red)
          .multilineTextAlignment(.center).padding(.horizontal, 16).padding(.vertical, 10)
          .glass(20)
          .allowsHitTesting(false)
          .transition(.opacity)
      }
    }
    .padding(.horizontal, 18)
    .padding(.top, 66)
    .frame(maxWidth: .infinity)
    .opacity(covered ? 0 : 1)
    .onReceive(Timer.publish(every: 0.4, on: .main, in: .common).autoconnect()) { _ in
      let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
      let now = scene?.keyWindow?.rootViewController?.presentedViewController != nil
      if now != covered { covered = now }
    }
    .animation(Motion.pick(Motion.pop, reduceMotion), value: offline && !store.connected)
    .animation(Motion.pick(Motion.pop, reduceMotion), value: store.hubUpdated)
    .task(id: store.connected) {
      if store.connected { offline = false; return }
      try? await Task.sleep(for: .seconds(2))
      if !Task.isCancelled { offline = true }
    }
    .onChange(of: store.hubUpdated) { _, now in if !now { dismissedUpdate = false } }
    // a sync error fades by itself; it never blocks what's under it
    .task(id: store.syncError) {
      guard store.syncError != nil else { return }
      try? await Task.sleep(for: .seconds(6))
      if !Task.isCancelled { store.syncError = nil }
    }
    .animation(Motion.pick(Motion.pop, reduceMotion), value: store.syncError)
    .allowsHitTesting(!covered && (offline || store.hubUpdated))
  }
}

struct ReconnectingPill: View {
  var body: some View {
    HStack(spacing: 12) {
      ProgressView().controlSize(.small).tint(Palette.muted)
      Text("Reconnecting…").font(.system(size: 15, weight: .medium)).foregroundStyle(Palette.text)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 18)
    .frame(height: 48)
    .glassPill()
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("banner-reconnecting")
  }
}

struct UpdatedBanner: View {
  var notNow: () -> Void
  var reload: () -> Void

  var body: some View {
    HStack(spacing: 4) {
      Text("Wisp was updated").font(.system(size: 15, weight: .medium)).foregroundStyle(Palette.text)
      Spacer(minLength: 8)
      Button("Not now", action: notNow)
        .font(.system(size: 15, weight: .medium)).foregroundStyle(Palette.muted)
        .padding(.horizontal, 14).frame(height: 44).buttonStyle(.plain)
      Button(action: reload) {
        Text("Reload").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.ground)
          .padding(.horizontal, 18).frame(height: 44).background(Capsule().fill(Palette.text))
      }.buttonStyle(.plain)
    }
    .padding(.leading, 18).padding(.trailing, 14).padding(.vertical, 8)
    .glass(30)
    .accessibilityIdentifier("banner-updated")
  }
}
