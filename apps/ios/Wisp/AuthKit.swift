import SwiftUI

// The pieces of the screens before you're in the app (pairing, waiting, errors): the Wisp ghost
// bobbing over a big title, a tall code card, and full-width pill buttons. They follow the
// approved design (auth-Pair*, auth-Join*) and build on Palette and Chrome.

/** Wisp's ghost as one simple piece, drawn in a 24-point box like the design's path. */
struct WispGhostShape: Shape {
  func path(in rect: CGRect) -> Path {
    let s = min(rect.width, rect.height) / 24
    let ox = rect.midX - 12 * s, oy = rect.midY - 12 * s
    func p(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: ox + x * s, y: oy + y * s) }
    var path = Path()
    path.move(to: p(4.5, 10))
    // the round top: from the left edge over the top to the right edge
    for i in 1...40 {
      let a = Double.pi * (1 - Double(i) / 40)
      path.addLine(to: p(12 + 7.5 * cos(a), 10 - 7.5 * sin(a)))
    }
    path.addLine(to: p(19.5, 21))
    path.addLine(to: p(17, 19.3))
    path.addLine(to: p(14.5, 21))
    path.addLine(to: p(12, 19.3))
    path.addLine(to: p(9.5, 21))
    path.addLine(to: p(7, 19.3))
    path.addLine(to: p(4.5, 21))
    path.closeSubpath()
    return path
  }
}

/** The ghost with its two eyes, optionally floating up and down. */
struct WispMark: View {
  var size: CGFloat = 84
  var bobbing = true
  @State private var up = false
  @ReduceMotion private var reduceMotion

  var body: some View {
    ZStack {
      WispGhostShape().fill(Palette.text)
      Circle().fill(Palette.ground).frame(width: size * 0.108, height: size * 0.108).position(x: size * 9.5 / 24, y: size * 10.5 / 24)
      Circle().fill(Palette.ground).frame(width: size * 0.108, height: size * 0.108).position(x: size * 14.5 / 24, y: size * 10.5 / 24)
    }
    .frame(width: size, height: size)
    .offset(y: reduceMotion || !bobbing ? 0 : (up ? -6 : 0))
    .animation(reduceMotion || !bobbing ? nil : .easeInOut(duration: 1.3).repeatForever(autoreverses: true), value: up)
    .onAppear { up = true }
    .accessibilityHidden(true)
  }
}

/** The ghost, a big title and a line under it. */
struct AuthHero: View {
  var title: String
  var subtitle: String? = nil
  var ghost = true

  var body: some View {
    VStack(spacing: 14) {
      if ghost { WispMark() }
      Text(title)
        .font(.system(size: 22, weight: .semibold))
        .tracking(-0.4)
        .foregroundStyle(Palette.text)
        .multilineTextAlignment(.center)
        .padding(.top, ghost ? 10 : 0)
        .accessibilityAddTraits(.isHeader)
      if let subtitle {
        Text(subtitle)
          .font(.system(size: 15))
          .foregroundStyle(Palette.muted)
          .multilineTextAlignment(.center)
          .lineSpacing(3)
          .frame(maxWidth: 320)
      }
    }
    .frame(maxWidth: .infinity)
  }
}

/** The six digits to compare with the other screen, on a card. */
struct CodeCard: View {
  var code: String
  var body: some View {
    Text(code)
      .font(.system(size: 44, weight: .bold))
      .monospacedDigit()
      .tracking(8)
      .foregroundStyle(Palette.text)
      .padding(.vertical, 20)
      .padding(.horizontal, 34)
      .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
      .accessibilityLabel(code.filter { $0 != " " }.map(String.init).joined(separator: " "))
  }
}

/** Three pulsing dots and a line, for "still waiting". */
struct WaitingLine: View {
  var text: String
  var body: some View {
    HStack(spacing: 8) {
      WorkingDots(color: Palette.muted)
      Text(text).font(.system(size: 13)).foregroundStyle(Palette.muted)
    }
  }
}

/** The page: ground color, a leading circle button on top, the body, and buttons pinned at the bottom. */
struct AuthPage<Body: View, Bottom: View>: View {
  var back: (symbol: String, label: String, action: () -> Void)? = nil
  @ViewBuilder var content: Body
  @ViewBuilder var bottom: Bottom

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        if let back { CircleButton(symbol: back.symbol, label: back.label, action: back.action) }
        Spacer()
      }
      .frame(minHeight: 52)
      .padding(.horizontal, 18)
      .padding(.top, 8)
      ScrollView {
        content
          .padding(.horizontal, 28)
          .padding(.top, 28)
          .padding(.bottom, 24)
          .frame(maxWidth: 480)
          .frame(maxWidth: .infinity)
      }
      .scrollBounceBehavior(.basedOnSize)
      VStack(spacing: 6) { bottom }
        .frame(maxWidth: 480)
        .padding(.horizontal, 22)
        .padding(.bottom, 18)
        .frame(maxWidth: .infinity)
    }
    .background(Palette.ground.ignoresSafeArea())
  }
}

/** A full-width pill: filled for the main action, a raised control for the rest. */
struct AuthButton: View {
  var title: String
  var symbol: String? = nil
  var primary = true
  var id: String? = nil
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        if let symbol { Image(systemName: symbol).font(.system(size: 17, weight: .medium)) }
        Text(title).font(.system(size: 15, weight: .semibold))
      }
      .frame(maxWidth: .infinity, minHeight: 40)
    }
    .modifier(AuthButtonStyle(primary: primary))
    .accessibilityIdentifier(id ?? "")
  }
}

private struct AuthButtonStyle: ViewModifier {
  var primary: Bool
  func body(content: Content) -> some View {
    if primary { content.primaryButton() } else { content.secondaryButton() }
  }
}

/** A quiet blue text button under the pills. */
struct AuthLinkButton: View {
  var title: String
  var action: () -> Void
  var body: some View {
    Button(action: action) {
      Text(title).font(.system(size: 15, weight: .medium)).foregroundStyle(Palette.blue).frame(minHeight: 44).padding(.horizontal, 12)
    }
    .buttonStyle(.plain)
  }
}
