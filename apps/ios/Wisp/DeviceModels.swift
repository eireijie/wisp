import Foundation

/** What a device can do for its agents (DeviceCapabilities in packages/core/src/computers.ts). */
struct DeviceCapabilities: Decodable, Hashable {
  struct Screen: Decodable, Hashable {
    var ok: Bool
    var detail: String?
    /** it could be used, but it's turned off at the device */
    var off: Bool?
    /** "pin" or "password" when opening it needs the code picked at the device */
    var code: String?
  }
  struct VM: Decodable, Hashable { var ok: Bool; var detail: String? }
  struct RustDesk: Decodable, Hashable { var id: String }

  var platform: String?
  var screen: Screen?
  var vm: VM?
  var rustdesk: RustDesk?
  /** other remote desktop apps found on the device, to suggest first */
  var remoteApps: [String]?

  var osName: String {
    switch platform {
    case "darwin": "Mac"
    case "win32": "Windows PC"
    case "linux": "Linux"
    default: "computer"
    }
  }
}

/** A remote desktop app a device's owner already uses (REMOTE_APPS in packages/core/src/computers.ts). */
enum RemoteApp: String, CaseIterable, Codable, Identifiable {
  case teamviewer, anydesk, chrome, rdp, screenSharing = "screen-sharing", vnc, other
  var id: String { rawValue }

  /** An app a newer hub knows and this one doesn't still shows, as another app. */
  init(from decoder: Decoder) throws {
    self = RemoteApp(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .other
  }

  enum Field { case id, address, link }

  var label: String {
    switch self {
    case .teamviewer: "TeamViewer"
    case .anydesk: "AnyDesk"
    case .chrome: "Chrome Remote Desktop"
    case .rdp: "Windows Remote Desktop"
    case .screenSharing: "Screen Sharing (Mac)"
    case .vnc: "VNC"
    case .other: "Another app"
    }
  }

  var field: Field {
    switch self {
    case .teamviewer, .anydesk: .id
    case .rdp, .screenSharing, .vnc: .address
    case .chrome, .other: .link
    }
  }

  /** The apps found on the device first, then the rest. */
  static func ordered(found: [String]?) -> [RemoteApp] {
    let first = (found ?? []).compactMap(RemoteApp.init(rawValue:))
    return first + allCases.filter { !first.contains($0) }
  }
}

/** How its owner reaches a device with their own app: its ID, address or link there. Never a password. */
struct OwnRemoteDesktop: Codable, Hashable {
  var app: RemoteApp
  var value: String
  var name: String?

  private static let patterns: [RemoteApp.Field: String] = [
    .id: "^[A-Za-z0-9@._-]{3,60}$",
    .address: "^[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$",
    .link: "^https://[^\\s<>\"']{4,500}$",
  ]

  static func matches(_ value: String, _ field: RemoteApp.Field) -> Bool {
    value.range(of: patterns[field]!, options: .regularExpression) != nil
  }

  /** What was typed, cleaned up: IDs are often copied with spaces ("123 456 789"). */
  init(app: RemoteApp, typed: String, name: String = "") {
    self.app = app
    value = app.field == .id ? typed.replacingOccurrences(of: "\\s+", with: "", options: .regularExpression) : typed.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    self.name = app == .other && !trimmed.isEmpty ? String(trimmed.prefix(60)) : nil
  }

  /** Why the hub would turn this down, in its words; nil when it's fine. */
  var problem: String? {
    if Self.matches(value, app.field) { return nil }
    switch app.field {
    case .id: return "That doesn't look like an ID."
    case .address: return "Enter a computer name or address, like shop-pc.local or 192.168.1.20."
    case .link: return "Paste a link that starts with https://"
    }
  }

  var label: String { app == .other ? name ?? app.label : app.label }
  var shown: String { app.field == .id ? DeviceText.rustdeskID(value) : value }

  /** A link that opens the app on this device, or nil when it has none (copy the ID instead). */
  var link: URL? {
    guard problem == nil else { return nil }
    let v = value
    let link: String?
    switch app {
    case .anydesk: link = "anydesk:\(v)"
    case .teamviewer: link = v.allSatisfy(\.isASCIIDigit) ? "teamviewer10://control?device=\(v)" : nil
    case .rdp: link = "rdp://full%20address=s:\(v)"
    case .screenSharing, .vnc: link = "vnc://\(v)"
    case .chrome, .other: link = v
    }
    // rdp://full%20address=s:host isn't a URL by RFC 3986, so URL(string:) refuses it; the value was checked above
    return link.flatMap { URL(dataRepresentation: Data($0.utf8), relativeTo: nil) }
  }
}

enum DeviceText {
  /** "482117903" → "482 117 903", the way RustDesk shows an ID. */
  static func rustdeskID(_ id: String) -> String {
    guard !id.isEmpty, id.allSatisfy(\.isASCIIDigit) else { return id }
    var out = ""
    for (i, ch) in id.enumerated() {
      if i > 0 && (id.count - i) % 3 == 0 { out.append(" ") }
      out.append(ch)
    }
    return out
  }

  /** rustdesk://<id>, only for an ID RustDesk could have given. */
  static func rustdeskLink(_ id: String) -> URL? {
    guard OwnRemoteDesktop.matches(id, .id) else { return nil }
    return URL(string: "rustdesk://\(id)")
  }
}

/** What an agent on a device works on: its screen, a computer (a VM here), a new VM, or nothing. */
enum WorksOn: Hashable {
  case screen, computer(String), newVM, none

  var tag: String {
    switch self {
    case .screen: "screen"
    case .computer(let id): id
    case .newVM: "new-vm"
    case .none: "none"
    }
  }

  init(tag: String) {
    switch tag {
    case "screen": self = .screen
    case "new-vm": self = .newVM
    case "none": self = .none
    default: self = .computer(tag)
    }
  }
}

private extension Character {
  var isASCIIDigit: Bool { isASCII && isNumber }
}
