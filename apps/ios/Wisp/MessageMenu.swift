import SwiftUI
import UIKit

// Press and hold a message: the chat blurs behind it, the bubble lifts, six quick reactions pop in
// above it and its actions show below. Swipe a message right to open its thread. Reactions sit on
// the bubble's top corner. The screen (a chat or a thread) draws the menu over everything, its
// composer and top bar too, so a row only says which message was held and where it is.

/** The quick reactions on top of a message's menu, in order (TAPBACKS in packages/core). */
enum Tapbacks {
  static let all: [(emoji: String, label: String)] = [("❤️", "Love"), ("👍", "Like"), ("👎", "Dislike"), ("😂", "Laugh"), ("‼️", "Emphasize"), ("❓", "Question")]
}

/** What a chat or thread screen does with its messages: the held one's menu, editing, deleting, opening a thread. */
@MainActor @Observable final class MessageActions {
  struct Held: Equatable {
    var message: Message
    /** the bubble's frame on screen when it was held */
    var frame: CGRect
    var mine: Bool
    /** the bubble's own frame (false: the row had no bubble, so a plain one stands in) */
    var bubble: Bool
    var thread: ThreadRef?
    /** the thread whose message bar "Reply" fills (nil: the chat's own) */
    var composerThread: String?
  }

  var held: Held?
  var editing: Message?
  var deleting: Message?
  /** a thread to open (the menu's "Reply in thread", a swipe to the right) */
  var thread: ThreadRef?
  var failure: String?

  func react(_ message: Message, _ emoji: String, store: Store) {
    Task {
      do { try await store.toggleReaction(message, emoji: emoji) } catch { failure = error.localizedDescription }
    }
  }

  func setPinned(_ message: Message, _ pinned: Bool, store: Store) {
    Task {
      do { try await store.setPinned(message, pinned) } catch { failure = error.localizedDescription }
    }
  }

  func copy(_ message: Message) { UIPasteboard.general.string = message.body }
}

private struct MessageActionsKey: EnvironmentKey { nonisolated(unsafe) static let defaultValue: MessageActions? = nil }
extension EnvironmentValues {
  var messageActions: MessageActions? {
    get { self[MessageActionsKey.self] }
    set { self[MessageActionsKey.self] = newValue }
  }
}

extension View {
  /** A screen of messages: draws the held message's menu over everything, and the edit sheet, delete question and thread they lead to. */
  func messageActionsHost() -> some View { modifier(MessageActionsHost()) }
}

private struct MessageActionsHost: ViewModifier {
  @Environment(Store.self) private var store
  @State private var actions = MessageActions()

  func body(content: Content) -> some View {
    @Bindable var actions = actions
    content
      .environment(\.messageActions, actions)
      .overlay {
        if let held = actions.held {
          MessageMenuOverlay(held: held).environment(\.messageActions, actions)
        }
      }
      .sheet(item: $actions.editing) { EditMessageSheet(message: $0) }
      .confirmationDialog("Delete this message?", isPresented: Binding(get: { actions.deleting != nil }, set: { if !$0 { actions.deleting = nil } }), titleVisibility: .visible, presenting: actions.deleting) { m in
        Button("Delete message", role: .destructive) {
          Task {
            do { try await store.deleteMessage(m) } catch { actions.failure = error.localizedDescription }
          }
        }
      } message: { _ in Text("Everyone will see “This message was deleted.” instead. Replies in its thread stay.") }
      .alert("Couldn't do that", isPresented: Binding(get: { actions.failure != nil }, set: { if !$0 { actions.failure = nil } })) {
        Button("OK") {}
      } message: { Text(actions.failure ?? "") }
      .navigationDestination(item: $actions.thread) { ThreadView(ref: $0) }
  }
}

// MARK: the menu

/** A held message over the blurred chat: reactions above, the lifted bubble, its actions below. */
struct MessageMenuOverlay: View {
  @Environment(Store.self) private var store
  @Environment(\.messageActions) private var actions
  var held: MessageActions.Held
  @ReduceMotion private var reduceMotion
  @State private var shown = false

  private struct Item: Identifiable {
    var id: String { title }
    var title: String
    var symbol: String
    var destructive = false
    var action: () -> Void
  }

  private var message: Message { store.message(held.message.id, in: held.message.channelId) ?? held.message }

  private var items: [Item] {
    let m = message
    var out: [Item] = []
    if store.canReply(m) { out.append(Item(title: "Reply", symbol: "arrowshape.turn.up.left") { close { store.startReply(m, thread: held.composerThread) } }) }
    if let thread = held.thread, m.deletedAt == nil { out.append(Item(title: "Reply in thread", symbol: "bubble.left") { close { actions?.thread = thread } }) }
    if !m.body.isEmpty { out.append(Item(title: "Copy", symbol: "doc.on.doc") { close { actions?.copy(m) } }) }
    if store.canPin(m) {
      let pinned = store.isPinned(m)
      out.append(Item(title: pinned ? "Unpin" : "Pin to team", symbol: pinned ? "pin.slash" : "pin") { close { actions?.setPinned(m, !pinned, store: store) } })
    }
    if store.canEdit(m) { out.append(Item(title: "Edit", symbol: "pencil") { close { actions?.editing = m } }) }
    return out
  }

  private var canDelete: Bool { store.canDelete(message) }
  private var canReact: Bool { store.canReact(message) }

  private static let tapSize: CGFloat = 40
  private static let tapsHeight: CGFloat = 50
  private static let tapsWidth: CGFloat = CGFloat(Tapbacks.all.count) * tapSize + CGFloat(Tapbacks.all.count - 1) * 2 + 10
  private static let menuWidth: CGFloat = 236
  private static let rowHeight: CGFloat = 44
  private static let gap: CGFloat = 8

  var body: some View {
    GeometryReader { geo in
      let origin = geo.frame(in: .global).origin
      let insets = Self.windowInsets
      let size = geo.size
      let f = held.frame.offsetBy(dx: -origin.x, dy: -origin.y)
      let menuHeight = CGFloat(items.count + (canDelete ? 1 : 0)) * Self.rowHeight + (canDelete && !items.isEmpty ? 9 : 0) + 10
      let tapsHeight = canReact ? Self.tapsHeight : 0
      let top = insets.top + 8
      let bottom = size.height - insets.bottom - 8
      let room = bottom - top - tapsHeight - menuHeight - Self.gap * 2
      let bubbleHeight = min(f.height, max(room, 60))
      let lowest = bottom - menuHeight - Self.gap - bubbleHeight
      let highest = top + tapsHeight + (canReact ? Self.gap : 0)
      let y = min(max(f.minY, highest), max(lowest, highest))
      let lifted = shown || reduceMotion
      let bubbleY = lifted ? y : f.minY
      let x = { (width: CGFloat) in
        min(max(held.mine ? f.maxX - width : f.minX, 12), size.width - 12 - width)
      }

      ZStack(alignment: .topLeading) {
        Button { close() } label: {
          ZStack {
            Rectangle().fill(.ultraThinMaterial)
            Color.black.opacity(0.28)
          }
        }
        .buttonStyle(.plain)
        .opacity(shown ? 1 : 0)
        .accessibilityLabel("Close")
        .accessibilityIdentifier("message-menu-close")

        preview(width: f.width, height: bubbleHeight)
          .scaleEffect(shown && !reduceMotion ? 1.03 : 1, anchor: held.mine ? .trailing : .leading)
          .shadow(color: .black.opacity(shown && !reduceMotion ? 0.45 : 0), radius: 20, y: 12)
          .offset(x: f.minX, y: bubbleY)
          .allowsHitTesting(false)
          .accessibilityHidden(true)

        if canReact {
          taps
            .offset(x: x(Self.tapsWidth), y: bubbleY - Self.gap - Self.tapsHeight)
        }

        menu(height: menuHeight)
          .offset(x: x(Self.menuWidth), y: bubbleY + bubbleHeight + Self.gap)
      }
      .frame(width: size.width, height: size.height, alignment: .topLeading)
    }
    .ignoresSafeArea()
    .accessibilityAddTraits(.isModal)
    .accessibilityAction(.escape) { close() }
    .onAppear {
      UIImpactFeedbackGenerator(style: .light).impactOccurred()
      withAnimation(Motion.pick(.spring(response: 0.36, dampingFraction: 0.78), reduceMotion)) { shown = true }
    }
  }

  /** The held bubble, drawn again on top of the blur at the same width. */
  private func preview(width: CGFloat, height: CGFloat) -> some View {
    let m = message
    return Group {
      if held.bubble {
        Bubble(side: held.mine ? .mine : .theirs) {
          VStack(alignment: .leading, spacing: 6) {
            if let quote = m.replyTo { QuoteBlock(quote: quote, side: held.mine ? .mine : .theirs, chat: m.conversationId) }
            if !m.body.isEmpty { MarkdownText(m.body, edited: m.editedAt != nil, selectable: false) }
          }
        }
        .frame(width: width, alignment: held.mine ? .trailing : .leading)
      } else {
        Bubble(side: held.mine ? .mine : .theirs) {
          Text(ChatFormat.snippet(m).isEmpty ? "Message" : ChatFormat.snippet(m)).font(.system(size: 15)).lineLimit(3)
        }
        .frame(maxWidth: min(width, 300), alignment: .leading)
      }
    }
    .fixedSize(horizontal: false, vertical: true)
    .frame(height: height, alignment: .top)
    .clipShape(BubbleShape(mine: held.mine))
  }

  private var taps: some View {
    let mine = Set((message.reactions ?? []).filter { $0.isMine(store.me?.id) }.map(\.emoji))
    return HStack(spacing: 2) {
      ForEach(Array(Tapbacks.all.enumerated()), id: \.offset) { i, t in
        Button {
          actions?.react(message, t.emoji, store: store)
          close()
        } label: {
          Text(t.emoji).font(.system(size: 21))
            .frame(width: Self.tapSize, height: Self.tapSize)
            .background(Circle().fill(mine.contains(t.emoji) ? Palette.blue.opacity(0.28) : .clear))
            .contentShape(Circle())
        }
        .buttonStyle(.press)
        .scaleEffect(shown || reduceMotion ? 1 : 0.6)
        .opacity(shown ? 1 : 0)
        .animation(shown ? Motion.pick(Motion.pop.delay(0.06 + Double(i) * 0.03), reduceMotion) : Motion.fade, value: shown)
        .accessibilityLabel(mine.contains(t.emoji) ? "\(t.label), your reaction" : t.label)
        .accessibilityHint(mine.contains(t.emoji) ? "Takes it off" : "Reacts with \(t.emoji)")
        .accessibilityIdentifier("tapback-\(i)")
      }
    }
    .padding(5)
    .background(.ultraThinMaterial, in: Capsule())
    .overlay(Capsule().strokeBorder(Palette.hairline))
    .shadow(color: .black.opacity(0.3), radius: 15, y: 10)
    .scaleEffect(shown || reduceMotion ? 1 : 0.6, anchor: held.mine ? .bottomTrailing : .bottomLeading)
    .opacity(shown ? 1 : 0)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("React")
  }

  private func menu(height: CGFloat) -> some View {
    VStack(spacing: 0) {
      ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
        row(item, first: i == 0)
      }
      if canDelete {
        if !items.isEmpty { Rectangle().fill(Palette.separator).frame(height: 1).padding(.horizontal, 8).padding(.vertical, 4) }
        row(Item(title: "Delete", symbol: "trash", destructive: true) { close { actions?.deleting = message } }, first: items.isEmpty)
      }
    }
    .padding(5)
    .frame(width: Self.menuWidth)
    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Palette.hairline))
    .shadow(color: .black.opacity(0.35), radius: 22, y: 16)
    .scaleEffect(shown || reduceMotion ? 1 : 0.6, anchor: held.mine ? .topTrailing : .topLeading)
    .opacity(shown ? 1 : 0)
    .animation(shown ? Motion.pick(Motion.pop.delay(0.04), reduceMotion) : Motion.fade, value: shown)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Message actions")
  }

  private func row(_ item: Item, first: Bool) -> some View {
    Button(action: item.action) {
      HStack(spacing: 11) {
        Image(systemName: item.symbol).font(.system(size: 16)).frame(width: 20)
          .foregroundStyle(item.destructive ? Palette.red : Palette.muted)
        Text(item.title).font(.system(size: 15))
        Spacer(minLength: 0)
      }
      .foregroundStyle(item.destructive ? Palette.red : Palette.text)
      .padding(.horizontal, 11)
      .frame(height: Self.rowHeight)
      .contentShape(Rectangle())
    }
    .buttonStyle(MenuRowStyle())
    .accessibilityIdentifier("message-menu-\(item.title.lowercased().replacingOccurrences(of: " ", with: "-"))")
  }

  /** Puts the bubble back and fades the rest, then does what was picked. */
  private func close(_ then: (() -> Void)? = nil) {
    withAnimation(Motion.pick(Motion.soft, reduceMotion)) { shown = false } completion: {
      actions?.held = nil
      then?()
    }
  }

  private static var windowInsets: UIEdgeInsets {
    let window = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first { $0.isKeyWindow }
    return window?.safeAreaInsets ?? UIEdgeInsets(top: 59, left: 0, bottom: 34, right: 0)
  }
}

/** A menu row: a soft highlight while pressed. */
private struct MenuRowStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(configuration.isPressed ? Palette.hairline : .clear))
  }
}

// MARK: reactions on a bubble

/** The reactions on a bubble's top corner: one round chip per emoji, with a count past one. A tap adds or takes back yours. */
struct ReactionBadges: View {
  @Environment(Store.self) private var store
  @Environment(\.messageActions) private var actions
  var message: Message
  @ReduceMotion private var reduceMotion

  var body: some View {
    let reactions = (message.reactions ?? []).filter { !$0.actors.isEmpty }
    HStack(spacing: 3) {
      ForEach(reactions, id: \.emoji) { r in
        let mine = r.isMine(store.me?.id)
        Button {
          if let actions { actions.react(message, r.emoji, store: store) } else { Task { try? await store.toggleReaction(message, emoji: r.emoji) } }
        } label: {
          HStack(spacing: 3) {
            Text(r.emoji).font(.system(size: 14))
            if r.actors.count > 1 { Text("\(r.actors.count)").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.text).monospacedDigit() }
          }
          .padding(.horizontal, 6)
          .frame(minWidth: 28, minHeight: 28)
          .background(Capsule().fill(mine ? Palette.blue.opacity(0.22) : Color.clear).background(Capsule().fill(Palette.control)))
          .overlay(Capsule().strokeBorder(Palette.ground, lineWidth: 2))
          .contentShape(Capsule())
        }
        .buttonStyle(.press)
        .disabled(!store.canReact(message))
        .transition(reduceMotion ? .opacity : .scale(scale: 0.3).combined(with: .opacity).combined(with: .offset(y: 10)))
        .accessibilityLabel("\(r.emoji) \(r.actors.count)\(mine ? ", including you" : "")")
        .accessibilityHint(mine ? "Takes your reaction off" : "Adds yours")
        .accessibilityIdentifier("reaction-\(r.emoji)")
      }
    }
    .animation(Motion.pick(Motion.badge, reduceMotion), value: reactions)
  }
}

// MARK: gestures

/** Press and hold (0.4s), as a UIKit recognizer so it never holds up the chat's scrolling. */
struct HoldGesture: UIGestureRecognizerRepresentable {
  var onHold: () -> Void

  func makeUIGestureRecognizer(context: Context) -> UILongPressGestureRecognizer {
    let g = UILongPressGestureRecognizer()
    g.minimumPressDuration = 0.4
    return g
  }

  func handleUIGestureRecognizerAction(_ recognizer: UILongPressGestureRecognizer, context: Context) {
    if recognizer.state == .began { onHold() }
  }
}

/**
 * A drag to the right on a message. It only starts when the finger moves clearly sideways and
 * didn't start at the screen's left edge (that's the swipe back), and the chat's scrolling waits
 * for it to decide, so the two never fight.
 */
struct SwipeRightGesture: UIGestureRecognizerRepresentable {
  var changed: (CGFloat) -> Void
  var ended: (_ translation: CGFloat, _ cancelled: Bool) -> Void

  final class Coordinator: NSObject, UIGestureRecognizerDelegate {
    func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
      guard let pan = g as? UIPanGestureRecognizer, let window = pan.view?.window else { return false }
      let t = pan.translation(in: window)
      let v = pan.velocity(in: window)
      let startX = pan.location(in: window).x - t.x
      guard startX > 24, t.x > 0 || v.x > 0 else { return false }
      return abs(t.x) > abs(t.y) * 1.4 && abs(v.x) >= abs(v.y)
    }

    /** the chat's scrolling waits for this to fail first */
    func gestureRecognizer(_ g: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
      other.view is UIScrollView && other is UIPanGestureRecognizer
    }
  }

  func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

  func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
    let g = UIPanGestureRecognizer()
    g.delegate = context.coordinator
    g.maximumNumberOfTouches = 1
    return g
  }

  func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
    let x = recognizer.translation(in: recognizer.view).x
    switch recognizer.state {
    case .began, .changed: changed(x)
    case .ended: ended(x, false)
    case .cancelled, .failed: ended(x, true)
    default: break
    }
  }
}

/** Where a swiped bubble sits: with the finger up to the point it opens, then resisting (no give with Reduce Motion). */
enum SwipeMath {
  static let arm: CGFloat = 64
  static func offset(_ raw: CGFloat, reduceMotion: Bool) -> CGFloat {
    let x = max(0, raw)
    if x <= arm { return x }
    return reduceMotion ? arm : min(arm + (x - arm) * 0.35, 110)
  }
}

/** The thread icon that shows on a swiped message's left: fades and grows in, blue once it will open. */
struct SwipeThreadIcon: View {
  var dx: CGFloat

  var body: some View {
    let p = min(dx / SwipeMath.arm, 1)
    let armed = dx >= SwipeMath.arm
    Image(systemName: "bubble.left")
      .font(.system(size: 14, weight: .semibold))
      .foregroundStyle(armed ? Color.white : Palette.muted)
      .frame(width: 32, height: 32)
      .background(Circle().fill(armed ? Palette.blue : Palette.hairline))
      .scaleEffect(0.6 + 0.4 * p)
      .opacity(p)
      .animation(.easeOut(duration: 0.15), value: armed)
      .accessibilityHidden(true)
  }
}

/** A frame kept off to the side: read when a message is held, so scrolling never redraws a row. */
final class FrameBox {
  var frame: CGRect = .zero
}
