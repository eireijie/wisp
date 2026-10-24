import XCTest
import SwiftUI
import Synchronization
@testable import Wisp

@MainActor
final class GhostTests: XCTestCase {
  private func agent(_ status: Agent.Status = .online) -> Agent {
    Agent(id: "agent-1", handle: "warren", name: "Warren", harness: "codex", computerId: "computer-1", status: status)
  }

  func testDefaultsMatchCoreIncludingUTF16Seeds() throws {
    let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "appearance-fixtures", withExtension: "json"))
    let expected = try JSONDecoder().decode([String: GhostLook].self, from: Data(contentsOf: url))
    for (seed, look) in expected { XCTAssertEqual(GhostLook.defaultAppearance(seed), look, seed) }
  }

  func testLegacyLookDecodesAndSavesAllAppearanceOptions() throws {
    let legacy = try JSONDecoder().decode(GhostLook.self, from: Data(##"{"color":"#2e2a4f"}"##.utf8))
    let look = legacy.resolved
    XCTAssertEqual(look.shape, "classic")
    XCTAssertEqual(look.motion, "float")
    XCTAssertEqual(look.hat, "none")
    XCTAssertNil(look.color2, "Keep the web's HSL shade for legacy single-color looks")
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(look)) as? [String: Any])
    XCTAssertEqual(Set(json.keys), Set(["color", "shape", "eyes", "mouth", "cheeks", "glow", "hat", "accessory", "motion"]))
    for palette in GhostLook.palettes {
      var look = GhostLook.defaultAppearance(palette.name)
      look.color = palette.top
      look.color2 = palette.bottom
      XCTAssertEqual(try JSONDecoder().decode(GhostLook.self, from: JSONEncoder().encode(look)), look)
    }
  }

  func testMoodPrecedenceAndCompletionExpiry() async throws {
    let store = Store(loadSession: false)
    var a = agent(.busy)
    store.agents = [a]
    XCTAssertEqual(store.mood(for: a), .working)
    a.status = .online
    store.agents = [a]
    XCTAssertEqual(store.mood(for: a), .done)
    store.computers = [Computer(id: "computer-1", name: "Mac", kind: "device", status: "error", statusText: "Error")]
    XCTAssertEqual(store.mood(for: a), .error)
    store.approvals = [Approval(id: "approval-1", agentId: a.id, channelId: "channel-1", summary: "OK?", details: "", status: "pending", note: "", createdAt: "")]
    XCTAssertEqual(store.mood(for: a), .waiting)
    store.computers[0].paused = true
    XCTAssertEqual(store.mood(for: a), .asleep)
    store.computers[0].paused = false
    store.computers[0].status = "offline"
    XCTAssertEqual(store.mood(for: a), .asleep)
    store.computers = []
    a.status = .offline
    XCTAssertEqual(store.mood(for: a), .asleep)
    store.approvals = []
    a.status = .online
    try await Task.sleep(for: .seconds(4.2))
    XCTAssertEqual(store.mood(for: a), .awake)
    XCTAssertEqual(store.mood(for: nil), .awake)
  }

  func testNewWorkCancelsCompletionAndRefreshDoesNotRestartIt() {
    let store = Store(loadSession: false)
    store.agents = [agent(.busy)]
    store.agents = [agent()]
    XCTAssertEqual(store.mood(for: store.agents[0]), .done)
    store.agents = [agent(.busy)]
    XCTAssertEqual(store.mood(for: store.agents[0]), .working)
    store.agents = [agent(.offline)]
    store.agents = [agent()]
    XCTAssertEqual(store.mood(for: store.agents[0]), .awake)
  }

  func testEveryPathAndBodyMorphIsFinite() {
    for path in GhostArt.paths.values {
      XCTAssertFalse(path.isEmpty)
      XCTAssertTrue(path.boundingRect.width.isFinite)
    }
    for g in GhostGeometry.shapes.values {
      XCTAssertEqual(g.a.commands.map(\.letter), g.b.commands.map(\.letter))
      XCTAssertEqual(g.a.commands.map { $0.values.count }, g.b.commands.map { $0.values.count })
      for fraction in [0.0, 0.25, 0.5, 0.75, 1] {
        let box = g.a.path(toward: g.b, fraction: fraction).boundingRect
        XCTAssertTrue(box.width > 0 && box.width < 121)
        XCTAssertEqual(box.minY, g.top, accuracy: 0.001)
      }
    }
  }

  func testRenderEveryMoodAndOutfit() throws {
    let groups: [(String, [GhostLook])] = [
      ("Shapes", GhostLook.shapes.map { var l = GhostLook.defaultAppearance("warren"); l.shape = $0; l.hat = "none"; l.accessory = "none"; return l }),
      ("Hats", GhostLook.hats.map { var l = GhostLook.defaultAppearance("warren"); l.hat = $0; return l }),
      ("Accessories", GhostLook.accessories.map { var l = GhostLook.defaultAppearance("warren"); l.hat = "none"; l.accessory = $0; return l }),
      ("Eyes", GhostLook.eyeStyles.map { var l = GhostLook.defaultAppearance("warren"); l.eyes = $0; return l }),
      ("Mouths", GhostLook.mouths.map { var l = GhostLook.defaultAppearance("warren"); l.mouth = $0; return l }),
    ]
    let gallery = VStack(spacing: 10) {
      HStack {
        ForEach(GhostMood.allCases, id: \.self) { mood in
          VStack {
            self.sample(GhostLook.defaultAppearance("warren"), mood: mood)
            Text(mood.rawValue).font(.caption)
          }
        }
      }
      ForEach(groups.indices, id: \.self) { i in
        Text(groups[i].0).font(.headline)
        HStack(spacing: 0) {
          ForEach(groups[i].1.indices, id: \.self) { j in
            self.sample(groups[i].1[j], mood: .awake)
          }
        }
      }
    }.padding(20).background(.white).foregroundStyle(.black)
    let renderer = ImageRenderer(content: gallery)
    renderer.scale = 2
    let image = try XCTUnwrap(renderer.uiImage)
    let attachment = XCTAttachment(image: image)
    attachment.name = "Ghost moods and wardrobe"
    attachment.lifetime = .keepAlways
    add(attachment)
    XCTAssertGreaterThan(image.size.width, 500)
  }

  func testSavePatchesOnlyAppearanceAndKeepsServerSettings() async throws {
    let store = Store(loadSession: false)
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [GhostHTTPStub.self]
    let session = URLSession(configuration: config)
    defer { session.invalidateAndCancel() }
    store.api = API(base: URL(string: "https://ghost.test")!, token: nil, session: session)
    var a = agent()
    a.settings = Agent.Settings(description: "Keep this description")
    store.agents = [a]
    let look = GhostLook.defaultAppearance("alice")
    var saved = a
    saved.settings?.appearance = look
    GhostHTTPStub.response.withLock { $0 = (200, try! JSONEncoder().encode(saved)) }
    GhostHTTPStub.requests.withLock { $0 = [] }
    try await store.saveLook(look, for: a)
    XCTAssertEqual(store.agents[0], saved)
    let request = try XCTUnwrap(GhostHTTPStub.requests.withLock { $0.last })
    XCTAssertEqual(request.httpMethod, "PATCH")
    XCTAssertEqual(request.url?.path, "/api/agents/agent-1")
    let data = try XCTUnwrap(request.httpBody)
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(Set(json.keys), ["settings"])
    let settings = try XCTUnwrap(json["settings"] as? [String: Any])
    XCTAssertEqual(Set(settings.keys), ["appearance"])
    let appearance = try JSONSerialization.data(withJSONObject: settings["appearance"]!)
    XCTAssertEqual(try JSONDecoder().decode(GhostLook.self, from: appearance), look)

    GhostHTTPStub.response.withLock { $0 = (403, Data(#"{"error":"Only the owner can change it"}"#.utf8)) }
    do {
      try await store.saveLook(GhostLook.defaultAppearance("other"), for: a)
      XCTFail("A rejected save must report the server error")
    } catch { XCTAssertTrue(error.localizedDescription.contains("owner")) }
    XCTAssertEqual(store.agents[0], saved, "A rejected save must not change the displayed look")
  }

  func testReducedMotionIsStillAcrossTimeAndSmallSizesRender() throws {
    func render(time: Double, animated: Bool) throws -> Data {
      let view = HStack {
        ForEach(GhostMood.allCases, id: \.self) { mood in
          Canvas { context, _ in
            var look = GhostLook.defaultAppearance("warren").resolved
            look.glow = true
            GhostRenderer(look: look, mood: mood, size: 50, time: time, animated: animated,
              poke: nil, pokeCount: 0, darkMode: true).draw(context)
          }.frame(width: 50, height: 60)
        }
      }.background(.black)
      return try XCTUnwrap(ImageRenderer(content: view).uiImage?.pngData())
    }
    XCTAssertEqual(try render(time: 0, animated: false), try render(time: 1.6, animated: false))
    XCTAssertNotEqual(try render(time: 0, animated: true), try render(time: 1.6, animated: true))
    for size in [16.0, 24, 26, 28, 44] {
      let view = Canvas { context, _ in
        GhostRenderer(look: GhostLook.defaultAppearance("agt_1").resolved, mood: .working,
          size: size, time: 1, animated: true, poke: nil, pokeCount: 0, darkMode: false).draw(context)
      }.frame(width: size, height: size)
      XCTAssertNotNil(ImageRenderer(content: view).uiImage)
    }
  }

  func testThirtySixLiveGhostsKeepAnimating() async throws {
    try XCTSkipIf(UIAccessibility.isReduceMotionEnabled, "This live-animation check requires Reduce Motion to be off")
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let previous = scene.windows.first { $0.isKeyWindow }
    let window = UIWindow(windowScene: scene)
    let grid = LazyVGrid(columns: Array(repeating: GridItem(.fixed(76)), count: 4), spacing: 8) {
      ForEach(0..<36) { i in
        GhostView(look: nil, seed: "agent-\(i)", size: 68, mood: GhostMood.allCases[i % GhostMood.allCases.count])
      }
    }.environment(\.scenePhase, .active)
      .frame(maxWidth: .infinity, maxHeight: .infinity).background(.white)
    window.rootViewController = UIHostingController(rootView: grid)
    window.makeKeyAndVisible()
    defer { window.isHidden = true; previous?.makeKey() }
    try await Task.sleep(for: .seconds(0.5))
    func snapshot() -> UIImage {
      UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
        window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
      }
    }
    let first = snapshot()
    let probe = GhostFrameProbe()
    let link = CADisplayLink(target: probe, selector: #selector(GhostFrameProbe.tick(_:)))
    link.add(to: .main, forMode: .common)
    try await Task.sleep(for: .seconds(1.2))
    link.invalidate()
    let second = snapshot()
    XCTAssertNotEqual(first.pngData(), second.pngData(), "The live TimelineViews must update, not just the static renderer")
    let attachment = XCTAttachment(image: second)
    attachment.name = "36 live ghosts"
    attachment.lifetime = .keepAlways
    add(attachment)
    let report = XCTAttachment(string: "36 ghosts: \(probe.frames) display callbacks over 1.2 seconds; longest gap \(probe.longestGap) seconds")
    report.name = "Live animation timing"
    report.lifetime = .keepAlways
    add(report)
  }

  private func sample(_ look: GhostLook, mood: GhostMood) -> some View {
    Canvas { context, _ in
      GhostRenderer(look: look.resolved, mood: mood, size: 90, time: 0.5, animated: true,
        poke: nil, pokeCount: 0, darkMode: false).draw(context)
    }.frame(width: 90, height: 100)
  }
}

/** A private transport for testing the exact PATCH payload without touching a hub. */
final class GhostHTTPStub: URLProtocol, @unchecked Sendable {
  static let response = Mutex((200, Data()))
  static let requests = Mutex<[URLRequest]>([])

  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "ghost.test" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    var captured = request
    if captured.httpBody == nil, let stream = request.httpBodyStream {
      stream.open()
      defer { stream.close() }
      var body = Data(), buffer = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count <= 0 { break }
        body.append(contentsOf: buffer.prefix(count))
      }
      captured.httpBody = body
    }
    Self.requests.withLock { $0.append(captured) }
    let (status, data) = Self.response.withLock { $0 }
    let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

@MainActor
private final class GhostFrameProbe: NSObject {
  var frames = 0
  var last = 0.0
  var longestGap = 0.0
  @objc func tick(_ link: CADisplayLink) {
    if last != 0 { longestGap = max(longestGap, link.timestamp - last) }
    last = link.timestamp
    frames += 1
  }
}
