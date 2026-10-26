import Foundation

/** GET /api/onboarding: what exists so far (helpers, devices) and whether Wisp is reachable from anywhere. */
struct OnboardingState: Decodable {
  struct Device: Decodable, Identifiable { var id: String; var name: String; var online: Bool; var mine: Bool?; var role: String? }
  var devices: [Device] = []
  var agents: [Agent] = []
  var reachable: Bool?

  init() {}
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Key.self)
    devices = (try? c.decode([Device].self, forKey: .devices)) ?? []
    agents = (try? c.decode([Agent].self, forKey: .agents)) ?? []
    reachable = try? c.decode(Bool.self, forKey: .reachable)
  }
  private enum Key: String, CodingKey { case devices, agents, reachable }
}

extension Store {
  func refreshOnboarding() async throws { onboarding = try await fetch { try await $0.get("/api/onboarding") } }
}

/** A device as setup checks see it: the hub's word on whether it is on, plus what it reported about itself. */
struct ReadyDevice: Equatable {
  var id: String
  var name: String
  var online: Bool
  var paused: Bool
  /** the AI programs the device says it has; empty = it hasn't said yet */
  var harnesses: [String]
}

/** "My helper isn't answering", as the web's Help page and Inbox card work it out (apps/web/src/onboarding.ts). */
enum Readiness {
  struct Check: Equatable, Identifiable {
    enum Status { case ok, bad, unknown }
    enum Fix: Equatable { case makeHelper, chooseDevice(agentId: String), devices, chooseModel(agentId: String) }
    var id: String
    var status: Status
    var label: String
    var fix: String?
    var to: Fix?
  }

  /** The wording and place for each harness; helpers that join from outside need no device. */
  static func runsOutside(_ harness: String) -> Bool { HarnessChoice.all.first { $0.id == harness }?.protocolName == "mcp" }
  static func runsInVm(_ harness: String) -> Bool { ["claude-code", "codex", "hermes", "kimi"].contains(harness) }

  static func ready(_ agent: Agent, devices: [ReadyDevice]?) -> (ready: Bool, problem: String?) {
    if runsOutside(agent.harness) { return (true, nil) }
    guard agent.nodeId != nil else { return (false, "No device yet") }
    guard let device = devices?.first(where: { $0.id == agent.nodeId }) else { return (true, nil) }
    if !device.online { return (false, "\(device.name) is offline") }
    if device.paused { return (false, "\(device.name) is paused") }
    let inComputer = runsInVm(agent.harness) && agent.settings?.runIn == "computer" && agent.computerId != nil
    if !device.harnesses.isEmpty && !inComputer && !device.harnesses.contains(agent.harness) {
      return (false, "\(HarnessChoice.label(agent.harness)) isn't installed on \(device.name)")
    }
    return (true, nil)
  }

  /** The helper to talk about: a ready one first, then one with a device, then any. */
  static func pickHelper(_ agents: [Agent], devices: [ReadyDevice]?) -> Agent? {
    agents.first { ready($0, devices: devices).ready } ?? agents.first { $0.nodeId != nil } ?? agents.first
  }

  /** The first thing wrong, in plain words, or nil when the helper can answer. */
  static func checks(agents: [Agent], devices: [ReadyDevice]?) -> [Check] {
    func unknown(_ id: String, _ label: String) -> Check { Check(id: id, status: .unknown, label: label) }
    guard let agent = pickHelper(agents, devices: devices) else {
      return [Check(id: "helper", status: .bad, label: "You have a helper", fix: "Make one. It takes a few minutes.", to: .makeHelper),
              unknown("device", "It has a device to work on"), unknown("online", "That device is on and connected"), unknown("harness", "Its AI is installed there")]
    }
    var out = [Check(id: "helper", status: .ok, label: "You have a helper: \(agent.name)")]
    if runsOutside(agent.harness) {
      out.append(Check(id: "device", status: .ok, label: "\(agent.name) runs outside Wisp and needs no device here"))
      return out
    }
    let rest = [unknown("online", "That device is on and connected"), unknown("harness", "Its AI is installed there")]
    guard agent.nodeId != nil else {
      out.append(Check(id: "device", status: .bad, label: "\(agent.name) has a device to work on", fix: "Pick the computer \(agent.name) should use.", to: .chooseDevice(agentId: agent.id)))
      return out + rest
    }
    guard let device = devices?.first(where: { $0.id == agent.nodeId }) else {
      let known = devices != nil
      out.append(Check(id: "device", status: known ? .bad : .unknown, label: "\(agent.name) has a device to work on",
                       fix: known ? "Its device was removed. Pick another for \(agent.name)." : nil, to: known ? .chooseDevice(agentId: agent.id) : nil))
      return out + rest
    }
    out.append(Check(id: "device", status: .ok, label: "\(agent.name) works on \(device.name)"))
    if !device.online || device.paused {
      out.append(Check(id: "online", status: .bad, label: "\(device.name) is on and connected",
                       fix: device.paused ? "\(device.name) is paused. Resume Wisp on it." : "Turn on \(device.name) and make sure Wisp is running there.", to: .devices))
      out.append(unknown("harness", "Its AI is installed there"))
      return out
    }
    out.append(Check(id: "online", status: .ok, label: "\(device.name) is on and connected"))
    let label = HarnessChoice.label(agent.harness)
    if runsInVm(agent.harness) && agent.settings?.runIn == "computer" && agent.computerId != nil {
      out.append(Check(id: "harness", status: .ok, label: "\(label) runs inside \(agent.name)'s computer"))
    } else if device.harnesses.isEmpty {
      out.append(unknown("harness", "\(label) is installed on \(device.name)"))
    } else if device.harnesses.contains(agent.harness) {
      out.append(Check(id: "harness", status: .ok, label: "\(label) is installed on \(device.name)"))
    } else {
      out.append(Check(id: "harness", status: .bad, label: "\(label) is installed on \(device.name)",
                       fix: "Install \(label) on \(device.name), or pick an AI that's already there.", to: .chooseModel(agentId: agent.id)))
    }
    return out
  }
}

extension Store {
  /** Devices for the checks: the live list of your devices, falling back to the hub's setup list while that loads. */
  var readyDevices: [ReadyDevice]? {
    if !nodes.isEmpty {
      return nodes.map { ReadyDevice(id: $0.id, name: $0.name, online: $0.online, paused: $0.paused == true, harnesses: ($0.harnesses ?? []).map(\.id)) }
    }
    guard let onboarding else { return nil }
    return onboarding.devices.map { ReadyDevice(id: $0.id, name: $0.name, online: $0.online, paused: false, harnesses: []) }
  }
}
