import SwiftUI

/** Warren's ghost (the same outline as the web app's icon), in an agent's own two colors. */
struct GhostShape: Shape {
  func path(in rect: CGRect) -> Path {
    // the outline lives in a 60x86 box at (30,18) in the icon's coordinates
    let s = min(rect.width / 60, rect.height / 86)
    let ox = rect.midX - 30 * s - 30 * s, oy = rect.midY - 43 * s - 18 * s
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: ox + x * s, y: oy + y * s) }
    var path = Path()
    path.move(to: p(30, 60))
    path.addCurve(to: p(60, 18), control1: p(30, 32), control2: p(44, 18))
    path.addCurve(to: p(90, 60), control1: p(76, 18), control2: p(90, 32))
    path.addLine(to: p(90, 96))
    var x: CGFloat = 90
    var down = true
    while x > 30 {
      path.addQuadCurve(to: p(x - 10, 96), control: p(x - 5, down ? 104 : 88))
      x -= 10
      down.toggle()
    }
    path.closeSubpath()
    return path
  }
}

struct GhostView: View {
  var look: GhostLook?
  var seed: String
  var asleep = false
  var size: CGFloat = 36

  private static let palettes: [(String, String)] = [
    ("#8bd4ff", "#ff51bf"), ("#ff26a8", "#fff78a"), ("#e771ff", "#ffd87c"), ("#beffe8", "#ff797b"),
    ("#b4ffa4", "#26dfff"), ("#97fff3", "#0084ff"), ("#ecca5c", "#fe3c3f"), ("#ff5c43", "#6262ff"),
    ("#003d60", "#32fffc"), ("#26e2ff", "#ff6666"), ("#ffcd4f", "#fde5ba"), ("#ffad32", "#4169ff"),
    ("#b4ff32", "#008d58"), ("#ff4f9a", "#36edaa"), ("#ff69db", "#d51c46"), ("#37f0db", "#ff4f64"),
    ("#7516cf", "#00e8d1"),
  ]

  private var colors: (Color, Color) {
    if asleep { return (Color(hex: "#a6aaad"), Color(hex: "#44464a")) }
    if let look { return (Color(hex: look.color), Color(hex: look.color2 ?? look.color).opacity(look.color2 == nil ? 0.8 : 1)) }
    // agents that were never customized get a stable palette from their id
    var h: UInt32 = 2_166_136_261
    for b in seed.utf8 { h = (h ^ UInt32(b)) &* 16_777_619 }
    let p = Self.palettes[Int(h % UInt32(Self.palettes.count))]
    return (Color(hex: p.0), Color(hex: p.1))
  }

  var body: some View {
    let (top, bottom) = colors
    ZStack {
      GhostShape()
        .fill(LinearGradient(colors: [top, bottom], startPoint: .top, endPoint: .bottom))
        .overlay(GhostShape().stroke(.black.opacity(0.08), lineWidth: 0.5))
      // eyes, closed while asleep
      HStack(spacing: size * 0.13) {
        ForEach(0..<2, id: \.self) { _ in
          if asleep {
            Capsule().fill(Color(hex: "#1b1b1f")).frame(width: size * 0.12, height: size * 0.035)
          } else {
            Circle().fill(Color(hex: "#1b1b1f")).frame(width: size * 0.12, height: size * 0.12)
          }
        }
      }
      .offset(y: -size * 0.08)
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}

struct AgentAvatar: View {
  var agent: Agent?
  var size: CGFloat = 36
  var showStatus = true

  var body: some View {
    GhostView(look: agent?.settings?.appearance, seed: agent?.id ?? "", asleep: agent?.status == .offline, size: size)
      .overlay(alignment: .bottomTrailing) {
        if showStatus, let s = agent?.status, s != .offline {
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

#Preview {
  HStack {
    GhostView(look: nil, seed: "agt_1", size: 60)
    GhostView(look: GhostLook(color: "#ff26a8", color2: "#fff78a"), seed: "", size: 60)
    GhostView(look: nil, seed: "x", asleep: true, size: 60)
  }
}
