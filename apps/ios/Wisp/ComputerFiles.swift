import SwiftUI
import PhotosUI
import QuickLook
import UniformTypeIdentifiers

/** The iOS share sheet (Save to Files, Save Image, AirDrop, other apps). */
struct ShareSheet: UIViewControllerRepresentable {
  var items: [Any]
  func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: items, applicationActivities: nil) }
  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/** A file on this phone to hand to the share sheet. */
struct SharedFile: Identifiable { var url: URL; var id: URL { url } }

/** Browse a computer's files: open or share what's there, send files and photos to it, make folders. */
struct ComputerFilesView: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var computerId: String

  @State private var path = "~"
  @State private var folder: RemoteFolder?
  @State private var loading = false
  @State private var error: String?
  @State private var busy: String?
  @State private var showHidden = false
  @State private var naming = false
  @State private var folderName = ""
  @State private var pickingFiles = false
  @State private var pickingPhotos = false
  @State private var photos: [PhotosPickerItem] = []
  @State private var preview: URL?
  @State private var sharing: SharedFile?
  @State private var sent = 0

  private var computer: Computer? { store.computers.first { $0.id == computerId } }

  private var shortcuts: [(String, String, String)] {
    var list = [("Home", "house", "~"), ("Desktop", "menubar.dock.rectangle", "~/Desktop"), ("Downloads", "arrow.down.circle", "~/Downloads")]
    if computer?.kind == "vm" { list.append(("Agents' files", "folder.badge.person.crop", "~/files")) }
    return list
  }

  var body: some View {
    NavigationStack {
      List {
        Section {
          ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
              ForEach(shortcuts, id: \.2) { s in
                Button { Task { await load(s.2) } } label: { Label(s.0, systemImage: s.1).font(.footnote.weight(.medium)).padding(.horizontal, 12).padding(.vertical, 7).background(Capsule().fill(Color(.tertiarySystemFill))) }
                  .buttonStyle(.plain)
              }
            }
          }
          .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
          if let folder {
            HStack(spacing: 8) {
              Button { if let parent = folder.parent { Task { await load(parent) } } } label: { Image(systemName: "arrow.up") }
                .disabled(folder.parent == nil || loading)
                .accessibilityLabel("Up a folder")
              Text(folder.crumbs).font(.footnote).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
            }
          }
        }
        if let busy { Section { HStack(spacing: 8) { ProgressView(); Text(busy).font(.footnote).foregroundStyle(.secondary) } } }
        if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
        if let folder {
          let shown = folder.shown(hidden: showHidden)
          Section {
            ForEach(shown) { f in row(f, in: folder) }
            if shown.isEmpty && !loading {
              Text(folder.hiddenCount > 0 && !showHidden ? "Only hidden files here." : "This folder is empty.").foregroundStyle(.secondary)
            }
          } footer: {
            if folder.hiddenCount > 0 {
              Button(showHidden ? "Hide hidden files" : "Show \(folder.hiddenCount) hidden") { showHidden.toggle() }.font(.footnote)
            }
          }
        } else if loading {
          Section { HStack { Spacer(); ProgressView(); Spacer() } }
        }
      }
      .navigationTitle("Files on \(computer?.name ?? "computer")")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
        ToolbarItemGroup(placement: .primaryAction) {
          Button { folderName = ""; naming = true } label: { Image(systemName: "folder.badge.plus") }
            .accessibilityLabel("New folder")
            .disabled(busy != nil || folder == nil)
          Menu {
            Button("Files", systemImage: "doc") { pickingFiles = true }
            Button("Photos and videos", systemImage: "photo") { pickingPhotos = true }
          } label: { Image(systemName: "square.and.arrow.up") }
            .accessibilityLabel("Send to this folder")
            .disabled(busy != nil || folder == nil)
        }
      }
      .refreshable { await load(path) }
      .task { await load(path) }
      .alert("New folder", isPresented: $naming) {
        TextField("Folder name", text: $folderName).textInputAutocapitalization(.never)
        Button("Cancel", role: .cancel) {}
        Button("Make") { makeFolder() }
      }
      .fileImporter(isPresented: $pickingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
        switch result {
        case .success(let urls):
          send(urls.map { url in
            { () throws -> (String, Data) in
              let scoped = url.startAccessingSecurityScopedResource()
              defer { if scoped { url.stopAccessingSecurityScopedResource() } }
              return (url.lastPathComponent, try Data(contentsOf: url))
            }
          })
        case .failure(let e): error = e.localizedDescription
        }
      }
      .photosPicker(isPresented: $pickingPhotos, selection: $photos, maxSelectionCount: 10, matching: .any(of: [.images, .videos]))
      .onChange(of: photos) { _, items in
        guard !items.isEmpty else { return }
        photos = []
        send(items.map { item in { () async throws -> (String, Data) in try await Self.photo(item) } })
      }
      .quickLookPreview($preview)
      .sheet(item: $sharing) { ShareSheet(items: [$0.url]).ignoresSafeArea() }
      .sensoryFeedback(.success, trigger: sent)
    }
  }

  @ViewBuilder private func row(_ f: RemoteFile, in folder: RemoteFolder) -> some View {
    Button {
      if f.dir { Task { await load(folder.join(f.name)) } } else { fetchFile(folder.join(f.name), then: { preview = $0 }) }
    } label: {
      HStack(spacing: 12) {
        Image(systemName: f.dir ? "folder.fill" : Self.symbol(f.name)).foregroundStyle(f.dir ? Color.blue : .secondary).frame(width: 24)
        Text(f.name).foregroundStyle(f.name.hasPrefix(".") ? .secondary : .primary).lineLimit(1)
        Spacer()
        if f.dir { Image(systemName: "chevron.right").font(.footnote).foregroundStyle(.tertiary) }
        else { Text(Self.size(f.size)).font(.footnote).foregroundStyle(.secondary) }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(busy != nil && !f.dir)
    .contextMenu {
      if !f.dir {
        Button("Open", systemImage: "eye") { fetchFile(folder.join(f.name), then: { preview = $0 }) }
        Button("Save or share", systemImage: "square.and.arrow.up") { fetchFile(folder.join(f.name), then: { sharing = SharedFile(url: $0) }) }
      }
    }
    .swipeActions(edge: .trailing) {
      if !f.dir { Button("Share", systemImage: "square.and.arrow.up") { fetchFile(folder.join(f.name), then: { sharing = SharedFile(url: $0) }) }.tint(.blue) }
    }
  }

  static func size(_ bytes: Int) -> String { ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file) }

  static func symbol(_ name: String) -> String {
    let type = UTType(filenameExtension: (name as NSString).pathExtension)
    if type?.conforms(to: .image) == true { return "photo" }
    if type?.conforms(to: .movie) == true { return "film" }
    if type?.conforms(to: .audio) == true { return "waveform" }
    if type?.conforms(to: .archive) == true { return "doc.zipper" }
    return "doc"
  }

  /** A photo or video from the library; photos that aren't already JPEG, PNG or GIF go as JPEG. */
  static func photo(_ item: PhotosPickerItem) async throws -> (String, Data) {
    guard let data = try await item.loadTransferable(type: Data.self) else { throw API.Failure(status: 0, message: "Couldn't read that photo.") }
    let type = item.supportedContentTypes.first
    let stamp = Store.stamp(Date())
    if type?.conforms(to: .image) == true, ![UTType.png, .gif, .jpeg].contains(where: { type?.conforms(to: $0) == true }), let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.9) {
      return ("Photo \(stamp).jpg", jpeg)
    }
    return ("\(type?.conforms(to: .movie) == true ? "Video" : "Photo") \(stamp).\(type?.preferredFilenameExtension ?? "jpg")", data)
  }

  private func load(_ next: String) async {
    guard let c = computer else { return }
    loading = true
    error = nil
    defer { loading = false }
    do {
      let l = try await store.listFiles(c, path: next)
      folder = l
      path = l.path
    } catch is Store.Stale {
    } catch { self.error = error.localizedDescription }
  }

  private func fetchFile(_ remote: String, then done: @escaping (URL) -> Void) {
    guard let c = computer else { return }
    let name = remote.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? "file"
    busy = "Downloading \(name)…"
    error = nil
    Task {
      defer { busy = nil }
      do { done(try await store.downloadRemoteFile(c, path: remote)) } catch is Store.Stale {} catch { self.error = error.localizedDescription }
    }
  }

  private func makeFolder() {
    guard let c = computer, let folder else { return }
    let name = folderName.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty else { return }
    Task {
      do {
        try await store.makeRemoteFolder(c, in: folder.path, name: name)
        await load(folder.path)
      } catch is Store.Stale {} catch { self.error = error.localizedDescription }
    }
  }

  /** Send each file to the open folder, one at a time. */
  private func send(_ reads: [() async throws -> (String, Data)]) {
    guard let c = computer, let folder, !reads.isEmpty else { return }
    let target = folder.path
    Task {
      defer { busy = nil }
      error = nil
      do {
        for (n, read) in reads.enumerated() {
          busy = reads.count == 1 ? "Sending…" : "Sending \(n + 1) of \(reads.count)…"
          let (name, data) = try await read()
          busy = reads.count == 1 ? "Sending \(name)…" : "Sending \(n + 1) of \(reads.count): \(name)…"
          try await store.uploadRemoteFile(c, folder: target, name: name, data: data)
        }
        sent += 1
        await load(target)
      } catch is Store.Stale {} catch { self.error = error.localizedDescription }
    }
  }
}
