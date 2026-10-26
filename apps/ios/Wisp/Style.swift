import SwiftUI

/**
 * Wisp's look on the phone: dark first with matching light colors, the system font, 24pt rounded
 * cards, glass circle buttons and pill buttons. Liquid Glass floats over content on iOS 26 and
 * later (frosted material before). The colors come from the approved design (Palette below).
 */
enum Corner {
  /** cards, screens, sheets */
  static let card: CGFloat = 24
  /** small chips (a team chart's cards) */
  static let tile: CGFloat = 14
  /** sheets keep a big rounded top */
  static let sheet: CGFloat = 38
}

extension Color {
  /** A color that changes with light and dark mode. */
  init(light: UInt32, dark: UInt32) {
    self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
  }

  /** A translucent color that changes with light and dark mode. */
  init(light: UInt32, lightAlpha: Double, dark: UInt32, darkAlpha: Double) {
    self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark).withAlphaComponent(darkAlpha) : UIColor(hex: light).withAlphaComponent(lightAlpha) })
  }

  init(hex: UInt32) { self.init(uiColor: UIColor(hex: hex)) }
}

/** The design's colors. Dark is the design; light is its matching twin. */
enum Palette {
  /** the page behind everything (chat list, chat) */
  static let ground = Color(light: 0xF2F2F6, dark: 0x161618)
  /** sheets and settings pages */
  static let sheet = Color(light: 0xF7F7FA, dark: 0x1C1C1F)
  /** grouped rows and tiles */
  static let card = Color(light: 0xFFFFFF, dark: 0x26262A)
  /** glass circle buttons, pills, the tab bar */
  static let control = Color(light: 0xFFFFFF, dark: 0x2A2A2E)
  /** search fields */
  static let field = Color(light: 0xE6E6EC, dark: 0x222225)
  /** an agent's chat bubble */
  static let bubble = Color(light: 0xE8E8EE, dark: 0x262629)
  static let text = Color(light: 0x111113, dark: 0xF2F2F4)
  static let muted = Color(light: 0x5F5F68, dark: 0xA1A1AA)
  static let faint = Color(light: 0x7C7C86, dark: 0x8E8E96)
  static let separator = Color(light: 0x000000, lightAlpha: 0.08, dark: 0xFFFFFF, darkAlpha: 0.07)
  static let hairline = Color(light: 0x000000, lightAlpha: 0.09, dark: 0xFFFFFF, darkAlpha: 0.10)
  static let blue = Color(hex: 0x0A84FF)
  /** text that says an agent is working */
  static let green = Color(light: 0x1E9E52, dark: 0x5BD68A)
  /** online dots */
  static let online = Color(hex: 0x34C759)
  static let red = Color(light: 0xD92D3A, dark: 0xFF6B6B)
}

extension View {
  /** A content card: a soft, rounded surface. */
  func card(_ radius: CGFloat = Corner.card, padding: CGFloat = 16) -> some View {
    self.padding(padding).background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(Palette.card))
  }

  /** Liquid Glass in a rounded rectangle, for controls floating over content. */
  @ViewBuilder func glass(_ radius: CGFloat = Corner.card, tint: Color? = nil, interactive: Bool = false) -> some View {
    if #available(iOS 26, *) {
      self.glassEffect(glassStyle(tint, interactive), in: .rect(cornerRadius: radius, style: .continuous))
    } else {
      self.background(.regularMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
    }
  }

  /** Liquid Glass in a capsule. */
  @ViewBuilder func glassCapsule(tint: Color? = nil, interactive: Bool = false) -> some View {
    if #available(iOS 26, *) {
      self.glassEffect(glassStyle(tint, interactive), in: .capsule)
    } else {
      self.background(.regularMaterial, in: Capsule())
    }
  }

  /** The one main action on a screen: a big, prominent capsule. */
  @ViewBuilder func primaryButton() -> some View {
    // the app's tint is the text color (black, or white in dark mode), so the label is the background's color
    if #available(iOS 26, *) {
      self.foregroundStyle(Color(.systemBackground)).buttonStyle(.glassProminent).buttonBorderShape(.capsule).controlSize(.large)
    } else {
      self.foregroundStyle(Color(.systemBackground)).buttonStyle(.borderedProminent).buttonBorderShape(.capsule).controlSize(.large)
    }
  }

  /** Everything else that's a button: a glass capsule. */
  @ViewBuilder func secondaryButton() -> some View {
    if #available(iOS 26, *) {
      self.buttonStyle(.glass).buttonBorderShape(.capsule)
    } else {
      self.buttonStyle(.bordered).buttonBorderShape(.capsule)
    }
  }

  /** The page color behind a screen; hides a list's own grey so the design's ground shows. */
  func groundBackground(_ color: Color = Palette.ground) -> some View {
    self.scrollContentBackground(.hidden).background(color.ignoresSafeArea())
  }
}

@available(iOS 26, *)
private func glassStyle(_ tint: Color?, _ interactive: Bool) -> Glass {
  var g = Glass.regular
  if let tint { g = g.tint(tint) }
  if interactive { g = g.interactive() }
  return g
}

/**
 * A plain line icon, like the design's: no colored tile behind it. (The old tile took a color;
 * callers still pass one, and it is ignored, so every screen gets the plain look.)
 */
struct IconTile: View {
  var symbol: String
  var color: Color = .secondary
  var size: CGFloat = 38

  var body: some View {
    Image(systemName: symbol)
      .font(.system(size: size * 0.52, weight: .regular))
      .foregroundStyle(Palette.muted)
      .frame(width: size, height: size)
      .accessibilityHidden(true)
  }
}

/** A colored dot with a soft glow, for status. */
struct GlowDot: View {
  var color: Color
  var body: some View {
    Circle().fill(color).frame(width: 8, height: 8).shadow(color: color.opacity(0.6), radius: 3)
  }
}
