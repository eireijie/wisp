import SwiftUI

struct GhostRenderer {
  var look: GhostLook
  var mood: GhostMood
  var size: Double
  var time: Double
  var animated: Bool
  var poke: Double?
  var pokeCount: Int
  var darkMode: Bool

  func draw(_ context: GraphicsContext) {
    let g = GhostGeometry.shapes[look.shape ?? "classic"]!
    let sleeping = mood == .asleep, details = size >= 26
    let top = sleeping ? "#a6aaad" : look.color
    let bottom = sleeping ? "#44464a" : look.color2 ?? GhostColor.shade(top)
    let ink = GhostColor.ink(top: top, bottom: sleeping ? bottom : look.color2)
    let gradient = GraphicsContext.Shading.linearGradient(Gradient(stops: [
      .init(color: Color(hex: top), location: 0.08), .init(color: Color(hex: bottom), location: 0.95),
    ]), startPoint: CGPoint(x: 0, y: g.top), endPoint: CGPoint(x: 0, y: g.bottom))
    let hatted = look.hat != "none"
    let scale = size / (hatted ? 140 : 111)
    var root = GhostPainter(context: context).moved(scaleX: scale, scaleY: scale)
    root = root.moved(hatted ? 10 : -4.5, hatted ? 18 : -8)
    let moving = animated && look.motion != "still"
    let duration = mood == .thinking ? 1.4 : look.motion == "bounce" ? 1.7 : look.motion == "sway" ? 3 : 3.2
    let phase = GhostAnimation.phase(time, duration), wave = GhostAnimation.wave(time, duration)
    if size >= 28 {
      let bounce = look.motion == "bounce"
      let breath = moving && look.motion != "sway" ? (bounce ? GhostAnimation.key(phase, [(0, 0), (0.45, 1), (0.6, 1), (1, 0)]) : wave) : 0
      let width = bounce && moving ? 1.05 - 0.29 * breath : 1 - 0.16 * breath
      root.faded(1 - (bounce ? 0.45 : 0.4) * breath).ellipse(60, g.ground, 24 * width, 3.4,
        darkMode ? .black.opacity(0.42) : Color(white: 0.086).opacity(0.14))
    }
    var y = 0.0, sx = 1.0, sy = 1.0, angle = 0.0
    if moving {
      switch look.motion {
      case "bounce":
        y = GhostAnimation.key(phase, [(0, 0), (0.45, -7), (0.6, -7), (1, 0)])
        sx = GhostAnimation.key(phase, [(0, 1.04), (0.45, 0.97), (0.6, 1), (1, 1.04)])
        sy = GhostAnimation.key(phase, [(0, 0.96), (0.45, 1.03), (0.6, 1), (1, 0.96)])
      case "sway": angle = -5 + 10 * wave
      default: y = 1.5 - 5.5 * wave
      }
    }
    if animated {
      if mood == .waiting {
        angle += GhostAnimation.key(GhostAnimation.phase(time, 4.5), [(0, 0), (0.72, 0), (0.8, -4), (0.86, 4), (0.92, -4), (1, 0)])
      } else if mood == .error { angle += -3 + 6 * GhostAnimation.wave(time, 2.5) }
      if mood == .done {
        let hop = GhostAnimation.phase(time, 1.1)
        y += GhostAnimation.key(hop, [(0, 0), (0.18, 0), (0.5, -7), (0.82, 0), (1, 0)])
        sx *= GhostAnimation.key(hop, [(0, 1.05), (0.18, 1), (0.5, 0.98), (0.82, 1), (1, 1.05)])
        sy *= GhostAnimation.key(hop, [(0, 0.95), (0.18, 1), (0.5, 1.03), (0.82, 1), (1, 0.95)])
      }
    }
    let poking = poke.map { $0 >= 0 && $0 < 0.8 } == true
    if poking, let poke {
      let t = poke / 0.8
      if pokeCount % 5 == 0 {
        angle += GhostAnimation.key(t, [(0, 0), (0.18, -12), (0.75, 365), (1, 360)])
        y += GhostAnimation.key(t, [(0, 0), (0.18, 0), (0.75, -6), (1, 0)])
        sx *= GhostAnimation.key(t, [(0, 1), (0.18, 1.15), (0.75, 1), (1, 1)])
        sy *= GhostAnimation.key(t, [(0, 1), (0.18, 0.82), (0.75, 1), (1, 1)])
      } else {
        y += GhostAnimation.key(t, [(0, 0), (0.18, 3), (0.42, -7), (0.68, 1), (1, 0)])
        sx *= GhostAnimation.key(t, [(0, 1), (0.18, 1.12), (0.42, 0.94), (0.68, 1.03), (1, 1)])
        sy *= GhostAnimation.key(t, [(0, 1), (0.18, 0.84), (0.42, 1.07), (0.68, 0.97), (1, 1)])
      }
    }
    let pivot = poking || mood == .waiting || mood == .error ? 85.0 : g.ground
    let p = root.moved(60, pivot + y, scaleX: sx, scaleY: sy, angle: angle).moved(-60, -pivot)
    let body = g.a.path(toward: g.b, fraction: animated && size >= 44 ? GhostAnimation.wave(time, mood == .thinking ? 1.4 : 2.6) : 0)
    p.context.fill(body, with: gradient)
    var lit = p.context
    lit.clip(to: body)
    let box = body.boundingRect
    lit.scaleBy(x: 1, y: box.height / box.width)
    lit.fill(Path(CGRect(x: box.minX, y: box.minY * box.width / box.height, width: box.width, height: box.width)),
      with: .radialGradient(Gradient(stops: [.init(color: .white.opacity(sleeping ? 0.1 : 0.24), location: 0),
        .init(color: .white.opacity(0.06), location: 0.65), .init(color: .white.opacity(0), location: 1)]),
        center: CGPoint(x: box.midX, y: (box.minY + box.height * 0.42) * box.width / box.height), startRadius: 0, endRadius: box.width * 0.6))
    var rim = p.context
    rim.clip(to: body)
    rim.stroke(body, with: .color(.black.opacity(0.1)), lineWidth: 7)
    if details { p.arms(geometry: g, mood: mood, time: time, animated: animated, gradient: gradient, body: body) }
    let happy = poking || mood == .done
    let face = p.moved(0, mood == .listening ? -2 : mood == .working && !happy ? 3 : 0)
    if (look.cheeks == true || size >= 40) && !sleeping {
      for x in [g.eyeX[0] - 4, g.eyeX[1] + 4] { face.ellipse(x, g.eyeY + 8, 4.5, 2.6, Color(hex: "#ff8fab").opacity(look.cheeks == true ? 0.5 : 0.18)) }
    }
    let eyes = mood == .listening ? "big" : happy ? "happy" : sleeping ? "closed" : mood == .error ? "dizzy" : look.eyes!
    let blink = animated && details && ["dots", "big", "sparkle"].contains(eyes)
      ? GhostAnimation.key(GhostAnimation.phase(time, 4.6), [(0, 1), (0.9, 1), (0.93, 0.12), (1, 1)]) : 1
    face.eyes(eyes, geometry: g, ink: ink, details: details, mood: happy ? .awake : mood, blink: blink)
    if look.accessory != "mustache" || look.mouth == "none" {
      face.moved(60, g.mouth).mouth(happy ? "open" : mood == .error ? "wavy" : [.asleep, .thinking, .working].contains(mood) ? "flat" : look.mouth!, ink: ink)
    }
    if sleeping && details { face.moved(63.5, g.mouth + 2.2).path("M0 0 q1.7 3.2 0 4.8 q-1.7 -1.6 0 -4.8 Z", fill: Color(hex: "#e8f6ff").opacity(0.95)) }
    // glasses and the mustache ride on the face, so they follow its mood shifts; neckwear stays with the body
    (["glasses", "sunglasses", "monocle", "mustache"].contains(look.accessory!) ? face : p).accessory(look.accessory!, geometry: g)
    p.moved(60, g.top, scaleX: g.hatScale, scaleY: g.hatScale).hat(look.hat!, time: time, animated: animated)
    if mood == .error && details {
      p.moved(g.eyeX[1] + 5, g.top + 8).path("M0 0 c-1 4 -5 7 -4 10 c1 4 7 4 7 0 c0 -3 -2 -7 -3 -10 Z", fill: Color(hex: "#a9dfff"), stroke: Color(hex: "#e4f6ff"), width: 0.7)
    }
    marks(root, geometry: g, details: details, poking: poking)
  }

  private func marks(_ root: GhostPainter, geometry g: GhostGeometry, details: Bool, poking: Bool) {
    let mark = Color(hex: "#f5c542")
    if poking && pokeCount >= 2, let poke {
      let t = poke / 0.8
      let opacity = GhostAnimation.key(t, [(0, 0), (0.2, 1), (1, 0)])
      let scale = GhostAnimation.key(t, [(0, 0.65), (0.2, 1), (1, 1.08)])
      root.faded(opacity).moved(88, g.top + 11 + 3 - 21 * t, scaleX: scale, scaleY: scale)
        .path("M0 0 c-15 -9 -10 -20 -2.5 -14 c7.5 -6 12.5 5 2.5 14 Z", fill: Color(hex: "#ff8fab"))
    }
    guard details else { return }
    if mood == .done {
      let sparkles: [(Double, Double, Double, Double)] = [(24, 4, 5, 0), (97, 2, 6, 0.35), (106, 34, 4, 0.7), (13, 38, 4.5, 0.2), (50, -9, 3.5, 0.55), (80, -8, 4, 0.9), (104, 62, 3, 0.45), (16, 66, 3.2, 1.05)]
      for (x, y, r, delay) in sparkles {
        let t = GhostAnimation.phase(time + delay, 1.4)
        let alpha = animated ? GhostAnimation.key(t, [(0, 0), (0.4, 1), (0.7, 0.8), (1, 0)]) : 1
        let scale = r * (animated ? GhostAnimation.key(t, [(0, 0.2), (0.4, 1), (0.7, 0.7), (1, 0.2)]) : 1)
        root.faded(alpha).moved(x, g.top + y, scaleX: scale, scaleY: scale, angle: animated ? 40 * t : 0)
          .path("M0 -1 Q0.18 -0.18 1 0 Q0.18 0.18 0 1 Q-0.18 0.18 -1 0 Q-0.18 -0.18 0 -1 Z", fill: mark)
      }
    }
    if mood == .asleep {
      for i in 0..<2 {
        let t = GhostAnimation.phase(time + Double(i) * 1.3, 2.6)
        let alpha = animated ? GhostAnimation.key(t, [(0, 0), (0.25, 0.85), (1, 0)]) : 1
        let scale = animated ? 0.7 + 0.4 * t : 1
        let p = root.faded(alpha).moved(Double(i == 0 ? 92 : 101) + (animated ? 6 * t : 0),
          g.top + (i == 0 ? 6 : -5) + (animated ? 4 - 16 * t : 0), scaleX: scale, scaleY: scale)
        p.context.draw(Text("z").font(.system(size: i == 0 ? 15 : 11, weight: .heavy, design: .rounded)).foregroundColor(mark), at: .zero, anchor: .bottomLeading)
      }
    }
    if mood == .thinking {
      for i in 0..<3 {
        let wave = animated ? GhostAnimation.wave(time + Double(i) * 0.25, 1.2) : 1
        root.faded(animated ? 0.25 + 0.75 * wave : 1).ellipse(90 + Double(i) * 7,
          g.top - 2 - Double(i) * 5 - (animated ? 1.5 * wave : 0), 2.4 + Double(i) * 0.6, 2.4 + Double(i) * 0.6, mark)
      }
    }
  }
}
