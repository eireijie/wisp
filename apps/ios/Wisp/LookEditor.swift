import SwiftUI

/**
 * Look (agent-Look.dc.html): the ghost, Shuffle, Color, Hat, Neckwear, Back to its original ghost,
 * Save. Shape, eyes, mouth, motion, cheeks and a mood to preview it in are under More options,
 * so the same wardrobe as on the web is still here. A ghost stays one simple piece; hats and
 * neckwear sit rigid on the body.
 */
struct LookEditor: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  private var agent: Agent?
  private var draft: Binding<GhostLook>?
  private var name: String
  private var seed: String
  @State private var look: GhostLook
  @State private var mood: GhostMood = .awake
  @State private var more = false
  @State private var saving = false
  @State private var error: String?

  /** Edits an agent's look and saves it to the hub. */
  init(agent: Agent) {
    self.agent = agent
    name = agent.name
    seed = agent.handle
    _look = State(initialValue: (agent.settings?.appearance ?? GhostLook.defaultAppearance(agent.handle)).resolved)
  }

  /** Edits the look of an agent that doesn't exist yet (New agent); Done hands it back. */
  init(look: Binding<GhostLook>, name: String, seed: String) {
    draft = look
    self.name = name.isEmpty ? "New agent" : name
    self.seed = seed
    _look = State(initialValue: look.wrappedValue.resolved)
  }

  static let previewMoods: [(GhostMood, String)] = [(.awake, "Awake"), (.working, "Working"), (.asleep, "Asleep")]

  var body: some View {
    NavigationStack {
      AgentFrame(title: "Look", subtitle: name, close: true) {
        VStack(spacing: 12) {
          GhostView(look: look, seed: seed, size: 160, mood: mood, interactive: true)
            .frame(width: 160, height: 160).accessibilityHidden(true)
          AgentChip(title: "Shuffle", symbol: "shuffle") { look = GhostLook.shuffled(keeping: look.motion) }
            .accessibilityIdentifier("look-shuffle")
        }.frame(maxWidth: .infinity).padding(.vertical, 4)
        CardCaption("Color")
        GhostColors(look: $look, labels: true).padding(.horizontal, 18)
        options("Hat", values: GhostLook.hats, key: \.hat)
        options("Neckwear", values: GhostLook.accessories, key: \.accessory)
        CardGroup {
          Button { more.toggle() } label: {
            RowLabel(title: "More options", subtitle: "Shape, eyes, mouth, motion", chevron: false)
              .overlay(alignment: .trailing) { Image(systemName: more ? "chevron.up" : "chevron.down").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.faint).padding(.trailing, 18) }
          }.buttonStyle(.plain).accessibilityIdentifier("look-more")
        }
        if more {
          options("Shape", values: GhostLook.shapes, key: \.shape)
          options("Eyes", values: GhostLook.eyeStyles, key: \.eyes)
          options("Mouth", values: GhostLook.mouths, key: \.mouth)
          options("Motion", values: GhostLook.motions, key: \.motion)
          CardGroup { SwitchRow(title: "Rosy cheeks", subtitle: "A little blush under the eyes.", isOn: flag(\.cheeks)) }
          Segments(options: Self.previewMoods.map { ($0.0, $0.1) }, selection: $mood)
          CardCaption("Preview it awake, working or asleep.")
        }
        CardGroup {
          Button { look = GhostLook.defaultAppearance(seed).resolved } label: {
            RowLabel(title: "Back to its original ghost", chevron: false, leading: { rowIcon("arrow.counterclockwise") })
          }.buttonStyle(.plain).accessibilityIdentifier("look-reset")
        }
        AgentError(text: error)
        PillButton(title: draft == nil ? "Save" : "Done", busy: saving, id: "look-save") { save() }.disabled(saving)
      }
    }
    .agentSheet()
    .interactiveDismissDisabled(saving)
  }

  private func save() {
    if let draft {
      draft.wrappedValue = look.resolved
      dismiss()
      return
    }
    guard let agent else { return }
    Task {
      saving = true
      error = nil
      do { try await store.saveLook(look, for: agent); dismiss() }
      catch { self.error = error.localizedDescription }
      saving = false
    }
  }

  private func options(_ title: String, values: [String], key: WritableKeyPath<GhostLook, String?>) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      CardCaption(title)
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          ForEach(values, id: \.self) { value in
            let selected = (look[keyPath: key] ?? (value == values.first ? value : nil)) == value
            Button { look[keyPath: key] = value } label: {
              VStack(spacing: 4) {
                GhostView(look: preview(value, key: key), seed: seed, size: 52, animate: title == "Motion")
                  .frame(width: 52, height: 52)
                Text(label(value)).font(.system(size: 13, weight: .medium)).foregroundStyle(selected ? Color(light: 0xFFFFFF, dark: 0x111113) : Palette.text).lineLimit(1)
              }
              .padding(.horizontal, 10).padding(.vertical, 8).frame(minWidth: 76)
              .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(selected ? Palette.text : Palette.card))
              .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(title): \(label(value))")
            .accessibilityAddTraits(selected ? .isSelected : [])
          }
        }.padding(.horizontal, 2)
      }
    }
  }

  private func preview(_ value: String, key: WritableKeyPath<GhostLook, String?>) -> GhostLook {
    var result = look
    result[keyPath: key] = value
    if key == \.shape || key == \.eyes || key == \.mouth { result.hat = "none"; result.accessory = "none" }
    if key == \.accessory { result.hat = "none" }
    return result
  }

  private func label(_ value: String) -> String { GhostLabels.label(value) }

  private func flag(_ key: WritableKeyPath<GhostLook, Bool?>) -> Binding<Bool> {
    Binding(get: { look[keyPath: key] ?? false }, set: { look[keyPath: key] = $0 })
  }
}

enum GhostLabels {
  /** A look option in words: "tophat" is Top hat, "bowtie" is Bow tie, "none" is None. */
  static func label(_ value: String) -> String {
    ["sheet": "Bedsheet", "tophat": "Top hat", "bowtie": "Bow tie", "sunglasses": "Shades"][value] ?? value.capitalized
  }
}

extension GhostLook {
  /** A random look from every option, like Shuffle on the web. */
  static func shuffled(keeping motion: String? = nil) -> GhostLook {
    let palette = palettes.randomElement()!
    return GhostLook(color: palette.top, color2: palette.bottom, eyes: eyeStyles.randomElement(), mouth: mouths.dropLast().randomElement(),
      cheeks: Double.random(in: 0..<1) < 0.6, shape: shapes.randomElement(), glow: false,
      hat: Double.random(in: 0..<1) < 0.4 ? hats.dropFirst().randomElement() : "none",
      accessory: Double.random(in: 0..<1) < 0.35 ? accessories.dropFirst().randomElement() : "none", motion: motion ?? "float")
  }

  /** A new agent's look: plain white, with a random face and outfit. */
  static func newAgent() -> GhostLook {
    var look = shuffled()
    look.color = GhostColors.white
    look.color2 = GhostColors.white
    return look
  }
}
