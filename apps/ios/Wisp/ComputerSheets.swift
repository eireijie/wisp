import SwiftUI

// Small pieces of the computer page: the chips under the screen, the screen-code prompt and the
// hand-back note (comp-Detail, comp-ScreenCode, comp-HandBack).

/** A square-ish chip with a line icon over a word: Keys, Clipboard, Files, Screenshot. */
struct ChipFace: View {
  var symbol: String
  var title: String
  var body: some View {
    VStack(spacing: 4) {
      Image(systemName: symbol).font(.system(size: 20, weight: .regular))
      Text(title).font(.system(size: 12, weight: .medium))
    }
    .foregroundStyle(Palette.text)
    .frame(maxWidth: .infinity, minHeight: 62)
    .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Palette.control))
    .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Palette.hairline))
    .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
  }
}

/** The screen's code: six dots and a number pad (or a password box). The device checks it, not Wisp. */
struct ScreenCodeSheet: View {
  @Environment(\.dismiss) private var dismiss
  var computer: Computer
  var deviceName: String
  var error: String?
  var onSubmit: (String) -> Void
  @State private var code = ""
  @State private var help = false
  private var isPin: Bool { computer.code != "password" }

  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: computer.name) { dismiss() }
      ScrollView {
        VStack(spacing: 18) {
          Image(systemName: "lock").font(.system(size: 28)).foregroundStyle(Palette.muted).padding(.top, 8)
          Text("Screen code").font(.system(size: 22, weight: .bold)).foregroundStyle(Palette.text)
          if let error {
            Text(error.lowercased().contains("code") || error.lowercased().contains("pin") ? error : "That code is not right. Try again.")
              .font(.system(size: 15)).foregroundStyle(Palette.red).multilineTextAlignment(.center).accessibilityIdentifier("screen-code-error")
          } else {
            Text("Type the code you set on \(deviceName) to open its screen. The device checks it, not Wisp.")
              .font(.system(size: 15)).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
          }
          if isPin { pin } else { password }
          Button { help.toggle() } label: { Label("Where do I find my screen code?", systemImage: "questionmark.circle").font(.system(size: 15)) }
            .buttonStyle(.plain).foregroundStyle(Palette.muted)
          if help { Text("At \(deviceName), run wisp node screen code to pick a new one.").font(.system(size: 14)).foregroundStyle(Palette.faint).multilineTextAlignment(.center) }
        }.padding(.horizontal, 24).padding(.bottom, 24)
      }
    }
    .background(Palette.sheet.ignoresSafeArea())
    .presentationBackground(Palette.sheet)
    .presentationCornerRadius(Corner.sheet)
    .presentationDragIndicator(.hidden)
    .presentationDetents([.large])
  }

  private var pin: some View {
    VStack(spacing: 22) {
      HStack(spacing: 16) {
        ForEach(0..<6, id: \.self) { i in
          Circle().fill(i < code.count ? Palette.text : Palette.control).frame(width: 14, height: 14)
            .overlay(Circle().strokeBorder(Palette.hairline))
        }
      }.accessibilityElement(children: .ignore).accessibilityLabel("\(code.count) of 6 digits")
      let keys: [[String]] = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["", "0", "⌫"]]
      VStack(spacing: 12) {
        ForEach(keys, id: \.self) { row in
          HStack(spacing: 18) {
            ForEach(row, id: \.self) { k in
              if k.isEmpty { Color.clear.frame(width: 72, height: 72) }
              else {
                Button { press(k) } label: {
                  Group {
                    if k == "⌫" { Image(systemName: "delete.left").font(.system(size: 22)) } else { Text(k).font(.system(size: 28, weight: .regular)) }
                  }
                  .foregroundStyle(Palette.text).frame(width: 72, height: 72)
                  .background(Circle().fill(k == "⌫" ? Color.clear : Palette.control))
                  .overlay(Circle().strokeBorder(k == "⌫" ? Color.clear : Palette.hairline))
                }
                .buttonStyle(.plain).accessibilityLabel(k == "⌫" ? "Delete" : k).accessibilityIdentifier("pin-\(k)")
              }
            }
          }
        }
      }
    }
  }

  private var password: some View {
    VStack(spacing: 12) {
      ScreenCodeField(kind: "password", code: $code) { send() }
      Button { send() } label: { Text("Open").frame(maxWidth: .infinity) }.primaryButton().disabled(!ScreenCodeField.ready("password", code))
    }
  }

  private func press(_ k: String) {
    if k == "⌫" { if !code.isEmpty { code.removeLast() }; return }
    guard code.count < 6 else { return }
    code += k
    if code.count == 6 { send() }
  }

  private func send() {
    guard ScreenCodeField.ready(computer.code, code) else { return }
    let c = code
    code = ""
    onSubmit(c)
    dismiss()
  }
}

/** Tell the agent what you did before it picks up again. */
struct HandBackSheet: View {
  @Environment(\.dismiss) private var dismiss
  var agentName: String
  var onHandBack: (String?) -> Void
  @State private var note = ""

  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: "Hand back to \(agentName)") { dismiss() }
      VStack(alignment: .leading, spacing: 14) {
        Text("\(agentName) picks up where you left off. Tell it what you changed so it does not redo or undo it.").font(.system(size: 15)).foregroundStyle(Palette.muted)
        CardCaption("What you did (optional)")
        TextField("Signed in to the dashboard", text: $note, axis: .vertical).lineLimit(2...5)
          .padding(14).background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
          .accessibilityIdentifier("hand-back-note")
        Button { onHandBack(note); dismiss() } label: { Text("Hand back").frame(maxWidth: .infinity) }.primaryButton().accessibilityIdentifier("hand-back-go")
        Button { dismiss() } label: { Text("Keep control").frame(maxWidth: .infinity) }.secondaryButton()
        Spacer(minLength: 0)
      }.padding(.horizontal, 18).padding(.top, 8)
    }
    .background(Palette.sheet.ignoresSafeArea())
    .presentationBackground(Palette.sheet)
    .presentationCornerRadius(Corner.sheet)
    .presentationDetents([.medium])
    .presentationDragIndicator(.hidden)
  }
}
