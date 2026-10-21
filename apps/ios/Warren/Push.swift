import SwiftUI
import UIKit
import UserNotifications

/** Where a tapped notification takes you. */
enum Route: Equatable {
  case chat(channelId: String, threadId: String?)
  case approval(id: String)
  case computer(id: String)

  /** From the `warren` part of a push the hub sent (see apps/hub/src/apns.ts). */
  init?(_ info: [AnyHashable: Any]) {
    guard let w = info["warren"] as? [String: Any], let kind = w["kind"] as? String else { return nil }
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
    print("Warren: couldn't register for push: \(error.localizedDescription)")
  }

  /** In the app: show it, unless it's about the chat already on screen. */
  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
    let payload = notification.request.content.userInfo["warren"] as? [String: Any]
    let kind = payload?["kind"] as? String
    let hasThread = payload?["threadId"] is String
    let route = Route(notification.request.content.userInfo)
    return await MainActor.run {
      if kind == "test" { return [.banner, .list, .sound] }
      let defaults = UserDefaults.standard
      let on: (String, Bool) -> Bool = { key, fallback in
        defaults.object(forKey: "warren.notify." + key) as? Bool ?? fallback
      }
      guard on("enabled", true) else { return [] }
      if case .chat(let channel, _) = route, channel == store.openChannel { return [] }
      let category: String
      switch kind {
      case "approval": category = "approvals"
      case "computer": category = "help"
      case "task": category = "tasks"
      default: category = hasThread ? "replies" : "dms"
      }
      guard on(category, true) else { return [] }
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
    pushAvailable = ((try? await api?.get("/api/me/push")) as Status?)?.available ?? false
    let settings = await UNUserNotificationCenter.current().notificationSettings()
    notificationStatus = settings.authorizationStatus
    if settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional {
      UIApplication.shared.registerForRemoteNotifications()
    }
  }

  /**
   * Ask once, at a moment it makes sense: right after you've asked an agent for something, so
   * you hear back when it answers. Never at launch.
   */
  func askForNotificationsIfDue() {
    guard pushAvailable, notificationStatus == .notDetermined, !UserDefaults.standard.bool(forKey: "warren.askedPush") else { return }
    UserDefaults.standard.set(true, forKey: "warren.askedPush")
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

  func pushTokenReceived(_ hex: String) {
    struct Body: Encodable { var token: String; var bundleId: String?; var environment: String }
    #if DEBUG
      let env = "sandbox" // development builds get tokens from APNs' sandbox
    #else
      let env = "production"
    #endif
    Task { try? await api?.post("/api/me/push", Body(token: hex, bundleId: Bundle.main.bundleIdentifier, environment: env)) }
  }

  /** The app icon's badge: unread messages, the same count the hub puts on pushes. */
  func updateBadge() {
    UNUserNotificationCenter.current().setBadgeCount(phase == .ready ? unreadTotal : 0)
  }
}
