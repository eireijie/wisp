import SwiftUI

/**
 * Wisp's look on the phone: dark first with matching light colors, the system font, 12pt cards, glass circle buttons and pill buttons. Liquid Glass floats over content on iOS 26 and
 * later (frosted material before). The colors come from the approved design (Palette below).
 */
enum Corner {
  /** cards, screens, sheets */
  static let card: CGFloat = 12
  /** small chips (a team chart's cards) */
  static let tile: CGFloat = 10
  /** sheets: a modest rounded top */
  static let sheet: CGFloat = 16
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
  static let card = Color(light: 0xFFFFFF, dark: 0x1E1E21)
  /** glass circle buttons, pills, the tab bar */
  static let control = Color(light: 0xFFFFFF, dark: 0x2A2A2E)
  /** search fields */
  static let field = Color(light: 0xE6E6EC, dark: 0x222225)
  /** an agent's chat bubble */
  static let bubble = Color(light: 0xE8E8EE, dark: 0x262629)
  static let text = Color(light: 0x111113, dark: 0xF2F2F4)
  static let muted = Color(light: 0x5F5F68, dark: 0xA1A1AA)
  static let faint = Color(light: 0x7C7C86, dark: 0x8E8E96)
  static let separator = Color(light: 0x000000, lightAlpha: 0.08, dark: 0xFFFFFF, darkAlpha: 0.08)
  static let hairline = Color(light: 0x000000, lightAlpha: 0.09, dark: 0xFFFFFF, darkAlpha: 0.10)
  /** the 1px edge on cards and panels */
  static let cardBorder = Color(light: 0x000000, lightAlpha: 0.08, dark: 0xFFFFFF, darkAlpha: 0.08)
  static let blue = Color(hex: 0x0A84FF)
  /** text that says an agent is working */
  static let green = Color(light: 0x1E9E52, dark: 0x30D158)
  /** online dots */
  static let online = Color(light: 0x1E9E52, dark: 0x30D158)
  static let red = Color(light: 0xD92D3A, dark: 0xFF6B6B)

  // MARK: small pops of color (pop-Palette). A pop is a solid icon or dot, usually on a 16% tint of itself; never a fill behind text.

  /** each tab's accent: its icon and highlight while you are on it */
  static let tabInbox = Color(light: 0xC77700, dark: 0xFF9F0A)
  static let tabChats = Color(light: 0x0A6FE0, dark: 0x0A84FF)
  static let tabAgents = Color(light: 0x9B3FD0, dark: 0xBF5AF2)
  static let tabComputers = Color(light: 0x0A8FB8, dark: 0x64D2FF)
  /** online and done: dots, checks, "handed back" */
  static let statusOnline = Color(light: 0x1E9E52, dark: 0x30D158)
  /** working: pulsing dots and the working line */
  static let statusWorking = Color(light: 0x0A6FE0, dark: 0x0A84FF)
  /** needs you: approvals, help requests, "took control" */
  static let statusNeeds = Color(light: 0xC77700, dark: 0xFF9F0A)
  /** a problem, or recording */
  static let statusProblem = Color(light: 0xD92D3A, dark: 0xFF453A)
  /** offline and idle stay gray on purpose */
  static let statusOffline = Color(light: 0x7C7C86, dark: 0x8E8E96)
  /** @mentions */
  static let mention = tabAgents
  /** computer and device icons */
  static let computer = tabComputers
  /** the tools while you are in control of a computer */
  static let toolTeach = statusProblem
  static let toolClipboard = Color(light: 0xB38F00, dark: 0xFFD60A)
  static let toolFiles = Color(light: 0x0A6FE0, dark: 0x0A84FF)
  static let toolKeys = tabComputers
  static let toolScreenshot = tabAgents
  /** the call button's icon */
  static let call = statusOnline
}

extension Color {
  /** The 16% tint that sits behind a solid pop. */
  var tint16: Color { opacity(0.16) }
}

/** A solid line icon on a 16% tint of its own color: the pop. */
struct PopIcon: View {
  var symbol: String
  var color: Color
  var size: CGFloat = 40
  var body: some View {
    Image(systemName: symbol)
      .font(.system(size: size * 0.42, weight: .regular))
      .foregroundStyle(color)
      .frame(width: size, height: size)
      .background(RoundedRectangle(cornerRadius: size * 0.3, style: .continuous).fill(color.tint16))
      .accessibilityHidden(true)
  }
}

extension View {
  /** A content card: a sharp-cornered surface with a 1px border. */
  func card(_ radius: CGFloat = Corner.card, padding: CGFloat = 16) -> some View {
    self.padding(padding).background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(Palette.card))
      .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Palette.cardBorder))
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
