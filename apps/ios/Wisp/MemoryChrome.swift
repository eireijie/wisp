import SwiftUI

// What the Memory screens share: the top bar (a back or close circle, a name pill, an optional circle on
// the right), the grouped cards, section captions, search field, the big pill action at the bottom, and
// a few small parts (author avatar, tag chip, the confirm card).

/** The name pill in the middle of a Memory page's top bar. */
struct MemoryPill: View {
  var title: String
  var body: some View {
    Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text).lineLimit(1)
      .padding(.horizontal, 20).frame(height: 52).glassPill().contentShape(Capsule())
      .accessibilityAddTraits(.isHeader)
  }
}

/** A full page with the design's top bar and a scrolling body on the sheet color. */
struct MemoryScreen<Trailing: View, Content: View>: View {
  @Environment(\.dismiss) private var dismiss
  var title: String
  var id: String
  /** an X instead of the back chevron (pages that open over others) */
  var close = false
  var scrolls = true
  @ViewBuilder var trailing: Trailing
  @ViewBuilder var content: Content

  var body: some View {
    VStack(spacing: 0) {
      TopBar(
        leading: { CircleButton(symbol: close ? "xmark" : "chevron.left", label: close ? "Close" : "Back", id: "memory-back") { dismiss() } },
        center: { MemoryPill(title: title) },
        trailing: { trailing })
      if scrolls {
        ScrollView {
          VStack(alignment: .leading, spacing: 14) { content }
            .padding(.horizontal, 18).padding(.top, 6).padding(.bottom, 120)
            .frame(maxWidth: .infinity, alignment: .leading)
        }.scrollDismissesKeyboard(.interactively)
      } else {
        content
      }
    }
    .background(Palette.sheet.ignoresSafeArea())
    .toolbar(.hidden, for: .navigationBar)
    .accessibilityIdentifier("screen-\(id)")
  }
}

extension MemoryScreen where Trailing == EmptyView {
  init(title: String, id: String, close: Bool = false, scrolls: Bool = true, @ViewBuilder content: () -> Content) {
    self.init(title: title, id: id, close: close, scrolls: scrolls, trailing: { EmptyView() }, content: content)
  }
}

/** The "..." circle: a menu of the page's extra actions. */
struct MoreCircle<Items: View>: View {
  var label = "More"
  @ViewBuilder var items: Items
  var body: some View {
    Menu { items } label: { CircleLabel(symbol: "ellipsis") }
      .accessibilityLabel(label).accessibilityIdentifier("memory-more")
  }
}

/** The big light pill pinned to the bottom of a page. */
struct PillAction: View {
  var title: String
  var symbol: String?
  var enabled = true
  var id: String? = nil
  var action: () -> Void
  var body: some View {
    Button(action: action) {
      HStack(spacing: 8) {
        if let symbol { Image(systemName: symbol).font(.system(size: 17, weight: .semibold)) }
        Text(title).font(.system(size: 15, weight: .semibold))
      }
      .foregroundStyle(Palette.sheet)
      .padding(.horizontal, 30).frame(height: 54).background(Capsule().fill(Palette.text)).opacity(enabled ? 1 : 0.4)
    }
    .buttonStyle(.plain).disabled(!enabled).accessibilityIdentifier(id ?? "")
  }
}

/** A small glass pill button (Edit, History, Graph). */
struct GlassPillButton: View {
  var title: String
  var symbol: String
  var id: String? = nil
  var action: () -> Void
  var body: some View {
    Button(action: action) {
      HStack(spacing: 8) {
        Image(systemName: symbol).font(.system(size: 15, weight: .medium))
        Text(title).font(.system(size: 15, weight: .semibold))
      }
      .foregroundStyle(Palette.text).frame(maxWidth: .infinity).frame(height: 54).glassPill().contentShape(Capsule())
    }
    .buttonStyle(.plain).accessibilityIdentifier(id ?? "")
  }
}

/** Small uppercase heading over a card. */
struct SectionCaption: View {
  var text: String
  var trailing: AnyView? = nil
  init(_ text: String, trailing: AnyView? = nil) { self.text = text; self.trailing = trailing }
  var body: some View {
    HStack {
      Text(text.uppercased()).font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.faint).tracking(0.4)
      Spacer(minLength: 0)
      trailing
    }.padding(.horizontal, 18).padding(.top, 10)
  }
}

/** The pill-shaped field: a magnifier and a text field. */
struct MemorySearchField: View {
  var prompt: String
  @Binding var text: String
  var id: String? = nil
  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: "magnifyingglass").font(.system(size: 16)).foregroundStyle(Palette.faint)
      TextField(prompt, text: $text).textInputAutocapitalization(.never).autocorrectionDisabled().foregroundStyle(Palette.text)
        .accessibilityIdentifier(id ?? "")
      if !text.isEmpty {
        Button { text = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.faint) }.buttonStyle(.plain).accessibilityLabel("Clear search")
      }
    }
    .padding(.horizontal, 16).frame(height: 52)
    .background(Capsule().fill(Palette.card)).overlay(Capsule().strokeBorder(Palette.hairline))
  }
}

/** A card holding a text field. */
struct MemoryFieldCard<Content: View>: View {
  @ViewBuilder var content: Content
  var body: some View {
    content.padding(.horizontal, 18).padding(.vertical, 16).frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
  }
}

/** A round check, filled when picked. */
struct RadioMark: View {
  var on: Bool
  var body: some View {
    ZStack {
      Circle().strokeBorder(on ? Color.clear : Palette.faint, lineWidth: 1.5)
      if on { Circle().fill(Palette.blue); Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)).foregroundStyle(.white) }
    }.frame(width: 26, height: 26)
  }
}

/** A short tag chip: "# release". */
struct TagChip: View {
  var text: String
  var tint: Color? = nil
  var body: some View {
    HStack(spacing: 5) {
      if tint == nil { Text("#").foregroundStyle(Palette.faint) }
      Text(text).foregroundStyle(tint ?? Palette.text)
    }
    .font(.system(size: 13, weight: .semibold)).padding(.horizontal, 12).frame(height: 32)
    .background(Capsule().fill(tint.map { $0.opacity(0.18) } ?? Palette.control)).overlay(Capsule().strokeBorder(Palette.hairline))
  }
}

/** A selectable chip in a row of filters. */
struct FilterChip: View {
  var title: String
  var on: Bool
  var leading: AnyView? = nil
  var action: () -> Void
  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) { leading; Text(title).font(.system(size: 15, weight: .semibold)) }
        .foregroundStyle(on ? Palette.sheet : Palette.text).padding(.horizontal, 16).frame(height: 40)
        .background(Capsule().fill(on ? Palette.text : Palette.control)).overlay(Capsule().strokeBorder(on ? Color.clear : Palette.hairline))
    }.buttonStyle(.plain).accessibilityAddTraits(on ? .isSelected : [])
  }
}

/** A centered confirm card over a dimmed page (delete, restore). */
struct ConfirmCard: View {
  var symbol: String
  var title: String
  var message: String
  var confirm: String
  var cancel: String
  var busy = false
  var onConfirm: () -> Void
  var onCancel: () -> Void
  var body: some View {
    ZStack {
      Color.black.opacity(0.55).ignoresSafeArea().onTapGesture(perform: onCancel)
      VStack(alignment: .leading, spacing: 14) {
        Image(systemName: symbol).font(.system(size: 20, weight: .medium)).foregroundStyle(Palette.red)
          .frame(width: 48, height: 48).background(Circle().fill(Palette.red.opacity(0.18)))
        Text(title).font(.system(size: 22, weight: .semibold)).foregroundStyle(Palette.text)
        Text(message).font(.system(size: 15)).foregroundStyle(Palette.muted)
        Button(action: onConfirm) {
          Text(confirm).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white).frame(maxWidth: .infinity).frame(height: 52)
            .background(Capsule().fill(Palette.red)).opacity(busy ? 0.5 : 1)
        }.buttonStyle(.plain).disabled(busy).accessibilityIdentifier("confirm-destructive")
        Button(action: onCancel) {
          Text(cancel).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text).frame(maxWidth: .infinity).frame(height: 52)
            .background(Capsule().fill(Palette.control))
        }.buttonStyle(.plain)
      }
      .padding(24).frame(maxWidth: 360).background(Palette.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.cardBorder))
      .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.hairline))
      .padding(.horizontal, 24)
    }
  }
}

/** An author: an agent's ghost, a person's initials, Obsidian or Wisp. */
struct AuthorAvatar: View {
  var author: ChangeAuthor
  var size: CGFloat = 40
  var body: some View {
    if let agent = author.agent { AgentAvatar(agent: agent, size: size, showStatus: false) }
    else if let symbol = author.symbol {
      Image(systemName: symbol).font(.system(size: size * 0.42)).foregroundStyle(Palette.muted).frame(width: size, height: size).background(Circle().fill(Palette.control))
    } else {
      Text(initials(author.name)).font(.system(size: size * 0.34, weight: .semibold)).foregroundStyle(Palette.muted)
        .frame(width: size, height: size).background(Circle().fill(Color(light: 0xE3E3EA, dark: 0x34343A))).accessibilityHidden(true)
    }
  }
  private func initials(_ name: String) -> String {
    let letters = name.split(separator: " ").prefix(2).compactMap { $0.first }
    return letters.isEmpty ? "?" : String(letters).uppercased()
  }
}

/** "You" for the signed-in person's own commits, otherwise the author's own name. */
@MainActor func displayAuthor(_ raw: String, store: Store) -> ChangeAuthor {
  var who = ChangeAuthor.of(raw, store: store)
  let me = store.me.map { [$0.name, $0.preferredName ?? ""] } ?? []
  if who.agent == nil, who.symbol == nil, me.contains(raw) { who.name = "You" }
  return who
}

func relative(_ iso: String?) -> String? {
  guard let iso, let date = Wire.date(iso) else { return nil }
  return date.formatted(.relative(presentation: .named))
}

extension MemoryNote {
  /** Last saved, from the list's millisecond (or second) stamp. */
  var updatedText: String? {
    guard let t = updatedAt, t > 0 else { return nil }
    let date = Date(timeIntervalSince1970: t > 10_000_000_000 ? t / 1000 : t)
    return date.formatted(.relative(presentation: .named))
  }
}
