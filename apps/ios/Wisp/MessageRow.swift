import QuickLook
import SwiftUI

struct MessageRow: View {
  @Environment(Store.self) private var store
  @Environment(\.flashedMessage) private var flashed
  var message: Message
  /** the same author a moment ago: no name again */
  var compact: Bool
  /** the last bubble of its group: the avatar sits beside it */
  var last = true
  var replies: Int
  /** the thread this message starts (or would start): any message can have one, a reply too */
  var thread: ThreadRef?
  /** agents working in that thread, or in a sub-thread under it */
  var working: [Agent] = []
  /** the thread whose message bar "Reply" fills (nil: the chat's own) */
  var composerThread: String? = nil
  @State private var toolsOpen = false
  @State private var editing = false
  @State private var deleting = false
  @State private var error: String?
  @State private var failure: String?

  private var tools: [(name: String, line: String)] {
    message.parts.compactMap { if case .toolCall(let n, let line, _) = $0 { (n, line.isEmpty ? n : line) } else { nil } }
  }

  private var remembered: [MessagePart.Remembered] {
    message.parts.compactMap { if case .toolCall(_, _, let r) = $0 { r } else { nil } }
  }

  var body: some View {
    if message.author.id == "system" { systemLine } else { row }
  }

  /** the task a step Wisp handed out, if this is one of those */
  private var handedTask: String? {
    message.parts.lazy.compactMap { if case .task(let id) = $0 { id } else { nil } }.first
  }

  /**
   * Wisp's own notes ("@scout isn't connected to a device yet") as a quiet line, not a person. A
   * step Wisp handed out is a row that opens its own thread.
   */
  @ViewBuilder private var systemLine: some View {
    if let taskId = handedTask {
      HandoffRow(message: message, taskId: taskId, replies: replies, thread: thread ?? ThreadRef(channelId: message.channelId, rootId: message.id), working: working)
    } else {
      plainSystemLine
    }
  }

  private var plainSystemLine: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Image(systemName: "info.circle")
      Text(message.parts.compactMap { if case .status(let t) = $0 { t } else if case .notice(let t) = $0 { t } else { nil } }.joined(separator: " ") + message.body)
    }
    .font(.caption)
    .foregroundStyle(Palette.faint)
    .padding(.horizontal, 16)
    .padding(.leading, 38)
    .padding(.vertical, 6)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var mine: Bool { message.author == Actor(kind: .user, id: store.me?.id ?? "") }
  private var pinned: Bool { store.isPinned(message) }

  /** the agent a chat is with already sits in the title: its messages carry no picture or name */
  private var home: Bool {
    message.author.kind == .agent && store.channels.first { $0.id == message.channelId }.flatMap { store.dmAgent($0) }?.id == message.author.id
  }

  private var hasChange: Bool { message.parts.contains { if case .change = $0 { true } else { false } } }
  private var showsBubble: Bool { message.deletedAt == nil && (!message.body.isEmpty || message.replyTo != nil) && !hasChange }

  private var row: some View {
    HStack(alignment: .bottom, spacing: 8) {
      if mine {
        Spacer(minLength: 56)
      } else if !home {
        Group {
          if last {
            if message.author.kind == .agent { AgentAvatar(agent: store.agent(message.author.id), size: 30, showStatus: false) }
            else { PersonAvatar(name: store.name(of: message.author), size: 30) }
          } else { Color.clear }
        }
        .frame(width: 30, height: 30)
      }
      column
      if !mine { Spacer(minLength: home ? 56 : 40) }
    }
    .padding(.horizontal, 16)
    .padding(.top, compact ? 0 : 4)
    .padding(.bottom, last ? 4 : 1)
    .background {
      if flashed == message.id { Palette.blue.opacity(0.14) }
    }
    .animation(.easeOut(duration: 0.5), value: flashed)
    .contentShape(Rectangle())
    .id(message.id)
    .contextMenu {
      if store.canReply(message) { Button("Reply", systemImage: "arrowshape.turn.up.left") { store.startReply(message, thread: composerThread) } }
      if let thread, message.deletedAt == nil { NavigationLink(value: thread) { Label("Reply in thread", systemImage: "bubble.left") } }
      if !message.body.isEmpty { Button("Copy text", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.body } }
      if store.canPin(message) {
        Button(pinned ? "Unpin" : "Pin to team", systemImage: pinned ? "pin.slash" : "pin") {
          Task { do { try await store.setPinned(message, !pinned) } catch { failure = error.localizedDescription } }
        }
      }
      if store.canEdit(message) { Button("Edit", systemImage: "pencil") { editing = true } }
      if store.canDelete(message) { Button("Delete", systemImage: "trash", role: .destructive) { deleting = true } }
    }
    .sheet(isPresented: $editing) { EditMessageSheet(message: message) }
    .alert("Couldn't do that", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
      Button("OK") {}
    } message: { Text(failure ?? "") }
    .confirmationDialog("Delete this message?", isPresented: $deleting, titleVisibility: .visible) {
      Button("Delete message", role: .destructive) {
        Task {
          do { try await store.deleteMessage(message) } catch { self.error = error.localizedDescription }
        }
      }
    } message: { Text("Everyone will see “This message was deleted.” instead. Replies in its thread stay.") }
    .alert("Couldn't delete it", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
      Button("OK") {}
    } message: { Text(error ?? "") }
  }

  private var column: some View {
    VStack(alignment: mine ? .trailing : .leading, spacing: 3) {
        if !compact && !mine && !home {
          HStack(spacing: 4) {
            Text(store.name(of: message.author)).font(.system(size: 12)).foregroundStyle(Palette.faint)
            if pinned { Image(systemName: "pin.fill").font(.system(size: 9)).foregroundStyle(Palette.faint).accessibilityLabel("Pinned") }
          }
          .padding(.leading, 14)
        } else if mine && pinned {
          Label("Pinned", systemImage: "pin.fill").font(.system(size: 11)).foregroundStyle(Palette.faint).padding(.trailing, 6)
        }
        if message.deletedAt != nil {
          Text("This message was deleted.").font(.system(size: 15)).italic().foregroundStyle(Palette.muted)
            .padding(.horizontal, 16).padding(.vertical, 11)
            .background(RoundedRectangle(cornerRadius: 24, style: .continuous).fill(Palette.bubble))
        } else if showsBubble {
          Bubble(side: mine ? .mine : .theirs) {
            VStack(alignment: .leading, spacing: 6) {
              if let quote = message.replyTo { QuoteBlock(quote: quote, side: mine ? .mine : .theirs) }
              if !message.body.isEmpty { MarkdownText(message.body, edited: message.editedAt != nil) }
            }
          }
        }
        ForEach(Array(message.parts.enumerated()), id: \.offset) { _, part in
          PartView(part: part, message: message)
        }
        if !tools.isEmpty && store.prefs?.toolCalls != "hidden" { toolLine }
        ForEach(Array(remembered.enumerated()), id: \.offset) { _, r in RememberedChip(note: r) }
        if let thread, replies > 0 || !working.isEmpty {
          HStack(spacing: 8) {
            if replies > 0 {
              NavigationLink(value: thread) {
                HStack(spacing: 6) {
                  Image(systemName: "bubble.left").font(.system(size: 12))
                  Text(replies == 1 ? "1 reply" : "\(replies) replies")
                  Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(Palette.faint)
                }
                .font(.system(size: 14))
                .foregroundStyle(Palette.text)
                .padding(.horizontal, 12)
                .frame(height: 34)
                .glassPill()
              }
              .buttonStyle(.plain)
            }
            if !working.isEmpty { ThreadWork(agents: working, thread: thread) }
          }
          .padding(.top, 2)
        }
    }
  }

  /** "Ran 4 tools" on a pill; it opens the list of what each one did. */
  private var toolLine: some View {
    let open = toolsOpen || store.prefs?.toolCalls == "expanded"
    return VStack(alignment: .leading, spacing: 6) {
      Button {
        withAnimation(.snappy) { toolsOpen.toggle() }
      } label: {
        HStack(spacing: 6) {
          Image(systemName: "terminal").font(.system(size: 12))
          Text(tools.count == 1 ? tools[0].line : "Ran \(tools.count) tools").lineLimit(1)
          Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).rotationEffect(.degrees(open ? 90 : 0))
        }
        .font(.system(size: 13))
        .foregroundStyle(Palette.muted)
        .padding(.horizontal, 12)
        .frame(height: 32)
        .glassPill()
      }
      .buttonStyle(.plain)
      .accessibilityLabel(tools.count == 1 ? tools[0].line : "Ran \(tools.count) tools")
      .accessibilityHint(open ? "Hides them" : "Shows what each one did")
      if open && tools.count > 1 {
        VStack(alignment: .leading, spacing: 0) {
          Text("Ran \(tools.count) tools").font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.muted).padding(.horizontal, 16).padding(.vertical, 10)
          ForEach(Array(tools.enumerated()), id: \.offset) { _, t in
            Rectangle().fill(Palette.separator).frame(height: 1)
            Text(t.line).font(.system(size: 14)).padding(.horizontal, 16).padding(.vertical, 10).frame(maxWidth: .infinity, alignment: .leading)
          }
        }
        .frame(maxWidth: 340)
        .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
      }
    }
  }
}

/** What an agent saved about someone during its reply, right where it happened: "Remembered · Release is Friday". */
struct RememberedChip: View {
  var note: MessagePart.Remembered

  var body: some View {
    let face = HStack(spacing: 8) {
      Image(systemName: "bookmark").font(.system(size: 12)).foregroundStyle(Palette.muted)
      Text("Remembered").fontWeight(.medium)
      Text("·").foregroundStyle(Palette.faint)
      Text(note.text).foregroundStyle(Palette.muted).lineLimit(1)
      Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(Palette.faint)
    }
    .font(.system(size: 13))
    .foregroundStyle(Palette.text)
    .padding(.horizontal, 12)
    .frame(height: 32)
    .glassPill()
    if let path = note.path {
      NavigationLink { NoteView(path: path) } label: { face }.buttonStyle(.plain).accessibilityHint("Saved to memory. Open it to edit or delete.")
    } else {
      face
    }
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
      HStack(spacing: 6) {
        HStack(spacing: -6) {
          ForEach(agents.prefix(3)) { a in
            AgentAvatar(agent: a, size: 20, showStatus: false)
              .padding(1)
              .background(Circle().fill(Palette.bubble))
          }
        }
        PulseDots().scaleEffect(0.7)
        (Text(who).fontWeight(.semibold) + Text(" \(agents.count == 1 ? "is" : "are") working\(deeper ? " in a sub-thread" : "")"))
          .lineLimit(1)
      }
      .font(.system(size: 13))
      .foregroundStyle(Palette.text)
      .padding(.leading, 6)
      .padding(.trailing, 12)
      .frame(height: 34)
      .background(Capsule().fill(Palette.bubble))
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
      Text(t).font(.caption).foregroundStyle(Palette.faint).italic().padding(.horizontal, 4)
    case .file(let id, let name):
      FileChip(id: id, name: name)
    case .task(let id):
      TaskChip(taskId: id)
    case .routine(let id):
      RoutineChip(routineId: id)
    case .discussion(let id):
      DiscussionCard(discussionId: id)
    case .context(let usage):
      ContextCard(usage: usage, message: message)
    case .approval(let id):
      ApprovalCard(approvalId: id)
    case .change(let id):
      ChangeCard(changeId: id)
    case .computer(let id, let request):
      ComputerCard(computerId: id, request: request, agentName: store.agent(message.author.id)?.name)
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

/** What an agent changed for you (a setting, a mod, a note), one line each, with Undo. */
struct ChangeCard: View {
  @Environment(Store.self) private var store
  var changeId: String
  @State private var busy = false
  @State private var error: String?

  private var change: Change? { store.changes?.first { $0.id == changeId } }

  var body: some View {
    if let change {
      ChatCardShell(symbol: "pencil", label: "Changed") {
        ForEach(change.lines, id: \.self) { line in
          Text(line).font(.system(size: 16, weight: .semibold))
            .strikethrough(change.undoneAt != nil)
            .foregroundStyle(change.undoneAt != nil ? Palette.muted : Palette.text)
        }
        HStack(spacing: 10) {
          if change.undoneAt != nil {
            Label("Undone", systemImage: "arrow.uturn.backward").font(.system(size: 14)).foregroundStyle(Palette.muted)
          } else {
            Button { undo() } label: { Label("Undo", systemImage: "arrow.uturn.backward").font(.system(size: 15, weight: .semibold)).padding(.horizontal, 16).frame(height: 40) }
              .buttonStyle(.plain)
              .background(Capsule().fill(Palette.control))
              .overlay(Capsule().strokeBorder(Palette.hairline))
              .disabled(busy)
              .accessibilityIdentifier("undo-change")
            if let at = Wire.date(change.createdAt) {
              Text(at, format: .dateTime.hour().minute()).font(.system(size: 14)).foregroundStyle(Palette.faint)
            }
          }
          if let error { Text(error).font(.caption).foregroundStyle(Palette.red) }
        }
        .padding(.top, 2)
      }
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
        ApprovalBox(approval: a, agentName: store.agent(a.agentId)?.name)
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

/**
 * "Can I go ahead?" with Approve and Not now. A login request ("Nova wants to use your Zendesk
 * login") is the same card: your password manager signs in for the agent and Wisp never sees the
 * password, so only whoever connected it can answer.
 */
struct ApprovalBox: View {
  @Environment(Store.self) private var store
  var approval: Approval
  /** who's asking, when it isn't clear from around the card */
  var agentName: String? = nil
  /** a row of a list, which is its own card */
  var inList = false
  @State private var busy = false
  @State private var error: String?
  @State private var note = ""

  private var login: Approval.Login? { approval.login }
  private var pending: Bool { approval.status == "pending" }
  private var name: String { agentName ?? store.agent(approval.agentId)?.name ?? "It" }
  private var title: String {
    if let login { return pending ? "\(name) wants to use your \(login.title) login" : "\(name) used your \(login.title) login" }
    return approval.summary
  }

  var body: some View {
    if inList {
      content.padding(.vertical, 6)
    } else {
      ChatCardShell(symbol: "lock", label: login != nil ? "Login request" : "Asking for your OK") { content }
    }
  }

  private var decider: String {
    approval.decidedBy == store.me?.id ? "You" : (approval.decidedBy.flatMap { id in store.members.first { $0.id == id }?.name } ?? "Someone")
  }

  @ViewBuilder private var content: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(title).font(.system(size: 16, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
      if let login, pending {
        Text("Your password manager signs in for it. Wisp never sees the password.").font(.system(size: 14)).foregroundStyle(Palette.muted)
        HStack(spacing: 8) {
          Image(systemName: "lock").font(.system(size: 13)).foregroundStyle(Palette.muted)
          Text(login.site).lineLimit(1)
          Text(login.username ?? "").foregroundStyle(Palette.muted).lineLimit(1)
        }
        .font(.system(size: 14))
        .padding(.horizontal, 12).padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.ground))
      } else if login == nil, !approval.details.isEmpty {
        Text(approval.details)
          .font(.system(size: 14, design: .monospaced))
          .lineLimit(8)
          .padding(.horizontal, 12).padding(.vertical, 9)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.ground))
      }
      if pending && store.role != "guest" {
        if let login, login.ownerId != store.me?.id {
          Text("Waiting for whoever connected it: only they can let agents use their logins.").font(.system(size: 14)).foregroundStyle(Palette.muted)
        } else {
          if login == nil {
            Text("Can I go ahead?").font(.system(size: 15)).foregroundStyle(Palette.muted)
            TextField("Add a note (optional)", text: $note, axis: .vertical)
              .lineLimit(1...4)
              .font(.system(size: 15))
              .padding(.horizontal, 14).padding(.vertical, 11)
              .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Palette.control))
              .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Palette.hairline))
              .disabled(busy)
          }
          HStack(spacing: 10) {
            Button("Approve") { decide(true) }.buttonStyle(CardButtonStyle(prominent: true)).accessibilityIdentifier("approval-approve")
            Button("Not now") { decide(false) }.buttonStyle(CardButtonStyle()).accessibilityIdentifier("approval-deny")
          }
          .disabled(busy)
          if login != nil {
            Button("Always allow for \(name)") { decide(true, always: true) }
              .font(.system(size: 14)).foregroundStyle(Palette.muted).frame(maxWidth: .infinity).disabled(busy)
          }
        }
      } else if !pending {
        HStack(spacing: 6) {
          Image(systemName: approval.status == "approved" ? "checkmark" : "xmark")
          Text(approval.status == "approved" ? "\(decider) approved this" : "\(decider) said not now")
          Spacer(minLength: 8)
          if let at = approval.decidedAt.flatMap(Wire.date) { Text(at, format: .dateTime.hour().minute()).foregroundStyle(Palette.faint) }
        }
        .font(.system(size: 14))
        .foregroundStyle(approval.status == "approved" ? Palette.green : Palette.muted)
        if !approval.note.isEmpty { Text("“\(approval.note)”").font(.system(size: 14)).foregroundStyle(Palette.muted) }
      }
      if let error { Text(error).font(.caption).foregroundStyle(Palette.red) }
    }
  }

  private func decide(_ yes: Bool, always: Bool = false) {
    busy = true
    Task {
      do { try await store.decide(approval, approve: yes, note: note.trimmingCharacters(in: .whitespacesAndNewlines), always: always) } catch { self.error = error.localizedDescription }
      busy = false
    }
  }
}

/** An agent's computer in the chat: a card that takes you there when it asked for help, or the screen it's on. */
struct ComputerCard: View {
  @Environment(Store.self) private var store
  var computerId: String
  var request: String?
  var agentName: String? = nil

  var body: some View {
    if store.canViewComputers, let c = store.computers.first(where: { $0.id == computerId }) {
      if let request {
        let waiting = c.help != nil
        ChatCardShell(symbol: "desktopcomputer", label: waiting ? "Needs you on a computer" : "Helped on a computer", warn: waiting) {
          Text("\(agentName ?? "It") asked for help on \(c.name)").font(.system(size: 16, weight: .semibold))
          Text(request).font(.system(size: 14)).foregroundStyle(Palette.muted)
          NavigationLink { ComputerDetail(computerId: c.id) } label: {
            Label("Open \(c.name)", systemImage: "desktopcomputer").font(.system(size: 16, weight: .semibold))
              .foregroundStyle(Palette.ground).frame(maxWidth: .infinity).frame(height: 44)
              .background(Capsule().fill(Palette.text))
          }
          .buttonStyle(.plain)
        }
      } else {
        NavigationLink {
          ComputerDetail(computerId: c.id)
        } label: {
          VStack(alignment: .leading, spacing: 8) {
            ScreenThumb(computer: c).frame(maxWidth: 320)
            Text("Open \(c.name)").font(.caption.weight(.semibold)).foregroundStyle(Palette.blue)
          }
        }
        .buttonStyle(.plain)
      }
    }
  }
}

enum ApprovalText {
  /** "Sam approved this: "go ahead"" (the note only when there is one) */
  static func decided(_ a: Approval, by name: String?) -> String {
    let note = a.note.trimmingCharacters(in: .whitespacesAndNewlines)
    return "\(name ?? "Someone") \(a.status == "approved" ? "approved" : "denied") this\(note.isEmpty ? "." : ": “\(note)”")"
  }
}
