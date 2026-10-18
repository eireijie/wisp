import SwiftUI

/** Preview and save the same wardrobe offered by Warren on the web. */
struct LookEditor: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var agent: Agent
  @State private var look: GhostLook
  @State private var mood: GhostMood = .awake
  @State private var saving = false
  @State private var error: String?

  init(agent: Agent) {
    self.agent = agent
    _look = State(initialValue: (agent.settings?.appearance ?? GhostLook.defaultAppearance(agent.handle)).resolved)
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 24) {
          stage
          colors
          options("Shape", values: GhostLook.shapes, key: \.shape)
          options("Eyes", values: GhostLook.eyeStyles, key: \.eyes)
          options("Mouth", values: GhostLook.mouths, key: \.mouth)
          Toggle("Cheeks", isOn: flag(\.cheeks))
          options("Hat", values: GhostLook.hats, key: \.hat)
          options("Accessory", values: GhostLook.accessories, key: \.accessory)
          options("Motion", values: GhostLook.motions, key: \.motion)
          if let error { Text(error).foregroundStyle(.red).font(.footnote).accessibilityLabel("Could not save: \(error)") }
        }
        .padding(20)
        .disabled(saving)
      }
      .navigationTitle("\(agent.name)’s look")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
        ToolbarItem(placement: .confirmationAction) {
          Button {
            Task {
              saving = true
              error = nil
              do { try await store.saveLook(look, for: agent); dismiss() }
              catch { self.error = error.localizedDescription }
              saving = false
            }
          } label: {
            if saving { ProgressView() } else { Text("Save").bold() }
          }.disabled(saving)
        }
      }
      .interactiveDismissDisabled(saving)
    }
  }

  private var stage: some View {
    VStack(spacing: 12) {
      GhostView(look: look, seed: agent.handle, size: 180, mood: mood, interactive: true)
        .padding(.vertical, 24)
        .frame(maxWidth: .infinity)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 24))
      Picker("Preview mood", selection: $mood) {
        ForEach(GhostMood.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
      }
      .pickerStyle(.menu)
      HStack {
        Button("Shuffle", systemImage: "shuffle") {
          look = GhostLook.defaultAppearance(UUID().uuidString)
          look.glow = Double.random(in: 0..<1) < 0.25
          look.hat = GhostLook.hats.randomElement()
        }
        Spacer()
        Button("Reset", systemImage: "arrow.counterclockwise") { look = GhostLook.defaultAppearance(agent.handle) }
      }.buttonStyle(.bordered)
    }
  }

  private var colors: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Colors").font(.headline)
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 44))], spacing: 12) {
        ForEach(GhostLook.palettes, id: \.name) { palette in
          let selected = look.color.lowercased() == palette.top && look.color2?.lowercased() == palette.bottom
          Button {
            look.color = palette.top
            look.color2 = palette.bottom
          } label: {
            Circle()
              .fill(LinearGradient(colors: [Color(hex: palette.top), Color(hex: palette.bottom)], startPoint: .top, endPoint: .bottom))
              .frame(width: 36, height: 36)
              .padding(4)
              .overlay(Circle().stroke(selected ? Color.accentColor : .clear, lineWidth: 2))
          }
          .buttonStyle(.plain)
          .accessibilityLabel(palette.name)
          .accessibilityAddTraits(selected ? .isSelected : [])
        }
      }
      ColorPicker("Top color", selection: color(bottom: false), supportsOpacity: false)
      ColorPicker("Bottom color", selection: color(bottom: true), supportsOpacity: false)
      Toggle("Glow", isOn: flag(\.glow))
    }
  }

  private func options(_ title: String, values: [String], key: WritableKeyPath<GhostLook, String?>) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(title).font(.headline)
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 82))], spacing: 10) {
        ForEach(values, id: \.self) { value in
          let selected = look[keyPath: key] == value
          Button { look[keyPath: key] = value } label: {
            VStack(spacing: 4) {
              GhostView(look: preview(value, key: key), seed: agent.handle, size: 56, animate: title == "Motion")
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

  private func color(bottom: Bool) -> Binding<Color> {
    Binding(get: { Color(hex: bottom ? look.color2 ?? GhostColor.shade(look.color) : look.color) }, set: { color in
      var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
      guard UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return }
      let hex = String(format: "#%02x%02x%02x", Int((red * 255).rounded()), Int((green * 255).rounded()), Int((blue * 255).rounded()))
      if bottom { look.color2 = hex } else { look.color = hex }
    })
  }
}
