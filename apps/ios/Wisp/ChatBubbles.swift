import SwiftUI

// The pieces of a conversation that look like Messages: your blue bubbles on the right, everyone else's
// grey on the left, a quote above a reply, time labels between, and the grey bubble with three pulsing
// dots while an agent works.

/** The message a composer is replying to: who said it and a few of their words. */
struct ReplyTarget: Hashable {
  var id: String
  var name: String
  var snippet: String
}

extension Store {
  /** Reply to a message: the composer of its conversation shows "Replying to …" and takes focus. */
  func startReply(_ m: Message, thread: String?) {
    replying[ComposerDrafts.key(channel: m.channelId, thread: thread)] = ReplyTarget(id: m.id, name: name(of: m.author), snippet: ChatFormat.snippet(m))
  }

  func replyTarget(channel: String, thread: String?) -> ReplyTarget? {
    replying[ComposerDrafts.key(channel: channel, thread: thread)]
  }

  func cancelReply(channel: String, thread: String?) {
    replying[ComposerDrafts.key(channel: channel, thread: thread)] = nil
  }
}

enum BubbleSide { case mine, theirs }

/** A bubble: 16pt corners with a 4pt tail corner (bottom right when it is yours, bottom left otherwise). */
struct BubbleShape: Shape {
  var mine: Bool
  func path(in rect: CGRect) -> Path {
    UnevenRoundedRectangle(topLeadingRadius: 16, bottomLeadingRadius: mine ? 16 : 4, bottomTrailingRadius: mine ? 4 : 16, topTrailingRadius: 16, style: .continuous).path(in: rect)
  }
}

/** A message's rounded bubble: Wisp blue with white words when it's yours, grey otherwise. */
struct Bubble<Content: View>: View {
  var side: BubbleSide
  @ViewBuilder var content: Content

  var body: some View {
    content
      .padding(.horizontal, 13)
      .padding(.vertical, 9)
      .foregroundStyle(side == .mine ? Color.white : Palette.text)
      .tint(side == .mine ? Color.white : Palette.blue)
      .background(BubbleShape(mine: side == .mine).fill(side == .mine ? Palette.blue : Palette.bubble))
  }
}

/** The message a reply answers, above the reply's words inside its bubble; a tap goes to it. */
struct QuoteBlock: View {
  @Environment(Store.self) private var store
  @Environment(\.scrollToMessage) private var scrollTo
  var quote: ReplyQuote
  var side: BubbleSide

  private var author: String { quote.author == Actor(kind: .user, id: store.me?.id ?? "") ? "You" : store.name(of: quote.author) }

  var body: some View {
    Button { scrollTo?(quote.id) } label: {
      HStack(spacing: 8) {
        Rectangle().fill(side == .mine ? Color.white.opacity(0.6) : Palette.faint).frame(width: 2)
        VStack(alignment: .leading, spacing: 1) {
          Text(author).font(.system(size: 13, weight: .semibold))
          Text(quote.deleted == true ? "This message was deleted." : quote.snippet).font(.system(size: 13)).lineLimit(2).multilineTextAlignment(.leading)
        }
        .opacity(0.85)
      }
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Reply to \(author): \(quote.snippet)")
    .accessibilityHint("Goes to that message")
  }
}

/** "Today 9:30 PM" between messages that are far apart. */
struct TimeDivider: View {
  var date: Date
  var body: some View {
    Text(ChatFormat.stamp(date))
      .font(.system(size: 13))
      .foregroundStyle(Palette.faint)
      .frame(maxWidth: .infinity)
      .padding(.vertical, 12)
  }
}

/** Three dots that pulse while something works. */
struct PulseDots: View {
  @State private var on = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    HStack(spacing: 4) {
      ForEach(0..<3, id: \.self) { i in
        Circle().fill(Palette.muted).frame(width: 7, height: 7)
          .opacity(reduceMotion ? 0.7 : on ? 1 : 0.3)
          .animation(reduceMotion ? nil : .easeInOut(duration: 0.6).repeatForever(autoreverses: true).delay(Double(i) * 0.2), value: on)
      }
    }
    .onAppear { on = true }
    .accessibilityHidden(true)
  }
}

enum WorkLabel {
  /** "Reading main.ts", "Writing notes/release.md", or what the agent's last status said. */
  static func of(tool: String?, file: String?, activity: String?) -> String {
    if let tool, let file, !file.isEmpty {
      let name = (file as NSString).lastPathComponent
      switch ToolLine.key(tool) {
      case "read", "file_view", "view", "cat", "read_file", "open_file": return "Reading \(name)"
      case "edit", "multiedit", "write", "apply_patch", "str_replace", "str_replace_editor", "write_file", "edit_file", "create_file": return "Writing \(name)"
      default: break
      }
    }
    guard let a = activity?.trimmingCharacters(in: .whitespacesAndNewlines), !a.isEmpty, a != "started" else { return "Thinking…" }
    if a.hasPrefix("Using ") { return "\(String(a.dropFirst(6)))…" }
    return a.hasSuffix("…") ? a : a + "…"
  }
}

/** The grey bubble an agent shows while it works: three pulsing dots and what it's doing. */
struct WorkingBubble: View {
  var label: String

  var body: some View {
    HStack(spacing: 10) {
      PulseDots()
      Text(label).font(.system(size: 15)).foregroundStyle(Palette.muted).lineLimit(1)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 13)
    .background(BubbleShape(mine: false).fill(Palette.bubble))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(label)
  }
}

/** An agent's reply as it's being written: its words so far, then the working bubble. */
struct StreamingRow: View {
  @Environment(Store.self) private var store
  var run: LiveRun

  private var home: Bool {
    store.channels.first { $0.id == run.channelId }.flatMap { store.dmAgent($0) }?.id == run.agentId
  }

  var body: some View {
    HStack(alignment: .bottom, spacing: 8) {
      if !home { AgentAvatar(agent: store.agent(run.agentId), size: 24, showStatus: false).frame(width: 24) }
      VStack(alignment: .leading, spacing: 3) {
        if !home { Text(store.agent(run.agentId)?.name ?? "Agent").font(.system(size: 12)).foregroundStyle(Palette.faint).padding(.leading, 14) }
        if !run.text.isEmpty { Bubble(side: .theirs) { MarkdownText(run.text) } }
        WorkingBubble(label: WorkLabel.of(tool: run.tool, file: run.file, activity: store.activity[run.agentId]))
      }
      Spacer(minLength: 40)
    }
    .padding(.horizontal, 16)
    .padding(.top, 8)
    .padding(.bottom, 4)
  }
}

/** "› Handed to Pappy · 4 replies · Working": a step Wisp handed out, which opens its own thread. */
struct HandoffRow: View {
  @Environment(Store.self) private var store
  var message: Message
  var taskId: String
  var replies: Int
  var thread: ThreadRef
  var working: [Agent]

  var body: some View {
    let task = store.tasks.first { $0.id == taskId }
    let agent = task.flatMap { store.agent($0.toAgentId ?? "") }
    let state = working.isEmpty ? task.map { store.taskState($0) } : "Working"
    NavigationLink(value: thread) {
      HStack(spacing: 6) {
        Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(Palette.muted)
        (Text("Handed to ") + Text(agent?.name ?? Self.handle(message.body) ?? "an agent").fontWeight(.semibold))
        if replies > 0 { Text("· \(replies == 1 ? "1 reply" : "\(replies) replies")").foregroundStyle(Palette.muted) }
        if let state { Text("· \(state)").foregroundStyle(working.isEmpty ? Palette.muted : Palette.green) }
      }
      .font(.system(size: 13))
      .foregroundStyle(Palette.text)
      .lineLimit(1)
      .padding(.horizontal, 14)
      .frame(height: 38)
      .glassPill()
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .padding(.horizontal, 16)
    .padding(.leading, 38)
    .padding(.vertical, 4)
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityLabel("Handed to \(agent?.name ?? "an agent")\(replies > 0 ? ", \(replies) replies" : "")\(state.map { ", \($0)" } ?? ""). Opens its thread")
    .accessibilityIdentifier("handoff-row")
  }

  static func handle(_ body: String) -> String? {
    body.range(of: "^@[\\w-]+", options: .regularExpression).map { String(body[$0].dropFirst()) }
  }
}

/** A way for a quote to ask the list it's in to scroll to a message. */
private struct ScrollToMessageKey: EnvironmentKey { nonisolated(unsafe) static let defaultValue: ((String) -> Void)? = nil }
extension EnvironmentValues {
  var scrollToMessage: ((String) -> Void)? {
    get { self[ScrollToMessageKey.self] }
    set { self[ScrollToMessageKey.self] = newValue }
  }
}

/** The message the list just scrolled to, so its row can flash. */
private struct FlashedMessageKey: EnvironmentKey { static let defaultValue: String? = nil }
extension EnvironmentValues {
  var flashedMessage: String? {
    get { self[FlashedMessageKey.self] }
    set { self[FlashedMessageKey.self] = newValue }
  }
}

/** A card an agent posts in the chat: a small label with a line icon, then what the card says. */
struct ChatCardShell<Content: View>: View {
  var symbol: String
  var label: String
  var warn = false
  @ViewBuilder var content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Label { Text(label).font(.system(size: 13, weight: .medium)) } icon: { Image(systemName: symbol).font(.system(size: 12)) }
        .foregroundStyle(warn ? Color.orange : Palette.muted)
      content
    }
    .padding(16)
    .frame(maxWidth: 340, alignment: .leading)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
  }
}

/** The big pill buttons on a card: the main answer filled, the other outlined. */
struct CardButtonStyle: ButtonStyle {
  var prominent = false
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 15, weight: .semibold))
      .foregroundStyle(prominent ? Palette.ground : Palette.text)
      .frame(maxWidth: .infinity)
      .frame(height: 44)
      .background(Capsule().fill(prominent ? Palette.text : Palette.control))
      .overlay(Capsule().strokeBorder(Palette.hairline, lineWidth: prominent ? 0 : 1))
      .opacity(configuration.isPressed ? 0.7 : 1)
  }
}
