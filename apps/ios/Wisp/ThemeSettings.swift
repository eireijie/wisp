import SwiftUI
import UIKit

/** Appearance choices kept on this iPhone, like the web keeps them in the browser: color theme, text size, reduced motion. */
enum ThemeSettings {
  static let themeKey = "wisp.theme"
  static let textKey = "wisp.textSize"
  static let motionKey = "wisp.motion"
  static let modeKey = "wisp.mode"
  /** Wisp is designed dark first; light and "match the system" are a choice away. */
  static let defaultMode = "dark"

  /** The theme's accent: dark in light mode and light in dark mode for Mono, so it reads as the text color. */
  static func accent(_ id: String) -> Color {
    if id == "mono" { return .primary }
    let theme = AppTheme.named(id)
    return Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: theme.dark) : UIColor(hex: theme.light) })
  }

  /** Steps from the iPhone's own text size: small is one smaller, large is one bigger. */
  static func shifted(_ size: DynamicTypeSize, _ choice: String) -> DynamicTypeSize {
    let all = DynamicTypeSize.allCases
    guard let i = all.firstIndex(of: size) else { return size }
    let step = choice == "small" ? -1 : choice == "large" ? 1 : 0
    return all[min(max(i + step, 0), all.count - 1)]
  }
}

extension UIColor {
  convenience init(hex: UInt32) {
    self.init(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
  }
}

/** Applies the theme's accent, the text size and reduced motion to everything below it. */
struct AppearanceModifier: ViewModifier {
  @AppStorage(ThemeSettings.themeKey, store: WispPreferences.standard) private var theme = "mono"
  @AppStorage(ThemeSettings.textKey, store: WispPreferences.standard) private var textSize = "default"
  @AppStorage(ThemeSettings.motionKey, store: WispPreferences.standard) private var reduceMotion = false
  @Environment(\.dynamicTypeSize) private var systemSize

  func body(content: Content) -> some View {
    content
      .tint(ThemeSettings.accent(theme))
      .dynamicTypeSize(ThemeSettings.shifted(systemSize, textSize))
      .transaction { if reduceMotion { $0.animation = nil } }
  }
}

extension View {
  func appearance() -> some View { modifier(AppearanceModifier()) }
}

struct AppearanceSettingsView: View {
  @AppStorage(ThemeSettings.themeKey, store: WispPreferences.standard) private var theme = "mono"
  @AppStorage(ThemeSettings.textKey, store: WispPreferences.standard) private var textSize = "default"
  @AppStorage(ThemeSettings.motionKey, store: WispPreferences.standard) private var reduceMotion = false
  @AppStorage(ThemeSettings.modeKey, store: WispPreferences.standard) private var mode = ThemeSettings.defaultMode
  @Environment(\.colorScheme) private var scheme

  private let sizes = ["small", "default", "large"]
  private var sizeStep: Binding<Double> {
    Binding(get: { Double(sizes.firstIndex(of: textSize) ?? 1) }, set: { textSize = sizes[min(max(Int($0.rounded()), 0), 2)] })
  }

  var body: some View {
    SettingsPage("Appearance", id: "appearance") {
      CardLabel("Mode")
      SegmentedPicker(options: [("system", "System"), ("light", "Light"), ("dark", "Dark")], selection: $mode, label: "Mode", id: "mode")
      CardLabel("Theme")
      HStack(alignment: .top) {
        ForEach(AppTheme.all) { item in
          let on = theme == item.id
          Button { theme = item.id } label: {
            VStack(spacing: 8) {
              Circle()
                .fill(LinearGradient(stops: [.init(color: Color(hex: item.light), location: 0.5), .init(color: Color(hex: item.dark), location: 0.5)], startPoint: .topLeading, endPoint: .bottomTrailing))
                .frame(width: 52, height: 52)
                .overlay(Circle().strokeBorder(on ? Palette.blue : Palette.hairline, lineWidth: 2))
              Text(item.name).font(.system(size: 12, weight: .medium)).foregroundStyle(Palette.text).lineLimit(1).minimumScaleFactor(0.7)
            }.frame(maxWidth: .infinity)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("\(item.name) theme").accessibilityIdentifier("theme-\(item.id)")
          .accessibilityAddTraits(on ? .isSelected : [])
        }
      }
      .padding(.vertical, 18).padding(.horizontal, 6)
      .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
      CardHint("\(AppTheme.named(theme).name): \(AppTheme.named(theme).blurb) Every theme works in light and dark. Agents keep their own colors in all of them.")
      CardLabel("Accessibility")
      CardGroup {
        HStack(spacing: 12) {
          Text("A").font(.system(size: 13)).foregroundStyle(Palette.faint)
          Slider(value: sizeStep, in: 0...2, step: 1).tint(Palette.blue).accessibilityLabel("Text size").accessibilityValue(textSize.capitalized)
          Text("A").font(.system(size: 22)).foregroundStyle(Palette.text)
        }.padding(.horizontal, 18).frame(minHeight: 54)
        ToggleRow(title: "Reduce motion", isOn: $reduceMotion, id: "reduce-motion")
      }
      CardHint("Text size goes one step either way from your iPhone's own setting. Reduce motion calms the ghosts and screen transitions; the iPhone's Reduce Motion setting does this too.")
    }
  }
}
