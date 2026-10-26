import SwiftUI

// The pieces the agent screens are built from (agent-*.dc.html): a page with a back circle and a
// two-line title, grouped rows, choice rows with a radio, switch rows, text field cards, pill
// buttons and segmented chips. They sit on Chrome.swift's circles and cards and Style.swift's Palette.

/** A page of the agent area: back (or close) circle, title with the agent's name under it, then scrolling cards. */
struct AgentFrame<Trailing: View, Content: View>: View {
  @Environment(\.dismiss) private var dismiss
  var title: String
  var subtitle: String? = nil
  /** an X instead of a back arrow, for sheets */
  var close = false
  var scrolls = true
  @ViewBuilder var trailing: Trailing
  @ViewBuilder var content: Content

  var body: some View {
    VStack(spacing: 0) {
      ZStack {
        VStack(spacing: 1) {
          Text(title).font(.system(size: 16, weight: .semibold)).foregroundStyle(Palette.text).lineLimit(1)
          if let subtitle, !subtitle.isEmpty { Text(subtitle).font(.system(size: 13)).foregroundStyle(Palette.faint).lineLimit(1) }
        }
        .padding(.horizontal, 72)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        HStack {
          CircleButton(symbol: close ? "xmark" : "chevron.left", label: close ? "Close" : "Back", id: close ? "agent-close" : "agent-back") { dismiss() }
          Spacer(minLength: 0)
          trailing
        }
      }
      .padding(.horizontal, 18).padding(.top, 8).padding(.bottom, 10)
      if scrolls {
        ScrollView {
          VStack(alignment: .leading, spacing: 14) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 18).padding(.top, 6).padding(.bottom, 120)
        }
        .scrollDismissesKeyboard(.interactively)
      } else {
        content
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Palette.sheet.ignoresSafeArea())
    .toolbar(.hidden, for: .navigationBar)
    .navigationBarBackButtonHidden(true)
  }
}

extension AgentFrame where Trailing == EmptyView {
  init(title: String, subtitle: String? = nil, close: Bool = false, scrolls: Bool = true, @ViewBuilder content: () -> Content) {
    self.init(title: title, subtitle: subtitle, close: close, scrolls: scrolls, trailing: { EmptyView() }, content: content)
  }
}

extension View {
  /** A sheet that looks like the rest of the design: sheet color, big rounded top. */
  func agentSheet(_ detents: Set<PresentationDetent> = [.large]) -> some View {
    self.tint(Palette.text)
      .presentationDetents(detents)
      .presentationBackground(Palette.sheet)
      .presentationCornerRadius(Corner.sheet)
      .presentationDragIndicator(.hidden)
  }
}

/** A line icon at the left of a row. */
func rowIcon(_ symbol: String) -> some View {
  Image(systemName: symbol).font(.system(size: 18, weight: .regular)).foregroundStyle(Palette.muted).frame(width: 24)
}

/** A row with a title, a smaller line under it and a radio at the right. */
struct ChoiceRow<Leading: View>: View {
  var title: String
  var subtitle: String? = nil
  var selected: Bool
  var tint: Color = Palette.text
  var action: () -> Void
  @ViewBuilder var leading: Leading

  var body: some View {
    Button(action: action) {
      HStack(spacing: 12) {
        leading
        VStack(alignment: .leading, spacing: 2) {
          Text(title).font(.system(size: 15)).foregroundStyle(tint).multilineTextAlignment(.leading)
          if let subtitle { Text(subtitle).font(.system(size: 13)).foregroundStyle(Palette.faint).multilineTextAlignment(.leading) }
        }
        Spacer(minLength: 8)
        Radio(on: selected)
      }
      .padding(.horizontal, 18).padding(.vertical, 8)
      .frame(minHeight: 60)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
  }
}

extension ChoiceRow where Leading == EmptyView {
  init(title: String, subtitle: String? = nil, selected: Bool, tint: Color = Palette.text, action: @escaping () -> Void) {
    self.init(title: title, subtitle: subtitle, selected: selected, tint: tint, action: action) { EmptyView() }
  }
}

/** The 24pt circle at the right of a choice: empty, or blue with a check. */
struct Radio: View {
  var on: Bool
  var body: some View {
    ZStack {
      if on {
        Circle().fill(Palette.blue)
        Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)).foregroundStyle(.white)
      } else {
        Circle().strokeBorder(Palette.faint.opacity(0.6), lineWidth: 1.5)
      }
    }
    .frame(width: 24, height: 24)
    .accessibilityHidden(true)
  }
}

/** A row with a switch at the right. */
struct SwitchRow: View {
  var title: String
  var subtitle: String? = nil
  @Binding var isOn: Bool
  var id: String = ""

  var body: some View {
    Toggle(isOn: $isOn) {
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 15)).foregroundStyle(Palette.text)
        if let subtitle { Text(subtitle).font(.system(size: 13)).foregroundStyle(Palette.faint) }
      }
    }
    .tint(Palette.blue)
    .padding(.horizontal, 18).padding(.vertical, 8)
    .frame(minHeight: 60)
    .accessibilityIdentifier(id)
  }
}

/** A card holding one text field with a small label over it. */
struct FieldCard: View {
  var label: String
  @Binding var text: String
  var prompt: String = ""
  var lines: ClosedRange<Int> = 1...1
  var monospaced = false
  var lowercase = false

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(label).font(.system(size: 13)).foregroundStyle(Palette.faint)
      Group {
        if lines.upperBound > 1 {
          TextField(prompt, text: $text, axis: .vertical).lineLimit(lines)
        } else {
          TextField(prompt, text: $text)
        }
      }
      .font(monospaced ? .system(size: 15, design: .monospaced) : .system(size: 17))
      .foregroundStyle(Palette.text)
      .textInputAutocapitalization(lowercase ? .never : nil)
      .autocorrectionDisabled(lowercase)
      .accessibilityLabel(label)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 18).padding(.vertical, 12)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
  }
}

/** The face of a full-width pill, for a Button or a NavigationLink. */
struct PillLabel: View {
  var title: String
  var kind: PillButton.Kind = .primary
  var busy = false
  @Environment(\.isEnabled) private var enabled

  var body: some View {
    Group {
      if busy { ProgressView().tint(kind == .primary ? Color(light: 0xFFFFFF, dark: 0x111113) : Palette.text) }
      else { Text(title).font(.system(size: 15, weight: kind == .primary ? .semibold : .medium)) }
    }
    .foregroundStyle(foreground)
    .frame(maxWidth: .infinity).frame(height: 56)
    .background(Capsule().fill(kind == .primary ? Palette.text : Palette.control))
    .overlay(Capsule().strokeBorder(kind == .primary ? Color.clear : Palette.hairline))
    .opacity(enabled ? 1 : 0.45)
    .contentShape(Capsule())
  }

  private var foreground: Color {
    switch kind {
    case .primary: Color(light: 0xFFFFFF, dark: 0x111113)
    case .secondary: Palette.text
    case .destructive: Palette.red
    }
  }
}

/** The one main action: a full-width pill filled with the text color. */
struct PillButton: View {
  enum Kind { case primary, secondary, destructive }
  var title: String
  var kind: Kind = .primary
  var busy = false
  var id: String = ""
  var action: () -> Void

  var body: some View {
    Button(action: action) { PillLabel(title: title, kind: kind, busy: busy) }
      .buttonStyle(.plain)
      .accessibilityIdentifier(id)
  }
}

/** A small pill, like Edit under a name. */
struct SmallPill: View {
  var title: String
  var symbol: String? = nil
  var id: String = ""
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        if let symbol { Image(systemName: symbol).font(.system(size: 14, weight: .medium)) }
        Text(title).font(.system(size: 15, weight: .medium))
      }
      .foregroundStyle(Palette.text)
      .padding(.horizontal, 20).frame(height: 40)
      .background(Capsule().fill(Color(light: 0xE3E3EA, dark: 0x2E2E32)))
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier(id)
  }
}

/** A chip that is filled when picked. */
struct AgentChip: View {
  var title: String
  var symbol: String? = nil
  var on = false
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 8) {
        if let symbol { Image(systemName: symbol).font(.system(size: 14, weight: .medium)) }
        Text(title).font(.system(size: 15, weight: .medium)).lineLimit(1)
      }
      .foregroundStyle(on ? Color(light: 0xFFFFFF, dark: 0x111113) : Palette.text)
      .padding(.horizontal, 16).frame(height: 38)
      .background(Capsule().fill(on ? Palette.text : Palette.control))
      .overlay(Capsule().strokeBorder(on ? Color.clear : Palette.hairline))
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
  }
}

/** Equal-width chips in a row where one is picked: Low / Medium / High, Use defaults / Customize. */
struct Segments<Value: Hashable>: View {
  var options: [(Value, String)]
  @Binding var selection: Value
  /** tapping the picked one again picks nothing (the harness's own) */
  var allowsNone: Value? = nil
  var id: String = ""

  var body: some View {
    HStack(spacing: 8) {
      ForEach(Array(options.enumerated()), id: \.offset) { _, option in
        let on = option.0 == selection
        Button {
          if on, let none = allowsNone { selection = none } else { selection = option.0 }
        } label: {
          Text(option.1).font(.system(size: 15, weight: .medium)).lineLimit(1).minimumScaleFactor(0.8)
            .foregroundStyle(on ? Color(light: 0xFFFFFF, dark: 0x111113) : Palette.text)
            .frame(maxWidth: .infinity).frame(height: 40)
            .background(Capsule().fill(on ? Palette.text : Palette.control))
            .overlay(Capsule().strokeBorder(on ? Color.clear : Palette.hairline))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
      }
    }
    .accessibilityIdentifier(id)
  }
}

/** Chips that wrap onto more lines. */
struct FlowLayout: Layout {
  var spacing: CGFloat = 8

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let rows = arrange(subviews, width: proposal.width ?? 320)
    return CGSize(width: proposal.width ?? rows.width, height: rows.height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    let rows = arrange(subviews, width: bounds.width)
    for (index, frame) in rows.frames.enumerated() {
      subviews[index].place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY), proposal: ProposedViewSize(frame.size))
    }
  }

  private func arrange(_ subviews: Subviews, width: CGFloat) -> (frames: [CGRect], width: CGFloat, height: CGFloat) {
    var frames: [CGRect] = []
    var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, maxX: CGFloat = 0
    for subview in subviews {
      let size = subview.sizeThatFits(.unspecified)
      if x > 0, x + size.width > width { x = 0; y += rowHeight + spacing; rowHeight = 0 }
      frames.append(CGRect(origin: CGPoint(x: x, y: y), size: size))
      x += size.width + spacing
      rowHeight = max(rowHeight, size.height)
      maxX = max(maxX, x - spacing)
    }
    return (frames, maxX, y + rowHeight)
  }
}

/** A plain card that wraps whatever is in it (text, a list of lines). */
struct AgentCard<Content: View>: View {
  @ViewBuilder var content: Content
  var body: some View {
    VStack(alignment: .leading, spacing: 6) { content }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 18).padding(.vertical, 14)
      .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
  }
}

/** A small error line under a card. */
struct AgentError: View {
  var text: String?
  var body: some View {
    if let text, !text.isEmpty {
      Text(text).font(.system(size: 13)).foregroundStyle(Palette.red).padding(.horizontal, 18)
        .frame(maxWidth: .infinity, alignment: .leading).accessibilityLabel("Error: \(text)")
    }
  }
}

/** A ghost, a title, two lines and two pills: the "Run headless?" and "Remove?" sheets. */
struct AgentConfirm: View {
  @Environment(\.dismiss) private var dismiss
  var agent: Agent
  var title: String
  var message: String
  var confirm: String
  var destructive = false
  var busy = false
  var error: String?
  var action: () -> Void

  var body: some View {
    VStack(spacing: 10) {
      Spacer(minLength: 0)
      GhostView(look: agent.settings?.appearance, seed: agent.handle, size: 96, animate: false)
        .frame(width: 96, height: 96).accessibilityHidden(true)
      Text(agent.name).font(.system(size: 22, weight: .semibold)).foregroundStyle(Palette.text)
      Text("@\(agent.handle) · \(HarnessChoice.label(agent.harness))").font(.system(size: 15)).foregroundStyle(Palette.faint)
      Text(title).font(.system(size: 20, weight: .semibold)).foregroundStyle(Palette.text).padding(.top, 14)
      Text(message).font(.system(size: 15)).foregroundStyle(Palette.muted).multilineTextAlignment(.center).padding(.horizontal, 12)
      AgentError(text: error)
      Spacer(minLength: 12)
      PillButton(title: confirm, kind: destructive ? .destructive : .primary, busy: busy, id: "agent-confirm", action: action)
        .disabled(busy)
      PillButton(title: "Cancel", kind: .secondary) { dismiss() }.disabled(busy)
    }
    .padding(.horizontal, 18).padding(.bottom, 18)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Palette.sheet.ignoresSafeArea())
    .agentSheet([.medium, .large])
    .interactiveDismissDisabled(busy)
  }
}
