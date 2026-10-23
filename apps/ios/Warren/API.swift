import Foundation
import Security

/** The hub's HTTP API, with the session token Warren issues at sign-in (a Bearer token). */
struct API {
  var base: URL
  var token: String?
  var session: URLSession = .shared
  var timeout: TimeInterval = 30
  var authenticationExpired: (@MainActor @Sendable () -> Void)?

  /** A longer allowance for a single slow hub operation. */
  func withTimeout(_ seconds: TimeInterval) -> API {
    var api = self; api.timeout = seconds
    return api
  }

  struct AuthenticationExpired: LocalizedError {
    var errorDescription: String? { "Signed out: sign in again" }
  }

  struct Failure: LocalizedError, CustomStringConvertible {
    var status: Int
    var message: String
    var diagnostic: String? = nil
    var errorDescription: String? { message }
    var description: String { diagnostic.map { "\(message) \($0)" } ?? message }
  }

  func get<T: Decodable>(_ path: String, _ query: [String: String] = [:]) async throws -> T {
    try await send("GET", path, query: query, body: Optional<[String: String]>.none)
  }

  func post<T: Decodable, B: Encodable>(_ path: String, _ body: B) async throws -> T {
    try await send("POST", path, body: body)
  }

  @discardableResult
  func post<B: Encodable>(_ path: String, _ body: B) async throws -> Data {
    try await raw("POST", path, body: body)
  }

  func patch<T: Decodable, B: Encodable>(_ path: String, _ body: B) async throws -> T {
    try await send("PATCH", path, body: body)
  }

  @discardableResult
  func put<B: Encodable>(_ path: String, _ body: B) async throws -> Data {
    try await raw("PUT", path, body: body)
  }

  @discardableResult
  func delete(_ path: String) async throws -> Data {
    try await raw("DELETE", path, body: Optional<Empty>.none)
  }

  func send<T: Decodable, B: Encodable>(_ method: String, _ path: String, query: [String: String] = [:], body: B?) async throws -> T {
    let data = try await raw(method, path, query: query, body: body)
    do {
      return try Wire.decoder.decode(T.self, from: data)
    } catch {
      let context: DecodingError.Context?
      var missing: String? = nil
      switch error {
      case DecodingError.keyNotFound(let key, let c): context = c; missing = key.stringValue
      case DecodingError.typeMismatch(_, let c), DecodingError.valueNotFound(_, let c), DecodingError.dataCorrupted(let c): context = c
      default: context = nil
      }
      let path = ((context?.codingPath.map(\.stringValue) ?? []) + (missing.map { [$0] } ?? [])).joined(separator: ".")
      let body = String(String(decoding: data, as: UTF8.self).prefix(200))
      throw Failure(status: 0, message: "The hub sent something this app doesn't understand. Is Warren up to date?",
        diagnostic: "Decoding at \(path.isEmpty ? "<root>" : path): \(context?.debugDescription ?? String(describing: error)). Body: \(body)")
    }
  }

  @discardableResult
  func raw<B: Encodable>(_ method: String, _ path: String, query: [String: String] = [:], body: B?) async throws -> Data {
    let (data, _) = try await request(method, path, query: query, body: body)
    return data
  }

  func request<B: Encodable>(_ method: String, _ path: String, query: [String: String] = [:], body: B?) async throws -> (Data, HTTPURLResponse) {
    var comps = URLComponents(url: base.appending(path: path), resolvingAgainstBaseURL: false)!
    if !query.isEmpty { comps.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
    var req = URLRequest(url: comps.url!, timeoutInterval: timeout)
    req.httpMethod = method
    if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    if let body {
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = try JSONEncoder().encode(body)
    }
    let data: Data, resp: URLResponse
    do {
      (data, resp) = try await session.data(for: req)
    } catch let e as URLError where e.code != .cancelled {
      throw Failure(status: 0, message: "Couldn't reach Warren at \(base.host() ?? base.absoluteString). \(e.localizedDescription)")
    }
    let http = resp as! HTTPURLResponse
    if http.statusCode == 401 {
      await authenticationExpired?()
      throw AuthenticationExpired()
    }
    guard (200..<300).contains(http.statusCode) else {
      let msg = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
      throw Failure(status: http.statusCode, message: msg ?? "Warren said \(http.statusCode)")
    }
    return (data, http)
  }

  /** Turn what a person typed ("warren.example.com", "100.90.1.2:4747") into the hub's address. */
  static func normalize(_ text: String) -> URL? {
    var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.isEmpty { return nil }
    if !s.contains("://") {
      // a name with a certificate gets https; an address on your own network (an IP, localhost,
      // a .local name or an explicit port like :4747) is usually plain http
      let host = s.split(separator: "/").first.map(String.init) ?? s
      let local = host.hasPrefix("localhost") || host.first?.isNumber == true || host.contains(".local") || host.contains(":")
      s = (local ? "http://" : "https://") + s
    }
    guard var c = URLComponents(string: s), c.host?.isEmpty == false else { return nil }
    c.path = ""
    c.query = nil
    c.fragment = nil
    return c.url
  }
}

struct Empty: Codable {}

/** The session token lives in the Keychain, the hub's address in UserDefaults. */
enum Session {
  private static let service = "ai.warren.session"
  private static let hubKey = "warren.hub"

  static var hub: URL? {
    get { UserDefaults.standard.string(forKey: hubKey).flatMap(URL.init(string:)) }
    set { UserDefaults.standard.set(newValue?.absoluteString, forKey: hubKey) }
  }

  static var token: String? {
    get {
      let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecReturnData as String: true]
      var out: AnyObject?
      guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
      return String(data: d, encoding: .utf8)
    }
  }

  /** Do not adopt a session unless both Keychain operations succeeded. */
  static func saveToken(_ token: String?,
    delete: (CFDictionary) -> OSStatus = { SecItemDelete($0) },
    add: (CFDictionary) -> OSStatus = { SecItemAdd($0, nil) }
  ) throws {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
    let removed = delete(q as CFDictionary)
    guard removed == errSecSuccess || removed == errSecItemNotFound else { throw PersistenceFailure(status: removed) }
    guard let token else { return }
    var item = q
    item[kSecValueData as String] = Data(token.utf8)
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    let saved = add(item as CFDictionary)
    guard saved == errSecSuccess else { throw PersistenceFailure(status: saved) }
  }

  struct PersistenceFailure: LocalizedError {
    var status: OSStatus
    var errorDescription: String? { "Couldn't save your sign-in on this iPhone. Try pairing again. (\(status))" }
  }
}
