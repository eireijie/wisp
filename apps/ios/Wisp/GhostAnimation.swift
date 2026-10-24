import Foundation

enum GhostMood: String, CaseIterable {
  case awake, working, done, waiting, error, asleep, thinking, listening
}

/** Keyframes use the web's timing and coordinates; each seed supplies a different clock offset. */
enum GhostAnimation {
  static func phase(_ time: Double, _ duration: Double) -> Double {
    (time / duration).truncatingRemainder(dividingBy: 1)
  }

  static func wave(_ time: Double, _ duration: Double) -> Double {
    (1 - cos(phase(time, duration) * .pi * 2)) / 2
  }

  static func key(_ phase: Double, _ frames: [(Double, Double)]) -> Double {
    guard phase > frames[0].0 else { return frames[0].1 }
    for i in 1..<frames.count where phase <= frames[i].0 {
      let a = frames[i - 1], b = frames[i]
      let t = (phase - a.0) / (b.0 - a.0)
      let ease = t * t * (3 - 2 * t)
      return a.1 + (b.1 - a.1) * ease
    }
    return frames.last!.1
  }

  static func arm(_ side: Int, mood: GhostMood, time: Double, animated: Bool) -> Double {
    let still: Double = mood == .working ? 120 : mood == .done ? -52 : mood == .asleep ? 80 : mood == .waiting && side == 1 ? -30 : 52
    guard animated else { return still }
    switch mood {
    case .awake where side == 1:
      return key(phase(time, 5), [(0, 52), (0.54, 52), (0.62, -62), (0.67, -36), (0.72, -72), (0.77, -38), (0.82, -72), (0.88, -52), (0.97, 52), (1, 52)])
    case .done: return -36 - 40 * wave(time, 1.1)
    case .waiting where side == 1: return -22 - 18 * wave(time, 1.5)
    case .working: return 120 - 9 * wave(time + Double(side) * 0.23, 0.46)
    case .asleep: return 80 - 3 * wave(time, 5)
    default: return still + 3 * wave(time, 4)
    }
  }
}
