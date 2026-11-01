import Foundation

// The words on an agent's profile rows, and the little rules behind its pages. No views, so the
// text can be unit tested.

enum AgentLine {
  /** "xhigh" is shown as Extra; the rest are their own word, capitalized. */
  static func effort(_ value: String) -> String {
    switch value.lowercased() {
    case "xhigh", "extra", "x-high", "extra-high": "Extra"
    case "": "Default"
    default: value.prefix(1).uppercased() + value.dropFirst()
    }
  }

  /** The Model row: "sol 6.1 · High", the model alone, or "Harness default". */
  static func model(agent: Agent, catalog: AgentModels.Catalog?) -> String {
    let id = agent.model ?? ""
    let label = id.isEmpty ? nil : catalog?.models.first { $0.id == id }?.label ?? id
    let effortValue = agent.settings?.effort ?? ""
    let effortText = effortValue.isEmpty ? nil : effort(effortValue)
    let fast = agent.settings?.fast == true ? "Fast" : nil
    let parts = [label, effortText, fast].compactMap { $0 }
    return parts.isEmpty ? "Harness default" : parts.joined(separator: " · ")
  }

  /** The Computer row: what state the agent's computer is in, or that it has none. */
  static func computer(agent: Agent, computer: Computer?, device: AgentNode? = nil) -> String {
    if agent.status == .busy { return "Working" }
    if let computer {
      switch computer.status {
      case "ready": return "Ready"
      case "starting": return "Starting"
      case "stopped": return "Stopped"
      case "offline": return "Offline"
      case "error": return "Needs a look"
      default: return computer.statusText.isEmpty ? "Ready" : computer.statusText.prefix(1).uppercased() + computer.statusText.dropFirst()
      }
    }
    if agent.computerId != nil { return "Ready" }
    return agent.settings?.headless == true ? "Headless" : device?.name ?? "None yet"
  }

  /** The Routines row: how many are on. */
  static func routines(_ routines: [Routine]) -> String {
    let on = routines.filter { $0.enabled != false }.count
    return on == 0 ? (routines.isEmpty ? "None" : "All off") : "\(on) on"
  }

  /** The Skills row. */
  static func count(_ n: Int) -> String { n == 0 ? "None" : "\(n)" }

  /** Who can really ask it: what the hub enforces. On a private device it runs directly on, only that device's owner until they open it up. */
  static func askMode(_ agent: Agent, device: AgentNode?) -> String {
    let inComputer = Readiness.runsInVm(agent.harness) && agent.settings?.runIn == "computer" && agent.computerId != nil
    if let device, !inComputer, agent.settings?.anyoneCanAsk != true, device.shared != true { return "me" }
    return agent.settings?.respondTo ?? "anyone"
  }

  /** Who can ask it, in the row's words. */
  static func respond(_ agent: Agent, device: AgentNode? = nil) -> String {
    switch askMode(agent, device: device) {
    case "me": "Only me"
    case "people": "Picked"
    default: "Anyone"
    }
  }

  /** Read / Edit / Full access, the three chips on Permissions. */
  static func accessChip(_ level: AgentAccess) -> String {
    switch level {
    case .readOnly: "Read"
    case .edit: "Edit"
    case .full: "Full access"
    }
  }

  /** Where an agent works, from the choice on the Computer page. */
  enum Place: Hashable { case screen, own, other, none }

  static func place(agent: Agent, computer: Computer?) -> Place {
    guard let computer else { return .none }
    if computer.kind == "device" { return .screen }
    return (computer.agents ?? []).filter { $0 != agent.id }.isEmpty ? .own : .other
  }
}

/** How a run is told on Activity: "Working", "Done", "Failed". */
enum RunLine {
  static func status(_ run: AgentRun) -> String {
    switch run.status {
    case "running": "Working"
    case "queued": "Waiting"
    case "done", "completed", "succeeded", "ok": "Done"
    case "failed", "error": "Failed"
    case "cancelled", "canceled": "Stopped"
    default: run.status.prefix(1).uppercased() + run.status.dropFirst()
    }
  }

  static func isGood(_ run: AgentRun) -> Bool { status(run) == "Done" }
  static func isBad(_ run: AgentRun) -> Bool { status(run) == "Failed" }

  /** "2m", "38s", "1h 4m" from a run's start and end; nil when it has no end (or no start). */
  static func duration(from start: String?, to end: String?, now: Date = .now) -> String? {
    guard let start = start.flatMap(Wire.date) else { return nil }
    let finish = end.flatMap(Wire.date) ?? now
    let seconds = max(0, Int(finish.timeIntervalSince(start)))
    if seconds < 60 { return "\(seconds)s" }
    if seconds < 3600 { return "\(seconds / 60)m" }
    return "\(seconds / 3600)h \(seconds % 3600 / 60)m"
  }

  /** What a run is called in a list: what it was asked, shortened. */
  static func title(_ run: AgentRun) -> String {
    let text = (run.trigger ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty { return run.kind == "background" ? "Background check" : "Run" }
    let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
    return line.count > 70 ? String(line.prefix(67)) + "…" : line
  }
}

/** Picked people on "Who can ask it", and what saves. */
enum AskWho {
  /** the settings to send for a choice; the people only matter for "people" */
  static func settings(_ mode: String, people: Set<String>) -> Fields {
    mode == "people" ? ["respondTo": AnyEncodable(mode), "respondPeople": AnyEncodable(Array(people).sorted())] : ["respondTo": AnyEncodable(mode)]
  }

  static func caption(_ mode: String, people: Int) -> String {
    switch mode {
    case "me": "Just you can message it."
    case "people": people == 0 ? "Pick at least one person." : "\(people) \(people == 1 ? "person" : "people") can message it."
    default: "Everyone here can message it."
    }
  }
}
