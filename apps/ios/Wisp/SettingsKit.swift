import SwiftUI

// The pieces every settings page is built from (set-*.dc.html): a back circle, a big title, grouped
// cards, hints under cards, pill buttons, option rows, and a centered confirmation card. Pages only
// compose these, so all of them share one look.

/** A settings page: back circle, 30pt title (and a line under it), then cards on the sheet color. */
struct SettingsPage<Content: View, Trailing: View>: View {
  @Environment(\.dismiss) private var dismiss
  var title: String
  var subtitle: String? = nil
  var id: String
  @ViewBuilder var trailing: Trailing
  @ViewBuilder var content: Content

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        CircleButton(symbol: "chevron.left", label: "Back", id: "settings-back") { dismiss() }
        Spacer()
        trailing
      }
      .padding(.horizontal, 18).padding(.top, 12)
      Text(title)
        .font(.system(size: 30, weight: .bold)).tracking(-0.4)
        .foregroundStyle(Palette.text)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 22).padding(.top, 12)
        .accessibilityAddTraits(.isHeader)
      if let subtitle {
        Text(subtitle).font(.system(size: 15)).foregroundStyle(Palette.faint)
          .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 22).padding(.top, 4)
      }
      ScrollView {
        VStack(spacing: 14) { content }
          .padding(.horizontal, 18).padding(.top, 16).padding(.bottom, 40)
      }
      .scrollDismissesKeyboard(.interactively)
    }
    .background(Palette.sheet.ignoresSafeArea())
    .toolbar(.hidden, for: .navigationBar)
    .accessibilityIdentifier("screen-\(id)")
  }
}

extension SettingsPage where Trailing == EmptyView {
  init(_ title: String, subtitle: String? = nil, id: String, @ViewBuilder content: () -> Content) {
    self.init(title: title, subtitle: subtitle, id: id, trailing: { EmptyView() }, content: content)
  }
}

/** A small caption above a card (the design's .lbl). */
struct CardLabel: View {
  var text: String
  init(_ text: String) { self.text = text }
  var body: some View {
    Text(text).font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.faint)
      .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 6).padding(.top, 4)
      .accessibilityAddTraits(.isHeader)
  }
}

/** A line of explanation under a card (the design's .hint). */
struct CardHint: View {
  var text: String
  init(_ text: String) { self.text = text }
  var body: some View {
    Text(text).font(.system(size: 14)).foregroundStyle(Palette.faint).fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 6).padding(.top, -6)
  }
}

/** Why a page can't be changed: only owners can. */
struct OwnersOnlyNote: View {
  var body: some View { CardHint("Only owners can change these. You can see how they're set.") }
}

/** A row with a label on the left and a text field on the right. */
struct FieldRow: View {
  var title: String
  var subtitle: String? = nil
  @Binding var text: String
  var prompt = ""
  var secure = false
  var keyboard: UIKeyboardType = .default
  var contentType: UITextContentType? = nil
  var id: String? = nil

  var body: some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 17)).foregroundStyle(Palette.text)
        if let subtitle { Text(subtitle).font(.system(size: 14)).foregroundStyle(Palette.faint) }
      }
      .frame(minWidth: 96, alignment: .leading)
      .layoutPriority(1)
      Group {
        if secure { SecureField("", text: $text, prompt: Text(prompt).foregroundStyle(Palette.faint)) }
        else { TextField("", text: $text, prompt: Text(prompt).foregroundStyle(Palette.faint)) }
      }
      .multilineTextAlignment(.trailing).font(.system(size: 17)).foregroundStyle(Palette.text)
      .keyboardType(keyboard).textContentType(contentType)
      .textInputAutocapitalization(.never).autocorrectionDisabled()
      .accessibilityLabel(title)
      .accessibilityIdentifier(id ?? "")
    }
    .padding(.horizontal, 18).frame(minHeight: subtitle == nil ? 54 : 62)
  }
}

/** A row with a switch on the right. */
struct ToggleRow: View {
  var title: String
  var subtitle: String? = nil
  @Binding var isOn: Bool
  var id: String? = nil

  var body: some View {
    Toggle(isOn: $isOn) {
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 17)).foregroundStyle(Palette.text)
        if let subtitle { Text(subtitle).font(.system(size: 14)).foregroundStyle(Palette.faint) }
      }
    }
    .tint(Palette.blue)
    .padding(.horizontal, 18).frame(minHeight: subtitle == nil ? 54 : 62)
    .accessibilityIdentifier(id ?? "")
  }
}

/** A row that shows a value and does nothing. */
struct ValueRow: View {
  var title: String
  var subtitle: String? = nil
  var value: String
  var body: some View { RowLabel(title: title, subtitle: subtitle, value: value, chevron: false) }
}

/** One choice out of several, with a check on the picked one. */
struct OptionRow: View {
  var title: String
  var subtitle: String? = nil
  var selected: Bool
  var id: String? = nil
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 12) {
        VStack(alignment: .leading, spacing: 2) {
          Text(title).font(.system(size: 17)).foregroundStyle(Palette.text)
          if let subtitle { Text(subtitle).font(.system(size: 14)).foregroundStyle(Palette.faint).multilineTextAlignment(.leading) }
        }
        Spacer(minLength: 8)
        if selected { Image(systemName: "checkmark").font(.system(size: 16, weight: .semibold)).foregroundStyle(Palette.blue) }
      }
      .padding(.horizontal, 18).frame(minHeight: subtitle == nil ? 54 : 62).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier(id ?? "")
  }
}

/** A small round-rectangle picture of a person or thing: initials in a dark circle. */
struct InitialsDot: View {
  var name: String
  var size: CGFloat = 40
  var body: some View {
    let letters = name.split(separator: " ").prefix(2).compactMap { $0.first }
    Text(letters.isEmpty ? "?" : String(letters).uppercased())
      .font(.system(size: size * 0.33, weight: .semibold)).foregroundStyle(Palette.muted)
      .frame(width: size, height: size)
      .background(Circle().fill(Color(light: 0xE3E3EA, dark: 0x34343A)))
      .accessibilityHidden(true)
  }
}

/** Two to five choices in a pill: System | Light | Dark. */
struct SegmentedPicker<Value: Hashable>: View {
  var options: [(Value, String)]
  @Binding var selection: Value
  var label: String
  var id: String? = nil

  var body: some View {
    HStack(spacing: 2) {
      ForEach(options.indices, id: \.self) { i in
        let on = options[i].0 == selection
        Button { selection = options[i].0 } label: {
          Text(options[i].1)
            .font(.system(size: 15, weight: on ? .semibold : .medium)).lineLimit(1).minimumScaleFactor(0.8)
            .foregroundStyle(on ? Palette.text : Palette.muted)
            .frame(maxWidth: .infinity, minHeight: 38)
            .background(RoundedRectangle(cornerRadius: 11, style: .continuous).fill(on ? Palette.selected : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier(id.map { "\($0)-\(i)" } ?? "")
      }
    }
    .padding(3)
    .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Palette.control))
    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Palette.hairline))
    .accessibilityElement(children: .contain).accessibilityLabel(label)
  }
}

extension Palette {
  /** the picked segment inside a segmented picker */
  static let selected = Color(light: 0xE6E6EC, dark: 0x45454B)
  static let danger = Color(hex: 0xE5484D)
}

/** The design's buttons: a filled pill, a glass pill, a red outline, and plain text. */
struct PillButtonStyle: ButtonStyle {
  enum Kind { case primary, secondary, destructive, ghost, danger }
  var kind: Kind
  var small = false
  @Environment(\.isEnabled) private var enabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: small ? 15 : 17, weight: .semibold))
      .foregroundStyle(foreground)
      .frame(maxWidth: small ? nil : .infinity, minHeight: small ? 38 : 52)
      .padding(.horizontal, small ? 16 : 20)
      .background(Capsule().fill(fill))
      .overlay(Capsule().strokeBorder(stroke))
      .opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.45)
      .contentShape(Capsule())
  }

  private var foreground: Color {
    switch kind {
    case .primary: Color(light: 0xFFFFFF, dark: 0x111111)
    case .secondary: Palette.text
    case .destructive: Palette.red
    case .danger: .white
    case .ghost: Palette.muted
    }
  }
  private var fill: Color {
    switch kind {
    case .primary: Palette.text
    case .secondary: Palette.control
    case .destructive: Palette.danger.opacity(0.14)
    case .danger: Palette.danger
    case .ghost: .clear
    }
  }
  private var stroke: Color {
    switch kind {
    case .secondary: Palette.hairline
    case .destructive: Palette.danger.opacity(0.35)
    default: .clear
    }
  }
}

extension ButtonStyle where Self == PillButtonStyle {
  static func pill(_ kind: PillButtonStyle.Kind, small: Bool = false) -> PillButtonStyle { PillButtonStyle(kind: kind, small: small) }
}

/** An error or a "Saved" line under the last card. */
struct StatusLine: View {
  var error: String?
  var saved: String? = nil
  var body: some View {
    if let error {
      Text(error).font(.system(size: 14)).foregroundStyle(Palette.red).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 6)
        .accessibilityLabel("Error: \(error)")
    } else if let saved {
      Text(saved).font(.system(size: 14)).foregroundStyle(Palette.green).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 6)
    }
  }
}

/** A centered confirmation: a dimmed page and a card with a title, a line, a main button and Cancel. */
struct ConfirmCard: ViewModifier {
  @Binding var isPresented: Bool
  var title: String
  var message: String
  var confirm: String
  var destructive = true
  var action: () -> Void

  func body(content: Content) -> some View {
    content.overlay {
      if isPresented {
        ZStack {
          Color.black.opacity(0.6).ignoresSafeArea().onTapGesture { isPresented = false }
          VStack(spacing: 12) {
            Text(title).font(.system(size: 19, weight: .semibold)).foregroundStyle(Palette.text).multilineTextAlignment(.center)
            Text(message).font(.system(size: 15)).foregroundStyle(Palette.muted).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            Button(confirm) { isPresented = false; action() }
              .buttonStyle(.pill(destructive ? .danger : .primary)).accessibilityIdentifier("confirm-yes")
            Button("Cancel") { isPresented = false }.buttonStyle(.pill(.ghost)).accessibilityIdentifier("confirm-cancel")
          }
          .padding(.horizontal, 20).padding(.top, 24).padding(.bottom, 18)
          .background(RoundedRectangle(cornerRadius: 28, style: .continuous).fill(Palette.control))
          .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous).strokeBorder(Palette.hairline))
          .padding(.horizontal, 28)
          .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
        }
        .transition(.opacity)
      }
    }
    .animation(.easeOut(duration: 0.15), value: isPresented)
  }
}

extension View {
  func confirmCard(_ isPresented: Binding<Bool>, title: String, message: String, confirm: String, destructive: Bool = true, action: @escaping () -> Void) -> some View {
    modifier(ConfirmCard(isPresented: isPresented, title: title, message: message, confirm: confirm, destructive: destructive, action: action))
  }
}

/** The rarely used knobs: one row that opens them below it, inside the card. */
struct MoreOptionsRow<Content: View>: View {
  @State private var open = false
  @ViewBuilder var content: Content
  var body: some View {
    VStack(spacing: 0) {
      Button { withAnimation(.easeOut(duration: 0.15)) { open.toggle() } } label: {
        RowLabel(title: "More options", chevron: false).overlay(alignment: .trailing) {
          Image(systemName: "chevron.down").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.faint)
            .rotationEffect(.degrees(open ? 180 : 0)).padding(.trailing, 18)
        }
      }
      .buttonStyle(.plain).accessibilityAddTraits(.isButton).accessibilityValue(open ? "Expanded" : "Collapsed")
      .accessibilityIdentifier("more-options")
      if open { content }
    }
  }
}
