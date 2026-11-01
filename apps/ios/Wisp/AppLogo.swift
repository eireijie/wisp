import SwiftUI

/**
 * An app's tile with its real logo: the first of its sources that loads, on a light square so any
 * brand color reads; a plain line icon when none does. Brand logos are one-path SVGs, drawn natively.
 */
struct AppLogo: View {
  @Environment(Store.self) private var store
  var sources: [String]
  var symbol: String
  var size: CGFloat = 44
  @State private var logo: LoadedLogo?

  var body: some View {
    Group {
      switch logo {
      case .image(let image)?:
        Image(uiImage: image).resizable().scaledToFit().frame(width: size * 0.6, height: size * 0.6).logoTile(size)
      case .vector(let shape)?:
        shape.path.fill(shape.color).frame(width: size * 0.6, height: size * 0.6).logoTile(size)
      case nil:
        MarketTile(symbol: symbol, size: size)
      }
    }
    .accessibilityHidden(true)
    .task(id: sources) { logo = await LogoCache.shared.load(sources, base: store.api?.base) }
  }

  /** The hub's address for a brand's logo, by name. */
  static func byName(_ name: String) -> [String] {
    var c = URLComponents()
    c.path = "/api/logo"
    c.queryItems = [URLQueryItem(name: "for", value: name)]
    return c.string.map { [$0] } ?? []
  }
}

private extension View {
  func logoTile(_ size: CGFloat) -> some View {
    frame(width: size, height: size)
      .background(Color.white, in: RoundedRectangle(cornerRadius: size * 0.27, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: size * 0.27, style: .continuous).strokeBorder(Color.black.opacity(0.1)))
  }
}

enum LoadedLogo: @unchecked Sendable {
  case image(UIImage)
  case vector(VectorLogo)
}

struct VectorLogo: Sendable {
  var path: SVGShape
  var color: Color
}

@MainActor final class LogoCache {
  static let shared = LogoCache()
  private var done: [String: LoadedLogo] = [:]

  func load(_ sources: [String], base: URL?) async -> LoadedLogo? {
    for source in sources {
      if let hit = done[source] { return hit }
      guard let url = URL(string: source, relativeTo: source.hasPrefix("/") ? base : nil)?.absoluteURL,
            let (data, response) = try? await URLSession.shared.data(from: url),
            (response as? HTTPURLResponse)?.statusCode == 200, !data.isEmpty else { continue }
      let logo = SVGShape.logo(from: data) ?? UIImage(data: data).map(LoadedLogo.image)
      if let logo { done[source] = logo; return logo }
    }
    return nil
  }
}

/** The paths of a simple SVG (moves, lines, curves and arcs) as a shape scaled to fit its frame. */
struct SVGShape: Shape, Sendable {
  var box: CGRect
  var commands: String

  func path(in rect: CGRect) -> Path {
    let scale = min(rect.width / box.width, rect.height / box.height)
    return Self.parse(commands).applying(CGAffineTransform(translationX: -box.minX, y: -box.minY).concatenating(CGAffineTransform(scaleX: scale, y: scale)))
  }

  static func logo(from data: Data) -> LoadedLogo? {
    guard let text = String(data: data, encoding: .utf8), text.contains("<svg") else { return nil }
    let paths = matches(#"\sd="([^"]+)""#, text)
    guard !paths.isEmpty else { return nil }
    let viewBox = matches(#"viewBox="([^"]+)""#, text).first ?? "0 0 24 24"
    let box: [Double] = viewBox.split { $0 == " " || $0 == "," }.compactMap { Double($0) }
    guard box.count == 4, box[2] > 0, box[3] > 0 else { return nil }
    let hex = matches(##"fill="#([0-9a-fA-F]{6})""##, text).first.flatMap { UInt32($0, radix: 16) } ?? 0x1C1C1E
    let color = Color(red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255)
    return .vector(VectorLogo(path: SVGShape(box: CGRect(x: box[0], y: box[1], width: box[2], height: box[3]), commands: paths.joined(separator: " ")), color: color))
  }

  private static func matches(_ pattern: String, _ text: String) -> [String] {
    guard let re = try? NSRegularExpression(pattern: pattern) else { return [] }
    return re.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { m in Range(m.range(at: 1), in: text).map { String(text[$0]) } }
  }

  /** Reads a path's `d`: every SVG command, absolute or relative. */
  static func parse(_ d: String) -> Path {
    var path = Path()
    let chars = Array(d)
    var i = 0
    var cmd: Character = " "
    var cur = CGPoint.zero, start = CGPoint.zero, lastControl: CGPoint?
    var lastCmd: Character = " "

    func skip() { while i < chars.count, chars[i] == " " || chars[i] == "," || chars[i] == "\n" || chars[i] == "\t" { i += 1 } }
    func number() -> CGFloat {
      skip()
      let from = i
      if i < chars.count, chars[i] == "-" || chars[i] == "+" { i += 1 }
      var dot = false
      while i < chars.count {
        let c = chars[i]
        if c.isNumber { i += 1 }
        else if c == ".", !dot { dot = true; i += 1 }
        else if c == "e" || c == "E" { i += 1; if i < chars.count, chars[i] == "-" || chars[i] == "+" { i += 1 } }
        else { break }
      }
      return CGFloat(Double(String(chars[from..<i])) ?? 0)
    }
    /** an arc's flags are single digits and may touch what follows */
    func flag() -> Bool {
      skip()
      defer { i += 1 }
      return i < chars.count && chars[i] == "1"
    }
    func point(_ rel: Bool) -> CGPoint {
      let x = number(), y = number()
      return rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
    }

    while true {
      skip()
      guard i < chars.count else { break }
      if chars[i].isLetter { cmd = chars[i]; i += 1 }
      let rel = cmd.isLowercase
      switch Character(cmd.uppercased()) {
      case "M":
        cur = point(rel); start = cur; path.move(to: cur)
        cmd = rel ? "l" : "L"
      case "L": cur = point(rel); path.addLine(to: cur)
      case "H": let x = number(); cur.x = rel ? cur.x + x : x; path.addLine(to: cur)
      case "V": let y = number(); cur.y = rel ? cur.y + y : y; path.addLine(to: cur)
      case "C":
        let a = point(rel), b = point(rel), e = point(rel)
        path.addCurve(to: e, control1: a, control2: b); lastControl = b; cur = e
      case "S":
        let a = "CSCS".contains(lastCmd.uppercased()) ? CGPoint(x: 2 * cur.x - (lastControl?.x ?? cur.x), y: 2 * cur.y - (lastControl?.y ?? cur.y)) : cur
        let b = point(rel), e = point(rel)
        path.addCurve(to: e, control1: a, control2: b); lastControl = b; cur = e
      case "Q":
        let a = point(rel), e = point(rel)
        path.addQuadCurve(to: e, control: a); lastControl = a; cur = e
      case "T":
        let a = "QT".contains(lastCmd.uppercased()) ? CGPoint(x: 2 * cur.x - (lastControl?.x ?? cur.x), y: 2 * cur.y - (lastControl?.y ?? cur.y)) : cur
        let e = point(rel)
        path.addQuadCurve(to: e, control: a); lastControl = a; cur = e
      case "A":
        let rx = number(), ry = number(), rot = number(), large = flag(), sweep = flag(), e = point(rel)
        addArc(&path, from: cur, to: e, rx: rx, ry: ry, degrees: rot, large: large, sweep: sweep); cur = e
      case "Z":
        path.closeSubpath(); cur = start
      default:
        return path
      }
      lastCmd = cmd
    }
    return path
  }

  /** An SVG arc as cubic curves (the endpoint-to-center conversion from the SVG spec). */
  private static func addArc(_ path: inout Path, from p0: CGPoint, to p1: CGPoint, rx rx0: CGFloat, ry ry0: CGFloat, degrees: CGFloat, large: Bool, sweep: Bool) {
    var rx = abs(rx0), ry = abs(ry0)
    guard rx > 0, ry > 0, p0 != p1 else { path.addLine(to: p1); return }
    let phi = degrees * .pi / 180, c = cos(phi), s = sin(phi)
    let dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2
    let x1 = c * dx + s * dy, y1 = -s * dx + c * dy
    let lambda = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry)
    if lambda > 1 { rx *= sqrt(lambda); ry *= sqrt(lambda) }
    let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
    let den = rx * rx * y1 * y1 + ry * ry * x1 * x1
    let k = (large == sweep ? -1 : 1) * sqrt(max(0, num / den))
    let cx1 = k * rx * y1 / ry, cy1 = -k * ry * x1 / rx
    let cx = c * cx1 - s * cy1 + (p0.x + p1.x) / 2, cy = s * cx1 + c * cy1 + (p0.y + p1.y) / 2
    let t1 = atan2((y1 - cy1) / ry, (x1 - cx1) / rx)
    var delta = atan2((-y1 - cy1) / ry, (-x1 - cx1) / rx) - t1
    if sweep && delta < 0 { delta += 2 * .pi }
    if !sweep && delta > 0 { delta -= 2 * .pi }
    let n = max(1, Int(ceil(abs(delta) / (.pi / 2))))
    let step = delta / CGFloat(n), h = 4 / 3 * tan(step / 4)
    func at(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: c * rx * x - s * ry * y + cx, y: s * rx * x + c * ry * y + cy) }
    var a = t1
    for j in 0..<n {
      let b = a + step
      let e = j == n - 1 ? p1 : at(cos(b), sin(b))
      path.addCurve(to: e, control1: at(cos(a) - h * sin(a), sin(a) + h * cos(a)), control2: at(cos(b) + h * sin(b), sin(b) - h * cos(b)))
      a = b
    }
  }
}
