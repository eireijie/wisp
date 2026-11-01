import SwiftUI
import UniformTypeIdentifiers

/** A chat to open, with the request to start it with. */
struct ChatTarget: Hashable {
  var channel: Channel
  var draft: String
}

/** The look of "Add" without being a button, for the end of a row that is itself a link. */
struct AddLabel: View {
  var title: String
  var muted = false
  var body: some View {
    Text(title)
      .font(.system(size: 15, weight: .medium))
      .foregroundStyle(muted ? Palette.faint : Palette.text)
      .padding(.horizontal, 14)
      .frame(height: 34)
      .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(MarketColor.chip))
  }
}

// MARK: - Sharing a skill without a server in between

/** A skill as it travels in a link or a file. */
struct SharedSkill: Equatable {
  var name: String
  var description: String
  var content: String
  var tags: [String]
}

/**
 * A skill is small, so "a link" carries the skill itself ("wisp-skill:" and the text, encoded: the same
 * as the web's), and a file is the SKILL.md anyone's harness reads. Bringing one in reads either back.
 */
enum SkillShare {
  static let prefix = "wisp-skill:"

  static func link(_ s: SharedSkill) -> String {
    let object: [String: Any] = ["n": s.name, "d": s.description, "c": s.content, "t": s.tags]
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data()
    return prefix + data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  /** The skill inside a link made by `link`, or nil when the text isn't one. */
  static func read(link text: String) -> SharedSkill? {
    guard let at = text.range(of: prefix) else { return nil }
    var body = String(text[at.upperBound...]).split(whereSeparator: \.isWhitespace).first.map(String.init) ?? ""
    body = body.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while body.count % 4 != 0 { body += "=" }
    guard let data = Data(base64Encoded: body),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let name = object["n"] as? String, let content = object["c"] as? String,
          !name.trimmed.isEmpty, !content.trimmed.isEmpty else { return nil }
    return SharedSkill(name: String(name.prefix(60)), description: String(((object["d"] as? String) ?? "").prefix(500)), content: content, tags: Array(((object["t"] as? [Any]) ?? []).compactMap { $0 as? String }.prefix(10)))
  }

  /** A SKILL.md (front matter with a name and description, then instructions) as a skill. */
  static func read(file text: String, name fileName: String = "") -> SharedSkill {
    let source = text.hasPrefix("\u{FEFF}") ? String(text.dropFirst()) : text
    var fields: [String: String] = [:]
    var body = source
    if let match = source.range(of: #"^---\r?\n([\s\S]*?)\r?\n---\r?\n?"#, options: .regularExpression) {
      for line in source[match].split(whereSeparator: \.isNewline) {
        guard let colon = line.firstIndex(of: ":"), line.first != "-" else { continue }
        let key = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
        let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        fields[key] = unquote(value)
      }
      body = String(source[match.upperBound...])
    }
    body = body.trimmed
    let heading = body.range(of: #"(?m)^#\s+(.+)$"#, options: .regularExpression).map { String(String(body[$0]).dropFirst(1)).trimmed }
    let title = fields["title"].flatMap { $0.isEmpty ? nil : $0 }
      ?? fields["name"].flatMap { $0.isEmpty ? nil : MarketText.skillTitle($0) }
      ?? heading ?? nameFromFile(fileName)
    let tags = (fields["tags"] ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "[]")).split(separator: ",").map { String($0).trimmed.lowercased() }.filter { !$0.isEmpty }
    let description = (fields["description"] ?? "").split(whereSeparator: \.isWhitespace).joined(separator: " ")
    return SharedSkill(name: String((title.isEmpty ? "New skill" : title).prefix(60)), description: String(description.prefix(500)), content: body, tags: Array(tags.prefix(10)))
  }

  /** The SKILL.md Wisp writes for a skill. */
  static func file(_ skill: HelperSkill) -> String {
    func quoted(_ v: String) -> String {
      let flat = v.split(whereSeparator: \.isWhitespace).joined(separator: " ")
      let data = (try? JSONEncoder().encode(flat)) ?? Data()
      return String(data: data, encoding: .utf8) ?? "\"\""
    }
    let slug = skill.slug ?? MarketText.slug(skill.name)
    return "---\nname: \(slug)\ntitle: \(quoted(skill.name))\ndescription: \(quoted(skill.description ?? ""))\n---\n\n\((skill.content ?? "").trimmed)\n"
  }

  private static func unquote(_ raw: String) -> String {
    if raw.hasPrefix("\""), let data = "[\(raw)]".data(using: .utf8), let list = try? JSONSerialization.jsonObject(with: data) as? [String], let first = list.first { return first }
    if raw.count >= 2, raw.hasPrefix("'"), raw.hasSuffix("'") { return String(raw.dropFirst().dropLast()) }
    return raw
  }

  private static func nameFromFile(_ fileName: String) -> String {
    var parts = fileName.replacingOccurrences(of: "\\", with: "/").split(separator: "/").map(String.init)
    var base = parts.popLast() ?? ""
    if base.lowercased() == "skill.md", let parent = parts.last { base = parent }
    if base.lowercased().hasSuffix(".md") { base = String(base.dropLast(3)) }
    let words = base.replacingOccurrences(of: "[_-]+", with: " ", options: .regularExpression).trimmed
    return words.isEmpty ? "New skill" : words.prefix(1).uppercased() + words.dropFirst()
  }
}

// MARK: - Try it

/** "Try it": a request to start a chat with, or to copy. */
struct TryItSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var name: String
  var description: String
  var agentIds: [String]
  var onOpenChat: (ChatTarget) -> Void
  @State private var pick = ""
  @State private var action = FormAction()
  @State private var copied = false
  private var holders: [Agent] { store.agents.filter { agentIds.contains($0.id) } }
  private var helper: Agent? { holders.first { $0.id == pick } ?? holders.first }

  var body: some View {
    let text = MarketText.trySuggestion(name: name, description: description)
    MarketSheet(title: "Try it", subtitle: name) {
      Text(helper == nil ? "Install the skill first so an agent can use it. Meanwhile, this is a request to try." : "Start a chat with this request ready. Add your own details, then send.")
        .font(.system(size: 13)).foregroundStyle(Palette.faint).padding(.horizontal, 4)
      Text(text).font(.system(size: 15)).textSelection(.enabled).padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.control, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.hairline))
      if holders.count > 1 {
        Picker("Which agent?", selection: Binding(get: { helper?.id ?? "" }, set: { pick = $0 })) { ForEach(holders) { Text($0.name).tag($0.id) } }.pickerStyle(.menu)
      }
      InlineError(error: action.error)
      HStack(spacing: 10) {
        Button { UIPasteboard.general.string = text; copied = true } label: { Text(copied ? "Copied" : "Copy request").frame(maxWidth: .infinity) }.secondaryButton()
        if let helper {
          Button {
            action.run { let channel = try await store.dm(with: helper); dismiss(); onOpenChat(ChatTarget(channel: channel, draft: text)) }
          } label: { Text("Open chat with \(helper.name)").frame(maxWidth: .infinity) }.primaryButton().disabled(action.busy)
        }
      }
    }
  }
}

// MARK: - Share and bring in

/**
 * Share a skill (a link, a file, or a copy for another helper) and bring one in (a pasted link, a
 * .md file, or the ones your devices' harnesses already have). Without a skill it is only "Bring one in".
 */
struct SkillShareSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var skill: HelperSkill?
  var onBrought: (HelperSkill) -> Void
  /** nil hides "From your devices", for a screen that has no device list to go to */
  var onDevices: (() -> Void)?
  enum Page { case home, agents, paste, found }
  @State private var page = Page.home
  @State private var picked: Set<String> = []
  @State private var pasted = ""
  @State private var found: SharedSkill?
  @State private var note: String?
  @State private var fileURL: URL?
  @State private var importing = false
  @State private var action = FormAction()

  private var used: [String] { skill.map { s in store.agents.filter { s.has($0.id) }.map(\.name) } ?? [] }
  private var title: String {
    switch page {
    case .home: skill == nil ? "Bring one in" : "Share a skill"
    case .agents: "Share with another agent"
    case .paste: "Paste a link"
    case .found: "Bring it in"
    }
  }

  var body: some View {
    MarketSheet(title: title, busy: action.busy) {
      switch page {
      case .home: home
      case .agents: agentsPage
      case .paste: pastePage
      case .found: foundPage
      }
      if let note { Text(note).font(.system(size: 13)).foregroundStyle(Palette.statusOnline).padding(.horizontal, 4) }
      InlineError(error: action.error)
    }
    .onAppear {
      picked = Set(skill?.agentIds ?? [])
      if let skill { fileURL = Self.write(skill) }
    }
    .fileImporter(isPresented: $importing, allowedContentTypes: [.plainText, UTType(filenameExtension: "md") ?? .plainText]) { result in
      guard case .success(let url) = result else { return }
      let scoped = url.startAccessingSecurityScopedResource()
      defer { if scoped { url.stopAccessingSecurityScopedResource() } }
      if let text = try? String(contentsOf: url, encoding: .utf8) { found = SkillShare.read(file: text, name: url.lastPathComponent); page = .found }
      else { action.error = "Couldn't read that file." }
    }
  }

  @ViewBuilder private var home: some View {
    if let skill {
      CardGroup {
        MarketRow(symbol: "wand.and.stars", tile: 50, title: skill.name, subtitle: used.isEmpty ? "No agent has it yet" : "Used by \(ShelfLogic.sentence(used))")
      }
      CardGroup {
        Button { UIPasteboard.general.string = SkillShare.link(SharedSkill(name: skill.name, description: skill.description ?? "", content: skill.content ?? "", tags: skill.tags ?? [])); note = "Link copied. Anyone with it can paste it into Bring one in." } label: {
          MarketRow(symbol: "link", title: "Copy a link")
        }.buttonStyle(.plain)
        if let fileURL {
          ShareLink(item: fileURL) { MarketRow(symbol: "arrow.down.doc", title: "Save as a file") }.buttonStyle(.plain)
        }
        if store.canManage && !store.agents.isEmpty {
          Button { page = .agents } label: { MarketRow(symbol: "person.2", title: "Share with another agent") }.buttonStyle(.plain)
        }
      }
    }
    if store.canManage {
      if skill != nil { MarketLabel("Bring one in") }
      CardGroup {
        Button { page = .paste } label: { MarketRow(symbol: "link", title: "Paste a link") }.buttonStyle(.plain)
        Button { importing = true } label: { MarketRow(symbol: "doc.text", title: "Choose a file") }.buttonStyle(.plain)
        if let onDevices {
          Button { dismiss(); onDevices() } label: { MarketRow(symbol: "laptopcomputer", title: "From your devices") }.buttonStyle(.plain)
        }
      }
    }
  }

  @ViewBuilder private var agentsPage: some View {
    CardGroup {
      ForEach(store.agents) { agent in
        MarketToggleRow(title: agent.name, subtitle: "@\(agent.handle)", isOn: Binding(get: { picked.contains(agent.id) }, set: { if $0 { picked.insert(agent.id) } else { picked.remove(agent.id) } })) {
          AgentAvatar(agent: agent, size: 30, showStatus: false)
        }
      }
    }
    HStack(spacing: 10) {
      Button { page = .home } label: { Text("Back").frame(maxWidth: .infinity) }.secondaryButton()
      Button {
        guard let skill else { return }
        action.run {
          let have = Set(skill.agentIds ?? [])
          for id in picked.subtracting(have) { try await store.setSkillAgent(skill.id, agent: id, on: true) }
          for id in have.subtracting(picked) { try await store.setSkillAgent(skill.id, agent: id, on: false) }
          dismiss()
        }
      } label: { Text("Share").frame(maxWidth: .infinity) }.primaryButton().disabled(action.busy)
    }
  }

  @ViewBuilder private var pastePage: some View {
    MarketField(label: nil, placeholder: "wisp-skill:…", text: $pasted, mono: true, lines: 3...6, plain: true)
    HStack(spacing: 10) {
      Button { page = .home } label: { Text("Back").frame(maxWidth: .infinity) }.secondaryButton()
      Button {
        if let s = SkillShare.read(link: pasted) ?? (pasted.contains("---") || pasted.contains("#") ? SkillShare.read(file: pasted) : nil) { found = s; action.error = nil; page = .found }
        else { action.error = "That isn't a Wisp skill link or a SKILL.md file." }
      } label: { Text("Continue").frame(maxWidth: .infinity) }.primaryButton().disabled(pasted.trimmed.isEmpty)
    }
  }

  @ViewBuilder private var foundPage: some View {
    if let found {
      CardGroup { MarketRow(symbol: "wand.and.stars", tile: 50, title: found.name, subtitle: found.description.isEmpty ? "No description" : found.description) }
      HStack(spacing: 10) {
        Button { page = .home } label: { Text("Back").frame(maxWidth: .infinity) }.secondaryButton()
        Button {
          action.run {
            let made = try await store.saveSkill(nil, ["name": AnyEncodable(found.name), "description": AnyEncodable(found.description), "content": AnyEncodable(found.content), "tags": AnyEncodable(found.tags), "agentIds": AnyEncodable([String]())])
            dismiss(); onBrought(made)
          }
        } label: { Text("Bring it in").frame(maxWidth: .infinity) }.primaryButton().disabled(action.busy)
      }
    }
  }

  private static func write(_ skill: HelperSkill) -> URL? {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(skill.slug ?? MarketText.slug(skill.name)).md")
    do { try SkillShare.file(skill).write(to: url, atomically: true, encoding: .utf8); return url } catch { return nil }
  }
}
