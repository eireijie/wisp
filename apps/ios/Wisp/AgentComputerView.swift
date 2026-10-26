import SwiftUI

/** The computer a new or imported agent gets: a new VM or screen on its device, one that exists, or none. */
enum ComputerChoice: Hashable {
  case vm, screen, existing(String), later, headless

  /** Follow what the device does for agents; otherwise reuse a shared computer first. Your own screen is only the default on your own device set to let agents use it. */
  static func initial(for node: AgentNode?, computers: [Computer]) -> ComputerChoice {
    if node?.role == "headless" { return .headless }
    if node?.role == "screen", node?.mine == true {
      if let screen = computers.first(where: { $0.kind == "device" && $0.nodeId == node?.id }) { return .existing(screen.id) }
      if node?.capabilities?.screen?.ok == true { return .screen }
    }
    if let shared = computers.first(where: { $0.kind == "vm" && $0.nodeId == node?.id }) ?? computers.first(where: { $0.kind == "orgo" }) { return .existing(shared.id) }
    if node?.capabilities?.vm?.ok == true { return .vm }
    return .later
  }

  /** Make the chosen computer if it's new, and return its id; nil for none. */
  @MainActor func resolve(nodeId: String, agentName: String, store: Store) async throws -> String? {
    switch self {
    case .existing(let id): return id
    case .vm: return try await store.createComputer(["kind": AnyEncodable("vm"), "nodeId": AnyEncodable(nodeId), "name": AnyEncodable("\(agentName)'s desk")]).id
    case .screen: return try await store.createComputer(["kind": AnyEncodable("device"), "nodeId": AnyEncodable(nodeId)]).id
    case .later, .headless: return nil
    }
  }

  /** Whether the agent will live inside a VM on its device. */
  func vmOnDevice(_ nodeId: String, computers: [Computer]) -> Bool {
    switch self {
    case .vm: return true
    case .existing(let id): return computers.contains { $0.id == id && $0.kind == "vm" && $0.nodeId == nodeId }
    default: return false
    }
  }
}

/** A short list of ways to give an agent a computer on a device, for choosing before it exists. */
struct ComputerChoicePicker: View {
  @Environment(Store.self) private var store
  @Binding var choice: ComputerChoice
  var node: AgentNode?

  var body: some View {
    Picker("Computer", selection: $choice) {
      if node?.capabilities?.vm?.ok == true { Text("A new VM on \(node?.name ?? "the device")").tag(ComputerChoice.vm) }
      if node?.mine == true, node?.capabilities?.screen?.ok == true, !store.computers.contains(where: { $0.kind == "device" && $0.nodeId == node?.id }) {
        Text("Your own screen").tag(ComputerChoice.screen)
      }
      ForEach(store.computers) { Text($0.name).tag(ComputerChoice.existing($0.id)) }
      Text("Pick later").tag(ComputerChoice.later)
      Text("Headless (no computer)").tag(ComputerChoice.headless)
    }
  }
}

