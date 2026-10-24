import SwiftUI

/**
 * Preview and save the same wardrobe offered by Wisp on the web: every palette, shape, face,
 * hat, accessory and motion, with cheeks, and a mood to preview it in.
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
      ScrollView {
        VStack(spacing: 24) {
          stage
          colors
          options("Shape", values: GhostLook.shapes, key: \.shape)
          options("Eyes", values: GhostLook.eyeStyles, key: \.eyes)
          options("Mouth", values: GhostLook.mouths, key: \.mouth)
          options("Hat", values: GhostLook.hats, key: \.hat)
          options("Accessory", values: GhostLook.accessories, key: \.accessory)
          options("Motion", values: GhostLook.motions, key: \.motion)
          switches
          if let error { Text(error).foregroundStyle(.red).font(.footnote).accessibilityLabel("Could not save: \(error)") }
        }
        .padding(20)
        .disabled(saving)
      }
      .navigationTitle("\(name)’s look")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
        ToolbarItem(placement: .confirmationAction) {
          Button {
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
          } label: {
            if saving { ProgressView() } else { Text(draft == nil ? "Save" : "Done").bold() }
          }.disabled(saving)
        }
      }
      .interactiveDismissDisabled(saving)
    }
  }

  private var stage: some View {
    VStack(spacing: 12) {
      GhostView(look: look, seed: seed, size: 180, mood: mood, interactive: true)
        .padding(.vertical, 24)
        .frame(maxWidth: .infinity)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
      Picker("Preview a mood", selection: $mood) {
        ForEach(Self.previewMoods, id: \.0) { Text($0.1).tag($0.0) }
      }
      .pickerStyle(.segmented)
      .accessibilityLabel("Preview a mood")
      HStack {
        Button("Shuffle", systemImage: "shuffle") { look = GhostLook.shuffled(keeping: look.motion) }
        Spacer()
        Button("Reset", systemImage: "arrow.counterclockwise") { look = GhostLook.defaultAppearance(seed) }
      }.secondaryButton()
    }
  }

  private var colors: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Colors").font(.headline)
      GhostColors(look: $look, labels: true)
    }
  }

  private var switches: some View {
    VStack(spacing: 0) {
      Toggle(isOn: flag(\.cheeks)) {
        VStack(alignment: .leading, spacing: 2) {
          Text("Rosy cheeks")
          Text("A little blush under the eyes.").font(.caption).foregroundStyle(.secondary)
        }
      }.padding(.vertical, 10)
    }
    .padding(.horizontal, 16)
    .background(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).fill(Color(.secondarySystemBackground)))
  }

  private func options(_ title: String, values: [String], key: WritableKeyPath<GhostLook, String?>) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(title).font(.headline)
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 82))], spacing: 10) {
        ForEach(values, id: \.self) { value in
          let selected = look[keyPath: key] == value
          Button { look[keyPath: key] = value } label: {
            VStack(spacing: 4) {
              GhostView(look: preview(value, key: key), seed: seed, size: 56, animate: title == "Motion")
              Text(label(value)).font(.caption).foregroundStyle(.primary).lineLimit(1).minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(selected ? Color.accentColor.opacity(0.12) : Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(selected ? Color.accentColor : .clear, lineWidth: 2))
          }
          .buttonStyle(.plain)
          .accessibilityLabel("\(title): \(label(value))")
          .accessibilityAddTraits(selected ? .isSelected : [])
        }
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

  private func label(_ value: String) -> String {
    ["sheet": "Bedsheet", "tophat": "Top hat", "bowtie": "Bow tie", "sunglasses": "Shades"][value] ?? value.capitalized
  }

  private func flag(_ key: WritableKeyPath<GhostLook, Bool?>) -> Binding<Bool> {
    Binding(get: { look[keyPath: key] ?? false }, set: { look[keyPath: key] = $0 })
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
