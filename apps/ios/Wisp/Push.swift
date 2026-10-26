import SwiftUI
import UIKit
import UserNotifications
import OSLog

/** Where a tapped notification takes you. */
enum Route: Equatable {
  case chat(channelId: String, threadId: String?)
  case approval(id: String)
  case computer(id: String)
  /** the Computers tab, on a device's page (or just the tab) */
  case device(id: String?)

  /** From the `wisp` part of a push the hub sent (see apps/hub/src/apns.ts). */
  init?(_ info: [AnyHashable: Any]) {
    guard let w = Self.payload(info), let kind = w["kind"] as? String else { return nil }
    let channel = w["channelId"] as? String
    let thread = w["threadId"] as? String
    switch kind {
    case "message", "task": guard let channel, !channel.isEmpty else { return nil }; self = .chat(channelId: channel, threadId: thread)
    case "approval":
      if let id = w["approvalId"] as? String { self = .approval(id: id) } else if let channel { self = .chat(channelId: channel, threadId: thread) } else { return nil }
    case "computer": guard let id = w["computerId"] as? String else { return nil }; self = .computer(id: id)
    default: return nil
    }
  }

  nonisolated static func payload(_ info: [AnyHashable: Any]) -> [String: Any]? {
    (info["wisp"] ?? info["warren"]) as? [String: Any]
  }
}

/**
 * The app delegate, here for push notifications: it hands the APNs device token to the hub and
 * turns a tapped notification into a Route. It owns the Store so both can reach it.
 */
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  let store = Store()

  func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    // set before launch finishes, so a tap that opened the app is delivered
    UNUserNotificationCenter.current().delegate = self
    return true
  }

  func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    store.pushTokenReceived(deviceToken.map { String(format: "%02x", $0) }.joined())
  }

  func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
    store.pushRegistrationFailed(error)
  }

  /** In the app: show it, unless it's about the chat already on screen. */
  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
    let payload = Route.payload(notification.request.content.userInfo)
    let kind = payload?["kind"] as? String
    let preference = PushPreference.key(category: payload?["category"] as? String, kind: kind, hasThread: payload?["threadId"] is String)
    let route = Route(notification.request.content.userInfo)
    return await MainActor.run {
      if kind == "test" { return [.banner, .list, .sound] }
      let defaults = WispPreferences.standard
      let on: (String, Bool) -> Bool = { key, fallback in
        defaults.object(forKey: "wisp.notify." + key) as? Bool ?? fallback
      }
      guard on("enabled", true) else { return [] }
      if case .chat(let channel, _) = route, channel == store.openChannel { return [] }
      guard on(preference, true) else { return [] }
      // "Only when I'm away": this runs only while the app is open, so there is nothing to show
      if on("onlyAway", false) { return [] }
      return on("sound", false) ? [.banner, .list, .sound] : [.banner, .list]
    }
  }

  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
    guard let route = Route(response.notification.request.content.userInfo) else { return }
    await MainActor.run { store.route = route }
  }
}

extension Store {
  /** After sign-in: if you already allowed notifications, make sure the hub has this phone. */
  func setUpPush() async {
    struct Status: Decodable { var available: Bool }
    let gen = session
    let status: Status? = try? await fetch { try await $0.get("/api/me/push") }
    guard gen == session else { return }
    pushAvailable = status?.available ?? false
    let settings = await UNUserNotificationCenter.current().notificationSettings()
    guard gen == session else { return }
    notificationStatus = settings.authorizationStatus
    if settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional {
      retryPushRegistration()
    }
  }

  /**
   * Ask once, at a moment it makes sense: right after you've asked an agent for something, so
   * you hear back when it answers. Never at launch.
   */
  func askForNotificationsIfDue() {
    guard pushAvailable, notificationStatus == .notDetermined, !WispPreferences.standard.bool(forKey: "wisp.askedPush") else { return }
    WispPreferences.standard.set(true, forKey: "wisp.askedPush")
    Task { await enableNotifications() }
  }

  /** The system prompt (the first time), then registration. */
  @discardableResult
  func enableNotifications() async -> Bool {
    let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])) ?? false
    notificationStatus = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    if granted { UIApplication.shared.registerForRemoteNotifications() }
    return granted
  }

  func pushRegistrationFailed(_ error: Error) {
    pushRegistrationError = "Couldn't register this phone"
    Logger(subsystem: "ai.wisp.ios", category: "push").error("[Wisp] couldn't register for push: \(error.localizedDescription)")
  }

  func retryPushRegistration() {
    UIApplication.shared.registerForRemoteNotifications()
    if let pushToken { pushTokenReceived(pushToken) }
  }

  func pushTokenReceived(_ hex: String, retryDelay: Duration = .seconds(2)) {
    pushToken = hex
    pushUploadTask?.cancel()
    guard api != nil else { return }
    let gen = session
    pushUploadTask = Task {
      for attempt in 0...1 {
        guard !Task.isCancelled, gen == session else { return }
        do {
          try await uploadPushToken(hex)
          guard !Task.isCancelled, gen == session else { return }
          pushRegistrationError = nil
          return
        } catch {
          guard !Task.isCancelled, gen == session else { return }
          pushRegistrationFailed(error)
          if attempt == 0 {
            do { try await Task.sleep(for: retryDelay) } catch { return }
          }
        }
      }
    }
  }

  func uploadPushToken(_ hex: String) async throws {
    struct Body: Encodable { var token: String; var bundleId: String?; var environment: String }
    #if DEBUG
      let env = "sandbox" // development builds get tokens from APNs' sandbox
    #else
      let env = "production"
    #endif
    try await fetch { try await $0.post("/api/me/push", Body(token: hex, bundleId: Bundle.main.bundleIdentifier, environment: env)) }
  }

  /** The app icon's badge: unread messages, the same count the hub puts on pushes. */
  func updateBadge() {
    UNUserNotificationCenter.current().setBadgeCount(phase == .ready ? unreadTotal : 0)
  }
}

enum PushPreference {
  nonisolated static func key(category: String?, kind: String?, hasThread: Bool) -> String {
    if let category {
      switch category {
      case "approval": return "approvals"
      case "help": return "help"
      case "reply": return "replies"
      default: return "dms"
      }
    }
    switch kind {
    case "approval": return "approvals"
    case "computer": return "help"
    case "task": return "tasks"
    default: return hasThread ? "replies" : "dms"
    }
  }
}
