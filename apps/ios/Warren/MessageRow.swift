import QuickLook
import SwiftUI

struct MessageRow: View {
  @Environment(Store.self) private var store
  var message: Message
  /** the same author a moment ago: no avatar or name again */
  var compact: Bool
  var replies: Int
  /** the thread this message starts (or would start): any message can have one, a reply too */
  var thread: ThreadRef?
  /** agents working in that thread, or in a sub-thread under it */
  var working: [Agent] = []
  @State private var toolsOpen = false
  @State private var editing = false
  @State private var deleting = false
  @State private var error: String?

  private var tools: [String] {
    message.parts.compactMap { if case .toolCall(let n) = $0 { n } else { nil } }
  }

  var body: some View {
    if message.author.id == "system" { systemLine } else { row }
  }

  /** Warren's own notes ("@scout isn't connected to a device yet") as a quiet line, not a person. */
  private var systemLine: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Image(systemName: "info.circle")
      Text(message.parts.compactMap { if case .status(let t) = $0 { t } else if case .notice(let t) = $0 { t } else { nil } }.joined(separator: " ") + message.body)
    }
    .font(.caption)
    .foregroundStyle(.secondary)
    .padding(.horizontal, 16)
    .padding(.leading, 44)
    .padding(.vertical, 6)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var row: some View {
    HStack(alignment: .top, spacing: 10) {
      Group {
        if compact { Color.clear } else if message.author.kind == .agent { AgentAvatar(agent: store.agent(message.author.id), size: 34, showStatus: false) } else { PersonAvatar(name: store.name(of: message.author), size: 34) }
      }
      .frame(width: 34)

      VStack(alignment: .leading, spacing: 5) {
        if !compact {
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(store.name(of: message.author))
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(nameColor)
            if message.author.kind == .agent {
              Text("agent")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .background(Capsule().fill(Color(.tertiarySystemFill)))
            }
            Text(message.date, format: .dateTime.hour().minute())
              .font(.caption2)
              .foregroundStyle(.tertiary)
          }
        }
        if message.deletedAt != nil {
          Text("This message was deleted.").font(.body).italic().foregroundStyle(.secondary)
        }
        if !tools.isEmpty { toolLine }
        if !message.body.isEmpty {
          MarkdownText(message.body, edited: message.editedAt != nil)
        }
        ForEach(Array(message.parts.enumerated()), id: \.offset) { _, part in
          PartView(part: part, message: message)
        }
        if let r = message.reactions, !r.isEmpty {
          HStack(spacing: 4) {
            ForEach(r, id: \.emoji) { x in
              Text("\(x.emoji) \(x.actors.count)")
                .font(.caption)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(Capsule().fill(Color(.secondarySystemFill)))
            }
          }
        }
        if let thread, replies > 0 || !working.isEmpty {
          HStack(spacing: 8) {
            if replies > 0 {
              NavigationLink(value: thread) {
                Text(replies == 1 ? "1 reply" : "\(replies) replies")
                  .font(.caption.weight(.semibold))
                  .foregroundStyle(.blue)
              }
            }
            if !working.isEmpty { ThreadWork(agents: working, thread: thread) }
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.horizontal, 16)
    .padding(.top, compact ? 2 : 10)
    .padding(.bottom, 2)
    .contentShape(Rectangle())
    .contextMenu {
      if !message.body.isEmpty { Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.body } }
      if let thread { NavigationLink(value: thread) { Label("Reply in thread", systemImage: "arrowshape.turn.up.left") } }
      if store.canEdit(message) { Button("Edit", systemImage: "pencil") { editing = true } }
      if store.canDelete(message) { Button("Delete", systemImage: "trash", role: .destructive) { deleting = true } }
    }
    .sheet(isPresented: $editing) { EditMessageSheet(message: message) }
    .confirmationDialog(mine ? "Delete this message?" : "Delete this message from someone else?", isPresented: $deleting, titleVisibility: .visible) {
      Button("Delete", role: .destructive) {
        Task {
          do { try await store.deleteMessage(message) } catch { self.error = error.localizedDescription }
        }
      }
    } message: { Text("This can't be undone.") }
    .alert("Couldn't delete it", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
      Button("OK") {}
    } message: { Text(error ?? "") }
  }

  private var mine: Bool { message.author == Actor(kind: .user, id: store.me?.id ?? "") }

  /** agents' names in their own color, like the web app */
  private var nameColor: Color {
    guard message.author.kind == .agent, let look = store.agent(message.author.id)?.settings?.appearance else { return .primary }
    return Color(hex: look.color2 ?? look.color).mix(with: .primary, by: 0.35)
  }

  private var toolLine: some View {
    Button {
      withAnimation(.snappy) { toolsOpen.toggle() }
    } label: {
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 4) {
          Image(systemName: "wrench.and.screwdriver").font(.caption2)
          Text(tools.count == 1 ? "Used \(tools[0])" : "Used \(tools.count) tools")
          Image(systemName: "chevron.right").font(.caption2).rotationEffect(.degrees(toolsOpen ? 90 : 0))
        }
        if toolsOpen {
          ForEach(Array(tools.enumerated()), id: \.offset) { _, t in
            Text("· \(t)").font(.caption.monospaced())
          }
        }
      }
      .font(.caption)
      .foregroundStyle(.secondary)
    }
    .buttonStyle(.plain)
  }
}

/** Who's working in a thread (or a sub-thread of it), on the thread's row: "Cy is working in a sub-thread". */
struct ThreadWork: View {
  @Environment(Store.self) private var store
  var agents: [Agent]
  var thread: ThreadRef

  var body: some View {
    let deeper = agents.allSatisfy { store.inSubThread($0.id, of: thread.rootId) }
    let who = agents.count == 1 ? agents[0].name : agents.count == 2 ? "\(agents[0].name) and \(agents[1].name)" : "\(agents[0].name) and \(agents.count - 1) more"
    NavigationLink(value: thread) {
      HStack(spacing: 5) {
        HStack(spacing: -5) {
          ForEach(agents.prefix(3)) { a in
            AgentAvatar(agent: a, size: 16, showStatus: false)
              .padding(1)
              .background(Circle().fill(Color(.tertiarySystemFill)))
          }
        }
        GlowDot(color: .green)
        (Text(who).fontWeight(.semibold) + Text(" \(agents.count == 1 ? "is" : "are") working\(deeper ? " in a sub-thread" : "")"))
          .lineLimit(1)
      }
      .font(.caption)
      .foregroundStyle(.primary)
      .padding(.leading, 3)
      .padding(.trailing, 8)
      .padding(.vertical, 3)
      .background(Capsule().fill(Color(.tertiarySystemFill)))
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(who) \(agents.count == 1 ? "is" : "are") working\(deeper ? " in a sub-thread" : " in this thread")")
  }
}

struct PartView: View {
  @Environment(Store.self) private var store
  var part: MessagePart
  var message: Message

  var body: some View {
    switch part {
    case .notice(let t), .status(let t):
      Text(t).font(.caption).foregroundStyle(.secondary).italic()
    case .file(let id, let name):
      FileChip(id: id, name: name)
    case .task(let id):
      TaskChip(taskId: id)
    case .routine(let id):
      RoutineChip(routineId: id)
    case .discussion(let id):
      DiscussionCard(discussionId: id)
    case .context(let usage):
      ContextCard(usage: usage)
    case .approval(let id):
      ApprovalCard(approvalId: id)
    case .change(let id):
      ChangeCard(changeId: id)
    case .computer(let id, let request):
      ComputerCard(computerId: id, request: request)
    case .toolCall, .other:
      EmptyView()
    }
  }
}

/** Message bodies are Markdown; inline styles and links render, block structure stays as written. */
struct MarkdownText: View {
  var source: String
  /** its author changed it: "(edited)" at the end, like the web app */
  var edited = false
  init(_ s: String, edited: Bool = false) { source = s; self.edited = edited }

  var body: some View {
    Group {
      if edited {
        Text(attributed) + Text(" (edited)").font(.caption).foregroundStyle(.tertiary)
      } else {
        Text(attributed)
      }
    }
      .font(.body)
      .textSelection(.enabled)
      .fixedSize(horizontal: false, vertical: true)
  }

  private var attributed: AttributedString {
    var opts = AttributedString.MarkdownParsingOptions()
    opts.interpretedSyntax = .inlineOnlyPreservingWhitespace
    opts.failurePolicy = .returnPartiallyParsedIfPossible
    var s = (try? AttributedString(markdown: source, options: opts)) ?? AttributedString(source)
    for run in s.runs where run.inlinePresentationIntent?.contains(.code) == true {
      s[run.range].font = .body.monospaced()
      s[run.range].backgroundColor = Color(.secondarySystemFill)
    }
    return s
  }
}

/** What an agent changed for you (a setting, a mod), with Undo. */
struct ChangeCard: View {
  @Environment(Store.self) private var store
  var changeId: String
  @State private var busy = false
  @State private var error: String?

  private var change: Change? { store.changes?.first { $0.id == changeId } }

  var body: some View {
    if let change {
      VStack(alignment: .leading, spacing: 8) {
        ForEach(change.lines, id: \.self) { line in
          Label { Text(line).strikethrough(change.undoneAt != nil) } icon: { Image(systemName: "checkmark").foregroundStyle(.green) }
            .font(.callout)
            .foregroundStyle(change.undoneAt != nil ? .secondary : .primary)
        }
        HStack(spacing: 10) {
          if change.undoneAt != nil {
            Text("Undone").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
          } else {
            Button { undo() } label: { Label("Undo", systemImage: "arrow.uturn.backward") }
              .secondaryButton().controlSize(.small).disabled(busy)
              .accessibilityIdentifier("undo-change")
          }
          if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }.padding(.top, 2)
      }
      .frame(maxWidth: 360, alignment: .leading)
      .card(18, padding: 14)
    } else {
      // a change made after the list was loaded: fetch it once
      Color.clear.frame(height: 0).task { try? await store.refreshChanges() }
    }
  }

  private func undo() {
    busy = true; error = nil
    Task {
      do { try await store.undoChange(changeId) } catch { self.error = error.localizedDescription }
      busy = false
    }
  }
}

/** An agent asking for an OK before it acts, answerable right in the chat. */
struct ApprovalCard: View {
  @Environment(Store.self) private var store
  var approvalId: String
  var refresh = false
  @State private var loading = true
  @State private var error: String?

  private var approval: Approval? { store.approvals.first { $0.id == approvalId } }

  var body: some View {
    Group {
      if let a = approval {
        ApprovalBox(approval: a)
      } else if loading {
        ProgressView()
      } else {
        HStack {
          Text(error ?? "Approval not found.").foregroundStyle(.secondary)
          Button("Try again") { Task { await load() } }
        }.font(.footnote)
      }
    }
    .task(id: approvalId) { if approval == nil || refresh { await load() } }
  }

  private func load() async {
    loading = true
    error = nil
    do { _ = try await store.loadApproval(approvalId) }
    catch { self.error = "Couldn't load this approval." }
    loading = false
  }
}

/** An approval opened from a notification, even after it has been decided. */
struct ApprovalDetail: View {
  var approvalId: String

  var body: some View {
    ScrollView {
      ApprovalCard(approvalId: approvalId, refresh: true).padding(16)
    }
    .navigationTitle("Approval")
    .navigationBarTitleDisplayMode(.inline)
  }
}

struct ApprovalBox: View {
  @Environment(Store.self) private var store
  var approval: Approval
  /** who's asking, when it isn't clear from around the card */
  var agentName: String? = nil
  /** a row of a list, which is its own card */
  var inList = false
  @State private var busy = false
  @State private var error: String?
  @State private var expanded = false
  /** lending a screen with a code: its owner types it to say yes, and the device checks it */
  @State private var code = ""
  private var codeKind: String? { approval.loan == nil ? nil : store.loanScreen(approval)?.code }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        Image(systemName: approval.status == "pending" ? "hand.raised" : approval.status == "approved" ? "checkmark.circle.fill" : "xmark.circle.fill")
          .foregroundStyle(approval.status == "pending" ? .orange : approval.status == "approved" ? .green : .red)
        Text(approval.status == "pending" ? "\(agentName ?? "It") asks for your OK" : approval.status == "approved" ? "Approved" : "Not approved")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)
      }
      Text(approval.summary).font(.callout.weight(.semibold))
      if !approval.details.isEmpty {
        MarkdownText(approval.details)
          .lineLimit(expanded ? nil : 5)
          .font(.callout)
          .onTapGesture { expanded.toggle() }
      }
      if approval.status == "pending" {
        if let kind = codeKind { ScreenCodeField(kind: kind, code: $code) { decide(true) } }
        HStack(spacing: 8) {
          Button {
            decide(false)
          } label: {
            Text("Not now").frame(maxWidth: .infinity)
          }
          .secondaryButton()
          .controlSize(.large)
          Button {
            decide(true)
          } label: {
            Label("Approve", systemImage: "checkmark").fontWeight(.semibold).frame(maxWidth: .infinity)
          }
          .primaryButton()
          .disabled(!ScreenCodeField.ready(codeKind, code))
        }
        .disabled(busy)
      }
      if let error { Text(error).font(.caption).foregroundStyle(.red) }
    }
    .modifier(ApprovalSurface(inList: inList))
  }

  private func decide(_ yes: Bool) {
    busy = true
    Task {
      do {
        try await store.decide(approval, approve: yes, code: codeKind != nil ? code : nil)
        code = ""
      } catch { self.error = error.localizedDescription }
      busy = false
    }
  }
}

private struct ApprovalSurface: ViewModifier {
  var inList: Bool
  func body(content: Content) -> some View {
    if inList { content.padding(.vertical, 6) } else { content.card(Corner.card, padding: 14) }
  }
}

/** An agent's computer in the chat: what's on it now, and what the agent asked a person to do there. */
struct ComputerCard: View {
  @Environment(Store.self) private var store
  var computerId: String
  var request: String?

  var body: some View {
    if let c = store.computers.first(where: { $0.id == computerId }) {
      NavigationLink {
        ComputerDetail(computerId: c.id)
      } label: {
        VStack(alignment: .leading, spacing: 8) {
          ScreenThumb(computer: c)
            .frame(maxWidth: 320)
          if let request {
            Label(request, systemImage: "person.fill.questionmark").font(.callout.weight(.medium))
          }
          Text("Open \(c.name)").font(.caption.weight(.semibold)).foregroundStyle(.blue)
        }
      }
      .buttonStyle(.plain)
    }
  }
}
