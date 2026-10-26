import SwiftUI

extension GhostPainter {
  func arms(geometry g: GhostGeometry, mood: GhostMood, time: Double, animated: Bool,
    gradient: GraphicsContext.Shading, body: Path) {
    func frame(_ side: Int, _ angle: Double) -> GhostPainter {
      moved(g.shoulderX[side], g.shoulderY, scaleX: side == 0 ? -1 : 1)
        .moved(angle: g.tilt[side]).moved(scaleX: g.armScale, scaleY: g.armScale)
        .moved(-3.8, 0).moved(angle: angle)
    }
    func hand(_ side: Int) -> CGPoint {
      let a = 120.0 * .pi / 180, tilt = g.tilt[side] * .pi / 180
      let x = (10.6 * cos(a) - 3.8) * g.armScale, y = 10.6 * sin(a) * g.armScale
      return CGPoint(x: g.shoulderX[side] + (side == 0 ? -1 : 1) * (x * cos(tilt) - y * sin(tilt)),
        y: g.shoulderY + x * sin(tilt) + y * cos(tilt))
    }
    let left = hand(0), right = hand(1), hy = (left.y + right.y) / 2
    let radius = 3.6 * g.armScale, lidTop = hy + radius + 0.6, deckTop = hy - 1.6 * g.armScale
    let width = right.x - left.x + 18 * g.armScale
    let height = min(28, max(18, g.bottom - lidTop + 1.5))
    let screen = Color(hex: "#a6e8d4"), shell = Color(hex: "#343244")
    if mood == .working {
      var glow = context
      glow.clip(to: body)
      glow.fill(Path(ellipseIn: CGRect(x: 60 - width * 0.48, y: lidTop - 15 * g.armScale,
        width: width * 0.96, height: 30 * g.armScale)), with: .radialGradient(
          Gradient(colors: [screen.opacity(0.55), screen.opacity(0)]), center: CGPoint(x: 60, y: lidTop), startRadius: 0, endRadius: width * 0.48))
      let dt = (width - 11) / 2, db = (width - 2) / 2
      var deck = Path()
      deck.move(to: CGPoint(x: 60 - dt, y: deckTop)); deck.addLine(to: CGPoint(x: 60 + dt, y: deckTop))
      deck.addLine(to: CGPoint(x: 60 + db, y: lidTop + 1)); deck.addLine(to: CGPoint(x: 60 - db, y: lidTop + 1)); deck.closeSubpath()
      draw(deck, fill: Color(hex: "#4a4760"), stroke: Color(hex: "#4a4760"), width: 1.6)
      for (row, k) in [0.38, 0.75].enumerated() {
        let ky = deckTop + (lidTop - deckTop) * k, half = dt + (db - dt) * k - 3
        for i in 0..<7 {
          let lit = animated && (i + row * 3) % 4 == 1 && GhostAnimation.phase(time + Double(i) * 0.37 + Double(row) * 0.21, 0.9) > 0.5
          moved(60 - half + half / 3 * Double(i), ky).path("M-1.3 0 h2.6", stroke: lit ? .white : screen.opacity(0.6), width: 1.1)
        }
      }
      for p in [left, right] { ellipse(p.x, hy + radius * 0.72, radius * 1.05, 0.9 * g.armScale, .black.opacity(0.3)) }
    }
    if mood == .waiting {
      let angle = GhostAnimation.arm(1, mood: mood, time: time, animated: animated)
      let sign = frame(1, angle).moved(10.6, 0, angle: -(-30 + g.tilt[1]))
      sign.path("M0 7.5 V-19", stroke: Color(hex: "#8d8291"), width: 2.6)
      sign.rect(-9.5, -37, 19, 19, 5, Color(hex: "#f5c542"))
      sign.path("M-6.2 -34.2 h5", stroke: .white.opacity(0.55), width: 1.6)
      sign.path("M-3.4 -30.4 C-3.4 -35 3.7 -35 3.7 -30.7 C3.7 -28.4 0.2 -28.3 0.2 -25.4", stroke: shell, width: 2.6)
      sign.ellipse(0.2, -21.7, 1.5, 1.5, shell)
    }
    for side in 0..<2 {
      let p = frame(side, GhostAnimation.arm(side, mood: mood, time: time, animated: animated))
      let limb = Path(roundedRect: CGRect(x: -3.6, y: -3.6, width: 17.8, height: 7.2), cornerRadius: 3.6)
      // Transform the clip back to body space so the gradient stays seamless at the shoulder.
      let transform = p.context.transform.concatenating(context.transform.inverted())
      let arm = limb.applying(transform)
      context.fill(arm, with: gradient)
      var rim = p.context
      rim.clip(to: limb)
      var outer = Path(CGRect(x: -20, y: -20, width: 60, height: 40))
      outer.addEllipse(in: CGRect(x: -4.2, y: -4.2, width: 8.4, height: 8.4))
      rim.clip(to: outer, style: FillStyle(eoFill: true))
      rim.stroke(limb, with: .color(.black.opacity(0.1)), lineWidth: 3.4 / g.armScale)
    }
    if mood == .working {
      let x0 = 60 - width / 2, x1 = 60 + width / 2
      let b0 = 60 - (width - 5) / 2, b1 = 60 + (width - 5) / 2, y1 = lidTop + height, c = 3.2
      var lid = Path()
      lid.move(to: CGPoint(x: x0 + c, y: lidTop)); lid.addLine(to: CGPoint(x: x1 - c, y: lidTop))
      lid.addQuadCurve(to: CGPoint(x: x1 - 0.3, y: lidTop + c), control: CGPoint(x: x1, y: lidTop))
      lid.addLine(to: CGPoint(x: b1 + 0.2, y: y1 - c))
      lid.addQuadCurve(to: CGPoint(x: b1 - c, y: y1), control: CGPoint(x: b1, y: y1))
      lid.addLine(to: CGPoint(x: b0 + c, y: y1))
      lid.addQuadCurve(to: CGPoint(x: b0 - 0.2, y: y1 - c), control: CGPoint(x: b0, y: y1))
      lid.addLine(to: CGPoint(x: x0 + 0.3, y: lidTop + c))
      lid.addQuadCurve(to: CGPoint(x: x0 + c, y: lidTop), control: CGPoint(x: x0, y: lidTop)); lid.closeSubpath()
      draw(lid, fill: shell)
      var edge = Path(); edge.move(to: CGPoint(x: x0 + 3.5, y: lidTop + 0.9)); edge.addLine(to: CGPoint(x: x1 - 3.5, y: lidTop + 0.9))
      draw(edge, stroke: screen.opacity(0.75), width: 1.1)
      moved(60, lidTop + height / 2, scaleX: 0.14, scaleY: 0.14).moved(-60, -59)
        .draw(GhostGeometry.shapes["classic"]!.a.path(), fill: screen.opacity(0.9))
    }
  }
}
