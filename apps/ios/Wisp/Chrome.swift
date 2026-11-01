import SwiftUI

// The shared pieces every screen is built from: glass circle buttons, the pill header, grouped cards,
// sheet headers, and the overlapped ghosts a team shows. They follow the approved design (Main, Chat,
// Settings), so later screens only compose them.

/** A round glass button's face: a line icon in a circle (52pt in the design). Use it as a Button or Menu label. */
struct CircleLabel: View {
  var symbol: String
  var size: CGFloat = 44
  var weight: Font.Weight = .medium

  var body: some View {
    Image(systemName: symbol)
      .font(.system(size: size * 0.38, weight: weight))
      .foregroundStyle(Palette.text)
      .frame(width: size, height: size)
      .glassCircle()
      .contentShape(Circle())
  }
}

extension View {
  /** Liquid Glass in a circle (a solid control with a hairline before iOS 26). */
  @ViewBuilder func glassCircle() -> some View {
    if #available(iOS 26, *) {
      self.glassEffect(.regular.interactive(), in: .circle)
    } else {
      self.background(Circle().fill(Palette.control)).overlay(Circle().strokeBorder(Palette.hairline))
    }
  }

  /** The light surface a pill (name, tab bar) sits on. */
  @ViewBuilder func glassPill() -> some View {
    if #available(iOS 26, *) {
      self.glassEffect(.regular.interactive(), in: .capsule)
    } else {
      self.background(Capsule().fill(Palette.control)).overlay(Capsule().strokeBorder(Palette.hairline))
    }
  }
}

/** A glass circle button with a line icon. */
struct CircleButton: View {
  var symbol: String
  var label: String
  var size: CGFloat = 44
  var id: String? = nil
  var action: () -> Void

  var body: some View {
    Button(action: action) { CircleLabel(symbol: symbol, size: size) }
      .buttonStyle(.press)
      .accessibilityLabel(label)
      .accessibilityIdentifier(id ?? "")
  }
}

/** Your initials in a glass circle: opens settings. */
struct ProfileCircle: View {
  @Environment(Store.self) private var store
  var size: CGFloat = 44
  /** false inside a navigation bar, which already draws its buttons on glass */
  var glass = true

  private var initials: String {
    let name = store.me?.preferredName ?? store.me?.name ?? ""
    let letters = name.split(separator: " ").prefix(2).compactMap { $0.first }
    return letters.isEmpty ? "?" : String(letters).uppercased()
  }

  var body: some View {
    let face = Text(initials)
      .font(.system(size: size * 0.31, weight: .semibold))
      .foregroundStyle(Palette.muted)
      .frame(width: size, height: size)
    Group {
      if glass { face.glassCircle() } else { face }
    }
    .contentShape(Circle())
    .accessibilityLabel("You and settings")
  }
}

/** The top of a page that has no navigation bar: a 44pt circle on each side, an optional centered pill or title between. */
struct TopBar<Leading: View, Center: View, Trailing: View>: View {
  /** room kept clear of the center on each side (wider when the trailing side has two things) */
  var inset: CGFloat = 64
  @ViewBuilder var leading: Leading
  @ViewBuilder var center: Center
  @ViewBuilder var trailing: Trailing

  var body: some View {
    ZStack {
      center.padding(.horizontal, inset)
      HStack { leading; Spacer(minLength: 0); trailing }
    }
    .padding(.horizontal, 18)
    .padding(.top, 8)
    .padding(.bottom, 8)
  }
}

/** The name in the middle of a chat's top bar: the ghost and the name on a glass pill. */
struct NamePill<Icon: View>: View {
  var title: String
  @ViewBuilder var icon: Icon

  var body: some View {
    HStack(spacing: 10) {
      icon
      Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text).lineLimit(1)
    }
    .padding(.leading, 12).padding(.trailing, 18)
    .frame(height: 44)
    .glassPill()
    .contentShape(Capsule())
  }
}

/** The top of a sheet: a close circle on the left and a title in the middle. */
struct SheetHeader: View {
  var title: String = ""
  var close: () -> Void

  var body: some View {
    ZStack {
      Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text)
      HStack {
        CircleButton(symbol: "xmark", label: "Close", action: close)
        Spacer()
      }
    }
    .padding(.horizontal, 18)
    .padding(.top, 16)
    .padding(.bottom, 8)
  }
}

/** A grouped card of rows with hairlines between them, 12pt corners and a 1px border. */
struct CardGroup<Content: View>: View {
  @ViewBuilder var content: Content

  var body: some View {
    VStack(spacing: 0) {
      Group(subviews: content) { subviews in
        ForEach(subviews.indices, id: \.self) { i in
          if i > 0 { Rectangle().fill(Palette.separator).frame(height: 1).padding(.leading, 14) }
          subviews[i]
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .clipShape(RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
  }
}

/** A row's face for a CardGroup: icon, title (and a smaller line under it), a value, and a chevron. */
struct RowLabel<Leading: View>: View {
  var title: String
  var subtitle: String? = nil
  var value: String? = nil
  var chevron = true
  var tint: Color = Palette.text
  @ViewBuilder var leading: Leading

  var body: some View {
    HStack(spacing: 12) {
      leading
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 15)).foregroundStyle(tint)
        if let subtitle { Text(subtitle).font(.system(size: 13)).foregroundStyle(Palette.faint) }
      }
      Spacer(minLength: 8)
      if let value { Text(value).font(.system(size: 15)).foregroundStyle(Palette.faint).lineLimit(1) }
      if chevron { Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.faint) }
    }
    .padding(.horizontal, 14)
    .frame(minHeight: subtitle == nil ? 48 : 56)
    .contentShape(Rectangle())
  }
}

extension RowLabel where Leading == EmptyView {
  init(title: String, subtitle: String? = nil, value: String? = nil, chevron: Bool = true, tint: Color = Palette.text) {
    self.init(title: title, subtitle: subtitle, value: value, chevron: chevron, tint: tint) { EmptyView() }
  }
}

/** A small grey caption over a card. */
struct CardCaption: View {
  var text: String
  init(_ text: String) { self.text = text }
  var body: some View {
    Text(text).font(.system(size: 13)).foregroundStyle(Palette.faint).padding(.horizontal, 18).frame(maxWidth: .infinity, alignment: .leading)
  }
}

/** A team: its first two agents as overlapped ghosts (a single agent is one ghost). */
struct TeamGhosts: View {
  @Environment(Store.self) private var store
  var agents: [Agent]
  /** keeps the stand-in ghosts the same from run to run when a team has fewer than two agents */
  var seed: String
  var size: CGFloat = 32

  var body: some View {
    let first = size * 0.71, second = size * 0.75
    ZStack(alignment: .topLeading) {
      ghost(0, first).offset(x: 0, y: 0)
      ghost(1, second)
        .padding(1.5).background(Circle().fill(Palette.ground).padding(2)).offset(x: size * 0.36, y: size * 0.25)
    }
    .frame(width: size * 1.14, height: size, alignment: .topLeading)
    .accessibilityHidden(true)
  }

  @ViewBuilder private func ghost(_ index: Int, _ side: CGFloat) -> some View {
    if index < agents.count { AgentAvatar(agent: agents[index], size: side, showStatus: false) }
    else { GhostView(look: nil, seed: seed + String(index), size: side) }
  }
}

/** One agent's ghost at the size a chat row uses. */
struct SoloGhost: View {
  var agent: Agent
  var size: CGFloat = 32
  var body: some View {
    AgentAvatar(agent: agent, size: size, showStatus: false)
      .frame(width: size * 1.14, height: size, alignment: .leading)
  }
}

extension UINavigationController: @retroactive UIGestureRecognizerDelegate {
  override open func viewDidLoad() {
    super.viewDidLoad()
    // screens with their own top bar hide the system one; the swipe back from the edge should still work
    interactivePopGestureRecognizer?.delegate = self
  }

  public func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    viewControllers.count > 1
  }
}

/** Dots that pulse while an agent works. */
struct WorkingDots: View {
  var color: Color = Palette.statusWorking
  @State private var on = false
  @ReduceMotion private var reduceMotion

  var body: some View {
    HStack(spacing: 3) {
      ForEach(0..<3, id: \.self) { i in
        Circle().fill(color).frame(width: 5, height: 5)
          .opacity(reduceMotion ? 0.8 : on ? 1 : 0.3)
          .animation(reduceMotion ? nil : .easeInOut(duration: 0.6).repeatForever().delay(Double(i) * 0.2), value: on)
      }
    }
    .onAppear { on = true }
    .accessibilityHidden(true)
  }
}
