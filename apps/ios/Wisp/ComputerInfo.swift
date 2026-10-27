import SwiftUI

/**
 * The small bubble behind a computer's info button (focus-PhoneWatch.dc.html): its kind, status, who is in control,
 * the device it lives on, the agents on it and the last three things that happened. "All activity" opens the full list.
 */
struct ComputerInfoBubble: View {
  @Environment(Store.self) private var store
  var computerId: String
  var openDevice: (String) -> Void
  var openAll: () -> Void
  @State private var log: [ComputerLogEntry]?

  private var computer: Computer? { store.computers.first { $0.id == computerId } }

  var body: some View {
    if let c = computer {
      VStack(alignment: .leading, spacing: 10) {
        row("Kind") { Text(c.kindLabel).foregroundStyle(Palette.text) }
        row("Status") { ComputerStatus(computer: c) }
        if let who = c.controller {
          row("In control") {
            Text(who.id == store.me?.id ? "You" : store.members.first { $0.id == who.id }.map { $0.preferredName ?? $0.name } ?? "Someone").foregroundStyle(Palette.text)
          }
        }
        if let node = store.nodes.first(where: { $0.id == c.nodeId }) {
          row("Lives on") {
            Button { openDevice(node.id) } label: {
              HStack(spacing: 4) {
                Text(node.name).lineLimit(1)
                Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold))
              }.foregroundStyle(Palette.computer)
            }.buttonStyle(.plain)
          }
        }
        let on = c.agentIds.compactMap { store.agent($0) }
        if !on.isEmpty {
          row("Agents") {
            HStack(spacing: -6) { ForEach(on.prefix(4)) { AgentAvatar(agent: $0, size: 22, showStatus: false) } }
          }
        }
        Divider().overlay(Palette.separator)
        if let log {
          if log.isEmpty { Text("Nothing yet.").font(.system(size: 13)).foregroundStyle(Palette.faint) }
          ForEach(log.prefix(3)) { entry in
            HStack(alignment: .firstTextBaseline, spacing: 8) {
              Circle().fill(dot(entry)).frame(width: 7, height: 7).offset(y: -1)
              Text(sentence(entry)).font(.system(size: 13)).foregroundStyle(Palette.muted).lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
          }
        } else {
          ProgressView().controlSize(.small).frame(maxWidth: .infinity)
        }
        Button(action: openAll) {
          Text("All activity").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.computer).frame(maxWidth: .infinity, alignment: .leading)
        }.buttonStyle(.plain).accessibilityIdentifier("computer-all-activity")
      }
      .font(.system(size: 13))
      .padding(16)
      .frame(width: 300, alignment: .leading)
      .task(id: "\(c.activity?.at ?? "") \(c.controller?.id ?? "")") {
        do { log = try await store.computerLog(c) } catch is Store.Stale {} catch { log = log ?? [] }
      }
    }
  }

  private func row<V: View>(_ title: String, @ViewBuilder _ value: () -> V) -> some View {
    HStack {
      Text(title).foregroundStyle(Palette.faint)
      Spacer(minLength: 12)
      value()
    }
  }

  private func dot(_ e: ComputerLogEntry) -> Color { ComputerLogLine.dot(e) }

  private func sentence(_ e: ComputerLogEntry) -> String {
    ComputerLogLine.sentence(e, store: store)
  }
}

/** Words and colors for one line of a computer's activity. */
enum ComputerLogLine {
  /** by what the line says, the same on every screen: took control amber, handed it back green, opened the live view sky, the rest gray */
  static func dot(_ e: ComputerLogEntry) -> Color {
    let t = e.text.lowercased()
    if t.contains("took control") { return Palette.statusNeeds }
    if t.contains("handed it back") { return Palette.statusOnline }
    if t.contains("opened the live view") { return Palette.tabComputers }
    return Palette.statusOffline
  }

  @MainActor static func sentence(_ e: ComputerLogEntry, store: Store) -> String {
    if e.actor.id == "system" { return e.text }
    let name = e.actor.kind == .agent ? (store.agent(e.actor.id)?.name ?? "An agent")
      : e.actor.id == store.me?.id ? "You" : (store.members.first { $0.id == e.actor.id }.map { $0.preferredName ?? $0.name } ?? "Someone")
    return "\(name) \(ComputerDetailsView.lowered(e.text))"
  }
}
