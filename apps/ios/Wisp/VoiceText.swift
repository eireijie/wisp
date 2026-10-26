import Foundation

/** Text helpers for calls, ported from the web's voice/text.ts. */
enum VoiceText {
  private static func regex(_ pattern: String, multiline: Bool = false) -> NSRegularExpression {
    // the patterns are constants, so a bad one is a programming error
    try! NSRegularExpression(pattern: pattern, options: multiline ? [.anchorsMatchLines] : [])
  }
  private static func strip(_ text: String, _ re: NSRegularExpression, with replacement: String = "") -> String {
    re.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: replacement)
  }

  private static let steps: [NSRegularExpression] = [
    regex("(`{3,}|~{3,})[^\\n]*\\n[\\s\\S]*?(?:\\1|$)"),
    regex("^(?: {4}|\\t).*$", multiline: true),
    regex("^.*\\|.*$", multiline: true),
    regex("!?\\[[^\\]]*\\]\\([^)]*\\)"),
    regex("!?\\[[^\\]]*\\]\\[[^\\]]*\\]"),
    regex("^\\s*\\[[^\\]]+\\]:.*$", multiline: true),
    regex("https?://\\S+|www\\.\\S+"),
    regex("<[^>]*>"),
    regex("[`*_~]"),
    regex("^\\s*(?:#{1,6}\\s+|>\\s*|[-+]\\s+|\\d+[.)]\\s+)", multiline: true),
  ]
  private static let sentence = regex("[^.!?]+(?:[.!?]+(?=\\s|$)|$)")
  private static let paragraphBreak = regex("\\n\\s*\\n")
  private static let spaces = regex("\\s+")

  /** A small spoken answer; the complete Markdown stays in chat. */
  static func spokenReply(_ markdown: String) -> String {
    var plain = markdown
    for step in steps { plain = strip(plain, step) }
    plain = plain.trimmingCharacters(in: .whitespacesAndNewlines)
    let paragraphs = paragraphBreak.stringByReplacingMatches(in: plain, range: NSRange(plain.startIndex..., in: plain), withTemplate: "\u{0}").components(separatedBy: "\u{0}")
    let first = paragraphs.first { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? ""
    let paragraph = strip(first, spaces, with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    let matches = sentence.matches(in: paragraph, range: NSRange(paragraph.startIndex..., in: paragraph))
    var text = matches.prefix(2).compactMap { Range($0.range, in: paragraph).map { String(paragraph[$0]) } }.joined().trimmingCharacters(in: .whitespacesAndNewlines)
    if matches.isEmpty { text = paragraph }
    guard text.count > 480 else { return text }
    var cut = String(text.prefix(477))
    if let space = cut.lastIndex(where: { $0.isWhitespace }) { cut = String(cut[..<space]) }
    return cut + "…"
  }

  private static let firstSentenceRe = regex("^.{8,}?[.!?]+(?=\\s)")
  /** The first whole sentence of a reply that is still streaming (it must be followed by whitespace), or nil. */
  static func firstSentence(_ excerpt: String) -> String? {
    guard let m = firstSentenceRe.firstMatch(in: excerpt, range: NSRange(excerpt.startIndex..., in: excerpt)), let r = Range(m.range, in: excerpt) else { return nil }
    return String(excerpt[r])
  }

  /** A stable pick from `count` choices for a seed, so an agent keeps one voice. */
  static func voiceIndex(_ seed: String, _ count: Int) -> Int {
    var hash: UInt32 = 0
    for unit in seed.utf16 { hash = hash &* 31 &+ UInt32(unit) }
    return count > 0 ? Int(hash % UInt32(count)) : 0
  }

  /** Recognition can hear the speakers; don't send the agent's own words back to it. */
  static func isSpeechEcho(heard: String, spoken: String) -> Bool {
    func words(_ s: String) -> [String] {
      s.lowercased().unicodeScalars.filter { CharacterSet.letters.contains($0) || CharacterSet.decimalDigits.contains($0) || CharacterSet.whitespacesAndNewlines.contains($0) }
        .map(String.init).joined().split(whereSeparator: \.isWhitespace).map(String.init)
    }
    let a = words(heard), b = words(spoken)
    return !a.isEmpty && b.joined(separator: " ").contains(a.joined(separator: " "))
  }

  static let openaiVoices = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"]
  static let elevenVoices = ["JBFqnCBsd6RMkjVDRZzb", "EXAVITQu4vr4xnSDxMaL", "21m00Tcm4TlvDq8ikWAM"]
}
