// Draws Wisp's "Peek" logo (the same mark as apps/web/public/icon.svg) as PNGs:
//   swift apps/ios/scripts/icons.swift
// writes the desktop app icon, the menu bar template icons, the iOS app icon, the web/PWA icons,
// the website icons and the Android launcher icons.
//
// Peek, in a 100x100 box: a diagonal purple-to-blue tile, a white dome ghost that runs off the
// bottom edge (so it peeks up) and two eyes shifted right so it looks to the side.
import AppKit

let purple = CGColor(srgbRed: 0xBF / 255, green: 0x5A / 255, blue: 0xF2 / 255, alpha: 1)
let blue = CGColor(srgbRed: 0x0A / 255, green: 0x84 / 255, blue: 0xFF / 255, alpha: 1)
let white = CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)
let eyeInk = CGColor(srgbRed: 0x15 / 255, green: 0x13 / 255, blue: 0x1C / 255, alpha: 1)

/// The ghost (a dome that runs off the bottom) and its eyes, with (0,0)-(100,100) mapped onto `rect`.
func peek(in rect: CGRect) -> (body: CGPath, eyes: CGPath) {
  let s = rect.width / 100
  func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * s, y: rect.minY + y * s) }
  let b = CGMutablePath()
  b.move(to: p(18, 101))
  b.addLine(to: p(18, 62))
  b.addCurve(to: p(50, 28), control1: p(18, 40), control2: p(32, 28))
  b.addCurve(to: p(82, 62), control1: p(68, 28), control2: p(82, 40))
  b.addLine(to: p(82, 101))
  b.closeSubpath()
  let e = CGMutablePath()
  for cx: CGFloat in [53, 70] {
    e.addEllipse(in: CGRect(x: p(cx - 4.2, 55 - 6.6).x, y: p(cx - 4.2, 55 - 6.6).y, width: 8.4 * s, height: 13.2 * s))
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

/// The logo in `r`: gradient tile (rounded when `radius` > 0, else square), clipped ghost and eyes.
func tile(_ ctx: CGContext, _ r: CGRect, radius: CGFloat) {
  ctx.saveGState()
  if radius > 0 { ctx.addPath(CGPath(roundedRect: r, cornerWidth: radius, cornerHeight: radius, transform: nil)) } else { ctx.addRect(r) }
  ctx.clip()
  let grad = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [purple, blue] as CFArray, locations: [0, 1])!
  ctx.drawLinearGradient(grad, start: CGPoint(x: r.minX, y: r.minY), end: CGPoint(x: r.maxX, y: r.maxY), options: [])
  let g = peek(in: r)
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
// menu bar: a black dome with see-through eyes (a template image macOS tints)
for (size, name) in [(18, "trayTemplate.png"), (36, "trayTemplate@2x.png")] {
  png(size, "\(root)/desktop/build/\(name)") { ctx, s in
    let k = s * 0.94 / 72
    let g = peek(in: CGRect(x: s / 2 - 50 * k, y: s * 0.06 - 28 * k, width: 100 * k, height: 100 * k))
    ctx.addRect(CGRect(x: 0, y: 0, width: s, height: s)); ctx.clip()
    ctx.addPath(g.body); ctx.addPath(g.eyes)
    ctx.setFillColor(CGColor(gray: 0, alpha: 1)); ctx.fillPath(using: .evenOdd)
  }
}
