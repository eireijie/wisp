import SwiftUI

/**
 * Runs on (board 16c): where an agent lives, picked on every New agent and moved later from its
 * profile. The shared computer, or one of your devices (and ones shared with you). Offline devices
 * show but can't be picked. Pure, so it can be tested.
 */
enum RunsOn: Hashable {
  case shared
  case device(String)

  struct Option: Identifiable, Hashable {
    var choice: RunsOn
    var title: String
    var line: String
    var symbol: String
    var enabled: Bool
    var id: String { RunsOn.key(choice) }
  }

  static func key(_ c: RunsOn) -> String {
    switch c {
    case .shared: "shared"
    case .device(let id): "device-\(id)"
    }
  }

  /** The shared computer first, then every device you can use, in the hub's order. */
  static func options(nodes: [AgentNode]) -> [Option] {
    var out = [Option(choice: .shared, title: "Shared computer", line: "Always on · uses the server", symbol: "person.2", enabled: true)]
    for n in nodes where n.usable {
      let kind = n.capabilities?.platform == "win32" ? "Windows · " : n.capabilities?.platform == "linux" ? "Linux · " : ""
      let whose = n.mine == true ? "" : n.ownerName.map { " · \($0)'s" } ?? ""
      out.append(Option(choice: .device(n.id), title: n.name, line: n.online ? "\(kind)online\(whose)".capitalizedFirst : "Offline\(whose)",
                        symbol: n.capabilities?.platform == "darwin" ? "laptopcomputer" : "desktopcomputer", enabled: n.online))
    }
    return out
  }

  /** Where an agent runs now: the shared computer when it works there, else its device. */
  static func current(_ agent: Agent, sharedComputerId: String?) -> RunsOn? {
    if let shared = sharedComputerId, agent.computerId == shared { return .shared }
    return agent.nodeId.map { .device($0) }
  }

  static func title(_ c: RunsOn?, nodes: [AgentNode]) -> String? {
    switch c {
    case .none: nil
    case .shared: "Shared computer"
    case .device(let id): nodes.first { $0.id == id }?.name ?? "A device"
    }
  }

  /**
   * What moving it sends (PATCH /api/agents/:id). The shared computer: it works there. A device: its
   * AI runs there, on that device's own screen when it has one you can use, else with no computer.
   */
  static func patch(_ c: RunsOn, sharedComputerId: String?, computers: [Computer], nodes: [AgentNode]) -> Fields? {
    switch c {
    case .shared:
      guard let shared = sharedComputerId else { return nil }
      return ["computerId": AnyEncodable(shared)]
    case .device(let id):
      let node = nodes.first { $0.id == id }
      let screen = node?.mine == true ? computers.first { $0.kind == "device" && $0.nodeId == id }?.id : nil
      return ["nodeId": AnyEncodable(id), "computerId": screen.map { AnyEncodable($0) } ?? .null]
    }
  }
}

/** The Runs on row: its value on the right, the choices in a menu (instant, like every menu). */
struct RunsOnRow: View {
  @Environment(Store.self) private var store
  var selection: RunsOn?
  var id = "runs-on"
  /** a plain list (All settings) has no icons */
  var icon = true
  var pick: (RunsOn) -> Void

  var body: some View {
    Menu {
      ForEach(RunsOn.options(nodes: store.nodes)) { o in
        // a menu row: its name, the line under it, and a check on the one it runs on
        Button { pick(o.choice) } label: {
          Text(o.title)
          Text(o.line)
          Image(systemName: o.choice == selection ? "checkmark" : o.symbol)
        }
        .disabled(!o.enabled)
      }
    } label: {
      RowLabel(title: "Runs on", value: RunsOn.title(selection, nodes: store.nodes) ?? "Pick", leading: { if icon { rowIcon("cpu") } })
    }
    .menuOrder(.fixed)
    .accessibilityIdentifier(id)
  }
}

/** The profile's Runs on row: moving the agent saves at once. */
struct AgentRunsOnRow: View {
  @Environment(Store.self) private var store
  var agent: Agent
  /** the list's own: its error line shows under the list */
  var action: FormAction
  var icon = true
  @State private var sharedId: String?

  var body: some View {
    RunsOnRow(selection: RunsOn.current(agent, sharedComputerId: sharedId), id: "agent-runs-on", icon: icon) { choice in
      action.run {
        var shared = sharedId
        if choice == .shared, shared == nil, store.isOwner {
          let made: Computer? = try? await store.fetch { try await $0.post("/api/computers/shared", Empty()) }
          shared = made?.id; sharedId = shared
          await store.refreshComputers()
        }
        guard let fields = RunsOn.patch(choice, sharedComputerId: shared, computers: store.computers, nodes: store.nodes) else {
          throw API.Failure(status: 0, message: "There's no shared computer yet. Your Bubble AI's owner can make one.")
        }
        _ = try await store.updateAgent(agent.id, fields)
      }
    }
    .disabled(action.busy)
    .task { sharedId = (try? await store.computerSettings())?.sharedComputerId }
  }
}
