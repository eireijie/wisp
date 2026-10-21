import SwiftUI

extension GhostPainter {
  func eyes(_ style: String, geometry g: GhostGeometry, ink: Color, details: Bool, mood: GhostMood, blink: Double) {
    let dx = mood == .thinking ? 1.4 : 0
    let dy = mood == .thinking ? -1.6 : mood == .working ? 2.5 : 0
    for (i, x) in g.eyeX.enumerated() {
      let p = moved(x, g.eyeY, scaleY: blink)
      switch style {
      case "dizzy":
        p.path("M-5 0 c0 -7 11 -7 11 0 c0 6 -9 6 -9 0 c0 -3 6 -3 6 0 q0 3 -3 1", stroke: ink, width: 1.8)
      case "closed": p.path("M-4.5 0 Q0 3.6 4.5 0", stroke: ink, width: 2.4)
      case "happy": p.path("M-4.8 1.5 Q0 -4.5 4.8 1.5", stroke: ink, width: 2.6)
      case "big":
        p.ellipse(0, 0, 6.2, 6.2, .white)
        p.ellipse(dx, 0.5 + dy, 3.6, 3.6, Color(hex: "#2a2340"))
        if details { p.ellipse(1.4 + dx, -1 + dy, 1.2, 1.2, .white) }
      case "sparkle":
        p.ellipse(dx * 0.5, dy * 0.5, 4.4, 5.6, ink)
        p.ellipse(1.4, -2, 1.6, 1.6, .white.opacity(0.95))
        p.ellipse(-1.4, 2, 0.9, 0.9, .white.opacity(0.8))
      case "wink":
        if i == 1 { p.path("M-4.6 0 Q0 -3.6 4.6 0", stroke: ink, width: 2.5) }
        else { p.ellipse(0, 0, 3.4, 4.4, ink) }
      default:
        p.ellipse(dx * 0.6, dy * 0.6, 3.9, 4.9, ink)
        if details {
          p.ellipse(1.3 + dx * 0.6, -1.8 + dy * 0.6, 1.4, 1.4, .white.opacity(0.95))
          p.ellipse(-1.2 + dx * 0.6, 1.9 + dy * 0.6, 0.7, 0.7, .white.opacity(0.8))
        }
      }
    }
  }

  func mouth(_ style: String, ink: Color) {
    switch style {
    case "none": break
    case "wavy": path("M-5 1 q1.7 -3 3.4 0 q1.7 3 3.4 0 q1.7 -3 3.4 0", stroke: ink, width: 2)
    case "flat": path("M-3.2 1.2 L3.2 1.2", stroke: ink, width: 2.2)
    case "open":
      ellipse(0, 1, 3.4, 4, ink)
      ellipse(0, 3, 2.2, 1.4, Color(hex: "#ff7a93"))
    case "cat": path("M-5.5 0 Q-2.75 3.6 0 0 Q2.75 3.6 5.5 0", stroke: ink, width: 2)
    case "fangs":
      path("M-6 0 Q0 4.5 6 0", stroke: ink, width: 2.1)
      path("M-4 1.6 l1.4 3.6 l1.4 -3.2 Z M1.2 1.9 l1.4 3.2 l1.4 -3.6 Z", fill: .white, stroke: ink, width: 0.6)
    case "tongue":
      path("M-5 0 Q0 4 5 0", stroke: ink, width: 2.1)
      path("M0.2 1.6 q0 5 3.2 5 q3.2 0 2.6 -5.8 Z", fill: Color(hex: "#ff7a93"))
    default: path("M-4.5 0 Q0 4.2 4.5 0", stroke: ink, width: 2.2)
    }
  }

  func hat(_ kind: String, time: Double, animated: Bool) {
    let dark = Color(hex: "#2b2735"), gold = Color(hex: "#ffd166")
    switch kind {
    case "tophat":
      rect(-13, -25, 26, 25, 3, dark)
      rect(-13, -9, 26, 5, 0, Color(hex: "#e5484d"))
      rect(-21, -2, 42, 5.5, 2.75, dark)
    case "party":
      path("M-12 3 L12 3 L0 -27 Z", fill: Color(hex: "#ff8fab"))
      path("M-8.4 -6 L6.6 -6.4 M-4.5 -15.6 L3.2 -15.8", stroke: gold, width: 3)
      ellipse(0, -28, 4, 4, gold)
    case "beanie":
      path("M-21 6 Q-21 -16 0 -16 Q21 -16 21 6 Z", fill: Color(hex: "#5b8def"))
      rect(-22.5, 0, 45, 8, 4, Color(hex: "#3f6fd8"))
      ellipse(0, -17, 5, 5, Color(hex: "#f8fafc"))
    case "crown":
      path("M-15 3 L-15 -12 L-7.5 -4.5 L0 -17 L7.5 -4.5 L15 -12 L15 3 Z", fill: Color(hex: "#ffcf3f"), stroke: Color(hex: "#e0a800"), width: 1.5)
      ellipse(0, -4, 2.4, 2.4, Color(hex: "#ff5d73"))
      ellipse(-9, -1.5, 1.7, 1.7, Color(hex: "#4dabf7"))
      ellipse(9, -1.5, 1.7, 1.7, Color(hex: "#4dabf7"))
    case "witch":
      path("M-13 1 L-2 -30 Q4 -36 13 -30 Q5 -27 3 -22 L13 1 Z", fill: Color(hex: "#4b2e83"))
      rect(-13, -5, 26, 4.5, 0, Color(hex: "#ffb703"))
      ellipse(0, 2, 27, 5, Color(hex: "#4b2e83"))
    case "headphones":
      path("M-28 24 C-30 -10 30 -10 28 24", stroke: dark, width: 5)
      rect(-34, 16, 10, 16, 4.5, Color(hex: "#ff6b6b"))
      rect(24, 16, 10, 16, 4.5, Color(hex: "#ff6b6b"))
    case "bow":
      let p = moved(15, 5, angle: 18)
      p.path("M0 0 L-10 -7 L-10 7 Z M0 0 L10 -7 L10 7 Z", fill: Color(hex: "#ff6fa3"))
      p.ellipse(0, 0, 3, 3, Color(hex: "#ff3d7f"))
    case "halo":
      ellipse(0, -11 - (animated ? 2.5 * GhostAnimation.wave(time, 2.4) : 0), 16, 4.5, stroke: Color(hex: "#ffd84d"), width: 3.6)
    case "flower":
      let p = moved(14, 5)
      for i in 0..<5 {
        let a = Double(i) * .pi * 2 / 5
        p.ellipse(cos(a) * 4.2, sin(a) * 4.2, 3.6, 3.6, .white, stroke: Color(hex: "#f1e7ff"), width: 0.6)
      }
      p.ellipse(0, 0, 2.9, 2.9, Color(hex: "#ffc83d"))
    case "propeller":
      path("M-19 6 Q-19 -13 0 -13 Q19 -13 19 6 Z", fill: Color(hex: "#ff5d73"))
      path("M-19 6 Q-19 -13 0 -13 L0 6 Z", fill: gold)
      rect(-1.2, -21, 2.4, 9, 0, dark)
      let p = moved(0, -21, angle: animated ? time / 0.9 * 360 : 0)
      p.ellipse(-7, 0, 7, 2.2, Color(hex: "#4dabf7"))
      p.ellipse(7, 0, 7, 2.2, Color(hex: "#22c55e"))
    default: break
    }
  }

  func accessory(_ kind: String, geometry g: GhostGeometry) {
    let a = g.eyeX[0], b = g.eyeX[1], dark = Color(hex: "#2b2735")
    let face = moved(0, g.eyeY), neck = moved(60, g.neck)
    switch kind {
    case "glasses":
      face.ellipse(a, 0, 7, 7, .white.opacity(0.18), stroke: dark, width: 2)
      face.ellipse(b, 0, 7, 7, .white.opacity(0.18), stroke: dark, width: 2)
      var bridge = Path(); bridge.move(to: CGPoint(x: a + 7, y: 0))
      bridge.addQuadCurve(to: CGPoint(x: b - 7, y: 0), control: CGPoint(x: 60, y: -3))
      face.draw(bridge, stroke: dark, width: 2)
    case "sunglasses":
      for x in [a, b] {
        face.rect(x - 8, -5.5, 16, 11, 4, Color(hex: "#1f1d2b"))
        face.moved(x, 0).path("M-4.5 -2.5 l3 -1.5", stroke: .white.opacity(0.8), width: 1.4)
      }
      var bridge = Path(); bridge.move(to: CGPoint(x: a + 8, y: -2)); bridge.addLine(to: CGPoint(x: b - 8, y: -2))
      face.draw(bridge, stroke: Color(hex: "#1f1d2b"), width: 2.2)
    case "monocle":
      let p = face.moved(b, 0), gold = Color(hex: "#c9a227")
      p.ellipse(0, 0, 7, 7, .white.opacity(0.2), stroke: gold, width: 2.2)
      p.path("M5 5 Q12 12 7 22", stroke: gold, width: 1.2)
    case "bowtie":
      neck.path("M0 0 L-11 -6.5 L-11 6.5 Z M0 0 L11 -6.5 L11 6.5 Z", fill: Color(hex: "#e5484d"))
      neck.rect(-3, -3.2, 6, 6.4, 1.6, Color(hex: "#c2333a"))
    case "scarf":
      neck.rect(-g.half + 1, -4.5, (g.half - 1) * 2, 9, 4.5, Color(hex: "#ff8f5a"))
      for x in [-g.half + 8, -g.half + 16, g.half - 10] {
        neck.moved(x, 0).path("M0 -4.5 v9", stroke: Color(hex: "#ffd166"), width: 2.4)
      }
      neck.moved(g.half * 0.25, 0, angle: -10).rect(0, 1, 8, 18, 3.5, Color(hex: "#ff8f5a"))
    case "tie":
      neck.path("M-3.5 -4 L3.5 -4 L2 1.5 L-2 1.5 Z", fill: Color(hex: "#2563eb"))
      neck.path("M-2 1.5 L2 1.5 L5 19 L0 24 L-5 19 Z", fill: Color(hex: "#3b82f6"))
    case "mustache":
      moved(60, g.mouth - 1.5).path("M0 0 Q-8 -5 -14 -1 Q-16 3.5 -11.5 3 Q-6 1.6 0 2.2 Q6 1.6 11.5 3 Q16 3.5 14 -1 Q8 -5 0 0 Z", fill: Color(hex: "#3a2a20"))
    default: break
    }
  }
}
