import Foundation

/** A skill in the hub's store: public repos, read at their source (GET /api/skill-store). */
struct StoreSkill: Decodable, Identifiable, Hashable {
  struct Source: Decodable, Hashable { var id: String; var label: String }
  struct License: Decodable, Hashable { var label: String; var open: Bool }
  var id: String
  var name: String
  var description: String
  var source: Source
  var url: String
  var license: License
}
struct SkillStoreList: Decodable { var skills: [StoreSkill]; var errors: [String]? }
struct SkillStoreDetail: Decodable { var skill: StoreSkill; var content: String? }

/** How much to trust a registry app's publisher, in words (trustLabel in packages/core). */
struct TrustLabel: Equatable {
  enum Kind { case unverified, verified, maker }
  var kind: Kind
  var text: String
  var explanation: String
}

/** What the "Before you connect" box says. */
struct ConnectSummary: Equatable {
  var can: String
  var runBy: String
  var caution: String?
}

enum MarketText {
  private static func squash(_ s: String) -> String { String(s.lowercased().filter { ($0.isASCII && $0.isLetter) || ($0.isASCII && $0.isNumber) }) }

  private static func titleCase(_ s: String) -> String {
    s.split(whereSeparator: { "-_. \t\n".contains($0) }).map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
  }

  static func trust(_ e: MarketplaceEntry) -> TrustLabel {
    guard e.verified == true else {
      return TrustLabel(kind: .unverified, text: "Not verified", explanation: "The registry hasn't confirmed who \(e.publisher ?? "the publisher") is. Only add servers you trust, since agents send them data.")
    }
    let brand = squash(e.brand ?? "")
    func named(_ s: String) -> Bool { brand.count >= 3 && squash(s).contains(brand) }
    let forApp = named(e.name) || named(e.id.split(separator: "/").last.map(String.init) ?? "")
    let owns = e.domain ?? e.publisher ?? "the publisher"
    if forApp {
      return TrustLabel(kind: .maker, text: "Made by \((e.brand ?? "").lowercased() == "github" ? "GitHub" : titleCase(e.brand ?? ""))", explanation: "Published by \(e.publisher ?? owns), which the registry confirmed owns \(owns), and the app is theirs.")
    }
    return TrustLabel(kind: .verified, text: "Verified publisher", explanation: "The registry confirmed this publisher owns \(owns). That doesn't mean the app's maker made or endorses it.")
  }

  /** "Before you connect" for a registry app (connectSummary in the web's ConnectorsView). */
  static func summary(_ e: MarketplaceEntry, _ install: MarketplaceInstall) -> ConnectSummary {
    let t = trust(e)
    let publisher = e.publisher ?? "its publisher"
    let can = install.fields?.isEmpty == false
      ? "Your agents get the key you enter, so they can use \(e.name) with it."
      : "Your agents will be able to use \(e.name) through this connection: read and act on what this app allows."
    switch t.kind {
    case .unverified:
      return ConnectSummary(can: can, runBy: "Run by \(publisher), not by the app's maker or Wisp.", caution: "Nobody has confirmed who they are. Only connect if you trust them.")
    case .maker:
      return ConnectSummary(can: can, runBy: "Made and run by \(t.text.replacingOccurrences(of: "Made by ", with: "")) (\(e.domain ?? publisher)), not by Wisp.", caution: nil)
    case .verified:
      let who = e.domain.map { "\(publisher) (\($0))" } ?? publisher
      return ConnectSummary(can: can, runBy: "Run by \(who), not by Wisp. The registry confirmed who they are; that doesn't mean \(e.name)'s own maker endorses it.", caution: nil)
    }
  }

  /** "Before you connect" for an app on Wisp's own list. */
  static func summary(builtIn c: AppConnector) -> ConnectSummary {
    let host = c.url.flatMap { URL(string: $0)?.host }
    switch c.kind {
    case "secret":
      return ConnectSummary(can: "Your agents get the key you enter, so they can use \(c.name) with it.", runBy: "Wisp keeps the key and gives it only to the agents you pick.", caution: nil)
    case "mcp-http":
      return ConnectSummary(can: "Your agents will be able to use \(c.name) through this connection: read and act on what this app allows.", runBy: "On Wisp's list of well-known apps. It connects to \(host ?? "the app's own address"), not to a server run by Wisp.", caution: nil)
    default:
      return ConnectSummary(can: "Your agents will be able to use \(c.name) through this connection: read and act on what this app allows.", runBy: "On Wisp's list of well-known apps. It runs as a program on the agent's own computer.", caution: nil)
    }
  }

  private static func lowerFirst(_ v: String) -> String {
    let chars = Array(v)
    guard chars.count > 1, chars[0].isUppercase, chars[1].isLowercase else { return v }
    return chars[0].lowercased() + String(chars.dropFirst())
  }

  /** First sentence of a skill description as a plain "what it's for" line, cut at a word boundary. */
  static func whatItsFor(_ description: String, max: Int = 110) -> String {
    let flat = description.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    guard !flat.isEmpty else { return "" }
    var text = flat
    if let r = text.range(of: #"^Use (when|for) "#, options: [.regularExpression, .caseInsensitive]) {
      text.replaceSubrange(r, with: text[r].lowercased().contains("for") ? "For " : "When ")
    }
    var first = text
    if let r = text.range(of: #"^.*?[.!?](?=\s|$)"#, options: .regularExpression) { first = String(text[r]) }
    guard first.count > max else { return first }
    var cut = String(first.prefix(max - 1))
    if let space = cut.lastIndex(of: " "), cut.distance(from: cut.startIndex, to: space) >= 20 { cut = String(cut[..<space]) }
    while let last = cut.last, " ,;:.-".contains(last) { cut.removeLast() }
    return cut + "…"
  }

  /** A request to start a chat with, to try a skill. */
  static func trySuggestion(name: String, description: String) -> String {
    let purpose = whatItsFor(description)
    return "Please use your \"\(name.trimmed)\" skill for this.\(purpose.isEmpty ? "" : " (It is for this: \(lowerFirst(purpose)))") Here is what I have: "
  }

  /** Same slug the hub gives a skill. */
  static func slug(_ name: String) -> String {
    var out = ""
    var dash = false
    for ch in name.lowercased() {
      if ch.isASCII && (ch.isLetter || ch.isNumber) { if dash && !out.isEmpty { out.append("-") }; out.append(ch); dash = false } else { dash = true }
    }
    let clipped = String(out.prefix(60))
    return clipped.isEmpty ? "skill" : clipped
  }

  /** "frontend-design" becomes "Frontend design"; "mcp-builder", "MCP builder". */
  static func skillTitle(_ slug: String) -> String {
    let acronyms: Set<String> = ["pdf", "docx", "pptx", "xlsx", "mcp", "api", "ci", "cli", "gh", "ui", "ux", "ai", "llm", "sql", "csv", "seo", "gif", "pr"]
    let names = ["chatgpt": "ChatGPT", "github": "GitHub", "openai": "OpenAI", "aspnet": "ASP.NET", "winui": "WinUI", "gitlab": "GitLab", "arxiv": "arXiv", "macos": "macOS", "ios": "iOS"]
    let words = slug.split(whereSeparator: { "_-".contains($0) || $0.isWhitespace }).map(String.init)
    return words.enumerated().map { i, w in
      let lower = w.lowercased()
      if let n = names[lower] { return n }
      if acronyms.contains(lower) { return w.uppercased() }
      return i == 0 ? w.prefix(1).uppercased() + w.dropFirst() : lower
    }.joined(separator: " ")
  }

  /** A plain line icon for a skill, from what it's about. */
  static func skillSymbol(_ text: String) -> String {
    let t = text.lowercased()
    let picks: [(String, String)] = [
      (#"\b(xlsx|spreadsheet|sheets?|excel|csv)\b"#, "tablecells"),
      (#"\b(pptx|slides?|deck|presentation)\b"#, "rectangle.on.rectangle"),
      (#"\b(pdf|docx|documents?|docs?|writ\w+)\b"#, "doc.text"),
      (#"\b(design|art|theme|canvas|frontend|figma|brand|ui)\b"#, "paintpalette"),
      (#"\b(images?|gif|imagegen|screenshot)\b"#, "photo"),
      (#"\b(security|threat|secure)\b"#, "shield"),
      (#"\b(gh|github|pull request|pr|ci|review)\b"#, "arrow.triangle.pull"),
      (#"\b(test\w*|playwright|browser|webapp)\b"#, "cursorarrow.click"),
      (#"\b(research|search|arxiv|papers?)\b"#, "magnifyingglass"),
      (#"\b(notion|notes?|knowledge|wiki|meeting)\b"#, "note.text"),
      (#"\b(comms|slack|messages?|email|chat)\b"#, "message"),
      (#"\b(mcp|api|cli|code|aspnet|winui|jupyter|sdk)\b"#, "chevron.left.forwardslash.chevron.right")
    ]
    return picks.first { t.range(of: $0.0, options: .regularExpression) != nil }?.1 ?? "wand.and.stars"
  }

  /** Where an installed skill came from, in words. */
  static func origin(_ s: HelperSkill) -> String {
    let id = s.catalogId ?? ""
    if id.hasPrefix("device:") {
      let harness = id.split(separator: ":", omittingEmptySubsequences: false).dropFirst(2).first.map(String.init) ?? ""
      return "From \(HarnessChoice.all.first { $0.id == harness }?.label ?? "a device")"
    }
    if s.source == "catalog" {
      if let prefix = id.split(separator: ":").first, id.contains(":") { return "From \(prefix == "anthropic" ? "Anthropic" : prefix == "openai" ? "OpenAI" : prefix.capitalized)" }
      return "From the library"
    }
    return "Yours"
  }
}
