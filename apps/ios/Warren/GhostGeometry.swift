import SwiftUI

/** The web's SVG commands, parsed once and interpolated without allocating strings per frame. */
struct GhostPath {
  struct Command {
    var letter: Character
    var values: [Double]
  }
  var commands: [Command]

  init(_ svg: String) {
    let pattern = /[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/
    var result: [Command] = []
    for match in svg.matches(of: pattern) {
      let token = String(match.output)
      if let number = Double(token), !result.isEmpty { result[result.count - 1].values.append(number) }
      else if let letter = token.first { result.append(Command(letter: letter, values: [])) }
    }
    commands = result
  }

  func path(toward other: GhostPath? = nil, fraction: Double = 0) -> Path {
    var path = Path(), point = CGPoint.zero, start = CGPoint.zero
    for (index, command) in commands.enumerated() {
      let a = command.values
      let b = other?.commands[index].values ?? a
      let v = zip(a, b).map { $0 + ($1 - $0) * fraction }
      let relative = command.letter.isLowercase
      func p(_ i: Int) -> CGPoint {
        CGPoint(x: v[i] + (relative ? point.x : 0), y: v[i + 1] + (relative ? point.y : 0))
      }
      switch command.letter.uppercased() {
      case "M": point = p(0); start = point; path.move(to: point)
      case "L": point = p(0); path.addLine(to: point)
      case "H": point.x = v[0] + (relative ? point.x : 0); path.addLine(to: point)
      case "V": point.y = v[0] + (relative ? point.y : 0); path.addLine(to: point)
      case "C":
        let c1 = p(0), c2 = p(2), end = p(4)
        path.addCurve(to: end, control1: c1, control2: c2); point = end
      case "Q":
        let control = p(0), end = p(2)
        path.addQuadCurve(to: end, control: control); point = end
      case "Z": path.closeSubpath(); point = start
      default: break
      }
    }
    return path
  }
}

struct GhostGeometry {
  var a: GhostPath
  var b: GhostPath
  var eyeX: [Double]
  var eyeY: Double
  var mouth: Double
  var top: Double
  var bottom: Double
  /** the head's width just under its top against the classic head's, so a hat covers the same part of every head */
  var hatScale: Double
  /** a point on the head's edge, up and to the right, where a bow or flower clips on */
  var clip: CGPoint
  /** where neckwear goes, the body's half-width there, and how far down the body stays solid (where the hem starts) */
  var neck: Double
  var half: Double
  var hem: Double
  var ground: Double
  var shoulderY: Double
  var shoulderX: [Double]
  var tilt: [Double]
  var armScale: Double
}

/** Small drawing helpers keep every part in the same SVG coordinate system. */
struct GhostPainter {
  var context: GraphicsContext

  func path(_ svg: String, fill: Color? = nil, stroke: Color? = nil, width: Double = 1) {
    draw(GhostArt.paths[svg]!, fill: fill, stroke: stroke, width: width)
  }

  func draw(_ path: Path, fill: Color? = nil, stroke: Color? = nil, width: Double = 1) {
    if let fill { context.fill(path, with: .color(fill)) }
    if let stroke { context.stroke(path, with: .color(stroke), style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round)) }
  }

  func ellipse(_ x: Double, _ y: Double, _ rx: Double, _ ry: Double, _ fill: Color? = nil, stroke: Color? = nil, width: Double = 1) {
    draw(Path(ellipseIn: CGRect(x: x - rx, y: y - ry, width: rx * 2, height: ry * 2)), fill: fill, stroke: stroke, width: width)
  }

  func rect(_ x: Double, _ y: Double, _ w: Double, _ h: Double, _ radius: Double, _ fill: Color) {
    draw(Path(roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerRadius: radius), fill: fill)
  }

  func moved(_ x: Double = 0, _ y: Double = 0, scaleX: Double = 1, scaleY: Double = 1, angle: Double = 0) -> GhostPainter {
    var p = self
    p.context.translateBy(x: x, y: y)
    p.context.rotate(by: .degrees(angle))
    p.context.scaleBy(x: scaleX, y: scaleY)
    return p
  }

  func faded(_ opacity: Double) -> GhostPainter {
    var p = self
    p.context.opacity *= opacity
    return p
  }
}

extension GhostGeometry {
  static let shapes: [String: GhostGeometry] = [
    "classic": GhostGeometry(
      a: GhostPath("M30 60 C30 32 44 18 60 18 C76 18 90 32 90 60 L90 96 Q85 104 80 96 Q75 88 70 96 Q65 104 60 96 Q55 88 50 96 Q45 104 40 96 Q35 88 30 96 Z"),
      b: GhostPath("M30 60 C30 32 44 18 60 18 C76 18 90 32 90 60 L90 96 Q85 88 80 96 Q75 104 70 96 Q65 88 60 96 Q55 104 50 96 Q45 88 40 96 Q35 104 30 96 Z"),
      eyeX: [50, 70], eyeY: 54, mouth: 66, top: 18, bottom: 100, hatScale: 1, clip: CGPoint(x: 75, y: 23), neck: 77, half: 30, hem: 98, ground: 111, shoulderY: 66, shoulderX: [30, 90], tilt: [0, 0], armScale: 0.95),
    "round": GhostGeometry(
      a: GhostPath("M22 64 C22 38 38 26 60 26 C82 26 98 38 98 64 L98 92 Q92 100 86 92 Q80 84 74 92 Q67 100 60 92 Q53 84 46 92 Q40 100 34 92 Q28 84 22 92 Z"),
      b: GhostPath("M22 64 C22 38 38 26 60 26 C82 26 98 38 98 64 L98 92 Q92 84 86 92 Q80 100 74 92 Q67 84 60 92 Q53 100 46 92 Q40 84 34 92 Q28 100 22 92 Z"),
      eyeX: [47, 73], eyeY: 58, mouth: 70, top: 26, bottom: 96, hatScale: 1.38, clip: CGPoint(x: 83, y: 32), neck: 80, half: 38, hem: 92, ground: 107, shoulderY: 70, shoulderX: [22, 98], tilt: [0, 0], armScale: 1.08),
    "tall": GhostGeometry(
      a: GhostPath("M38 52 C38 24 47 10 60 10 C73 10 82 24 82 52 L82 102 Q76.5 110 71 102 Q65.5 94 60 102 Q54.5 110 49 102 Q43.5 94 38 102 Z"),
      b: GhostPath("M38 52 C38 24 47 10 60 10 C73 10 82 24 82 52 L82 102 Q76.5 94 71 102 Q65.5 110 60 102 Q54.5 94 49 102 Q43.5 110 38 102 Z"),
      eyeX: [52, 68], eyeY: 44, mouth: 56, top: 10, bottom: 106, hatScale: 0.77, clip: CGPoint(x: 72, y: 15), neck: 68, half: 22, hem: 100, ground: 115, shoulderY: 58, shoulderX: [38, 82], tilt: [0, 0], armScale: 0.82),
    "sheet": GhostGeometry(
      a: GhostPath("M42 52 C42 28 50 16 60 16 C70 16 78 28 78 52 C80 72 92 86 100 100 Q93 95 86 102 Q78 95 70 102 Q60 95 50 102 Q42 95 34 102 Q27 95 20 100 C28 86 40 72 42 52 Z"),
      b: GhostPath("M42 52 C42 28 50 16 60 16 C70 16 78 28 78 52 C80 72 92 86 100 100 Q93 105 86 98 Q78 105 70 98 Q60 105 50 98 Q42 105 34 98 Q27 105 20 100 C28 86 40 72 42 52 Z"),
      eyeX: [53, 67], eyeY: 46, mouth: 57, top: 16, bottom: 102, hatScale: 0.65, clip: CGPoint(x: 70, y: 21), neck: 64, half: 20.5, hem: 96, ground: 110, shoulderY: 67, shoulderX: [38.5, 81.5], tilt: [-20.4, -20.4], armScale: 0.86),
    "wisp": GhostGeometry(
      a: GhostPath("M60 16 C80 16 90 32 90 52 C90 74 78 84 68 90 C60 95 58 104 66 108 C52 110 46 98 50 90 C36 84 30 72 30 52 C30 32 40 16 60 16 Z"),
      b: GhostPath("M60 16 C80 16 90 32 90 52 C90 74 80 86 70 92 C62 97 64 106 72 110 C58 110 52 100 52 92 C38 86 30 72 30 52 C30 32 40 16 60 16 Z"),
      eyeX: [50, 70], eyeY: 50, mouth: 62, top: 16, bottom: 109, hatScale: 1.09, clip: CGPoint(x: 77, y: 21), neck: 72, half: 25.7, hem: 92, ground: 115, shoulderY: 62, shoulderX: [30.4, 89], tilt: [6.9, 11.4], armScale: 0.98),
  ]
}
