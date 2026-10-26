import SwiftUI

/** What a computer is, who uses it, and who did what on it. */
struct ComputerDetailsView: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var computerId: String
  @State private var log: [ComputerLogEntry]?

  private var computer: Computer? { store.computers.first { $0.id == computerId } }
  private var inControl: Bool { computer?.controller != nil && computer?.controller?.id == store.me?.id }

  var body: some View {
    NavigationStack {
      List {
        if let c = computer {
          Section {
            LabeledContent("Kind", value: c.kindLabel)
            LabeledContent("Status") { ComputerStatus(computer: c) }
            if let who = c.controller, !inControl { LabeledContent("In control", value: store.members.first { $0.id == who.id }.map { $0.preferredName ?? $0.name } ?? "Someone") }
            Text(explanation(c)).font(.footnote).foregroundStyle(.secondary)
            if c.status == "error", !c.statusText.isEmpty { Text(c.statusText).font(.footnote).foregroundStyle(.red) }
          }

          Section {
            let on = c.agentIds.compactMap { store.agent($0) }
            if on.isEmpty {
              Text("None yet. Give an agent this computer on its page (Agents → Computer). Agents that share a computer share its files, browser and sign-ins.")
                .font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(on) { a in
              HStack(spacing: 10) {
                AgentAvatar(agent: a, size: 28)
                Text(a.name)
                Text("@\(a.handle)").foregroundStyle(.secondary)
                Spacer()
                if a.status == .busy { ProgressView().controlSize(.small) }
              }
            }
          } header: {
            Text("Agents on this computer")
          }

          Section("Activity") {
            if let log {
              if log.isEmpty { Text("Nothing yet.").foregroundStyle(.secondary) }
              ForEach(log.prefix(50)) { entry in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                  Text(Self.ago(entry.at)).font(.caption.monospacedDigit()).foregroundStyle(.tertiary).frame(width: 56, alignment: .leading)
                  who(entry).fixedSize(horizontal: false, vertical: true)
                }
              }
            } else {
              HStack { Spacer(); ProgressView(); Spacer() }
            }
          }
        }
      }
      .groundBackground()
      .navigationTitle("Details")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
      .task(id: "\(computer?.activity?.at ?? "") \(computer?.controller?.id ?? "")") { await loadLog() }
    }
  }

  private func explanation(_ c: Computer) -> String {
    if inControl { return "You're in control: taps and typing go to this computer, and agents wait until you hand it back." }
    if c.controller != nil { return "Someone has control; agents are waiting." }
    if c.kind == "device" { return "Take control to use it from here. Agents that run on this device use it for things you ask." }
    return "Agents use it on their own. Take control to use it yourself; they pause until you hand it back."
  }

  @ViewBuilder private func who(_ e: ComputerLogEntry) -> some View {
    if e.actor.id == "system" {
      // things that happened on their own (wrong codes) read as a sentence
      Text(e.text).foregroundStyle(.secondary).font(.footnote)
    } else {
      let name = e.actor.kind == .agent ? (store.agent(e.actor.id)?.name ?? "An agent") : (e.actor.id == store.me?.id ? "You" : store.members.first { $0.id == e.actor.id }.map { $0.preferredName ?? $0.name } ?? "Someone")
      Text("\(Text(name).fontWeight(.medium)) \(Text(Self.lowered(e.text)).foregroundStyle(.secondary))").font(.footnote)
    }
  }

  static func lowered(_ text: String) -> String { text.prefix(1).lowercased() + text.dropFirst() }

  static func ago(_ iso: String) -> String {
    guard let d = Wire.date(iso) else { return "" }
    let s = Int(Date().timeIntervalSince(d))
    if s < 60 { return "now" }
    if s < 3600 { return "\(s / 60)m ago" }
    if s < 86_400 { return "\(s / 3600)h ago" }
    return "\(s / 86_400)d ago"
  }

  private func loadLog() async {
    guard let c = computer else { return }
    do { log = try await store.computerLog(c) } catch is Store.Stale {} catch { log = log ?? [] }
  }
}
