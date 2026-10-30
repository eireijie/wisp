import SwiftUI

// The pieces of the screens before you're in the app (pairing, waiting, errors): the Wisp logo
// bobbing over a big title, a tall code card, and full-width pill buttons. They follow the
// approved design (auth-Pair*, auth-Join*) and build on Palette and Chrome.

/** The Will-o' wisp as one simple piece, drawn in a 100-point box: a round body with a tail flicking up to the right. */
struct WispGhostShape: Shape {
  func path(in rect: CGRect) -> Path {
    let s = min(rect.width, rect.height) / 100
    func p(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: rect.midX + (x - 50) * s, y: rect.midY + (y - 50) * s) }
    var path = Path()
    path.move(to: p(48, 88))
    path.addCurve(to: p(19, 60), control1: p(30, 88), control2: p(19, 75))
    path.addCurve(to: p(44, 31), control1: p(19, 44), control2: p(31, 35))
    path.addCurve(to: p(78, 7), control1: p(57, 27), control2: p(68, 20))
    path.addCurve(to: p(81, 52), control1: p(81, 22), control2: p(83, 36))
    path.addCurve(to: p(48, 88), control1: p(79, 74), control2: p(66, 88))
    path.closeSubpath()
    return path
  }
}

/** Wisp's logo, "Will-o'": the white flame-shaped wisp on the cyan-to-blue tile, optionally floating up and down. */
struct WispMark: View {
  var size: CGFloat = 84
  var bobbing = true
  @State private var up = false
  @ReduceMotion private var reduceMotion

  var body: some View {
    let eye = Color(red: 0x15 / 255, green: 0x13 / 255, blue: 0x1C / 255)
    ZStack {
      LinearGradient(colors: [Color(red: 0x64 / 255, green: 0xD2 / 255, blue: 0xFF / 255), Color(red: 0x0A / 255, green: 0x84 / 255, blue: 0xFF / 255)], startPoint: .topLeading, endPoint: .bottomTrailing)
      WispGhostShape().fill(Color.white)
      Ellipse().fill(eye).frame(width: size * 0.072, height: size * 0.108).position(x: size * 0.41, y: size * 0.62)
      Ellipse().fill(eye).frame(width: size * 0.072, height: size * 0.108).position(x: size * 0.57, y: size * 0.61)
    }
    .frame(width: size, height: size)
    .clipShape(RoundedRectangle(cornerRadius: size * 0.23, style: .continuous))
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
