import XCTest
@testable import Wisp

@MainActor
final class MemoryParityTests: XCTestCase {
  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T { try Wire.decoder.decode(type, from: Data(json.utf8)) }
  private let graphJSON = ##"{"nodes":[{"id":"shared/Roadmap.md","path":"shared/Roadmap.md","title":"Roadmap","kind":"shared","type":"project","tags":["planning"],"updatedAt":1,"links":3,"inbound":2},{"id":"shared/Plan.md","path":"shared/Plan.md","title":"Plan","kind":"shared","type":null,"tags":[],"updatedAt":1,"links":1,"inbound":1},{"id":"people/u1/Me.md","path":"people/u1/Me.md","title":"Me","kind":"people","type":null,"tags":["planning"],"updatedAt":1,"links":0,"inbound":0},{"id":"ghost:Nowhere","path":null,"title":"Nowhere","kind":"ghost","type":null,"tags":[],"updatedAt":null,"links":0,"inbound":1}],"edges":[{"source":"shared/Roadmap.md","target":"shared/Plan.md"},{"source":"shared/Plan.md","target":"shared/Roadmap.md"},{"source":"shared/Roadmap.md","target":"ghost:Nowhere"}]}"##

  func testGraphDecodesAndFilters() throws {
    let graph = try decode(GraphData.self, graphJSON)
    XCTAssertEqual(graph.nodes.count, 4)
    XCTAssertEqual(graph.nodes[0].graphKind, .shared)
    XCTAssertTrue(graph.nodes[3].isGhost)
    XCTAssertEqual(graph.count(of: .shared), 2)
    let noGhosts = graph.filtered(hidden: [.ghost], tag: "")
    XCTAssertEqual(noGhosts.nodes.count, 3)
    XCTAssertEqual(noGhosts.edges.count, 2)
    let tagged = graph.filtered(hidden: [], tag: "planning")
    XCTAssertEqual(Set(tagged.nodes.map(\.title)), ["Roadmap", "Me"])
    XCTAssertTrue(tagged.edges.isEmpty)
    XCTAssertEqual(graph.tagCounts.first?.0, "planning")
    XCTAssertEqual(graph.mostLinked().first?.title, "Roadmap")
    XCTAssertEqual(graph.find("pla").first?.title, "Plan")
    XCTAssertEqual(graph.neighbourhood(of: "shared/Plan.md").nodes.count, 2)
    XCTAssertEqual(graph.neighbourhood(of: "people/u1/Me.md").nodes.count, 1)
  }

  func testUnknownKindFallsBackToOther() throws {
    let node = try decode(GraphNode.self, ##"{"id":"x","path":"x.md","title":"X","kind":"strange"}"##)
    XCTAssertEqual(node.graphKind, .other)
    XCTAssertEqual(node.tagList, [])
  }

  func testLayoutIsDeterministicAndSpreadsNotes() throws {
    let graph = try decode(GraphData.self, graphJSON)
    let a = GraphLayout.positions(for: graph), b = GraphLayout.positions(for: graph)
    XCTAssertEqual(a.count, 4)
    XCTAssertEqual(a["shared/Plan.md"], b["shared/Plan.md"])
    let pts = Array(a.values)
    for i in 0..<pts.count { for j in (i + 1)..<pts.count { XCTAssertGreaterThan(hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y), 5) } }
    XCTAssertTrue(pts.allSatisfy { $0.x.isFinite && $0.y.isFinite })
    XCTAssertTrue(GraphLayout.positions(for: .empty).isEmpty)
  }

  func testLayoutHandlesAThousandNotesQuickly() {
    let nodes = (0..<1000).map { GraphNode(id: "n\($0)", path: "n\($0).md", title: "N\($0)", kind: "shared", links: 2) }
    let edges = (0..<1000).map { GraphEdge(source: "n\($0)", target: "n\(($0 * 7 + 1) % 1000)") }
    let start = Date()
    let out = GraphLayout.positions(for: GraphData(nodes: nodes, edges: edges))
    XCTAssertEqual(out.count, 1000)
    XCTAssertLessThan(Date().timeIntervalSince(start), 5)
  }

  func testCameraFitZoomAndCenter() {
    let size = CGSize(width: 400, height: 800)
    let cam = GraphCamera.fit([CGPoint(x: -100, y: -50), CGPoint(x: 100, y: 50)], in: size)
    XCTAssertEqual(cam.k, 328.0 / 200, accuracy: 0.001)
    XCTAssertEqual(cam.x, 0, accuracy: 0.001)
    XCTAssertEqual(GraphCamera().zoomed(by: 100).k, 5)
    XCTAssertEqual(GraphCamera().zoomed(by: 0.0001).k, 0.15)
    // zooming around a point keeps that point still
    let focal = CGPoint(x: 50, y: 20)
    let before = GraphCamera(x: 10, y: -5, k: 1)
    let after = before.zoomed(by: 2, around: focal)
    let worldBefore = CGPoint(x: (focal.x - before.x) / before.k, y: (focal.y - before.y) / before.k)
    let worldAfter = CGPoint(x: (focal.x - after.x) / after.k, y: (focal.y - after.y) / after.k)
    XCTAssertEqual(worldBefore.x, worldAfter.x, accuracy: 0.001)
    XCTAssertEqual(worldBefore.y, worldAfter.y, accuracy: 0.001)
    let centered = GraphCamera().centered(on: CGPoint(x: 10, y: 20))
    XCTAssertEqual(centered.x, -10 * centered.k, accuracy: 0.001)
    XCTAssertEqual(GraphCamera.fit([], in: size), GraphCamera())
    let world = GraphCamera(x: 0, y: 0, k: 2).toWorld(CGPoint(x: 250, y: 420), in: size)
    XCTAssertEqual(world.x, 25, accuracy: 0.001); XCTAssertEqual(world.y, 10, accuracy: 0.001)
  }

  func testChangesDecodeAndHideUnreadableFiles() throws {
    let json = ##"[{"hash":"a1","author":"@atlas","date":"2026-10-24T10:00:00Z","message":"Update plan","files":[{"path":"shared/Plan.md","change":"modified"},{"path":"secret/x.md","change":"added"},{"path":"shared/Old.md","change":"deleted"},{"path":"shared/New.md","change":"renamed","from":"shared/Was.md"}]}]"##
    let changes = try decode([MemoryChange].self, json)
    XCTAssertEqual(changes[0].files.count, 4)
    let seen = changes[0].keeping(visible: ["shared/Plan.md", "shared/New.md"])
    XCTAssertEqual(seen.files.map(\.path), ["shared/Plan.md", "shared/Old.md", "shared/New.md"])
    XCTAssertEqual(changes[0].keeping(visible: nil).files.count, 4)
    XCTAssertEqual(MemoryChange.verb("modified"), "edited")
    XCTAssertEqual(MemoryChange.verb("renamed"), "moved")
    XCTAssertEqual(noteTitle("shared/Plan.md"), "Plan")
  }

  func testBlameDropsFrontmatter() throws {
    let json = ##"[{"hash":"h1","author":"Sam","date":"2026-10-24T10:00:00Z","lines":["---","type: project","---"]},{"hash":"h2","author":"@atlas","date":"2026-10-24T11:00:00Z","lines":["# Plan","","Ship it"]}]"##
    let blocks = BlameBlock.withoutFrontmatter(try decode([BlameBlock].self, json))
    XCTAssertEqual(blocks.map(\.author), ["@atlas"])
    let plain = try decode([BlameBlock].self, ##"[{"hash":"h","author":"Sam","date":"2026-10-24T10:00:00Z","lines":["Hello"]}]"##)
    XCTAssertEqual(BlameBlock.withoutFrontmatter(plain).count, 1)
  }

  func testFrontmatterOnANote() throws {
    let json = ##"{"path":"shared/Roadmap.md","title":"Roadmap","content":"x","frontmatter":{"title":"Roadmap","type":"project","tags":["a","b"],"owner":"[[Sam|Sam P]]","empty":"","n":3}}"##
    let note = try decode(MemoryNote.self, json)
    let keys = note.properties.map(\.0)
    XCTAssertEqual(keys, ["n", "owner", "tags", "type"])
    XCTAssertEqual(note.properties.first { $0.0 == "tags" }?.1.items, ["a", "b"])
    XCTAssertEqual(note.properties.first { $0.0 == "n" }?.1.items, ["3"])
    XCTAssertEqual(wikiLinkParts("[[Sam|Sam P]]")?.target, "Sam")
    XCTAssertEqual(wikiLinkParts("[[Sam|Sam P]]")?.label, "Sam P")
    XCTAssertEqual(wikiLinkParts("[[Plan#Goals]]")?.target, "Plan")
    XCTAssertNil(wikiLinkParts("plain"))
    let bare = try decode(MemoryNote.self, ##"{"path":"a.md","title":"A"}"##)
    XCTAssertTrue(bare.properties.isEmpty)
  }

  func testNewNoteLocations() {
    let choices = NoteLocation.choices(meId: "u1", agents: [("a1", "Atlas")])
    XCTAssertEqual(choices.map(\.label), ["My notes", "Shared with everyone", "Atlas's notes"])
    XCTAssertEqual(choices.map(\.folder), ["people/u1", "shared", "agents/a1"])
    XCTAssertEqual(NoteLocation.path(folder: "shared", name: " Meeting notes "), "shared/Meeting notes.md")
    XCTAssertEqual(NoteLocation.path(folder: "/ideas/", name: "x.MD"), "ideas/x.md")
    XCTAssertEqual(NoteLocation.path(folder: "", name: "Top"), "Top.md")
    XCTAssertNil(NoteLocation.path(folder: "shared", name: "  "))
  }

  func testJournalGroupsByDayNewestFirst() throws {
    func item(_ text: String, _ date: String?) throws -> MemoryItem {
      try decode(MemoryItem.self, "{\"path\":\"p/\(text).md\",\"kind\":\"did\",\"text\":\"\(text)\"\(date.map { ",\"date\":\"\($0)\"" } ?? "")}")
    }
    let days = JournalDays.days([try item("a", "2026-10-22"), try item("b", nil), try item("c", "2026-10-24"), try item("d", "2026-10-24")])
    XCTAssertEqual(days.map(\.day), ["2026-10-24", "2026-10-22", ""])
    XCTAssertEqual(days[0].entries.map(\.text), ["c", "d"])
    XCTAssertEqual(JournalDays.title(""), "Undated")
    XCTAssertFalse(JournalDays.title("2026-10-24").isEmpty)
  }
}
