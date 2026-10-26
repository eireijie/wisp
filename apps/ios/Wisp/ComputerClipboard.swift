import SwiftUI

/** A link, for "Open there": only web links are opened on a computer from here. */
func isWebLink(_ text: String) -> Bool {
  let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !t.contains(where: \.isWhitespace), let url = URL(string: t), let scheme = url.scheme?.lowercased() else { return false }
  return (scheme == "http" || scheme == "https") && url.host?.isEmpty == false
}

/** The computer's clipboard next to yours: read it, send text there, paste it, or open a link on it. */
struct ComputerClipboardView: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var computerId: String

  @State private var remote: String?
  @State private var loading = false
  @State private var draft = ""
  @State private var busy: String?
  @State private var message: (text: String, bad: Bool)?

  private var computer: Computer? { store.computers.first { $0.id == computerId } }
  /** Pasting and opening links act on the screen, so they need you in control. */
  private var inControl: Bool { computer?.controller != nil && computer?.controller?.id == store.me?.id }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Text(remote == nil ? "…" : remote!.isEmpty ? "Nothing copied there yet" : remote!)
            .font(.callout.monospaced())
            .foregroundStyle(remote?.isEmpty == false ? .primary : .secondary)
            .lineLimit(8)
            .textSelection(.enabled)
          Button("Copy to this iPhone", systemImage: "iphone.and.arrow.forward") {
            UIPasteboard.general.string = remote
            message = ("Copied to this iPhone", false)
          }
          .disabled((remote ?? "").isEmpty)
        } header: {
          HStack { Text("On \(computer?.name ?? "the computer")"); Spacer(); Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }.disabled(loading).accessibilityLabel("Refresh") }
        }

        Section {
          TextField("Paste text or a link here", text: $draft, axis: .vertical)
            .lineLimit(3...8)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          Button("Paste from this iPhone", systemImage: "doc.on.clipboard") {
            if let text = UIPasteboard.general.string, !text.isEmpty { draft = text } else { message = ("Nothing copied on this iPhone", true) }
          }
          Button { run("send") { c in try await store.setClipboard(c, draft); remote = draft; return "It's on \(c.name)'s clipboard" } } label: {
            Label("Send", systemImage: "paperplane")
          }
          .disabled(draft.isEmpty || busy != nil)
          if inControl {
            Button { run("paste") { c in
              try await store.setClipboard(c, draft)
              remote = draft
              try await store.act(c, ["action": AnyEncodable("key"), "keys": AnyEncodable(await store.pasteKeys(c))])
              return "Pasted into \(c.name)"
            } } label: { Label("Send and paste", systemImage: "doc.on.clipboard.fill") }
              .disabled(draft.isEmpty || busy != nil)
            if isWebLink(draft) {
              Button { run("open") { c in try await store.openOnComputer(c, target: draft.trimmingCharacters(in: .whitespacesAndNewlines)); return "Opened on \(c.name)" } } label: {
                Label("Open there", systemImage: "safari")
              }
              .disabled(busy != nil)
            }
          }
        } header: {
          Text("Send to \(computer?.name ?? "the computer")")
        } footer: {
          if !inControl { Text("Take control to paste it or open links there.") }
        }

        if let message { Section { Text(message.text).font(.footnote).foregroundStyle(message.bad ? Color.red : Color.green) } }
      }
      .groundBackground()
      .navigationTitle("Clipboard")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
      .task { await load() }
    }
  }

  private func load() async {
    guard let c = computer else { return }
    loading = true
    defer { loading = false }
    do { remote = try await store.clipboard(c) } catch is Store.Stale {} catch { message = (error.localizedDescription, true) }
  }

  private func run(_ what: String, _ work: @escaping (Computer) async throws -> String) {
    guard let c = computer else { return }
    busy = what
    message = nil
    Task {
      defer { busy = nil }
      do { message = (try await work(c), false) } catch is Store.Stale {} catch { message = (error.localizedDescription, true) }
    }
  }
}
