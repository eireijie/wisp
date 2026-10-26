import SwiftUI

/**
 * The approved motion layer's springs, in one place. Pop overshoots a little (press release, bubbles, menus, badges); Soft barely
 * overshoots (sheets); Settle never does (pushes, tab panes, row stagger). Reduce Motion swaps each for a 120ms fade, see `Motion.pick`.
 */
enum Motion {
  static let pop = Animation.spring(response: 0.30, dampingFraction: 0.62)
  static let soft = Animation.spring(response: 0.34, dampingFraction: 0.82)
  static let settle = Animation.spring(response: 0.34, dampingFraction: 1.0)
  static let press = Animation.easeOut(duration: 0.09)
  static let fade = Animation.easeOut(duration: 0.16)
  /** the Reduce Motion fallback: a 120ms fade, no travel */
  static let reduced = Animation.easeOut(duration: 0.12)
  /** the badge's own spring (a touch livelier than Pop) */
  static let badge = Animation.spring(response: 0.30, dampingFraction: 0.55)
  /** a list row's delay: 20ms per row, capped so long lists don't wait */
  static func stagger(_ index: Int) -> Double { Double(min(index, 12)) * 0.02 }
  /** `animation` normally, the short fade when Reduce Motion is on */
  static func pick(_ animation: Animation, _ reduceMotion: Bool) -> Animation { reduceMotion ? reduced : animation }
}

/** Whether motion is off: iOS's Reduce Motion or Wisp's own setting (Settings > Appearance). Read it as `@ReduceMotion private var reduceMotion`. */
@MainActor @propertyWrapper
struct ReduceMotion: DynamicProperty {
  @Environment(\.accessibilityReduceMotion) private var system
  @AppStorage(ThemeSettings.motionKey, store: WispPreferences.standard) private var app = false
  var wrappedValue: Bool { system || app }
}

/** Scales on press (0.94 for circles and pills, 0.98 for rows) and springs back (Pop); with Reduce Motion it only dims. */
struct PressStyle: ButtonStyle {
  var scale: CGFloat = 0.94

  func makeBody(configuration: Configuration) -> some View {
    configuration.label.pressFeedback(configuration.isPressed, scale: scale)
  }
}

extension ButtonStyle where Self == PressStyle {
  /** circle buttons and small pills: the press feedback */
  static var press: PressStyle { PressStyle() }
  /** a full-width row: the same, a gentler scale */
  static var pressRow: PressStyle { PressStyle(scale: 0.98) }
}

/** The press look for custom ButtonStyles: scale 0.94 and a spring back; Reduce Motion only dims. */
private struct PressFeedback: ViewModifier {
  var pressed: Bool
  var scale: CGFloat
  @ReduceMotion private var reduceMotion
  func body(content: Content) -> some View {
    content
      .scaleEffect(pressed && !reduceMotion ? scale : 1)
      .opacity(pressed && reduceMotion ? 0.75 : 1)
      .animation(pressed ? Motion.press : Motion.pop, value: pressed)
  }
}

extension View {
  /** For a custom ButtonStyle's body: `.pressFeedback(configuration.isPressed)`. */
  func pressFeedback(_ pressed: Bool, scale: CGFloat = 0.94) -> some View { modifier(PressFeedback(pressed: pressed, scale: scale)) }

  /** Press feedback for a view that is not a Button (a tap-gesture row). */
  func pressScale(_ pressed: Bool, _ scale: CGFloat = 0.94) -> some View { modifier(PressScale(pressed: pressed, scale: scale)) }

  /** A list row's entrance: rises 10pt and fades in, 20ms later per row. Plays once, when the row first appears. */
  func rowEntrance(_ index: Int) -> some View { modifier(RowEntrance(index: index)) }

  /** A badge or count that pops when its value changes. */
  func badgePop(_ value: Int) -> some View { modifier(BadgePop(value: value)) }
}

/** A VStack whose children enter one after another (20ms apart), like the list rows. */
struct StaggeredStack<Content: View>: View {
  var spacing: CGFloat
  @ViewBuilder var content: Content

  var body: some View {
    VStack(spacing: spacing) {
      Group(subviews: content) { subviews in
        ForEach(Array(subviews.enumerated()), id: \.element.id) { i, view in view.rowEntrance(i) }
      }
    }
  }
}

private struct PressScale: ViewModifier {
  var pressed: Bool
  var scale: CGFloat
  @ReduceMotion private var reduceMotion
  func body(content: Content) -> some View {
    content.scaleEffect(pressed && !reduceMotion ? scale : 1).animation(pressed ? Motion.press : Motion.pop, value: pressed)
  }
}

private struct RowEntrance: ViewModifier {
  var index: Int
  @ReduceMotion private var reduceMotion
  @State private var shown = false

  func body(content: Content) -> some View {
    content
      .opacity(shown ? 1 : 0)
      .offset(y: shown || reduceMotion ? 0 : 10)
      .onAppear {
        guard !shown else { return }
        if reduceMotion { withAnimation(Motion.reduced) { shown = true } } else { withAnimation(Motion.settle.delay(Motion.stagger(index))) { shown = true } }
      }
  }
}

// MARK: messages

extension View {
  /** A message arriving: yours rises from the composer and settles; a reply pops in from the left. Only plays when the row is inserted. */
  func arrival(mine: Bool) -> some View { modifier(Arrival(mine: mine)) }

  /** The working bubble: fades in with a 6pt rise. */
  func workingArrival() -> some View { modifier(WorkingArrival()) }

  /** Animates inserted messages once a chat has loaded (never the first batch), so history doesn't all pop at once. */
  func messageArrivals<V: Equatable>(_ value: V, settled: Bool) -> some View { modifier(MessageArrivals(value: value, settled: settled)) }
}

private struct Arrival: ViewModifier {
  var mine: Bool
  @ReduceMotion private var reduceMotion

  func body(content: Content) -> some View {
    content.transition(reduceMotion ? .opacity : .asymmetric(
      insertion: mine
        ? .scale(scale: 0.86, anchor: .bottomTrailing).combined(with: .offset(y: 40)).combined(with: .opacity)
        : .scale(scale: 0.6, anchor: .bottomLeading).combined(with: .offset(y: 8)).combined(with: .opacity),
      removal: .opacity))
  }
}

private struct WorkingArrival: ViewModifier {
  @ReduceMotion private var reduceMotion
  func body(content: Content) -> some View {
    content.transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: 6)))
  }
}

private struct MessageArrivals<V: Equatable>: ViewModifier {
  var value: V
  var settled: Bool
  @ReduceMotion private var reduceMotion

  func body(content: Content) -> some View {
    content.animation(settled ? (reduceMotion ? Motion.reduced : Motion.pop) : nil, value: value)
  }
}

// MARK: badges

private struct BadgePop: ViewModifier {
  var value: Int
  @ReduceMotion private var reduceMotion
  @State private var scale: CGFloat = 1

  func body(content: Content) -> some View {
    content
      .scaleEffect(scale)
      .contentTransition(reduceMotion ? .identity : .numericText(value: Double(value)))
      .animation(reduceMotion ? nil : Motion.badge, value: value)
      .onChange(of: value) { old, new in
        guard !reduceMotion, new > 0 else { return }
        scale = new > old ? 0.55 : 0.8
        withAnimation(Motion.badge) { scale = 1 }
      }
  }
}

// MARK: tabs

extension View {
  /** A tab's pane when it becomes the selected one: it settles in from 8pt toward where you came from, with a fade (opacity only with Reduce Motion). */
  func tabEntrance(_ mine: MainTab, current: MainTab) -> some View { modifier(TabEntrance(mine: mine, current: current)) }
}

private struct TabEntrance: ViewModifier {
  var mine: MainTab
  var current: MainTab
  @ReduceMotion private var reduceMotion
  /** -1 or 1 while the pane is arriving (the side it comes from), 0 once settled */
  @State private var from: CGFloat = 0

  func body(content: Content) -> some View {
    content
      .opacity(from == 0 ? 1 : 0)
      .offset(x: reduceMotion ? 0 : from * 8)
      .onChange(of: current) { old, new in
        guard new == mine, old != new else { return }
        var instant = Transaction(animation: nil)
        instant.disablesAnimations = true
        withTransaction(instant) { from = new.rawValue > old.rawValue ? 1 : -1 }
        DispatchQueue.main.async {
          withAnimation(reduceMotion ? Motion.reduced : Motion.settle) { from = 0 }
        }
      }
  }
}
