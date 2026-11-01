import SwiftUI

// The shapes the marketplace, connected apps, skills, harnesses and logins share, drawn from the
// approved market-*.dc.html screens: neutral line-icon tiles (never brand logos), grouped rounded
// cards, little pills, pill buttons, segmented controls, and screens with a glass back circle.

enum MarketColor {
  /** a tile's neutral square */
  static let tile = Color(light: 0xE9E9EF, dark: 0x2E2E32)
  /** the small "Add" button and a selected segment */
  static let chip = Color(light: 0xE9E9EF, dark: 0x2E2E32)
  static let segment = Color(light: 0xFFFFFF, dark: 0x3A3A3F)
  static let blueText = Color(light: 0x0A6FD6, dark: 0x5EA8FF)
  static let warn = Color(light: 0xB86E00, dark: 0xFBBF24)
}

/** A neutral rounded square with a line icon: an app, a skill, a harness, a password manager. */
struct MarketTile: View {
  var symbol: String
  var size: CGFloat = 40

  var body: some View {
    Image(systemName: symbol)
      .font(.system(size: size * 0.45, weight: .regular))
      .foregroundStyle(Palette.text.opacity(0.9))
      .frame(width: size, height: size)
      .background(MarketColor.tile, in: RoundedRectangle(cornerRadius: size * 0.3, style: .continuous))
      .accessibilityHidden(true)
  }
}

/** A small status pill: "On", "Signed in", "Coming soon", "Made by Wisp". */
struct MarketPill: View {
  enum Tone { case blue, green, grey, warn }
  var text: String
  var tone: Tone = .grey
  var symbol: String?

  var body: some View {
    HStack(spacing: 5) {
      if let symbol { Image(systemName: symbol).font(.system(size: 11, weight: .semibold)) }
      Text(text).lineLimit(1)
    }
    .font(.system(size: 12, weight: .semibold))
    .foregroundStyle(ink)
    .padding(.horizontal, 10)
    .frame(height: 24)
    .background(Capsule().fill(fill))
    .fixedSize()
  }

  private var ink: Color {
    switch tone {
    case .blue: MarketColor.blueText
    case .green: Palette.statusOnline
    case .grey: Palette.muted
    case .warn: MarketColor.warn
    }
  }

  private var fill: Color {
    switch tone {
    case .blue: Palette.blue.opacity(0.16)
    case .green: Palette.statusOnline.opacity(0.14)
    case .grey: MarketColor.chip
    case .warn: MarketColor.warn.opacity(0.14)
    }
  }
}

/** The registry's word on who publishes an app, as a pill (the real trust levels). */
struct TrustBadge: View {
  var trust: TrustLabel
  var body: some View {
    MarketPill(text: trust.text, tone: trust.kind == .unverified ? .grey : .blue, symbol: trust.kind == .unverified ? "questionmark.shield" : trust.kind == .maker ? "checkmark.seal" : "checkmark.shield")
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("\(trust.text). \(trust.explanation)")
  }
}

/** "Add", "Install", "Bring in": the small pill button at the end of a row. */
struct AddButton: View {
  var title: String
  var muted = false
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(title)
        .font(.system(size: 15, weight: .medium))
        .foregroundStyle(muted ? Palette.faint : Palette.text)
        .padding(.horizontal, 14)
        .frame(height: 34)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(MarketColor.chip))
    }.buttonStyle(.plain)
  }
}

/** A row's content: a tile, a title with a line under it, and something on the right. */
struct MarketRow<Trailing: View>: View {
  var symbol: String?
  /** where its logo can be loaded from, best first; the symbol stands in until one does */
  var logos: [String] = []
  var tile: CGFloat = 40
  var title: String
  var subtitle: String?
  var danger = false
  /** no side padding, for rows that sit straight on the page instead of in a card */
  var flush = false
  @ViewBuilder var trailing: Trailing

  var body: some View {
    HStack(spacing: 14) {
      if !logos.isEmpty { AppLogo(sources: logos, symbol: symbol ?? "powerplug", size: tile) }
      else if let symbol { MarketTile(symbol: symbol, size: tile) }
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 15, weight: .medium)).foregroundStyle(danger ? Palette.red : Palette.text).lineLimit(2).fixedSize(horizontal: false, vertical: true)
        if let subtitle { Text(subtitle).font(.system(size: 13)).foregroundStyle(Palette.faint).lineLimit(2).fixedSize(horizontal: false, vertical: true) }
      }
      Spacer(minLength: 8)
      trailing
    }
    .padding(.horizontal, flush ? 0 : 16).padding(.vertical, 10)
    .frame(minHeight: 64)
    .contentShape(Rectangle())
  }
}

extension MarketRow where Trailing == EmptyView {
  init(symbol: String? = nil, tile: CGFloat = 40, title: String, subtitle: String? = nil, danger: Bool = false, flush: Bool = false) {
    self.init(symbol: symbol, tile: tile, title: title, subtitle: subtitle, danger: danger, flush: flush) { EmptyView() }
  }
}

/** A row with a switch on the right (which helpers get it, a plugin on or off). */
struct MarketToggleRow<Leading: View>: View {
  var title: String
  var subtitle: String?
  @Binding var isOn: Bool
  var disabled = false
  @ViewBuilder var leading: Leading

  var body: some View {
    HStack(spacing: 14) {
      leading
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 15, weight: .medium)).lineLimit(1)
        if let subtitle { Text(subtitle).font(.system(size: 13)).foregroundStyle(Palette.faint).lineLimit(2) }
      }
      Spacer(minLength: 8)
      Toggle(title, isOn: $isOn).labelsHidden().tint(Palette.blue).disabled(disabled)
    }
    .padding(.horizontal, 16).padding(.vertical, 10)
    .frame(minHeight: 64)
    .accessibilityElement(children: .combine)
  }
}

/**
 * Who gets an app or skill: an "All agents" switch first (every agent, and ones made later); when it's off,
 * a switch for each agent.
 */
struct AgentAccessPicker: View {
  @Environment(Store.self) private var store
  @ReduceMotion private var reduceMotion
  @Binding var allAgents: Bool
  var isOn: (Agent) -> Binding<Bool>
  var subtitle: (Agent) -> String = { "@\($0.handle)" }
  var agentDisabled: (Agent) -> Bool = { _ in false }
  var disabled = false
  var empty = "Add one from the Agents tab first."

  var body: some View {
    VStack(spacing: 14) {
      CardGroup {
        MarketToggleRow(title: "All agents", subtitle: "Including ones you add later", isOn: Binding(get: { allAgents }, set: { on in
          withAnimation(Motion.pick(Motion.settle, reduceMotion)) { allAgents = on }
        }), disabled: disabled) {
          Image(systemName: "person.2").font(.system(size: 15)).foregroundStyle(Palette.muted).frame(width: 30, height: 30)
        }
        .accessibilityIdentifier("all-agents")
      }
      if !allAgents {
        CardGroup {
          ForEach(store.agents) { agent in
            MarketToggleRow(title: agent.name, subtitle: subtitle(agent), isOn: isOn(agent), disabled: disabled || agentDisabled(agent)) {
              AgentAvatar(agent: agent, size: 30, showStatus: false)
            }
          }
          if store.agents.isEmpty { MarketRow(title: "No agents yet", subtitle: empty) }
        }
        .transition(.opacity)
      }
    }
  }
}

/** A small grey label over a card or field. */
struct MarketLabel: View {
  var text: String
  init(_ text: String) { self.text = text }
  var body: some View {
    Text(text).font(.system(size: 13)).tracking(0.2).foregroundStyle(Palette.faint).padding(.horizontal, 4).frame(maxWidth: .infinity, alignment: .leading)
  }
}

/** A text card: an explanation, a callout. */
struct MarketNote: View {
  var text: String
  var tone: MarketPill.Tone = .grey
  var body: some View {
    Text(text)
      .font(.system(size: 15))
      .foregroundStyle(tone == .warn ? MarketColor.warn : Palette.text.opacity(0.9))
      .padding(16)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
  }
}

/** A labeled field: a rounded box on the control color. */
struct MarketField: View {
  var label: String?
  var placeholder: String
  @Binding var text: String
  var secure = false
  var mono = false
  var lines: ClosedRange<Int> = 1...1
  var keyboard: UIKeyboardType = .default
  var plain = false

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let label { MarketLabel(label) }
      Group {
        if secure { SecureField(placeholder, text: $text) }
        else { TextField(placeholder, text: $text, axis: .vertical).lineLimit(lines) }
      }
      .font(.system(size: 15, design: mono ? .monospaced : .default))
      .textInputAutocapitalization(plain ? .never : nil)
      .autocorrectionDisabled(plain || mono || secure)
      .keyboardType(keyboard)
      .padding(.horizontal, 16).padding(.vertical, 14)
      .frame(minHeight: 50, alignment: .topLeading)
      .background(Palette.control, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.hairline))
    }
  }
}

/** A search field: a capsule with a magnifier. */
struct MarketSearch: View {
  @Binding var text: String
  var prompt: String

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: "magnifyingglass").foregroundStyle(Palette.faint)
      TextField(prompt, text: $text).font(.system(size: 15)).textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.search)
      if !text.isEmpty { Button { text = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.faint) }.buttonStyle(.plain).accessibilityLabel("Clear search") }
    }
    .padding(.horizontal, 16)
    .frame(height: 50)
    .background(Palette.control, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.hairline))
  }
}

/** A segmented control: one option on. */
struct SegPicker<T: Hashable>: View {
  var options: [(T, String)]
  @Binding var selection: T
  var disabled = false

  var body: some View {
    HStack(spacing: 2) {
      ForEach(Array(options.enumerated()), id: \.offset) { _, option in
        let on = option.0 == selection
        Button { selection = option.0 } label: {
          Text(option.1)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(on ? Palette.text : Palette.muted)
            .frame(maxWidth: .infinity).frame(height: 38)
            .background(Capsule().fill(on ? MarketColor.segment : Color.clear))
        }.buttonStyle(.plain).accessibilityAddTraits(on ? .isSelected : [])
      }
    }
    .padding(3)
    .background(Palette.control, in: Capsule())
    .overlay(Capsule().strokeBorder(Palette.hairline))
    .opacity(disabled ? 0.5 : 1).disabled(disabled)
  }
}

/** A pill to narrow a list, or pick a tab. */
struct ChipRow: View {
  var options: [String]
  var selection: String
  var counts: [String: Int] = [:]
  var onPick: (String) -> Void

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 6) {
        ForEach(options, id: \.self) { option in
          let on = option == selection
          Button { onPick(option) } label: {
            HStack(spacing: 5) {
              Text(option)
              if let n = counts[option], n > 0 { Text("\(n)").opacity(0.7) }
            }
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(on ? Color(.systemBackground) : Palette.text.opacity(0.8))
            .padding(.horizontal, 14).frame(height: 34)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(on ? Palette.text : Palette.control))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(on ? Color.clear : Palette.hairline))
          }.buttonStyle(.plain).accessibilityAddTraits(on ? .isSelected : [])
        }
      }.padding(.horizontal, 18)
    }.padding(.horizontal, -18)
  }
}

/**
 * A page with the glass back circle and a title on top (the marketplace's pages): a scroll of
 * cards on the sheet color. Hides the system bar; swiping back from the edge still works.
 */
struct MarketScreen<Trailing: View, Content: View>: View {
  @Environment(\.dismiss) private var dismiss
  var title: String
  var screenId: String
  var onBack: (() -> Void)?
  @ViewBuilder var trailing: Trailing
  @ViewBuilder var content: Content

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        CircleButton(symbol: "chevron.left", label: "Back") { if let onBack { onBack() } else { dismiss() } }
        Text(title).font(.system(size: 19, weight: .semibold)).foregroundStyle(Palette.text).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
        trailing
      }
      .padding(.horizontal, 18).padding(.top, 8).padding(.bottom, 8)
      ScrollView {
        VStack(alignment: .leading, spacing: 14) { content }
          .padding(.horizontal, 18).padding(.top, 6).padding(.bottom, 40)
      }
    }
    .background(Palette.sheet.ignoresSafeArea())
    .toolbar(.hidden, for: .navigationBar)
    .accessibilityIdentifier("screen-\(screenId)")
  }
}

extension MarketScreen where Trailing == EmptyView {
  init(title: String, screenId: String, onBack: (() -> Void)? = nil, @ViewBuilder content: () -> Content) {
    self.init(title: title, screenId: screenId, onBack: onBack, trailing: { EmptyView() }, content: content)
  }
}

/** A sheet: a title with a line under it and a close circle on the right, then cards. */
struct MarketSheet<Content: View>: View {
  @Environment(\.dismiss) private var dismiss
  var title: String
  var subtitle: String?
  var busy = false
  @ViewBuilder var content: Content

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        VStack(alignment: .leading, spacing: 2) {
          Text(title).font(.system(size: 20, weight: .semibold)).lineLimit(2)
          if let subtitle { Text(subtitle).font(.system(size: 13)).foregroundStyle(Palette.faint) }
        }.frame(maxWidth: .infinity, alignment: .leading)
        CircleButton(symbol: "xmark", label: "Close") { dismiss() }.disabled(busy)
      }
      .padding(.horizontal, 18).padding(.top, 16).padding(.bottom, 8)
      ScrollView {
        VStack(alignment: .leading, spacing: 14) { content }
          .padding(.horizontal, 18).padding(.top, 6).padding(.bottom, 30)
      }.scrollDismissesKeyboard(.interactively)
    }
    .background(Palette.sheet.ignoresSafeArea())
    .presentationBackground(Palette.sheet)
    .presentationCornerRadius(Corner.sheet)
    .presentationDragIndicator(.hidden)
    .interactiveDismissDisabled(busy)
  }
}

extension View {
  /** The one main action, pinned over the bottom of a screen. */
  func bottomAction<Bar: View>(@ViewBuilder _ bar: () -> Bar) -> some View {
    safeAreaInset(edge: .bottom, spacing: 0) {
      bar()
        .padding(.horizontal, 18).padding(.top, 12).padding(.bottom, 14)
        .frame(maxWidth: .infinity)
        .background(LinearGradient(colors: [Palette.sheet.opacity(0), Palette.sheet], startPoint: .top, endPoint: UnitPoint(x: 0.5, y: 0.4)))
    }
  }
}

/** A full-width primary capsule for a screen's one action. */
struct MarketPrimaryButton: View {
  var title: String
  var busy = false
  var disabled = false
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 8) {
        if busy { ProgressView() }
        Text(title).font(.system(size: 15, weight: .semibold))
      }.frame(maxWidth: .infinity, minHeight: 28)
    }.primaryButton().disabled(disabled || busy)
  }
}
