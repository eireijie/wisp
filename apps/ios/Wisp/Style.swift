import SwiftUI

/**
 * Wisp's look on the phone: rounded type, soft rounded cards for content, and Liquid Glass for
 * the controls that float over it (iOS 26 and later; frosted material before).
 */
enum Corner {
  /** cards, screens, sheets */
  static let card: CGFloat = 24
  /** small icon tiles */
  static let tile: CGFloat = 14
}

extension View {
  /** A content card: a soft, rounded surface. */
  func card(_ radius: CGFloat = Corner.card, padding: CGFloat = 16) -> some View {
    self.padding(padding).background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(Color(.secondarySystemBackground)))
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
}

@available(iOS 26, *)
private func glassStyle(_ tint: Color?, _ interactive: Bool) -> Glass {
  var g = Glass.regular
  if let tint { g = g.tint(tint) }
  if interactive { g = g.interactive() }
  return g
}

/** A symbol in a rounded, softly colored tile, like Settings' icons. */
struct IconTile: View {
  var symbol: String
  var color: Color = .accentColor
  var size: CGFloat = 38

  var body: some View {
    Image(systemName: symbol)
      .font(.system(size: size * 0.45, weight: .semibold, design: .rounded))
      .symbolRenderingMode(.hierarchical)
      .foregroundStyle(color)
      .frame(width: size, height: size)
      .background(RoundedRectangle(cornerRadius: size * 0.32, style: .continuous).fill(color.opacity(0.15)))
  }
}

/** A colored dot with a soft glow, for status. */
struct GlowDot: View {
  var color: Color
  var body: some View {
    Circle().fill(color).frame(width: 8, height: 8).shadow(color: color.opacity(0.6), radius: 3)
  }
}
