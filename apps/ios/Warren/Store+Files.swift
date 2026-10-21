import Foundation
import UniformTypeIdentifiers

extension Store {
  func uploadTaskFile(_ url: URL) async throws -> UploadedFile {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    let api = try connection()
    var request = URLRequest(url: api.base.appending(path: "/api/files"), timeoutInterval: 120)
    request.httpMethod = "POST"
    if let token = api.token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    request.setValue(url.lastPathComponent.addingPercentEncoding(withAllowedCharacters: .alphanumerics), forHTTPHeaderField: "x-filename")
    request.setValue(UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream", forHTTPHeaderField: "x-mime-type")
    request.httpBody = try Data(contentsOf: url)
    let (data, response) = try await api.session.data(for: request)
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let error = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
      throw API.Failure(status: (response as? HTTPURLResponse)?.statusCode ?? 0, message: error ?? "Couldn't upload this file. Try again.")
    }
    return try Wire.decoder.decode(UploadedFile.self, from: data)
  }
}
