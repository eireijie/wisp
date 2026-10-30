// Draws Wisp's "Will-o'" logo (the same mark as apps/web/public/icon.svg) as PNGs:
//   swift apps/ios/scripts/icons.swift
// writes the desktop app icon, the menu bar template icons, the iOS app icon, the web/PWA icons,
// the website icons and the Android launcher icons.
//
// Will-o', in a 100x100 box: a diagonal cyan-to-blue tile and a white flame-shaped wisp, a round
// body with a tail flicking up to the right, with two eyes.
import AppKit

let cyan = CGColor(srgbRed: 0x64 / 255, green: 0xD2 / 255, blue: 0xFF / 255, alpha: 1)
let blue = CGColor(srgbRed: 0x0A / 255, green: 0x84 / 255, blue: 0xFF / 255, alpha: 1)
let white = CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)
let eyeInk = CGColor(srgbRed: 0x15 / 255, green: 0x13 / 255, blue: 0x1C / 255, alpha: 1)

/// The wisp and its eyes, with (0,0)-(100,100) mapped onto `rect`.
func wisp(in rect: CGRect) -> (body: CGPath, eyes: CGPath) {
  let s = rect.width / 100
  func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * s, y: rect.minY + y * s) }
  let b = CGMutablePath()
  b.move(to: p(48, 88))
  b.addCurve(to: p(19, 60), control1: p(30, 88), control2: p(19, 75))
  b.addCurve(to: p(44, 31), control1: p(19, 44), control2: p(31, 35))
  b.addCurve(to: p(78, 7), control1: p(57, 27), control2: p(68, 20))
  b.addCurve(to: p(81, 52), control1: p(81, 22), control2: p(83, 36))
  b.addCurve(to: p(48, 88), control1: p(79, 74), control2: p(66, 88))
  b.closeSubpath()
  let e = CGMutablePath()
  for (cx, cy): (CGFloat, CGFloat) in [(41, 62), (57, 61)] {
    let o = p(cx - 3.6, cy - 5.4)
    e.addEllipse(in: CGRect(x: o.x, y: o.y, width: 7.2 * s, height: 10.8 * s))
  }
  return (b, e)
}

func png(_ size: Int, _ path: String, draw: (CGContext, CGFloat) -> Void) {
  let cs = CGColorSpace(name: CGColorSpace.sRGB)!
  let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.interpolationQuality = .high
  // SVG coordinates: y grows downward
  ctx.translateBy(x: 0, y: CGFloat(size)); ctx.scaleBy(x: 1, y: -1)
  draw(ctx, CGFloat(size))
  let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
  print("wrote", path)
}

let root = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("../..").standardized.path

/// The logo in `r`: gradient tile (rounded when `radius` > 0, else square), clipped wisp and eyes.
func tile(_ ctx: CGContext, _ r: CGRect, radius: CGFloat) {
  ctx.saveGState()
  if radius > 0 { ctx.addPath(CGPath(roundedRect: r, cornerWidth: radius, cornerHeight: radius, transform: nil)) } else { ctx.addRect(r) }
  ctx.clip()
  let grad = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [cyan, blue] as CFArray, locations: [0, 1])!
  ctx.drawLinearGradient(grad, start: CGPoint(x: r.minX, y: r.minY), end: CGPoint(x: r.maxX, y: r.maxY), options: [])
  let g = wisp(in: r)
  ctx.addPath(g.body); ctx.setFillColor(white); ctx.fillPath()
  ctx.addPath(g.eyes); ctx.setFillColor(eyeInk); ctx.fillPath()
  ctx.restoreGState()
}

/// Rounded tile filling the whole canvas (web, website, Android).
func rounded(_ ctx: CGContext, _ s: CGFloat) { tile(ctx, CGRect(x: 0, y: 0, width: s, height: s), radius: s * 0.23) }
/// Full bleed, no rounding or transparency: the system applies its own mask (iOS).
func fullBleed(_ ctx: CGContext, _ s: CGFloat) { tile(ctx, CGRect(x: 0, y: 0, width: s, height: s), radius: 0) }

// macOS/Windows/Linux app icon: a rounded tile with the usual margin
png(1024, "\(root)/desktop/build/icon.png") { ctx, s in tile(ctx, CGRect(x: 100, y: 100, width: s - 200, height: s - 200), radius: (s - 200) * 0.23) }
// iOS app icon: full bleed, the system rounds it
png(1024, "\(root)/ios/Wisp/Assets.xcassets/AppIcon.appiconset/icon-1024.png") { ctx, s in fullBleed(ctx, s) }
// web / PWA
for size in [192, 512] { png(size, "\(root)/web/public/icon-\(size).png") { ctx, s in rounded(ctx, s) } }
// website: social/og image and favicon are rounded, the home-screen icon is full bleed
png(512, "\(root)/../site/public/icon-512.png") { ctx, s in rounded(ctx, s) }
png(32, "\(root)/../site/public/favicon-32.png") { ctx, s in rounded(ctx, s) }
png(180, "\(root)/../site/public/apple-touch-icon.png") { ctx, s in fullBleed(ctx, s) }
// Android launcher icons
for (dir, size) in [("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)] {
  png(size, "\(root)/android/app/src/main/res/mipmap-\(dir)/ic_launcher.png") { ctx, s in rounded(ctx, s) }
}
// menu bar: a black wisp with see-through eyes (a template image macOS tints)
for (size, name) in [(18, "trayTemplate.png"), (36, "trayTemplate@2x.png")] {
  png(size, "\(root)/desktop/build/\(name)") { ctx, s in
    // the wisp spans x 19-81, y 7-88 of its box: fit that height into the canvas
    let k = s * 0.94 / 81
    let g = wisp(in: CGRect(x: s / 2 - 50 * k, y: s * 0.03 - 7 * k, width: 100 * k, height: 100 * k))
    ctx.addPath(g.body); ctx.addPath(g.eyes)
    ctx.setFillColor(CGColor(gray: 0, alpha: 1)); ctx.fillPath(using: .evenOdd)
  }
}
