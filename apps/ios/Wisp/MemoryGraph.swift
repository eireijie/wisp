import SwiftUI

extension GraphKind {
  /** The same colors as the web graph, in light and dark. */
  func color(dark: Bool) -> Color {
    let hex: UInt32
    switch self {
    case .shared: hex = dark ? 0x3CCF9F : 0x0F9D76
    case .people: hex = dark ? 0x6AA2FF : 0x2F6FE0
    case .agents: hex = dark ? 0xFF8A52 : 0xD9622B
    case .teams: hex = dark ? 0xC08CFF : 0x9B51E0
    case .groups: hex = dark ? 0xF2C14B : 0xC58A06
    case .other: hex = dark ? 0x97A6B4 : 0x6B7A88
    case .ghost: hex = dark ? 0x737373 : 0xB0B0B0
    }
    return Color(red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255)
  }
}

/** The graph drawn on a canvas: pan, pinch, tap a note. With `interactive` off it is a still thumbnail. */
struct GraphCanvas: View {
  var graph: GraphData
  var positions: [String: CGPoint]
  @Binding var camera: GraphCamera
  var selected: String?
  var interactive = true
  var onTap: (GraphNode?) -> Void = { _ in }
  var onSize: (CGSize) -> Void = { _ in }
  @Environment(\.colorScheme) private var scheme
  @State private var lastPan: CGSize = .zero
  @State private var lastMagnification: CGFloat = 1
  @State private var size: CGSize = .zero

  private var neighbours: [String: Set<String>] {
    var out: [String: Set<String>] = [:]
    for e in graph.edges { out[e.source, default: []].insert(e.target); out[e.target, default: []].insert(e.source) }
    return out
  }
  private var hubs: Set<String> {
    let count = max(6, graph.nodes.count / 8)
    return Set(graph.nodes.filter { !$0.isGhost && $0.linkCount > 1 }.sorted { $0.linkCount > $1.linkCount }.prefix(count).map(\.id))
  }

  var body: some View {
    GeometryReader { proxy in
      let near = neighbours, hubIds = hubs
      Canvas(opaque: false, rendersAsynchronously: false) { ctx, size in
        draw(&ctx, size: size, near: near, hubs: hubIds)
      }
      .contentShape(Rectangle())
      .onAppear { size = proxy.size; onSize(proxy.size) }
      .onChange(of: proxy.size) { _, new in size = new; onSize(new) }
      .modifier(GraphGestures(enabled: interactive, camera: $camera, size: size, lastPan: $lastPan, lastMagnification: $lastMagnification, onTap: tap))
    }
    .accessibilityElement()
    .accessibilityLabel("Graph of \(graph.nodes.count) notes and \(graph.edges.count) links")
    .accessibilityIdentifier("memory-graph-canvas")
  }

  private func tap(_ point: CGPoint) {
    let world = camera.toWorld(point, in: size)
    let slop = 14 / camera.k
    var best: (GraphNode, CGFloat)?
    for node in graph.nodes {
      guard let p = positions[node.id] else { continue }
      let d = hypot(p.x - world.x, p.y - world.y)
      if d < GraphLayout.radius(node) + slop, d < (best?.1 ?? .infinity) { best = (node, d) }
    }
    onTap(best?.0)
  }

  private func draw(_ ctx: inout GraphicsContext, size: CGSize, near: [String: Set<String>], hubs: Set<String>) {
    let dark = scheme == .dark
    let k = camera.k
    ctx.translateBy(x: size.width / 2 + camera.x, y: size.height / 2 + camera.y)
    ctx.scaleBy(x: k, y: k)
    let view = CGRect(x: (-size.width / 2 - camera.x) / k, y: (-size.height / 2 - camera.y) / k, width: size.width / k, height: size.height / k).insetBy(dx: -40, dy: -40)
    let focus = selected
    let lit: Set<String>? = focus.map { near[$0, default: []].union([$0]) }
    let faint = dark ? Color.white.opacity(0.28) : Color.black.opacity(0.22)
    let accent = Color.accentColor

    // links: one path for the quiet ones, one for the lit ones
    var quiet = Path(), strong = Path()
    for e in graph.edges {
      guard let a = positions[e.source], let b = positions[e.target] else { continue }
      if !view.contains(a) && !view.contains(b) { continue }
      if let focus, e.source == focus || e.target == focus { strong.move(to: a); strong.addLine(to: b) }
      else { quiet.move(to: a); quiet.addLine(to: b) }
    }
    ctx.stroke(quiet, with: .color(lit == nil ? faint : faint.opacity(0.25)), style: StrokeStyle(lineWidth: 1 / k, lineCap: .round))
    ctx.stroke(strong, with: .color(accent.opacity(0.9)), style: StrokeStyle(lineWidth: 1.8 / k, lineCap: .round))

    for node in graph.nodes {
      guard let p = positions[node.id], view.contains(p) else { continue }
      let r = GraphLayout.radius(node)
      let color = node.graphKind.color(dark: dark)
      var layer = ctx
      layer.opacity = (lit != nil && !lit!.contains(node.id)) ? 0.18 : 1
      let rect = CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2)
      let shape: Path
      switch node.type {
      case "project": shape = Path(roundedRect: rect, cornerRadius: r * 0.3)
      case "decision":
        var d = Path(); let s = r * 1.25
        d.move(to: CGPoint(x: p.x, y: p.y - s)); d.addLine(to: CGPoint(x: p.x + s, y: p.y)); d.addLine(to: CGPoint(x: p.x, y: p.y + s)); d.addLine(to: CGPoint(x: p.x - s, y: p.y)); d.closeSubpath()
        shape = d
      default: shape = Path(ellipseIn: rect)
      }
      if node.isGhost || node.type == "reference" {
        layer.fill(shape, with: .color(dark ? .black : .white))
        layer.stroke(shape, with: .color(color), style: StrokeStyle(lineWidth: 1.5 / k, dash: node.isGhost ? [2 / k, 2 / k] : []))
      } else {
        layer.fill(shape, with: .color(color))
      }
      if node.id == focus {
        layer.stroke(Path(ellipseIn: rect.insetBy(dx: -(3.5 / k + 1), dy: -(3.5 / k + 1))), with: .color(accent), lineWidth: 1.5 / k)
      }
    }

    guard interactive else { return }
    // names: the busiest notes, whatever is lit, and everything once zoomed in
    for node in graph.nodes {
      guard let p = positions[node.id], view.contains(p) else { continue }
      let show = lit != nil ? lit!.contains(node.id) : (k > 1.5 || (hubs.contains(node.id) && k > 0.45))
      guard show else { continue }
      let title = node.title.count > 28 ? String(node.title.prefix(27)) + "…" : node.title
      let text = Text(title).font(.system(size: 11 / k, weight: .medium)).foregroundColor(node.id == focus ? .primary : .secondary)
      ctx.draw(ctx.resolve(text), at: CGPoint(x: p.x, y: p.y + GraphLayout.radius(node) + 3 / k), anchor: .top)
    }
  }
}

private struct GraphGestures: ViewModifier {
  var enabled: Bool
  @Binding var camera: GraphCamera
  var size: CGSize
  @Binding var lastPan: CGSize
  @Binding var lastMagnification: CGFloat
  var onTap: (CGPoint) -> Void

  func body(content: Content) -> some View {
    if enabled {
      content
        .gesture(
          DragGesture(minimumDistance: 6)
            .onChanged { value in
              camera.x += value.translation.width - lastPan.width
              camera.y += value.translation.height - lastPan.height
              lastPan = value.translation
            }
            .onEnded { _ in lastPan = .zero }
        )
        .simultaneousGesture(
          MagnifyGesture()
            .onChanged { value in
              let focal = CGPoint(x: value.startAnchor.x * size.width - size.width / 2, y: value.startAnchor.y * size.height - size.height / 2)
              camera = camera.zoomed(by: value.magnification / lastMagnification, around: focal)
              lastMagnification = value.magnification
            }
            .onEnded { _ in lastMagnification = 1 }
        )
        .simultaneousGesture(SpatialTapGesture().onEnded { onTap($0.location) })
    } else {
      content.allowsHitTesting(false)
    }
  }
}

/** The whole memory as a map: every note you can read, and the links between them. */
struct MemoryGraphScreen: View {
  @Environment(Store.self) private var store
  var browse: MemoryBrowse
  var initialKind: GraphKind?
  /** a note (its path) to select and center on when the graph opens */
  var focus: String? = nil
  @State private var focused = false
  @State private var hidden: Set<GraphKind> = []
  @State private var tag = ""
  @State private var query = ""
  @State private var picked: GraphNode?
  @State private var camera = GraphCamera()
  @State private var size: CGSize = .zero
  @State private var started = false
  @State private var writing: String?
  @State private var opened: MemoryNote?

  private var shown: GraphData { (browse.graph ?? .empty).filtered(hidden: hidden, tag: tag) }
  private var matches: [GraphNode] { shown.find(query) }
  private var types: Set<String> { Set((browse.graph?.nodes ?? []).compactMap(\.type)) }

  var body: some View {
    MemoryScreen(title: "Graph", id: "memory-graph", scrolls: false) {
      if let graph = browse.graph {
        VStack(spacing: 0) {
          MemorySearchField(prompt: "Find a note", text: $query, id: "graph-find").padding(.horizontal, 18).padding(.top, 6)
          if !query.trimmed.isEmpty {
            CardGroup {
              ForEach(matches) { node in
                Button { pick(node) } label: { RowLabel(title: node.title, chevron: false) { Image(systemName: node.isGhost ? "circle.dashed" : "doc.text").font(.system(size: 17)).foregroundStyle(Palette.muted) } }.buttonStyle(.plain)
              }
              if matches.isEmpty { Text("No notes match.").foregroundStyle(Palette.muted).padding(18) }
            }.padding(.horizontal, 18).padding(.top, 8)
          }
          filters(graph)
          ZStack {
            if shown.nodes.isEmpty {
              Text(graph.nodes.isEmpty ? "No notes yet." : "Nothing matches these filters.").foregroundStyle(.secondary).padding()
            } else if browse.positions.isEmpty {
              ProgressView()
            } else {
              GraphCanvas(graph: shown, positions: browse.positions, camera: $camera, selected: picked?.id, onTap: { node in picked = node }, onSize: { size = $0; if !started { started = true; fit() } })
            }
            if !graph.nodes.isEmpty && graph.edges.isEmpty {
              VStack { Text("Nothing is linked yet. Write [[Note name]] in a note to link it to another one.").font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(12).glass(16); Spacer() }.padding()
            }
            overlay
          }
        }
      } else if browse.loading {
        ProgressView()
      } else {
        ContentUnavailableView("The graph isn't available", systemImage: "point.3.connected.trianglepath.dotted", description: Text(browse.error ?? "Try again in a moment."))
      }
    }
    .task { if browse.graph == nil { await browse.reload(store) } }
    .onChange(of: browse.positions.count) { _, count in
      if count > 0, let focus, !focused, let node = browse.graph?.nodes.first(where: { $0.id == focus }) { focused = true; picked = node; if let p = browse.positions[node.id] { camera = camera.centered(on: p) } }
    }
    .onAppear { if let initialKind, !started, hidden.isEmpty { hidden = Set(GraphKind.allCases.filter { $0 != initialKind }) } }
    .onChange(of: hidden) { _, _ in picked = nil; fit() }
    .onChange(of: tag) { _, _ in picked = nil; fit() }
    .onChange(of: browse.positions.count) { _, _ in fit() }
    .navigationDestination(item: $opened) { NoteView(path: $0.path) }
    .sheet(item: Binding(get: { writing.map { NamedNote(title: $0) } }, set: { writing = $0?.title })) { item in
      NewNoteSheet(folder: writeFolder(for: item.title), name: item.title) { opened = MemoryNote(path: $0) }
    }
  }

  private struct NamedNote: Identifiable { var title: String; var id: String { title } }

  private func writeFolder(for title: String) -> String {
    let from = browse.graph?.edges.first { $0.target == "ghost:\(title)" }?.source
    return from.map { ($0 as NSString).deletingLastPathComponent } ?? "people/\(store.me?.id ?? "")"
  }

  private func filters(_ graph: GraphData) -> some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(GraphKind.allCases.filter { graph.count(of: $0) > 0 }, id: \.self) { kind in
          let on = !hidden.contains(kind)
          Button {
            if on { hidden.insert(kind) } else { hidden.remove(kind) }
          } label: {
            HStack(spacing: 6) {
              Circle().fill(on ? kind.color(dark: scheme == .dark) : Color.secondary.opacity(0.4)).frame(width: 8, height: 8)
              Text(kind.label).strikethrough(!on)
              Text("\(graph.count(of: kind))").foregroundStyle(.secondary)
            }
            .font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text).padding(.horizontal, 14).frame(height: 40)
            .background(Capsule().fill(Palette.control)).overlay(Capsule().strokeBorder(Palette.hairline))
            .opacity(on ? 1 : 0.6)
          }
          .buttonStyle(.plain).accessibilityAddTraits(on ? .isSelected : [])
        }
        if !graph.tagCounts.isEmpty {
          Menu {
            Picker("Tag", selection: $tag) {
              Text("All tags").tag("")
              ForEach(graph.tagCounts, id: \.0) { Text("#\($0.0) (\($0.1))").tag($0.0) }
            }
          } label: {
            Label(tag.isEmpty ? "All tags" : "#\(tag)", systemImage: "number").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text).padding(.horizontal, 14).frame(height: 40).background(Capsule().fill(Palette.control)).overlay(Capsule().strokeBorder(Palette.hairline))
          }
        }
      }.padding(.horizontal, 16).padding(.vertical, 8)
    }
  }
  @Environment(\.colorScheme) private var scheme

  private var overlay: some View {
    VStack {
      Spacer()
      HStack(alignment: .bottom) {
        VStack(alignment: .leading, spacing: 8) {
          if let picked { pickedCard(picked) }
          else if types.contains(where: ["project", "decision", "reference"].contains) { legend }
        }
        Spacer(minLength: 12)
        VStack(spacing: 0) {
          zoomButton("plus", "Zoom in") { camera = camera.zoomed(by: 1.4) }
          Divider().frame(width: 28)
          zoomButton("minus", "Zoom out") { camera = camera.zoomed(by: 1 / 1.4) }
          Divider().frame(width: 28)
          zoomButton("arrow.up.left.and.arrow.down.right", "Show everything") { fit() }
        }.glass(14)
      }.padding(12)
    }
  }
  private func zoomButton(_ symbol: String, _ label: String, _ action: @escaping () -> Void) -> some View {
    Button(action: action) { Image(systemName: symbol).font(.system(size: 15, weight: .semibold)).frame(width: 44, height: 40) }
      .buttonStyle(.plain).accessibilityLabel(label)
  }
  private var legend: some View {
    VStack(alignment: .leading, spacing: 4) {
      if types.contains("project") { legendRow("square.fill", "Project") }
      if types.contains("decision") { legendRow("diamond.fill", "Decision") }
      if types.contains("reference") { legendRow("circle", "Reference") }
    }.font(.caption).foregroundStyle(.secondary).padding(10).glass(12)
  }
  private func legendRow(_ symbol: String, _ text: String) -> some View { HStack(spacing: 6) { Image(systemName: symbol).font(.system(size: 9)); Text(text) } }

  private func pickedCard(_ node: GraphNode) -> some View {
    let linked = Set((browse.graph?.edges ?? []).flatMap { e in e.source == node.id ? [e.target] : e.target == node.id ? [e.source] : [] }).count
    return VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .top, spacing: 8) {
        Circle().fill(node.graphKind.color(dark: scheme == .dark)).frame(width: 10, height: 10).padding(.top, 5)
        VStack(alignment: .leading, spacing: 2) {
          Text(node.title).font(.headline).lineLimit(2)
          Text((node.path.map { store.placeName($0) } ?? "\(GraphKind.ghost.label): other notes link to it") + (node.type.map { " · \($0)" } ?? "")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        Spacer(minLength: 0)
        Button { picked = nil } label: { Image(systemName: "xmark").font(.footnote.weight(.semibold)) }.buttonStyle(.plain).foregroundStyle(.secondary).accessibilityLabel("Close")
      }
      HStack {
        Label("Linked with \(linked) \(linked == 1 ? "note" : "notes")", systemImage: "point.3.connected.trianglepath.dotted").font(.caption).foregroundStyle(.secondary)
        Spacer()
        if let path = node.path { Button("Open note") { opened = MemoryNote(path: path) }.secondaryButton().accessibilityIdentifier("graph-open-note") }
        else if browse.viewAs == nil && store.canManage { Button("Write note from here") { writing = node.title }.secondaryButton() }
      }
    }
    .padding(12).frame(maxWidth: 320, alignment: .leading).glass(18)
  }

  private func pick(_ node: GraphNode) {
    picked = node; query = ""
    if let p = browse.positions[node.id] { camera = camera.centered(on: p) }
  }
  private func fit() {
    let points = shown.nodes.compactMap { browse.positions[$0.id] }
    camera = GraphCamera.fit(points, in: size)
  }
}
