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
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    Form {
      Section("Mode") { ModePicker() }
      Section {
        ForEach(AppTheme.all) { item in
          Button { theme = item.id } label: {
            HStack(spacing: 12) {
              Circle().fill(Color(uiColor: UIColor(hex: scheme == .dark ? item.dark : item.light))).frame(width: 26, height: 26)
                .overlay(Circle().strokeBorder(Color.primary.opacity(0.15)))
              VStack(alignment: .leading, spacing: 2) {
                Text(item.name).foregroundStyle(.primary)
                Text(item.blurb).font(.caption).foregroundStyle(.secondary)
              }
              Spacer()
              if theme == item.id { Image(systemName: "checkmark").foregroundStyle(.tint) }
            }
          }.accessibilityIdentifier("theme-\(item.id)").accessibilityAddTraits(theme == item.id ? .isSelected : [])
        }
      } header: { Text("Theme") } footer: { Text("Every theme works in light and dark. Agents keep their own colors in all of them.") }
      Section {
        Picker("Text size", selection: $textSize) { Text("Small").tag("small"); Text("Default").tag("default"); Text("Large").tag("large") }.pickerStyle(.segmented)
        Toggle("Reduce motion", isOn: $reduceMotion)
      } header: { Text("Accessibility") } footer: { Text("Text size goes one step either way from your iPhone's own setting. Reduce motion keeps ghosts and transitions still; the iPhone's Reduce Motion setting does this too.") }
    }.sectionScreen("Appearance", id: "appearance")
  }
}
