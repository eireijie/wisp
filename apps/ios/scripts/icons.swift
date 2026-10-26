// Draws Wisp's ghost icons (the same ghost as apps/web/public/icon.svg) as PNGs:
//   swift apps/ios/scripts/icons.swift
// writes the desktop app icon, the menu bar template icons and the iOS app icon.
import AppKit

func ghost(in rect: CGRect) -> (body: CGPath, eyes: CGPath) {
  // the SVG ghost lives in a 60x86 box at (30,18); fit it into rect
  let s = min(rect.width / 60, rect.height / 86)
  let ox = rect.midX - 60 * s / 2 - 30 * s, oy = rect.midY - 86 * s / 2 - 18 * s
  func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: ox + x * s, y: oy + y * s) }
  let b = CGMutablePath()
  b.move(to: p(30, 60))
  b.addCurve(to: p(60, 18), control1: p(30, 32), control2: p(44, 18))
  b.addCurve(to: p(90, 60), control1: p(76, 18), control2: p(90, 32))
  b.addLine(to: p(90, 96))
  var x: CGFloat = 90
  var down = true
  while x > 30 {
    b.addQuadCurve(to: p(x - 10, 96), control: p(x - 5, down ? 104 : 88))
    x -= 10; down.toggle()
  }
  b.closeSubpath()
  let e = CGMutablePath()
  e.addEllipse(in: CGRect(x: p(44, 51).x, y: p(44, 51).y, width: 12 * s, height: 12 * s))
  e.addEllipse(in: CGRect(x: p(64, 51).x, y: p(64, 51).y, width: 12 * s, height: 12 * s))
  return (b, e)
}

func png(_ size: Int, _ path: String, draw: (CGContext, CGFloat) -> Void) {
  let cs = CGColorSpace(name: CGColorSpace.sRGB)!
  let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  // SVG coordinates: y grows downward
  ctx.translateBy(x: 0, y: CGFloat(size)); ctx.scaleBy(x: 1, y: -1)
  draw(ctx, CGFloat(size))
  let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
  print("wrote", path)
}

let ink = CGColor(srgbRed: 0x11 / 255, green: 0x11 / 255, blue: 0x11 / 255, alpha: 1)
let paper = CGColor(srgbRed: 0xf5 / 255, green: 0xf5 / 255, blue: 0xf5 / 255, alpha: 1)
let root = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("../..").standardized.path

func tile(_ ctx: CGContext, _ s: CGFloat, inset: CGFloat, radius: CGFloat) {
  let r = CGRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
  ctx.addPath(CGPath(roundedRect: r, cornerWidth: radius, cornerHeight: radius, transform: nil))
  ctx.setFillColor(ink); ctx.fillPath()
  let g = ghost(in: r.insetBy(dx: r.width * 0.2, dy: r.height * 0.16))
  ctx.addPath(g.body); ctx.setFillColor(paper); ctx.fillPath()
  ctx.addPath(g.eyes); ctx.setFillColor(ink); ctx.fillPath()
}

// macOS/Windows/Linux app icon: a rounded tile with the usual margin
png(1024, "\(root)/desktop/build/icon.png") { ctx, s in tile(ctx, s, inset: 100, radius: 185) }
// iOS app icon: full bleed, the system rounds it
png(1024, "\(root)/ios/Wisp/Assets.xcassets/AppIcon.appiconset/icon-1024.png") { ctx, s in
  ctx.setFillColor(ink); ctx.fill(CGRect(x: 0, y: 0, width: s, height: s))
  let g = ghost(in: CGRect(x: s * 0.22, y: s * 0.17, width: s * 0.56, height: s * 0.66))
  ctx.addPath(g.body); ctx.setFillColor(paper); ctx.fillPath()
  ctx.addPath(g.eyes); ctx.setFillColor(ink); ctx.fillPath()
}
// menu bar: a black ghost with see-through eyes (a template image macOS tints)
for (size, name) in [(18, "trayTemplate.png"), (36, "trayTemplate@2x.png")] {
  png(size, "\(root)/desktop/build/\(name)") { ctx, s in
    let g = ghost(in: CGRect(x: 0, y: s * 0.04, width: s, height: s * 0.92))
    ctx.addPath(g.body); ctx.addPath(g.eyes)
    ctx.setFillColor(CGColor(gray: 0, alpha: 1)); ctx.fillPath(using: .evenOdd)
  }
}
