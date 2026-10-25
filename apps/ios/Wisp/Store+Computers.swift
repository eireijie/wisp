import Foundation
import UIKit

/** Adding, renaming, starting, removing and teaching computers, and moving files to and from them. */
extension Store {
  private func put(_ c: Computer) {
    if let i = computers.firstIndex(where: { $0.id == c.id }) { computers[i] = c } else { computers.append(c) }
  }

  // MARK: add, rename, start, stop, remove

  func computerSettings() async throws -> ComputerSettings {
    try await fetch { try await $0.get("/api/settings/computers") }
  }

  func addComputer(_ request: NewComputer) async throws -> Computer {
    let c: Computer = try await fetch { try await $0.post("/api/computers", request) }
    put(c)
    return c
  }

  func renameComputer(_ c: Computer, to name: String) async throws {
    let updated: Computer = try await fetch { try await $0.patch("/api/computers/\(c.id)", ["name": name]) }
    put(updated)
  }

  /** Start or stop a VM or cloud computer. */
  func setComputerRunning(_ c: Computer, _ running: Bool) async throws {
    let updated: Computer = try await fetch { try await $0.post("/api/computers/\(c.id)/\(running ? "start" : "stop")", Empty()) }
    put(updated)
  }

  func removeComputer(_ c: Computer) async throws {
    try await fetch { try await $0.delete("/api/computers/\(c.id)") }
    computers.removeAll { $0.id == c.id }
  }

  /** Hand a computer back; an agent that asked for help hears the note. */
  func handBack(_ c: Computer, note: String?) async throws {
    struct Body: Encodable { var take = false; var note: String? }
    let trimmed = note?.trimmingCharacters(in: .whitespacesAndNewlines)
    let updated: Computer = try await fetch { try await $0.post("/api/computers/\(c.id)/control", Body(note: trimmed?.isEmpty == false ? trimmed : nil)) }
    put(updated)
  }

  func computerLog(_ c: Computer) async throws -> [ComputerLogEntry] {
    try await fetch { try await $0.get("/api/computers/\(c.id)/log") }
  }

  // MARK: files on this phone, to share or preview

  /** A new file under a fresh folder in the temp directory, so the name stays as it was. */
  func scratchFile(named name: String, data: Data) throws -> URL {
    let safe = name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
    let dir = FileManager.default.temporaryDirectory.appending(path: "computer-files/\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let url = dir.appending(path: safe.isEmpty ? "file" : safe)
    try data.write(to: url, options: .atomic)
    return url
  }

  /** The screen right now as a picture file named like "Research desk 2026-10-25 14.05.jpg", for the share sheet. */
  func screenshotFile(_ c: Computer) async throws -> URL {
    let f = try await screen(c, maxAge: 1000)
    return try scratchFile(named: "\(c.name) \(Self.stamp(Date())).jpg", data: f.image)
  }

  static func stamp(_ date: Date) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd HH.mm"
    return f.string(from: date)
  }

  // MARK: files on the computer

  func listFiles(_ c: Computer, path: String) async throws -> RemoteFolder {
    try await fetch { try await $0.get("/api/computers/\(c.id)/files", ["path": path]) }
  }

  /** A file from the computer, saved on this phone under its own name. */
  func downloadRemoteFile(_ c: Computer, path: String) async throws -> URL {
    let data = try await fetch { try await $0.withTimeout(180).raw("GET", "/api/computers/\(c.id)/files/download", query: ["path": path], body: Optional<Empty>.none) }
    let name = path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? "file"
    return try scratchFile(named: name, data: data)
  }

  /** Send a file to a folder on the computer. Returns where it landed. */
  @discardableResult
  func uploadRemoteFile(_ c: Computer, folder: String, name: String, data: Data) async throws -> String {
    guard data.count <= ComputerFileLimits.maxBytes else {
      throw API.Failure(status: 0, message: "\(name) is bigger than \(ComputerFileLimits.maxBytes / 1024 / 1024) MB.")
    }
    let api = try connection()
    let gen = session
    var comps = URLComponents(url: api.base.appending(path: "/api/computers/\(c.id)/files"), resolvingAgainstBaseURL: false)!
    comps.queryItems = [URLQueryItem(name: "folder", value: folder)]
    var request = URLRequest(url: comps.url!, timeoutInterval: 180)
    request.httpMethod = "POST"
    if let token = api.token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    request.setValue(name.addingPercentEncoding(withAllowedCharacters: .alphanumerics), forHTTPHeaderField: "x-filename")
    request.httpBody = data
    let (body, response) = try await api.session.data(for: request)
    guard gen == session else { throw Stale() }
    if (response as? HTTPURLResponse)?.statusCode == 401 {
      authenticationExpired(generation: gen)
      throw API.AuthenticationExpired()
    }
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let error = (try? JSONDecoder().decode([String: String].self, from: body))?["error"]
      throw API.Failure(status: (response as? HTTPURLResponse)?.statusCode ?? 0, message: error ?? "Couldn't send \(name). Try again.")
    }
    struct Landed: Decodable { var path: String }
    return (try? Wire.decoder.decode(Landed.self, from: body))?.path ?? folder
  }

  func makeRemoteFolder(_ c: Computer, in folder: String, name: String) async throws {
    struct Body: Encodable { var folder: String; var name: String }
    try await fetch { try await $0.post("/api/computers/\(c.id)/files/folder", Body(folder: folder, name: name)) }
  }

  // MARK: open a link there

  func openOnComputer(_ c: Computer, target: String) async throws {
    try await act(c, ["action": AnyEncodable("open"), "target": AnyEncodable(target)])
  }

  // MARK: teaching

  /** Which page element a click landed on, when it was in a web page on a VM. */
  func inspect(_ c: Computer, x: Int, y: Int, width: Int, height: Int) async throws -> TaughtElement? {
    struct Body: Encodable { var action: [String: AnyEncodable] }
    struct Result: Decodable { var element: TaughtElement? }
    let action: [String: AnyEncodable] = ["action": AnyEncodable("inspect"), "x": AnyEncodable(x), "y": AnyEncodable(y), "space": AnyEncodable(["width": width, "height": height])]
    let r: Result = try await fetch { try await $0.post("/api/computers/\(c.id)/act", Body(action: action)) }
    return r.element
  }

  /** Save a lesson as a routine the agent writes up. Pictures go up first. */
  func saveLesson(agent: Agent, computer c: Computer, name: String, recording: TeachRecording, narration: String) async throws {
    var steps: [TaughtStep] = []
    for (n, item) in recording.items.enumerated() {
      var step = item.step
      if let shot = item.snapshot { step.imageFileId = try await uploadFile(shot, name: "step-\(n + 1).jpg", mime: "image/jpeg").id }
      steps.append(step)
    }
    let notes = narration.trimmingCharacters(in: .whitespacesAndNewlines)
    let request = TeachRequest(agentId: agent.id, name: name.trimmingCharacters(in: .whitespacesAndNewlines), computerId: c.id, steps: steps,
      durationMs: max(0, Int(Date().timeIntervalSince(recording.started) * 1000)), narration: notes.isEmpty ? nil : notes)
    try await fetch { try await $0.post("/api/routines/teach", request) }
    try? await refreshRoutines()
  }
}

extension UIImage {
  /** The picture as a JPEG no wider than `maxWidth`, the size a lesson's pictures are kept at. */
  static func lessonJPEG(from data: Data, maxWidth: CGFloat = 1280) -> Data? {
    guard let image = UIImage(data: data) else { return nil }
    guard image.size.width > maxWidth else { return image.jpegData(compressionQuality: 0.7) ?? data }
    let scale = maxWidth / image.size.width
    let size = CGSize(width: maxWidth, height: (image.size.height * scale).rounded())
    let format = UIGraphicsImageRendererFormat.default()
    format.scale = 1
    return UIGraphicsImageRenderer(size: size, format: format).jpegData(withCompressionQuality: 0.7) { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
  }
}
