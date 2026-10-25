import Foundation

// What the computer screens need beyond the list itself: the add form, files, the activity log
// and a recorded lesson. These follow packages/core/src/computers.ts and types.ts.

extension Computer {
  /** Its device is connected. A hub that doesn't say is taken as connected unless the computer reads offline. */
  var isOnline: Bool { online ?? (status != "offline") }
  /** Files and the clipboard need a computer that's there and not paused at its device. */
  var canTransfer: Bool { isOnline && paused != true }
  /** The agents that use it, as the people the hub knows of. */
  var agentIds: [String] { agents ?? [] }
}

// MARK: adding

enum ComputerKind: String, CaseIterable, Identifiable {
  case vm, device, orgo
  var id: String { rawValue }
}

enum ComputerSize: String, CaseIterable, Identifiable {
  case small, medium, large
  var id: String { rawValue }

  var cpus: Int { switch self { case .small: 1; case .medium: 2; case .large: 4 } }
  var vmMemoryGb: Int { switch self { case .small: 2; case .medium: 4; case .large: 8 } }
  var orgoRam: Int { switch self { case .small: 4; case .medium: 8; case .large: 16 } }

  /** "Medium: 2 CPUs, 4 GB" */
  func label(for kind: ComputerKind) -> String {
    let word = rawValue.prefix(1).uppercased() + rawValue.dropFirst()
    return "\(word): \(cpus) CPU\(cpus == 1 ? "" : "s"), \(kind == .vm ? vmMemoryGb : orgoRam) GB"
  }
}

/** The body of POST /api/computers. Unset fields are left out. */
struct NewComputer: Encodable, Equatable {
  var kind: String
  var nodeId: String?
  var name: String?
  var cpus: Int?
  var memoryGb: Int?
  var ram: Int?
  var cpu: Int?
  var computerId: String?

  /**
   * What the add form sends. A VM's size and name default like the web's; an Orgo computer is
   * either a new one in the chosen size, or one already in the account (by its ID).
   */
  static func make(kind: ComputerKind, nodeId: String, deviceName: String?, name: String, size: ComputerSize, existingOrgo: String) -> NewComputer {
    let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    switch kind {
    case .device:
      return NewComputer(kind: "device", nodeId: nodeId, name: name.isEmpty ? nil : name)
    case .vm:
      return NewComputer(kind: "vm", nodeId: nodeId, name: name.isEmpty ? "\(deviceName ?? "VM") desktop" : name, cpus: size.cpus, memoryGb: size.vmMemoryGb)
    case .orgo:
      let existing = existingOrgo.trimmingCharacters(in: .whitespacesAndNewlines)
      let named = name.isEmpty ? "Cloud computer" : name
      return existing.isEmpty ? NewComputer(kind: "orgo", name: named, ram: size.orgoRam, cpu: size.cpus) : NewComputer(kind: "orgo", name: named, computerId: existing)
    }
  }
}

struct ComputerSettings: Decodable {
  struct Orgo: Decodable { var configured: Bool }
  var orgo: Orgo
}

extension AgentNode {
  /** Why a VM can't go on this device yet, or nil when it can. */
  var vmProblem: String? {
    guard let caps = capabilities?.vm, !caps.ok else { return nil }
    return caps.detail.flatMap { $0.isEmpty ? nil : $0 } ?? "It can't run VMs yet."
  }
}

enum ComputerAdd {
  /** Devices a computer can go on: yours and the ones shared with you. */
  static func usable(_ nodes: [AgentNode]) -> [AgentNode] { nodes.filter(\.usable) }

  /** A note under "a VM on a device" when none of your devices can run one yet, like the web's. */
  static func vmNote(_ devices: [AgentNode]) -> String? {
    if devices.contains(where: { $0.capabilities?.vm?.ok == true }) { return nil }
    if devices.isEmpty { return "Connect a device first." }
    let online = devices.filter(\.online)
    if online.isEmpty {
      let names = list(devices.map(\.name))
      return "Can't check while \(names) \(devices.count == 1 ? "is" : "are") disconnected. Reconnect a device to see what it can run."
    }
    if let refused = online.first(where: { $0.capabilities?.vm != nil && $0.capabilities?.vm?.ok == false }) {
      let detail = refused.capabilities?.vm?.detail ?? ""
      return detail.isEmpty ? "None of your devices can run VMs yet: install Docker on one." : "\(refused.name): \(detail)"
    }
    return "Checking what \(list(online.map(\.name))) can run…"
  }

  static func list(_ names: [String]) -> String {
    switch names.count {
    case 0: ""
    case 1: names[0]
    case 2: "\(names[0]) and \(names[1])"
    default: names.dropLast().joined(separator: ", ") + ", and " + names[names.count - 1]
    }
  }
}

// MARK: who may do what

enum ComputerRights {
  /** Delete a computer: its owner for a device's screen; a workspace owner or the device's owner for a VM; anyone for Orgo. */
  static func canRemove(_ c: Computer, userId: String?, role: String, nodes: [AgentNode]) -> Bool {
    switch c.kind {
    case "device": return userId != nil && c.ownerId == userId
    case "vm": return role == "owner" || (c.nodeId.flatMap { id in nodes.first { $0.id == id }?.mine } ?? false)
    default: return true
    }
  }

  /** What deleting it takes with it, for the confirmation. */
  static func removeWarning(_ c: Computer) -> String {
    switch c.kind {
    case "vm": "Its VM and everything on it are deleted."
    case "orgo": "The Orgo computer is deleted too."
    default: "Agents won't be able to use this device's screen."
    }
  }
}

// MARK: activity

struct ComputerLogEntry: Decodable, Identifiable {
  var actor: Actor
  var text: String
  var at: String
  var id: String { "\(at)|\(actor.id)|\(text)" }
}

// MARK: files

struct RemoteFile: Decodable, Identifiable, Hashable {
  var name: String
  var dir: Bool
  var size: Int
  var modified: String?
  var id: String { name }
}

struct RemoteFolder: Decodable {
  var path: String
  var parent: String?
  var home: String
  var entries: [RemoteFile]

  /** Folders first, then files, each by name; hidden files only when asked for. */
  func shown(hidden: Bool) -> [RemoteFile] {
    entries
      .filter { hidden || !$0.name.hasPrefix(".") }
      .sorted { a, b in a.dir != b.dir ? a.dir : a.name.localizedStandardCompare(b.name) == .orderedAscending }
  }

  var hiddenCount: Int { entries.filter { $0.name.hasPrefix(".") }.count }

  /** The path of an entry in this folder (Windows paths use backslashes). */
  func join(_ name: String) -> String {
    let sep = path.contains("\\") && !path.contains("/") ? "\\" : "/"
    return path.hasSuffix(sep) ? path + name : path + sep + name
  }

  /** "Home / Documents / Reports" */
  var crumbs: String {
    let parts: [String]
    if !home.isEmpty, path.hasPrefix(home) {
      parts = ["Home"] + path.dropFirst(home.count).split(whereSeparator: { $0 == "/" || $0 == "\\" }).map(String.init)
    } else {
      parts = path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).map(String.init)
    }
    return parts.isEmpty ? "/" : parts.joined(separator: " / ")
  }
}

enum ComputerFileLimits {
  /** MAX_TRANSFER_BYTES: what the hub accepts for one file sent to a computer. */
  static let maxBytes = 50 * 1024 * 1024
}

// MARK: teaching

/** A web page element a click landed on, noted on VMs so a routine survives layout changes. */
struct TaughtElement: Codable, Hashable {
  var url: String
  var title: String?
  var role: String
  var name: String
  var selector: String?
}

/** One thing a person did while teaching, in the screenshot's pixels (RecordedStep). */
struct TaughtStep: Encodable, Hashable {
  var at: Int
  var kind: String
  var x: Int?
  var y: Int?
  var toX: Int?
  var toY: Int?
  var text: String?
  var keys: String?
  var direction: String?
  var imageFileId: String?
  var element: TaughtElement?
}

/** The body of POST /api/routines/teach. */
struct TeachRequest: Encodable {
  var agentId: String
  var name: String
  var computerId: String
  var steps: [TaughtStep]
  var durationMs: Int
  var narration: String?
}

/** Steps as they're taken, with the screenshot (JPEG) that goes with the ones a click or Enter begins. */
struct TeachRecording {
  struct Item { var step: TaughtStep; var snapshot: Data? }

  static let maxSnapshots = 40
  /** the hub takes up to this many steps */
  static let maxSteps = 500

  var started: Date
  private(set) var items: [Item] = []
  private var snapshots = 0

  init(started: Date = Date()) { self.started = started }

  var steps: [TaughtStep] { items.map(\.step) }
  var count: Int { items.count }

  /** Whether a step gets a picture of the screen before it: clicks, drags and Enter. */
  static func wantsSnapshot(kind: String, keys: String?) -> Bool {
    ["click", "double_click", "right_click", "drag"].contains(kind) || (kind == "key" && keys == "Enter")
  }

  /** Adds a step; returns its position, or nil past the limit. */
  @discardableResult
  mutating func add(kind: String, x: Int? = nil, y: Int? = nil, toX: Int? = nil, toY: Int? = nil, text: String? = nil, keys: String? = nil, direction: String? = nil, snapshot: @autoclosure () -> Data? = nil, now: Date = Date()) -> Int? {
    guard items.count < Self.maxSteps else { return nil }
    var shot: Data?
    if Self.wantsSnapshot(kind: kind, keys: keys), snapshots < Self.maxSnapshots, let data = snapshot() {
      shot = data
      snapshots += 1
    }
    let at = max(0, Int(now.timeIntervalSince(started) * 1000))
    items.append(Item(step: TaughtStep(at: at, kind: kind, x: x, y: y, toX: toX, toY: toY, text: text, keys: keys, direction: direction), snapshot: shot))
    return items.count - 1
  }

  mutating func setElement(_ element: TaughtElement, at index: Int) {
    guard items.indices.contains(index) else { return }
    items[index].step.element = element
  }

  /** "0:04" */
  static func clock(_ seconds: Int) -> String { "\(seconds / 60):" + String(format: "%02d", seconds % 60) }
}

/** Whether a click is worth asking the computer which page element it landed on (VMs only). */
func teachInspects(kind: String, computerKind: String) -> Bool {
  computerKind == "vm" && ["click", "double_click", "right_click"].contains(kind)
}
