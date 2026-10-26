import QuickLook
import SwiftUI

/**
 * A file shared in a message. Images show inline; anything opens in Quick Look, whose share button
 * saves it to Files or Photos. Files need the session's token, so they're fetched by the app first.
 */
struct FileChip: View {
  @Environment(Store.self) private var store
  var id: String
  var name: String
  @State private var image: UIImage?
  @State private var preview: URL?
  @State private var loading = false
  @State private var failed = false

  private var isImage: Bool { UploadedFile.isImage(name) }

  var body: some View {
    Button { open() } label: {
      if let image {
        Image(uiImage: image)
          .resizable()
          .scaledToFit()
          .frame(maxWidth: 260, maxHeight: 260, alignment: .leading)
          .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
          .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color(.separator), lineWidth: 0.5))
      } else {
        HStack(spacing: 6) {
          if loading { ProgressView().controlSize(.mini) } else { Image(systemName: failed ? "exclamationmark.triangle" : isImage ? "photo" : "doc") }
          Text(name).lineLimit(1)
        }
        .font(.callout)
        .foregroundStyle(failed ? .secondary : .primary)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(Capsule().fill(Color(.secondarySystemBackground)))
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel(failed ? "\(name), couldn't open" : "Open \(name)")
    .quickLookPreview($preview)
    .task(id: id) {
      guard isImage, image == nil, let url = try? await store.localFile(id, name: name) else { return }
      image = AttachmentThumbnail.image(at: url)
    }
  }

  private func open() {
    loading = true
    failed = false
    Task {
      do { preview = try await store.localFile(id, name: name) } catch { failed = true }
      loading = false
    }
  }
}

/** A task this message hands out: what it is, who has it and how it's going. */
struct TaskChip: View {
  @Environment(Store.self) private var store
  var taskId: String
  @State private var open: TaskRef?

  var body: some View {
    if let task = store.tasks.first(where: { $0.id == taskId }) {
      Button { open = TaskRef(id: task.id) } label: {
        HStack(spacing: 6) {
          Image(systemName: "checklist").foregroundStyle(.secondary)
          Text(task.title).fontWeight(.semibold).lineLimit(1)
          if let agent = store.agent(task.toAgentId ?? "") {
            AgentAvatar(agent: agent, size: 16, showStatus: false)
            Text(agent.name).foregroundStyle(.secondary).lineLimit(1)
          }
          Text(store.taskState(task))
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(Color(.tertiarySystemFill)))
        }
        .font(.caption)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(Capsule().fill(Color(.secondarySystemBackground)))
      }
      .buttonStyle(.plain)
      .sheet(item: $open) { TaskSheet(taskId: $0.id) }
    } else {
      // a task handed out after the list was loaded: fetch it once
      Color.clear.frame(height: 0).task { try? await store.refreshTasks() }
    }
  }
}

/** A routine that was taught, changed or run. */
struct RoutineChip: View {
  @Environment(Store.self) private var store
  var routineId: String

  var body: some View {
    if let routine = store.routines.first(where: { $0.id == routineId }) {
      let chip = HStack(spacing: 6) {
        Image(systemName: "list.bullet.clipboard").foregroundStyle(.secondary)
        Text(routine.name).fontWeight(.semibold).lineLimit(1)
        if routine.status == "learning" {
          Text("learning").foregroundStyle(.blue)
        } else if let schedule = routine.schedule {
          Label(describeCron(schedule), systemImage: "calendar.badge.clock").foregroundStyle(.secondary).lineLimit(1)
        }
      }
      .font(.caption)
      .padding(.horizontal, 10)
      .padding(.vertical, 7)
      .background(Capsule().fill(Color(.secondarySystemBackground)))
      if let agent = store.agent(routine.agentId) {
        NavigationLink { RoutinesView(agent: agent) } label: { chip }.buttonStyle(.plain)
      } else {
        chip
      }
    } else {
      Color.clear.frame(height: 0).task { try? await store.refreshRoutines() }
    }
  }
}

/** Live progress of a discussion: which round, who has answered, and the decision once it's written. */
struct DiscussionCard: View {
  @Environment(Store.self) private var store
  var discussionId: String
  @State private var stopping = false

  var body: some View {
    if let d = store.discussions[discussionId] {
      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 6) {
          Image(systemName: "bubble.left.and.bubble.right").foregroundStyle(.blue)
          Text(d.topic).font(.callout.weight(.semibold)).lineLimit(2)
          Spacer(minLength: 4)
          Text(label(d.status))
            .font(.caption2.weight(.semibold))
            .foregroundStyle(d.status == "done" ? .green : d.live ? .blue : .secondary)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Capsule().fill(Color(.tertiarySystemFill)))
        }
        if d.live {
          Text(d.status == "summarizing" ? "Writing the decision" : "Round \(max(d.round, 1)) of \(d.rounds)")
            .font(.caption).foregroundStyle(.secondary)
          FlowRow(ids: d.status == "summarizing" ? [d.moderatorId] : d.participants, progress: d.progress ?? [])
          if store.role != "guest" {
            Button {
              stopping = true
              Task {
                try? await store.stopDiscussion(d.id)
                stopping = false
              }
            } label: { Label("Stop", systemImage: "stop.fill") }
              .font(.caption.weight(.semibold))
              .tint(.red)
              .disabled(stopping)
          }
        }
        if let path = d.decisionPath {
          NavigationLink { NoteView(path: path) } label: {
            Label("Read the decision", systemImage: "book").font(.caption.weight(.semibold))
          }
        }
      }
      .frame(maxWidth: 420, alignment: .leading)
      .card(Corner.card, padding: 12)
    } else {
      Color.clear.frame(height: 0).task { await store.loadDiscussion(discussionId) }
    }
  }

  private func label(_ status: String) -> String {
    switch status {
    case "running": "in progress"
    case "summarizing": "writing the decision"
    case "done": "decided"
    default: "stopped"
    }
  }

  /** The agents taking part, each with how far it got this round. */
  private struct FlowRow: View {
    @Environment(Store.self) private var store
    var ids: [String]
    var progress: [Discussion.Progress]

    var body: some View {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          ForEach(ids, id: \.self) { id in
            let state = progress.first { $0.agentId == id }?.status
            HStack(spacing: 4) {
              AgentAvatar(agent: store.agent(id), size: 18, showStatus: false)
              Text(store.agent(id)?.name ?? "Agent").lineLimit(1)
              switch state {
              case "done": Image(systemName: "checkmark").foregroundStyle(.green)
              case "running": ProgressView().controlSize(.mini)
              case "queued": Image(systemName: "clock").foregroundStyle(.orange)
              default: EmptyView()
              }
            }
            .font(.caption)
            .padding(.leading, 2)
            .padding(.trailing, 8)
            .padding(.vertical, 2)
            .background(Capsule().fill(Color(.tertiarySystemFill)))
            .accessibilityElement(children: .combine)
            .accessibilityValue(state == "done" ? "answered" : state == "running" ? "answering" : state == "queued" ? "waiting for its device" : "")
          }
        }
      }
    }
  }
}

/** An agent's answer to /context: how full its conversation is. */
struct ContextCard: View {
  @Environment(Store.self) private var store
  var usage: ContextUsage?
  /** the message it sits in, so the agent's own "compact" can be run from here */
  var message: Message? = nil
  @State private var shrink: AgentCommand?
  @State private var running = false
  @State private var error: String?

  var body: some View {
    let used = usage?.contextUsed
    let window = usage?.contextWindow
    let fraction = used.flatMap { u in window.map { min(1, Double(u) / Double(max($0, 1))) } }
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline) {
        Text(used.map { "\(Self.tokens($0))\(window.map { " of \(Self.tokens($0))" } ?? "") used" } ?? "Nothing used yet")
          .font(.callout.weight(.semibold))
          .monospacedDigit()
        Spacer(minLength: 8)
        if let model = usage?.model { Text(model).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
      }
      if let fraction {
        ProgressView(value: fraction).tint(fraction > 0.85 ? .red : fraction > 0.6 ? .orange : .green)
      }
      if used == nil { Text("This shows up after its first reply here.").font(.caption).foregroundStyle(.secondary) }
      if let shrink, used != nil, store.role != "guest" {
        Button(shrink.name == "compact" ? "Compact" : "Compress") { run(shrink) }
          .secondaryButton().controlSize(.small).disabled(running)
      }
      if let error { Text(error).font(.caption).foregroundStyle(.red) }
    }
    .frame(maxWidth: 360, alignment: .leading)
    .card(Corner.card, padding: 12)
    .task(id: message?.author.id) {
      guard let message, message.author.kind == .agent else { return }
      shrink = await SlashMenuModel.commands(store, agentId: message.author.id).first { $0.via == "raw" && ($0.name == "compact" || $0.name == "compress") }
    }
  }

  /** Ask the agent to shrink its conversation by sending its command, in the same thread. */
  private func run(_ command: AgentCommand) {
    guard let message, let agent = store.agent(message.author.id) else { return }
    let dm = store.channels.first { $0.id == message.channelId }.map { store.dmAgent($0) != nil } ?? false
    running = true; error = nil
    Task {
      do { try await store.send("\(dm ? "" : "@\(agent.handle) ")/\(command.name)", in: message.channelId, thread: message.threadId) }
      catch { self.error = error.localizedDescription }
      running = false
    }
  }

  /** 1234 → "1.2k", 200000 → "200k" */
  static func tokens(_ n: Int) -> String {
    if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000).replacingOccurrences(of: ".0M", with: "M") }
    if n >= 1000 { return String(format: n >= 10_000 ? "%.0fk" : "%.1fk", Double(n) / 1000).replacingOccurrences(of: ".0k", with: "k") }
    return "\(n)"
  }
}

/** Fix a sent message in place. */
struct EditMessageSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var message: Message
  @State private var text = ""
  @State private var busy = false
  @State private var error: String?
  @FocusState private var focused: Bool

  var body: some View {
    NavigationStack {
      Form {
        TextField("Message", text: $text, axis: .vertical)
          .lineLimit(3...14)
          .focused($focused)
          .accessibilityLabel("Edit message")
        if let error { Text(error).font(.footnote).foregroundStyle(.red) }
      }
      .navigationTitle("Edit message")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") { save() }.disabled(busy || (text.trimmed.isEmpty && message.files.isEmpty))
        }
      }
      .onAppear {
        text = message.body
        focused = true
      }
    }
    .presentationDetents([.medium, .large])
  }

  private func save() {
    guard text != message.body else { return dismiss() }
    busy = true
    error = nil
    Task {
      do {
        try await store.editMessage(message, body: text)
        dismiss()
      } catch {
        self.error = error.localizedDescription
        busy = false
      }
    }
  }
}
