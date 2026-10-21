import SwiftUI

enum MarkdownBlock: Equatable {
  case heading(Int, String)
  case paragraph(String)
  case item(marker: String, text: String, indent: Int)
  case code(String)
  case quote(String)

  static func split(_ text: String) -> [MarkdownBlock] {
    let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
    var blocks: [MarkdownBlock] = []
    var paragraph: [String] = []
    var code: [String] = []
    var fence: String?
    func flush() {
      if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
    }
    for line in lines {
      let trimmed = line.trimmed
      if let opening = fence {
        if trimmed.count >= opening.count && trimmed.allSatisfy({ $0 == opening.first! }) {
          blocks.append(.code(code.joined(separator: "\n"))); code = []; fence = nil
        } else { code.append(line) }
        continue
      }
      if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
        flush(); fence = String(trimmed.prefix(while: { $0 == trimmed.first! })); continue
      }
      if trimmed.isEmpty { flush(); continue }
      let hashes = trimmed.prefix(while: { $0 == "#" }).count
      if (1...6).contains(hashes), trimmed.dropFirst(hashes).first == " " {
        flush(); blocks.append(.heading(hashes, String(trimmed.dropFirst(hashes)).trimmed)); continue
      }
      if trimmed.hasPrefix(">") {
        flush()
        let quote = String(trimmed.dropFirst()).trimmed
        if case .quote(let previous) = blocks.last { blocks[blocks.count - 1] = .quote(previous + "\n" + quote) }
        else { blocks.append(.quote(quote)) }
        continue
      }
      let indent = line.prefix(while: { $0 == " " || $0 == "\t" }).reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
      var marker: String?
      var content = ""
      if ["- ", "* ", "+ "].contains(where: { trimmed.hasPrefix($0) }) {
        marker = "•"; content = String(trimmed.dropFirst(2))
        if content.hasPrefix("[ ] ") { marker = "☐"; content = String(content.dropFirst(4)) }
        else if content.lowercased().hasPrefix("[x] ") { marker = "☑"; content = String(content.dropFirst(4)) }
      } else {
        let digits = trimmed.prefix(while: { $0.isNumber })
        let rest = trimmed.dropFirst(digits.count)
        if !digits.isEmpty && (rest.hasPrefix(". ") || rest.hasPrefix(") ")) {
          marker = String(digits) + "."; content = String(rest.dropFirst(2))
        }
      }
      if let marker {
        flush(); blocks.append(.item(marker: marker, text: content, indent: indent)); continue
      }
      if indent > 0, paragraph.isEmpty, case .item(let marker, let previous, let level) = blocks.last {
        blocks[blocks.count - 1] = .item(marker: marker, text: previous + "\n" + trimmed, indent: level)
      } else { paragraph.append(line) }
    }
    if fence != nil { blocks.append(.code(code.joined(separator: "\n"))) }
    flush()
    return blocks
  }
}

struct NoteMarkdown: View {
  var text: String
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      ForEach(Array(MarkdownBlock.split(text).enumerated()), id: \.offset) { _, block in
        switch block {
        case .heading(let level, let text):
          inline(text).font(level == 1 ? .title2.bold() : level == 2 ? .headline : .subheadline.bold())
        case .paragraph(let text): inline(text)
        case .item(let marker, let text, let indent):
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(marker).frame(minWidth: 24, alignment: .trailing)
            inline(text).frame(maxWidth: .infinity, alignment: .leading)
          }.padding(.leading, CGFloat(indent) * 6)
        case .code(let text):
          ScrollView(.horizontal) {
            Text(text).font(.system(.callout, design: .monospaced)).padding(12)
          }.background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
        case .quote(let text):
          HStack(alignment: .top, spacing: 10) {
            RoundedRectangle(cornerRadius: 2).fill(.secondary).frame(width: 3)
            inline(text).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
          }.fixedSize(horizontal: false, vertical: true)
        }
      }
    }.textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
  }
  private func inline(_ text: String) -> Text { Text(Self.inlineText(text)) }

  static func inlineText(_ text: String) -> AttributedString {
    // Linked notes below the body own navigation; wiki references only get link styling here.
    var result = (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    let plain = String(result.characters)
    guard let regex = try? NSRegularExpression(pattern: "\\[\\[([^\\]]+)\\]\\]") else { return result }
    for match in regex.matches(in: plain, range: NSRange(plain.startIndex..., in: plain)).reversed() {
      guard let range = Range(match.range, in: plain), let content = Range(match.range(at: 1), in: plain) else { continue }
      let lower = result.characters.index(result.startIndex, offsetBy: plain.distance(from: plain.startIndex, to: range.lowerBound))
      let upper = result.characters.index(lower, offsetBy: plain.distance(from: range.lowerBound, to: range.upperBound))
      if result[lower..<upper].runs.contains(where: { $0.inlinePresentationIntent?.contains(.code) == true || $0.link != nil }) { continue }
      let label = plain[content].lastIndex(of: "|").map { plain.index(after: $0) } ?? content.lowerBound
      let labelStart = result.characters.index(lower, offsetBy: plain.distance(from: range.lowerBound, to: label))
      let labelEnd = result.characters.index(lower, offsetBy: plain.distance(from: range.lowerBound, to: content.upperBound))
      var link = AttributedString(result[labelStart..<labelEnd])
      link.foregroundColor = .accentColor
      result.replaceSubrange(lower..<upper, with: link)
    }
    return result
  }
}
