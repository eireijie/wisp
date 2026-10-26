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

  var body: some View {
    VStack(spacing: 10) {
      if offline && !store.connected { ReconnectingPill().transition(.move(edge: .top).combined(with: .opacity)) }
      if store.hubUpdated && !dismissedUpdate {
        UpdatedBanner { dismissedUpdate = true } reload: { Task { await store.reloadAfterUpdate(); dismissedUpdate = false } }
          .transition(.move(edge: .top).combined(with: .opacity))
      }
      if let error = store.syncError {
        Text(error).font(.system(size: 14)).foregroundStyle(Palette.red)
          .multilineTextAlignment(.center).padding(.horizontal, 16).padding(.vertical, 10)
          .glass(20)
          .transition(.opacity)
      }
    }
    .padding(.horizontal, 18)
    .padding(.top, 66)
    .frame(maxWidth: .infinity)
    .animation(.snappy, value: offline && !store.connected)
    .animation(.snappy, value: store.hubUpdated)
    .task(id: store.connected) {
      if store.connected { offline = false; return }
      try? await Task.sleep(for: .seconds(2))
      if !Task.isCancelled { offline = true }
    }
    .onChange(of: store.hubUpdated) { _, now in if !now { dismissedUpdate = false } }
    .allowsHitTesting(offline || store.hubUpdated || store.syncError != nil)
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
      Text("Wisp was updated").font(.system(size: 16, weight: .medium)).foregroundStyle(Palette.text)
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
