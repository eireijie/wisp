import Foundation
import ImageIO
import UIKit
import UniformTypeIdentifiers

extension Store {
  /** Uploads a file for a message (or a task); the hub keeps it with the channel it's shared in. */
  func uploadFile(_ data: Data, name: String, mime: String?, channelId: String? = nil) async throws -> UploadedFile {
    let api = try connection()
    let gen = session
    var request = URLRequest(url: api.base.appending(path: "/api/files"), timeoutInterval: 120)
    request.httpMethod = "POST"
    if let token = api.token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    request.setValue(name.addingPercentEncoding(withAllowedCharacters: .alphanumerics), forHTTPHeaderField: "x-filename")
    request.setValue(mime ?? UTType(filenameExtension: (name as NSString).pathExtension)?.preferredMIMEType ?? "application/octet-stream", forHTTPHeaderField: "x-mime-type")
    if let channelId { request.setValue(channelId, forHTTPHeaderField: "x-channel-id") }
    request.httpBody = data
    let (body, response) = try await api.session.data(for: request)
    guard gen == session else { throw Stale() }
    if (response as? HTTPURLResponse)?.statusCode == 401 {
      authenticationExpired(generation: gen)
      throw API.AuthenticationExpired()
    }
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let error = (try? JSONDecoder().decode([String: String].self, from: body))?["error"]
      throw API.Failure(status: (response as? HTTPURLResponse)?.statusCode ?? 0, message: error ?? "Couldn't upload this file. Try again.")
    }
    guard gen == session else { throw Stale() }
    return try Wire.decoder.decode(UploadedFile.self, from: body)
  }

  /**
   * A shared file on this phone, fetched once with the session's token (file links need it, so
   * they can't just be opened in a browser). Kept in the caches folder under its id.
   */
  func localFile(_ id: String, name: String) async throws -> URL {
    let safe = name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
    let dir = URL.cachesDirectory.appending(path: "files/\(id)", directoryHint: .isDirectory)
    let url = dir.appending(path: safe.isEmpty ? "file" : safe)
    if FileManager.default.fileExists(atPath: url.path()) { return url }
    let data = try await fetch { try await $0.raw("GET", "/api/files/\(id)", body: Optional<Empty>.none) }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try data.write(to: url, options: .atomic)
    return url
  }

  func uploadTaskFile(_ url: URL) async throws -> UploadedFile {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    return try await uploadFile(Data(contentsOf: url), name: url.lastPathComponent, mime: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType)
  }
}

extension UploadedFile {
  static func isImage(_ name: String) -> Bool {
    ["png", "jpg", "jpeg", "gif", "webp", "heic"].contains((name as NSString).pathExtension.lowercased())
  }
}

@MainActor
enum AttachmentThumbnail {
  static let maxPixelSize = 780
  private static let cache: NSCache<NSURL, UIImage> = {
    let cache = NSCache<NSURL, UIImage>()
    cache.countLimit = 64
    cache.totalCostLimit = 24 * 1024 * 1024
    return cache
  }()

  static func image(at url: URL) -> UIImage? {
    if let image = cache.object(forKey: url as NSURL) { return image }
    guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
          let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
          ] as CFDictionary) else { return nil }
    let image = UIImage(cgImage: thumbnail)
    cache.setObject(image, forKey: url as NSURL, cost: thumbnail.bytesPerRow * thumbnail.height)
    return image
  }
}
