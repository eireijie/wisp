import SwiftUI

/**
 * A password, key or code field with an eye on the right (board 16, "Show password"): tap it to
 * show what was typed, and it turns into the crossed eye to hide it again. What's typed stays in the
 * binding either way; it never leaves the field. Style it like any text field.
 */
struct RevealField: View {
  var placeholder: String = ""
  @Binding var text: String
  var prompt: Text? = nil
  var alignment: TextAlignment = .leading
  /** VoiceOver's name for the field (not the eye, which says Show or Hide password) */
  var label: String? = nil
  var id: String? = nil
  @State private var shown = false
  @FocusState private var focused: Bool

  var body: some View {
    HStack(spacing: 8) {
      Group {
        if shown { TextField(placeholder, text: $text, prompt: prompt) }
        else { SecureField(placeholder, text: $text, prompt: prompt) }
      }
      .focused($focused)
      .multilineTextAlignment(alignment)
      .accessibilityLabel(label.map { Text($0) } ?? Text(placeholder))
      .accessibilityIdentifier(id ?? "")
      RevealEye(shown: $shown) { focused = true }
    }
  }
}

/** Just the eye: "eye" while hidden, "eye.slash" while shown. */
struct RevealEye: View {
  @Binding var shown: Bool
  var refocus: () -> Void = {}

  var body: some View {
    Button {
      shown.toggle()
      refocus()
    } label: {
      Image(systemName: shown ? "eye.slash" : "eye")
        .font(.system(size: 15))
        .foregroundStyle(Palette.faint)
        .frame(width: 28, height: 24)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(shown ? "Hide password" : "Show password")
    .accessibilityIdentifier("reveal")
  }
}
