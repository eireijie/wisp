import SwiftUI

/** Every saved version of an agent's personality (SOUL.md): who changed it and when, and what it said. */
struct SoulHistory: View {
  @Environment(Store.self) private var store
  var agent: Agent
  var canRestore = false
  /** puts an old version into the personality editor as an unsaved draft */
  var onRestore: (String) -> Void
  @State private var revisions: [NoteRevision]?
  @State private var error: String?

  var body: some View {
    List {
      if let revisions {
        if revisions.isEmpty { Text("No changes yet.").foregroundStyle(.secondary) }
        ForEach(revisions) { revision in
          NavigationLink {
            SoulVersion(agent: agent, revision: revision, canRestore: canRestore, onRestore: onRestore)
          } label: {
            VStack(alignment: .leading, spacing: 3) {
              Text(revision.message?.isEmpty == false ? revision.message! : "Edited")
              Text(caption(revision)).font(.caption).foregroundStyle(.secondary)
            }
          }
        }
      } else if error == nil {
        ProgressView()
      }
      InlineError(error: error)
      if error != nil { Button("Try again") { Task { await load() } } }
    }
    .navigationTitle("History")
    .navigationBarTitleDisplayMode(.inline)
    .task { await load() }
  }

  private func caption(_ revision: NoteRevision) -> String {
    var parts: [String] = []
    if let author = revision.author, !author.isEmpty { parts.append(author == "@\(agent.handle)" ? "@\(agent.handle) refined it" : author) }
    if let date = revision.date.flatMap(Wire.date) { parts.append(date.formatted(.relative(presentation: .named))) }
    return parts.joined(separator: " · ")
  }

  private func load() async {
    do { revisions = try await store.noteHistory(SoulText.path(agent.id)); error = nil }
    catch let failure as API.Failure where failure.status == 404 { revisions = [] }
    catch { self.error = error.localizedDescription }
  }
}

/** One old version of the personality, with a way to bring it back as a draft. */
private struct SoulVersion: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var agent: Agent
  var revision: NoteRevision
  var canRestore: Bool
  var onRestore: (String) -> Void
  @State private var content: String?
  @State private var error: String?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        if let content {
          Text(content.isEmpty ? "This version was empty." : content)
            .font(.system(.callout, design: .monospaced))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        } else if error == nil {
          ProgressView().frame(maxWidth: .infinity)
        }
        InlineError(error: error)
        if let content, canRestore {
          Button("Use this version") { onRestore(content); dismiss() }.secondaryButton()
          Text("It goes into the editor as a draft; save it there to keep it.").font(.caption).foregroundStyle(.secondary)
        }
      }.padding(16)
    }
    .navigationTitle("Earlier version")
    .navigationBarTitleDisplayMode(.inline)
    .task {
      do { content = try await store.noteAt(SoulText.path(agent.id), revision: revision.hash) }
      catch { self.error = error.localizedDescription }
    }
  }
}
