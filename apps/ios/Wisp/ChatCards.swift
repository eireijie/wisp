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
      } else {
        HStack(spacing: 6) {
          if loading { ProgressView().controlSize(.mini) } else { Image(systemName: failed ? "exclamationmark.triangle" : isImage ? "photo" : "doc") }
          Text(name).lineLimit(1)
        }
        .font(.callout)
        .foregroundStyle(failed ? .secondary : .primary)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.card))
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

/** A task an agent mentions: what it is, who has it and how it's going. */
struct TaskChip: View {
  @Environment(Store.self) private var store
  var taskId: String
  @State private var open: TaskRef?

  var body: some View {
    if let task = store.tasks.first(where: { $0.id == taskId }) {
      Button { open = TaskRef(id: task.id) } label: {
        ChatCardShell(symbol: "checklist", label: "Task") {
          Text(task.title).font(.system(size: 15, weight: .semibold)).multilineTextAlignment(.leading)
          HStack(spacing: 8) {
            Text(store.taskState(task))
              .font(.system(size: 12, weight: .semibold))
              .padding(.horizontal, 9).padding(.vertical, 3)
              .background(Capsule().fill(Palette.control))
            if let agent = store.agent(task.toAgentId ?? "") {
              HStack(spacing: 5) {
                AgentAvatar(agent: agent, size: 18, showStatus: false)
                Text(agent.name).font(.system(size: 13)).foregroundStyle(Palette.muted).lineLimit(1)
              }
            }
          }
        }
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
      let card = ChatCardShell(symbol: "list.bullet.clipboard", label: "Routine") {
        HStack(spacing: 8) {
          Text(routine.name).font(.system(size: 15, weight: .semibold)).lineLimit(2)
          if routine.status == "learning" {
            Text("Learning").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.blue)
              .padding(.horizontal, 9).padding(.vertical, 3).background(Capsule().fill(Palette.control))
          }
        }
        if let schedule = routine.schedule {
          Label(describeCron(schedule), systemImage: "calendar.badge.clock").font(.system(size: 13)).foregroundStyle(Palette.muted).lineLimit(1)
        }
      }
      if let agent = store.agent(routine.agentId) {
        NavigationLink { RoutinesView(agent: agent) } label: { card }.buttonStyle(.plain)
      } else {
        card
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
      ChatCardShell(symbol: "bubble.left.and.bubble.right", label: "Discussion") {
        Text(title(d)).font(.system(size: 15, weight: .semibold)).multilineTextAlignment(.leading)
        if d.live {
          Text(d.status == "summarizing" ? "Writing the decision" : "Round \(max(d.round, 1)) of \(d.rounds)")
            .font(.system(size: 13)).foregroundStyle(Palette.muted)
          FlowRow(ids: d.status == "summarizing" ? [d.moderatorId] : d.participants, progress: d.progress ?? [])
          if store.role != "guest" {
            Button {
              stopping = true
              Task {
                try? await store.stopDiscussion(d.id)
                stopping = false
              }
            } label: { Label("Stop", systemImage: "stop.fill").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.red) }
              .disabled(stopping)
          }
        }
        if let path = d.decisionPath {
          NavigationLink { NoteView(path: path) } label: {
            Label("Read the decision", systemImage: "chevron.right").labelStyle(TrailingIconLabel())
              .font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text)
              .padding(.horizontal, 16).frame(height: 40)
              .background(Capsule().fill(Palette.control)).overlay(Capsule().strokeBorder(Palette.hairline))
          }.buttonStyle(.plain)
        }
      }
    } else {
      Color.clear.frame(height: 0).task { await store.loadDiscussion(discussionId) }
    }
  }

  private func title(_ d: Discussion) -> String {
    switch d.status {
    case "done": "Decided: \(d.topic)"
    case "running", "summarizing":
      "Talking it through with \(ChannelTeam.list((d.status == "summarizing" ? [d.moderatorId] : d.participants).compactMap { store.agent($0)?.name }))…"
    default: d.topic
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
              case "done": Image(systemName: "checkmark").foregroundStyle(Palette.statusOnline)
              case "running": ProgressView().controlSize(.mini)
              case "queued": Image(systemName: "clock").foregroundStyle(.orange)
              default: EmptyView()
              }
            }
            .font(.caption)
            .padding(.leading, 2)
            .padding(.trailing, 8)
            .padding(.vertical, 2)
            .background(Capsule().fill(Palette.control))
            .accessibilityElement(children: .combine)
            .accessibilityValue(state == "done" ? "answered" : state == "running" ? "answering" : state == "queued" ? "waiting for its device" : "")
          }
        }
      }
    }
  }
}

/** A label with its icon after the words. */
struct TrailingIconLabel: LabelStyle {
  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: 6) { configuration.title; configuration.icon.font(.system(size: 12, weight: .semibold)) }
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
    ChatCardShell(symbol: "gauge.with.dots.needle.33percent", label: "Context window") {
      HStack(alignment: .firstTextBaseline) {
        Text(Self.words(fraction)).font(.system(size: 15, weight: .semibold))
        Spacer(minLength: 8)
        if let model = usage?.model { Text(model).font(.caption).foregroundStyle(Palette.muted).lineLimit(1) }
      }
      if let fraction {
        ProgressView(value: fraction).tint(fraction > 0.85 ? .red : fraction > 0.6 ? .orange : Palette.statusOnline)
      }
      Text(used.map { "\(Self.tokens($0))\(window.map { " of \(Self.tokens($0))" } ?? "") used. Older messages are summarized when it fills up." } ?? "This shows up after its first reply here.")
        .font(.system(size: 13)).foregroundStyle(Palette.muted)
      if let shrink, used != nil, store.role != "guest" {
        Button(shrink.name == "compact" ? "Compact" : "Compress") { run(shrink) }
          .buttonStyle(.plain).font(.system(size: 15, weight: .semibold))
          .padding(.horizontal, 16).frame(height: 40)
          .background(Capsule().fill(Palette.control)).overlay(Capsule().strokeBorder(Palette.hairline))
          .disabled(running)
      }
      if let error { Text(error).font(.caption).foregroundStyle(Palette.red) }
    }
    .task(id: message?.author.id) {
      guard let message, message.author.kind == .agent else { return }
      shrink = await SlashMenuModel.commands(store, agentId: message.author.id).first { $0.via == "raw" && ($0.name == "compact" || $0.name == "compress") }
    }
  }

  /** "Roughly half full" for the card's headline. */
  static func words(_ fraction: Double?) -> String {
    guard let f = fraction else { return "Nothing used yet" }
    return f < 0.35 ? "Roughly a third full" : f < 0.65 ? "Roughly half full" : f < 0.85 ? "Getting full" : "Nearly full"
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
