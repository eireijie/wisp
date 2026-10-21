import Foundation

/** Five-field cron, kept in step with packages/core/src/schedule.ts. */
struct CronSchedule {
  var fields: [[Int]]
  var domStar: Bool
  var dowStar: Bool
  private static let names = ["sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6,
                              "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12]
  init?(_ expression: String) {
    let parts = expression.split(whereSeparator: \.isWhitespace).map(String.init)
    guard parts.count == 5 else { return nil }
    let limits = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)]
    var fields: [[Int]] = []
    func number(_ value: String, named: Bool = false) -> Int? {
      if named, let name = Self.names[value.lowercased()] { return name }
      // JavaScript Number accepts an empty string as zero.
      if value.trimmed.isEmpty { return 0 }
      guard let n = Double(value), n.isFinite, n.rounded() == n, abs(n) < Double(Int.max) else { return nil }
      return Int(n)
    }
    for (i, part) in parts.enumerated() {
      let (min, max) = limits[i]
      var values: [Int] = []
      for item in part.components(separatedBy: ",") {
        let pieces = item.components(separatedBy: "/")
        guard let step = pieces.count > 1 ? number(pieces[1]) : 1, step >= 1 else { return nil }
        let lo: Int
        let hi: Int
        if pieces[0] == "*" { lo = min; hi = max }
        else {
          let range = pieces[0].components(separatedBy: "-")
          guard let a = number(range[0], named: true), let b = range.count > 1 ? number(range[1], named: true) : (pieces.count > 1 ? max : a) else { return nil }
          lo = a; hi = b
        }
        guard lo >= min, lo <= max, hi >= min, hi <= max, lo <= hi else { return nil }
        var value = lo
        while value <= hi {
          let mapped = i == 4 && value == 7 ? 0 : value
          if !values.contains(mapped) { values.append(mapped) }
          if step > hi - value { break }
          value += step
        }
      }
      fields.append(values)
    }
    self.fields = fields; domStar = parts[2] == "*"; dowStar = parts[4] == "*"
  }

  func nextRun(timezone: String, from: Date = Date()) -> Date? {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: timezone) ?? TimeZone(secondsFromGMT: 0)!
    var date = Date(timeIntervalSince1970: floor(from.timeIntervalSince1970 / 60) * 60 + 60)
    for _ in 0..<(366 * 24 * 60) {
      let p = calendar.dateComponents([.minute, .hour, .day, .month, .weekday], from: date)
      let domOK = fields[2].contains(p.day ?? 0)
      let dowOK = fields[4].contains((p.weekday ?? 1) - 1)
      if fields[0].contains(p.minute ?? -1) && fields[1].contains(p.hour ?? -1) && fields[3].contains(p.month ?? 0) &&
          (!domStar && !dowStar ? domOK || dowOK : domOK && dowOK) { return date }
      date.addTimeInterval(60)
    }
    return nil
  }
}

func describeCron(_ expression: String) -> String {
  guard let c = CronSchedule(expression) else { return expression }
  let min = c.fields[0], hour = c.fields[1], dom = c.fields[2], month = c.fields[3], dow = c.fields[4]
  let m = min.count == 1 ? min[0] : nil, h = hour.count == 1 ? hour[0] : nil
  guard month.count == 12 else { return expression }
  if let m, hour.count == 24 && c.domStar && c.dowStar {
    return m == 0 ? "Every hour" : String(format: "Every hour at :%02d", m)
  }
  guard let m, let h else {
    if min.count > 1 && hour.count == 24 && c.domStar && c.dowStar {
      let step = min[1] - min[0]
      if min.enumerated().allSatisfy({ $0.element == $0.offset * step }) { return "Every \(step) minutes" }
    }
    return expression
  }
  let at = "\(h % 12 == 0 ? 12 : h % 12)" + (m == 0 ? "" : String(format: ":%02d", m)) + (h < 12 ? "am" : "pm")
  if c.domStar && c.dowStar { return "Every day at \(at)" }
  if c.domStar {
    let days = dow.sorted()
    if days == [1, 2, 3, 4, 5] { return "Every weekday at \(at)" }
    if days == [0, 6] { return "Every weekend day at \(at)" }
    let names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    return "Every \(days.map { names[$0] }.joined(separator: ", ")) at \(at)"
  }
  if c.dowStar && dom.count == 1 {
    let d = dom[0]
    let suffix = d % 10 == 1 && d != 11 ? "st" : d % 10 == 2 && d != 12 ? "nd" : d % 10 == 3 && d != 13 ? "rd" : "th"
    return "On the \(d)\(suffix) of every month at \(at)"
  }
  return expression
}
