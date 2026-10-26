import Foundation
import UIKit

/**
 * What a pairing QR code from Wisp → Settings → Mobile carries:
 * `wisp://pair?v=1&id=…&s=…&u=http://wisp.local:4747&u=…`, the pairing, its one-time secret,
 * and the addresses this phone might reach the computer at, best first.
 */
struct PairLink: Equatable {
  var id: String
  var secret: String
  var addresses: [URL]

  init?(_ text: String) {
    guard let c = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
          ["wisp", "warren"].contains(c.scheme ?? ""), c.host == "pair" else { return nil }
    let items = c.queryItems ?? []
    guard let id = items.first(where: { $0.name == "id" })?.value,
          let secret = items.first(where: { $0.name == "s" })?.value else { return nil }
    let addresses = items.filter { $0.name == "u" }.compactMap { $0.value.flatMap(API.normalize) }
    guard !addresses.isEmpty else { return nil }
    self.id = id
    self.secret = secret
    self.addresses = addresses
  }
}

/** The phone's half of pairing: find the computer, claim the pairing, wait for the person to confirm. */
enum Pairing {
  struct Claimed: Decodable {
    var code: String
    var userName: String?
    var workspaceName: String?
  }

  struct Failure: LocalizedError {
    var message: String
    var errorDescription: String? { message }
  }

  /** The first of the QR code's addresses (in its order) that answers as a Wisp hub. */
  static func reachable(_ addresses: [URL]) async -> URL? {
    let answered = await withTaskGroup(of: (Int, Bool).self) { group in
      for (i, url) in addresses.enumerated() {
        group.addTask {
          var req = URLRequest(url: url.appending(path: "/api/setup"), timeoutInterval: 5)
          req.httpMethod = "GET"
          guard let (_, resp) = try? await URLSession.shared.data(for: req) else { return (i, false) }
          return (i, (resp as? HTTPURLResponse)?.statusCode == 200)
        }
      }
      var ok: [Int] = []
      for await (i, up) in group where up { ok.append(i) }
      return ok
    }
    return answered.min().map { addresses[$0] }
  }

  static func claim(_ link: PairLink, at hub: URL) async throws -> Claimed {
    struct Body: Encodable { var secret: String; var deviceName: String; var platform = "ios" }
    let name = await MainActor.run { UIDevice.current.name }
    return try await API(base: hub).post("/api/pair/\(link.id)/claim", Body(secret: link.secret, deviceName: name))
  }

  /** Asks every second and a half until the person confirms on the computer, cancels, or time runs out. */
  static func waitForConfirm(_ link: PairLink, at hub: URL) async throws -> String {
    struct Body: Encodable { var secret: String }
    struct Status: Decodable { var state: String; var token: String? }
    let api = API(base: hub)
    while !Task.isCancelled {
      let s: Status = try await api.post("/api/pair/\(link.id)/status", Body(secret: link.secret))
      switch s.state {
      case "approved":
        if let token = s.token { return token }
      case "rejected":
        throw Failure(message: "Pairing was cancelled on your computer.")
      case "expired":
        throw Failure(message: "The code expired. Show a new one on your computer and scan again.")
      default:
        break
      }
      try await Task.sleep(for: .milliseconds(1500))
    }
    throw CancellationError()
  }
}
