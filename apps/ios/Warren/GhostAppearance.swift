import SwiftUI

/** Shared option order and seed arithmetic match core/appearance.ts. */
extension GhostLook {
  static let shapes = ["classic", "round", "tall", "sheet", "wisp"]
  static let eyeStyles = ["dots", "big", "happy", "sparkle", "wink"]
  static let mouths = ["smile", "open", "cat", "fangs", "tongue", "none"]
  static let hats = ["none", "tophat", "party", "beanie", "crown", "witch", "headphones", "bow", "halo", "flower", "propeller"]
  static let accessories = ["none", "glasses", "sunglasses", "monocle", "bowtie", "scarf", "tie", "mustache"]
  static let motions = ["float", "bounce", "sway", "still"]

  static func hash(_ seed: String) -> UInt32 {
    var h: UInt32 = 2_166_136_261
    for c in (seed.isEmpty ? "ghost" : seed).utf16 { h = (h ^ UInt32(c)) &* 16_777_619 }
    return h
  }

  static func defaultAppearance(_ seed: String) -> GhostLook {
    var h = hash(seed)
    func pick<T>(_ list: [T]) -> T {
      let value = list[Int(h % UInt32(list.count))]
      h = (h ^ (h >> 13)) &* 2_654_435_761
      return value
    }
    func roll() -> Double {
      let value = Double(h % 1000) / 1000
      h = (h ^ (h >> 11)) &* 2_246_822_519
      return value
    }
    let palette = pick(palettes)
    let shape = pick(shapes)
    let eyes = pick(Array(eyeStyles.dropLast()))
    let mouth = pick(["smile", "open", "cat", "smile"])
    let cheeks = roll() < 0.6
    let hat = roll() < 0.35 ? pick(Array(hats.dropFirst())) : "none"
    let accessory = roll() < 0.2 ? pick(Array(accessories.dropFirst())) : "none"
    return GhostLook(color: palette.top, color2: palette.bottom, eyes: eyes, mouth: mouth,
      cheeks: cheeks, shape: shape, glow: false, hat: hat, accessory: accessory, motion: "float")
  }

  /** Fill missing fields from older hubs without changing a saved single-color gradient. */
  var resolved: GhostLook {
    var look = self
    look.shape = Self.shapes.contains(shape ?? "") ? shape : "classic"
    look.eyes = Self.eyeStyles.contains(eyes ?? "") ? eyes : "dots"
    look.mouth = Self.mouths.contains(mouth ?? "") ? mouth : "smile"
    look.hat = Self.hats.contains(hat ?? "") ? hat : "none"
    look.accessory = Self.accessories.contains(accessory ?? "") ? accessory : "none"
    look.motion = Self.motions.contains(motion ?? "") ? motion : "float"
    look.glow = glow ?? false
    look.cheeks = cheeks ?? false
    look.color = GhostColor.safe(color, fallback: "#f4f1ff")
    if let color2 { look.color2 = GhostColor.safe(color2, fallback: look.color) }
    return look
  }
}

struct GhostPalette {
  var name: String
  var top: String
  var bottom: String
}

enum GhostColor {
  static func safe(_ hex: String, fallback: String) -> String {
    hex.count == 7 && hex.first == "#" && hex.dropFirst().allSatisfy(\.isHexDigit) ? hex : fallback
  }

  static func rgb(_ hex: String) -> [Double] {
    let n = UInt32(hex.dropFirst(), radix: 16) ?? 0
    return [Double((n >> 16) & 255), Double((n >> 8) & 255), Double(n & 255)]
  }

  static func ink(top: String, bottom: String?) -> Color {
    let a = rgb(top), b = bottom.map(rgb) ?? a.map { $0 * 0.8 }
    let linear = zip(a, b).map { x, y in
      let s = (x + y) / 510
      return s <= 0.03928 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4)
    }
    return Color(hex: linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722 < 0.16 ? "#f7f7f8" : "#1d1d1f")
  }

  static func shade(_ hex: String) -> String {
    let v = rgb(hex).map { $0 / 255 }, r = v[0], g = v[1], b = v[2]
    let hi = v.max()!, lo = v.min()!, l = (hi + lo) / 2, d = hi - lo
    let s = d == 0 ? 0 : d / (1 - abs(2 * l - 1))
    var h = 0.0
    if d != 0 { h = hi == r ? (g - b) / d : hi == g ? (b - r) / d + 2 : (r - g) / d + 4 }
    h = (h * 60 + 12).rounded()
    let saturation = (min(1, s + 0.12) * 100).rounded() / 100
    let light = (max(0.12, l - 0.16) * 100).rounded() / 100
    let chroma = (1 - abs(2 * light - 1)) * saturation
    let hue = (h.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) / 60
    let x = chroma * (1 - abs(hue.truncatingRemainder(dividingBy: 2) - 1))
    let parts: [Double]
    switch hue {
    case ..<1: parts = [chroma, x, 0]
    case ..<2: parts = [x, chroma, 0]
    case ..<3: parts = [0, chroma, x]
    case ..<4: parts = [0, x, chroma]
    case ..<5: parts = [x, 0, chroma]
    default: parts = [chroma, 0, x]
    }
    return "#" + parts.map { String(format: "%02x", Int((($0 + light - chroma / 2) * 255).rounded())) }.joined()
  }
}

extension GhostLook {
  static let palettes: [GhostPalette] = [
    GhostPalette(name: "Bubblegum sky", top: "#8bd4ff", bottom: "#ff51bf"),
    GhostPalette(name: "Pink lemonade", top: "#ff26a8", bottom: "#fff78a"),
    GhostPalette(name: "Orchid peach", top: "#e771ff", bottom: "#ffd87c"),
    GhostPalette(name: "Coral mint", top: "#beffe8", bottom: "#ff797b"),
    GhostPalette(name: "Lime lagoon", top: "#b4ffa4", bottom: "#26dfff"),
    GhostPalette(name: "Arctic blue", top: "#97fff3", bottom: "#0084ff"),
    GhostPalette(name: "Solar flare", top: "#ecca5c", bottom: "#fe3c3f"),
    GhostPalette(name: "Violet ember", top: "#ff5c43", bottom: "#6262ff"),
    GhostPalette(name: "Deep tide", top: "#003d60", bottom: "#32fffc"),
    GhostPalette(name: "Coral current", top: "#26e2ff", bottom: "#ff6666"),
    GhostPalette(name: "Golden hour", top: "#ffcd4f", bottom: "#fde5ba"),
    GhostPalette(name: "Tangerine cobalt", top: "#ffad32", bottom: "#4169ff"),
    GhostPalette(name: "Electric grove", top: "#b4ff32", bottom: "#008d58"),
    GhostPalette(name: "Flamingo jade", top: "#ff4f9a", bottom: "#36edaa"),
    GhostPalette(name: "Cherry pop", top: "#ff69db", bottom: "#d51c46"),
    GhostPalette(name: "Turquoise cherry", top: "#37f0db", bottom: "#ff4f64"),
    GhostPalette(name: "Ultraviolet tide", top: "#7516cf", bottom: "#00e8d1"),
  ]
}
