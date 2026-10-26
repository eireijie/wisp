import SwiftUI

/**
 * Teach a task: an agent watches while you do it once on a computer. Taps, typing, keys and
 * scrolls are noted as steps (with a picture of the screen before each click), and the agent
 * writes them up as a routine. What you say along the way is typed.
 */
@Observable @MainActor
final class TeachSession {
  let agent: Agent
  var recording = TeachRecording()
  var narration = ""

  init(agent: Agent) { self.agent = agent }

  /** Note one step. Pass the screen the person saw, for the clicks that get a picture. */
  func record(_ store: Store, _ computer: Computer, kind: String, frame: Frame? = nil, x: Int? = nil, y: Int? = nil, toX: Int? = nil, toY: Int? = nil, text: String? = nil, keys: String? = nil, direction: String? = nil) {
    guard let index = recording.add(kind: kind, x: x, y: y, toX: toX, toY: toY, text: text, keys: keys, direction: direction, snapshot: frame.flatMap { UIImage.lessonJPEG(from: $0.image) }) else { return }
    // on a VM, also note which page element it was, so the routine survives layout changes
    guard teachInspects(kind: kind, computerKind: computer.kind), let x, let y, let frame, frame.width > 0 else { return }
    Task {
      if let element = try? await store.inspect(computer, x: x, y: y, width: frame.width, height: frame.height) {
        recording.setElement(element, at: index)
      }
    }
  }
}

/** Pick which agent learns the task: the ones on this computer first, else any. */
struct TeachAgentPicker: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var computer: Computer
  var onPick: (Agent) -> Void

  private var agents: [Agent] {
    let on = computer.agentIds.compactMap { store.agent($0) }
    return on.isEmpty ? store.agents : on
  }

  var body: some View {
    NavigationStack {
      List {
        Section {
          ForEach(agents) { a in
            Button { dismiss(); onPick(a) } label: {
              HStack(spacing: 12) {
                AgentAvatar(agent: a, size: 32, showStatus: false)
                Text(a.name).foregroundStyle(.primary)
                Text("@\(a.handle)").foregroundStyle(.secondary)
                Spacer()
                Image(systemName: "chevron.right").font(.footnote).foregroundStyle(.tertiary)
              }
            }
          }
        } footer: {
          Text("Do the task once on this computer while an agent watches. It saves the steps as a routine and can do it on its own next time, on a schedule if you like.")
        }
      }
      .groundBackground()
      .navigationTitle("Teach a task")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
      .overlay { if agents.isEmpty { ContentUnavailableView("No agents yet", systemImage: "person.crop.circle.badge.questionmark") } }
    }
  }
}

/** "Nova is watching and learning ● 0:04": above the screen while you show the task. */
struct TeachBar: View {
  var session: TeachSession
  var cancel: () -> Void
  var done: () -> Void

  var body: some View {
    @Bindable var session = session
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 10) {
        AgentAvatar(agent: session.agent, size: 30, showStatus: false)
        VStack(alignment: .leading, spacing: 1) {
          Text("\(session.agent.name) is watching and learning").font(.subheadline.weight(.semibold)).lineLimit(2)
          let n = session.recording.count
          Text("Do the task once, as you normally would. \(n) step\(n == 1 ? "" : "s") so far.").font(.caption).foregroundStyle(.secondary)
        }
        Spacer(minLength: 4)
        TimelineView(.periodic(from: .now, by: 0.5)) { ctx in
          HStack(spacing: 5) {
            Circle().fill(Palette.red).frame(width: 8, height: 8)
            Text(TeachRecording.clock(max(0, Int(ctx.date.timeIntervalSince(session.recording.started))))).font(.subheadline.monospacedDigit())
          }
        }
      }
      TextField("Explain anything as you go (optional)", text: $session.narration, axis: .vertical)
        .lineLimit(1...3)
        .font(.callout)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.field))
      HStack(spacing: 10) {
        Button { cancel() } label: { Text("Cancel").frame(maxWidth: .infinity) }.secondaryButton().controlSize(.regular)
        Button { done() } label: { Text("Done").frame(maxWidth: .infinity) }.primaryButton().controlSize(.regular).disabled(session.recording.count == 0)
      }
    }
    .card(Corner.card, padding: 12)
  }
}

/** Name the lesson and send it: the agent studies the steps and writes them up as a routine. */
struct TeachSaveSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var session: TeachSession
  var computer: Computer
  var onSaved: () -> Void

  @State private var name = ""
  @State private var saving = false
  @State private var error: String?

  var body: some View {
    @Bindable var session = session
    NavigationStack {
      Form {
        Section {
          TextField("Weekly reporting", text: $name)
        } header: {
          Text("What's the task called?")
        } footer: {
          Text("\(session.agent.name) studies your \(session.recording.count) step\(session.recording.count == 1 ? "" : "s") and writes them up as a routine you can run anytime or on a schedule.")
        }
        Section("Anything else it should know? (optional)") {
          TextField("Which parts change each time, where to find inputs, what done looks like…", text: $session.narration, axis: .vertical).lineLimit(3...8)
        }
        if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
      }
      .groundBackground()
      .navigationTitle("Save what you showed")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Keep recording") { dismiss() }.disabled(saving) }
        ToolbarItem(placement: .confirmationAction) {
          Button { save() } label: { if saving { ProgressView() } else { Text("Teach \(session.agent.name)") } }
            .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || saving)
        }
      }
      .interactiveDismissDisabled(saving)
    }
  }

  private func save() {
    saving = true
    error = nil
    Task {
      defer { saving = false }
      do {
        try await store.saveLesson(agent: session.agent, computer: computer, name: name, recording: session.recording, narration: session.narration)
        dismiss()
        onSaved()
      } catch is Store.Stale {} catch { self.error = error.localizedDescription }
    }
  }
}
