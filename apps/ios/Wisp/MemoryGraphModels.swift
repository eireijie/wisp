import Foundation
import CoreGraphics

/** The folder kinds the graph colors by, like the web's. */
enum GraphKind: String, CaseIterable, Hashable {
  case shared, people, agents, teams, groups, other, ghost
  /** Simple mode says "helpers", not "agents". */
  func label(simple: Bool) -> String {
    switch self {
    case .shared: "Shared"
    case .people: "People"
    case .agents: simple ? "Helpers" : "Agents"
    case .teams: "Teams"
    case .groups: "Groups"
    case .other: "Your folders"
    case .ghost: "Not written yet"
    }
  }
}

/** One note in the graph, as /api/vault/graph returns it. Ghosts are links to notes nobody wrote yet. */
struct GraphNode: Decodable, Identifiable, Hashable, Sendable {
  var id: String
  var path: String?
  var title: String
  var kind: String
  var type: String?
  var tags: [String]?
  var updatedAt: Double?
  var links: Int?
  var inbound: Int?
  var graphKind: GraphKind { GraphKind(rawValue: kind) ?? .other }
  var tagList: [String] { tags ?? [] }
  var linkCount: Int { links ?? 0 }
  var inboundCount: Int { inbound ?? 0 }
  var isGhost: Bool { graphKind == .ghost }
}
struct GraphEdge: Decodable, Hashable, Sendable { var source: String; var target: String }
struct GraphData: Decodable, Equatable, Sendable {
  var nodes: [GraphNode]
  var edges: [GraphEdge]
  static let empty = GraphData(nodes: [], edges: [])

  /** The note and everything linked to it, either way: the "connected notes" beside an open note. */
  func neighbourhood(of id: String, depth: Int = 1) -> GraphData {
    var keep: Set<String> = [id]
    for _ in 0..<depth {
      let step = keep
      for e in edges {
        if step.contains(e.source) { keep.insert(e.target) }
        if step.contains(e.target) { keep.insert(e.source) }
      }
    }
    return GraphData(nodes: nodes.filter { keep.contains($0.id) }, edges: edges.filter { keep.contains($0.source) && keep.contains($0.target) })
  }

  /** What is left after hiding folder kinds and (optionally) keeping one tag. */
  func filtered(hidden: Set<GraphKind>, tag: String) -> GraphData {
    let nodes = nodes.filter { !hidden.contains($0.graphKind) && (tag.isEmpty || $0.tagList.contains(tag)) }
    let ids = Set(nodes.map(\.id))
    return GraphData(nodes: nodes, edges: edges.filter { ids.contains($0.source) && ids.contains($0.target) })
  }

  /** Notes that others link to most, best first. */
  func mostLinked(_ limit: Int = 6) -> [GraphNode] {
    nodes.filter { $0.path != nil && $0.inboundCount > 0 }
      .sorted { $0.inboundCount != $1.inboundCount ? $0.inboundCount > $1.inboundCount : $0.linkCount > $1.linkCount }
      .prefix(limit).map { $0 }
  }

  /** Titles and paths that contain the text, best matches first. */
  func find(_ text: String, limit: Int = 8) -> [GraphNode] {
    let q = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !q.isEmpty else { return [] }
    return nodes.filter { $0.title.lowercased().contains(q) || ($0.path?.lowercased().contains(q) ?? false) }
      .sorted {
        let a = !$0.title.lowercased().hasPrefix(q), b = !$1.title.lowercased().hasPrefix(q)
        return a != b ? !a : $0.linkCount > $1.linkCount
      }
      .prefix(limit).map { $0 }
  }

  var tagCounts: [(String, Int)] {
    var counts: [String: Int] = [:]
    for n in nodes { for t in n.tagList { counts[t, default: 0] += 1 } }
    return counts.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }.map { ($0.key, $0.value) }
  }
  func count(of kind: GraphKind) -> Int { nodes.filter { $0.graphKind == kind }.count }
}

/** One saved change to memory (/api/vault/changes). */
struct MemoryChange: Decodable, Identifiable {
  struct File: Decodable, Hashable { var path: String; var change: String; var from: String? }
  var hash: String
  var author: String
  var date: String
  var message: String?
  var files: [File]
  var id: String { hash }

  static func verb(_ change: String) -> String {
    ["added": "added", "modified": "edited", "deleted": "deleted", "renamed": "moved"][change] ?? change
  }
  /** Changes with only the files the person can still open (or that were deleted). */
  func keeping(visible: Set<String>?) -> MemoryChange {
    var copy = self
    copy.files = files.filter { $0.change == "deleted" || visible == nil || visible!.contains($0.path) }
    return copy
  }
}

/** A run of lines last changed by one person or agent (/api/vault/blame). */
struct BlameBlock: Decodable, Identifiable {
  var hash: String
  var author: String
  var date: String
  var lines: [String]
  var id: String { hash + String(lines.count) + (lines.first ?? "") }

  /** Blame blocks minus the note's front matter, which is bookkeeping rather than writing. */
  static func withoutFrontmatter(_ blocks: [BlameBlock]) -> [BlameBlock] {
    let all = blocks.flatMap(\.lines)
    guard all.first == "---", let end = all.dropFirst().firstIndex(of: "---") else { return blocks }
    var seen = 0
    return blocks.compactMap { block in
      var copy = block
      copy.lines = block.lines.enumerated().filter { seen + $0.offset > end }.map(\.element)
      seen += block.lines.count
      return copy.lines.isEmpty ? nil : copy
    }.filter { $0.lines.contains { !$0.trimmingCharacters(in: .whitespaces).isEmpty } }
  }
}

/** A front matter value: one line of text, or a list. */
enum FrontValue: Decodable, Hashable {
  case text(String)
  case list([String])
  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if let s = try? c.decode(String.self) { self = .text(s) }
    else if let l = try? c.decode([String].self) { self = .list(l) }
    else if let n = try? c.decode(Double.self) { self = .text(n == n.rounded() ? String(Int(n)) : String(n)) }
    else if let b = try? c.decode(Bool.self) { self = .text(b ? "true" : "false") }
    else { self = .text("") }
  }
  var isEmpty: Bool {
    switch self { case .text(let s): s.isEmpty; case .list(let l): l.isEmpty }
  }
  var items: [String] {
    switch self { case .text(let s): [s]; case .list(let l): l }
  }
}

extension MemoryNote {
  /** The properties worth showing, in file order is lost by JSON so sorted by name; the title is the heading, so it is left out. */
  var properties: [(String, FrontValue)] {
    (frontmatter ?? [:]).filter { $0.key != "title" && !$0.value.isEmpty }.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
  }
}

/** `[[Note|Label]]` as front matter shows it: (target, label). Anything else is plain text. */
func wikiLinkParts(_ value: String) -> (target: String, label: String)? {
  let t = value.trimmingCharacters(in: .whitespaces)
  guard t.hasPrefix("[["), t.hasSuffix("]]") else { return nil }
  let inner = String(t.dropFirst(2).dropLast(2))
  guard !inner.contains("[") else { return nil }
  let parts = inner.components(separatedBy: "|")
  let target = (parts[0].components(separatedBy: "#").first ?? parts[0])
  return (target, parts.count > 1 ? parts[1] : parts[0])
}

/** Where new notes can go, like the web's "Where to keep it". */
struct NoteLocation: Hashable, Identifiable {
  var folder: String
  var label: String
  var id: String { folder }
  static func choices(meId: String?, agents: [(id: String, name: String)]) -> [NoteLocation] {
    (meId.map { [NoteLocation(folder: "people/\($0)", label: "My notes")] } ?? [])
      + [NoteLocation(folder: "shared", label: "Shared with everyone")]
      + agents.map { NoteLocation(folder: "agents/\($0.id)", label: "\($0.name)'s notes") }
  }
  /** `folder/Name.md`, with the extension and stray slashes sorted out. */
  static func path(folder: String, name: String) -> String? {
    var clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
    if clean.lowercased().hasSuffix(".md") { clean = String(clean.dropLast(3)) }
    guard !clean.isEmpty, !clean.hasSuffix("/") else { return nil }
    let dir = folder.trimmingCharacters(in: CharacterSet(charactersIn: "/ \n"))
    return (dir.isEmpty ? "" : dir + "/") + clean + ".md"
  }
}

/** A small force layout (springs along links, repulsion between notes, a pull to the middle), run once so the screen never has to simulate. */
enum GraphLayout {
  static func radius(_ node: GraphNode) -> CGFloat { node.isGhost ? 3.5 : 4.5 + CGFloat(Double(node.linkCount).squareRoot()) * 2.1 }

  static func positions(for graph: GraphData, iterations: Int? = nil) -> [String: CGPoint] {
    let n = graph.nodes.count
    guard n > 0 else { return [:] }
    var index: [String: Int] = [:]
    for (i, node) in graph.nodes.enumerated() { index[node.id] = i }
    let r = graph.nodes.map(radius)
    var links: [(Int, Int)] = []
    var linked = [Bool](repeating: false, count: n)
    for e in graph.edges {
      guard let a = index[e.source], let b = index[e.target], a != b else { continue }
      links.append((a, b)); linked[a] = true; linked[b] = true
    }
    // a deterministic spiral start, so the same notes always settle the same way
    var x = [CGFloat](repeating: 0, count: n), y = x, vx = x, vy = x
    for i in 0..<n {
      let angle = CGFloat(i) * 2.399963, dist = 10 * CGFloat(i).squareRoot()
      x[i] = cos(angle) * dist; y[i] = sin(angle) * dist
    }
    guard n > 1 else { return [graph.nodes[0].id: .zero] }
    // big graphs get fewer rounds: the pairwise pushes cost n² each
    let steps = iterations ?? (n > 2000 ? 25 : max(60, min(300, 150_000 / max(n, 1) / 2)))
    let alphaDecay = 1 - pow(0.001, 1 / CGFloat(steps))
    var alpha: CGFloat = 1
    for _ in 0..<steps {
      // repulsion, only between notes that are near each other
      for i in 0..<n {
        for j in (i + 1)..<n {
          var dx = x[j] - x[i], dy = y[j] - y[i]
          var d2 = dx * dx + dy * dy
          if d2 > 520 * 520 { continue }
          if d2 < 1 { dx = CGFloat((i * 7 + j) % 5) - 2.5; dy = CGFloat((i + j * 3) % 5) - 2.5; d2 = dx * dx + dy * dy + 1 }
          let d = d2.squareRoot()
          let push = 150 * alpha / d2
          vx[i] -= dx / d * push * d; vy[i] -= dy / d * push * d
          vx[j] += dx / d * push * d; vy[j] += dy / d * push * d
          // keep notes from sitting on each other
          let minGap = r[i] + r[j] + 4
          if d < minGap {
            let shove = (minGap - d) / d * 0.5
            vx[i] -= dx * shove; vy[i] -= dy * shove; vx[j] += dx * shove; vy[j] += dy * shove
          }
        }
      }
      for (a, b) in links {
        let dx = x[b] + vx[b] - x[a] - vx[a], dy = y[b] + vy[b] - y[a] - vy[a]
        let d = max(0.01, (dx * dx + dy * dy).squareRoot())
        let rest = 34 + (r[a] + r[b]) * 1.5
        let pull = (d - rest) / d * alpha * 0.3
        vx[a] += dx * pull; vy[a] += dy * pull; vx[b] -= dx * pull; vy[b] -= dy * pull
      }
      for i in 0..<n {
        let centre: CGFloat = linked[i] ? 0.05 : 0.2
        vx[i] -= x[i] * centre * alpha; vy[i] -= y[i] * centre * alpha
        vx[i] *= 0.6; vy[i] *= 0.6
        x[i] += vx[i]; y[i] += vy[i]
      }
      alpha -= alpha * alphaDecay
    }
    var out: [String: CGPoint] = [:]
    for (i, node) in graph.nodes.enumerated() { out[node.id] = CGPoint(x: x[i], y: y[i]) }
    return out
  }
}

/** Where the graph is looked at from: a pan and a zoom. */
struct GraphCamera: Equatable {
  var x: CGFloat = 0
  var y: CGFloat = 0
  var k: CGFloat = 1
  static let range: ClosedRange<CGFloat> = 0.15...5

  /** The view that shows every point with some room around it. */
  static func fit(_ points: [CGPoint], in size: CGSize, pad: CGFloat = 36) -> GraphCamera {
    guard let first = points.first, size.width > 0, size.height > 0 else { return GraphCamera() }
    var minX = first.x, maxX = first.x, minY = first.y, maxY = first.y
    for p in points { minX = min(minX, p.x); maxX = max(maxX, p.x); minY = min(minY, p.y); maxY = max(maxY, p.y) }
    let w = max(maxX - minX, 40), h = max(maxY - minY, 40)
    let k = min(2, max(range.lowerBound, min((size.width - pad * 2) / w, (size.height - pad * 2) / h)))
    return GraphCamera(x: -(minX + maxX) / 2 * k, y: -(minY + maxY) / 2 * k, k: k)
  }
  /** Zoom by a factor around a point in the view (measured from the view's center). */
  func zoomed(by factor: CGFloat, around focal: CGPoint = .zero) -> GraphCamera {
    let k2 = min(Self.range.upperBound, max(Self.range.lowerBound, k * factor))
    let s = k2 / k
    return GraphCamera(x: focal.x - (focal.x - x) * s, y: focal.y - (focal.y - y) * s, k: k2)
  }
  /** The view that puts a graph point in the middle at least as close as `minZoom`. */
  func centered(on p: CGPoint, minZoom: CGFloat = 1.6) -> GraphCamera {
    let k2 = min(Self.range.upperBound, max(k, minZoom))
    return GraphCamera(x: -p.x * k2, y: -p.y * k2, k: k2)
  }
  func toWorld(_ screen: CGPoint, in size: CGSize) -> CGPoint {
    CGPoint(x: (screen.x - size.width / 2 - x) / k, y: (screen.y - size.height / 2 - y) / k)
  }
}
