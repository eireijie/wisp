import SwiftUI

/** Wisp's web ghost, painted in its original SVG coordinates. */
struct GhostView: View {
  var look: GhostLook?
  var seed: String
  var asleep = false
  var size: CGFloat = 36
  var mood: GhostMood = .awake
  var interactive = false
  var animate = true
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.colorScheme) private var colorScheme
  @State private var pokeAt: Date?
  @State private var pokeCount = 0

  private var animated: Bool { animate && !reduceMotion && scenePhase == .active }

  var body: some View {
    let appearance = (look ?? GhostLook.defaultAppearance(seed)).resolved
    let currentMood = asleep ? GhostMood.asleep : mood
    let phase = Double(GhostLook.hash(seed) % 10_000) / 1000
    let overflow = max(12, size * 0.3)
    let rendered = TimelineView(.animation(minimumInterval: 1.0 / 60, paused: !animated)) { timeline in
      Canvas { context, _ in
        var context = context
        context.translateBy(x: overflow, y: overflow)
        let time = animated ? timeline.date.timeIntervalSinceReferenceDate + phase : 0
        let poke = animated ? pokeAt.map { timeline.date.timeIntervalSince($0) } : nil
        GhostRenderer(look: appearance, mood: currentMood, size: size, time: time, animated: animated,
          poke: poke, pokeCount: pokeCount, darkMode: colorScheme == .dark).draw(context)
      }
      // SVG overflow is visible on the web, including hats and hops.
      .frame(width: size + overflow * 2, height: size + overflow * 2)
    }
    .frame(width: size, height: size)
    if interactive && size >= 24 {
      rendered
        .contentShape(Rectangle())
        .onTapGesture(perform: react)
        .accessibilityLabel("Ghost, \(currentMood.rawValue)")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(.default, react)
    } else {
      rendered.allowsHitTesting(false).accessibilityHidden(true)
    }
  }

  private func react() {
    guard animated else { return }
    let now = Date()
    pokeCount = pokeAt.map { now.timeIntervalSince($0) < 1.8 } == true ? pokeCount + 1 : 1
    pokeAt = now
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
  }
}

struct AgentAvatar: View {
  @Environment(Store.self) private var store
  var agent: Agent?
  var size: CGFloat = 36
  var showStatus = true
  var interactive = false

  var body: some View {
    let current = agent.flatMap { store.agent($0.id) } ?? agent
    GhostView(look: current?.settings?.appearance, seed: current?.handle ?? "agent", size: size,
      mood: store.mood(for: current), interactive: interactive)
      .overlay(alignment: .bottomTrailing) {
        if showStatus, let s = current?.status, s != .offline {
          StatusDot(status: s).offset(x: 2, y: 1)
        }
      }
  }
}

struct StatusDot: View {
  var status: Agent.Status
  var body: some View {
    Circle()
      .fill(status == .busy ? Color.blue : Color.green)
      .frame(width: 9, height: 9)
      .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 2))
      .shadow(color: (status == .busy ? Color.blue : Color.green).opacity(0.6), radius: 3)
  }
}

struct PersonAvatar: View {
  var name: String
  var size: CGFloat = 36
  var body: some View {
    Text(initials)
      .font(.system(size: size * 0.38, weight: .semibold, design: .rounded))
      .foregroundStyle(Color(.systemBackground))
      .frame(width: size, height: size)
      .background(Circle().fill(Color.primary.opacity(0.85)))
      .accessibilityHidden(true)
  }
  private var initials: String {
    let parts = name.split(separator: " ").prefix(2)
    return parts.map { String($0.prefix(1)) }.joined().uppercased()
  }
}

extension Color {
  init(hex: String) {
    var v: UInt64 = 0
    Scanner(string: hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))).scanHexInt64(&v)
    self.init(red: Double((v >> 16) & 0xff) / 255, green: Double((v >> 8) & 0xff) / 255, blue: Double(v & 0xff) / 255)
  }
}


#Preview("Moods and looks") {
  ScrollView {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 100))]) {
      ForEach(GhostMood.allCases, id: \.self) { mood in
        VStack {
          GhostView(look: nil, seed: "warren", size: 100, mood: mood, interactive: true)
          Text(mood.rawValue).font(.caption)
        }
      }
      ForEach(GhostLook.shapes, id: \.self) { shape in
        GhostView(look: GhostLook(color: "#7516cf", color2: "#00e8d1", shape: shape,
          glow: false, hat: "propeller", accessory: "bowtie"), seed: shape, size: 100)
      }
    }.padding()
  }
}
