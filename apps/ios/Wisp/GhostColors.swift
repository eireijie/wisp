import SwiftUI

/**
 * A ghost's colors in two rows, like GhostColors on the web: plain colors (white first) ending
 * with a picker for your own, and gradients ending with a picker for your own top and bottom.
 */
struct GhostColors: View {
  @Binding var look: GhostLook
  var labels = false
  @State private var customGradient = false

  /** one color top to bottom (no second color, or the same one twice) */
  static func isPlain(_ look: GhostLook) -> Bool { look.color2 == nil || look.color2?.lowercased() == look.color.lowercased() }

  static let plain: [(name: String, hex: String)] = [
    ("White", "#ffffff"), ("Mist", "#f4f1ff"), ("Sky", "#b9dcff"), ("Mint", "#b8f0d8"),
    ("Lavender", "#d6c8ff"), ("Peach", "#ffd3b8"), ("Rose", "#ffc2d6"), ("Midnight", "#2e2a4f"),
  ]
  static let gradients: [GhostPalette] = ["Bubblegum sky", "Orchid peach", "Coral mint", "Lime lagoon", "Arctic blue", "Solar flare", "Violet ember", "Ultraviolet tide"]
    .compactMap { name in GhostLook.palettes.first { $0.name == name } }

  /** a new agent's ghost starts plain white */
  static let white = "#ffffff"

  private var plain: Bool { Self.isPlain(look) }
  private var color: String { look.color.lowercased() }
  private var knownPlain: Bool { plain && Self.plain.contains { $0.hex == color } }
  private var knownGradient: Bool { !plain && Self.gradients.contains { $0.top == color && $0.bottom == look.color2?.lowercased() } }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      row("Plain") {
        ForEach(Self.plain, id: \.hex) { c in
          dot(selected: plain && color == c.hex, name: c.name) { look.color = c.hex; look.color2 = c.hex } fill: { Circle().fill(Color(hex: c.hex)) }
        }
        // your own plain color
        ColorPicker("Your own plain color", selection: hex(top: true, plain: true), supportsOpacity: false)
          .labelsHidden()
          .frame(maxWidth: 34, maxHeight: 34)
          .overlay(Circle().inset(by: -3).stroke(plain && !knownPlain ? Color.primary : .clear, lineWidth: 2))
      }
      row("Gradient") {
        ForEach(Self.gradients, id: \.name) { p in
          dot(selected: !plain && color == p.top && look.color2?.lowercased() == p.bottom, name: p.name) { look.color = p.top; look.color2 = p.bottom } fill: {
            Circle().fill(LinearGradient(colors: [Color(hex: p.top), Color(hex: p.bottom)], startPoint: .top, endPoint: .bottom))
          }
        }
        // your own gradient: a top and a bottom color
        dot(selected: !plain && !knownGradient, name: "Your own gradient") { customGradient = true } fill: {
          if !plain && !knownGradient {
            Circle().fill(LinearGradient(colors: [Color(hex: look.color), Color(hex: look.color2 ?? look.color)], startPoint: .top, endPoint: .bottom))
          } else {
            Circle().fill(AngularGradient(colors: [.red, .yellow, .green, .blue, .purple, .red], center: .center))
          }
        }
        .popover(isPresented: $customGradient) {
          VStack(alignment: .leading, spacing: 14) {
            Text("Your own gradient").font(.headline)
            ColorPicker("Top color", selection: hex(top: true, plain: false), supportsOpacity: false)
            ColorPicker("Bottom color", selection: hex(top: false, plain: false), supportsOpacity: false)
          }
          .padding(20)
          .frame(minWidth: 260)
          .presentationCompactAdaptation(.popover)
        }
      }
    }
  }

  @ViewBuilder private func row<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
    HStack(spacing: 6) {
      if labels { Text(title).font(.footnote).foregroundStyle(.secondary).frame(width: 64, alignment: .leading) }
      // each row stays one line: on a narrow screen the dots shrink instead of wrapping
      HStack(spacing: 6) { content() }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(title == "Plain" ? "Plain colors" : "Gradients")
  }

  private func dot<Fill: View>(selected: Bool, name: String, _ pick: @escaping () -> Void, @ViewBuilder fill: () -> Fill) -> some View {
    Button(action: pick) {
      fill()
        .overlay(Circle().stroke(Color.primary.opacity(0.12), lineWidth: 1))
        .padding(3)
        .overlay(Circle().stroke(selected ? Color.primary : .clear, lineWidth: 2))
        .frame(minWidth: 20, maxWidth: 36)
        .aspectRatio(1, contentMode: .fit)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(name)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }

  /** A color picker's binding: the plain color, or a gradient's top or bottom. */
  private func hex(top: Bool, plain: Bool) -> Binding<Color> {
    Binding(get: {
      Color(hex: top ? look.color : look.color2 ?? look.color)
    }, set: { picked in
      var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
      guard UIColor(picked).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return }
      let value = String(format: "#%02x%02x%02x", Int((min(1, max(0, red)) * 255).rounded()), Int((min(1, max(0, green)) * 255).rounded()), Int((min(1, max(0, blue)) * 255).rounded()))
      if plain {
        look.color = value; look.color2 = value
      } else if top {
        // starting a gradient from a plain color: a bottom that differs, as on the web
        if Self.isPlain(look) { look.color2 = "#6262ff" }
        look.color = value
      } else {
        look.color2 = value
      }
    })
  }
}
