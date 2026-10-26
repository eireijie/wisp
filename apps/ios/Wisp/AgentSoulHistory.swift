import SwiftUI

/**
 * History (agent-PersonalityHistory.dc.html): every saved version of an agent's personality
 * (SOUL.md), who changed it and when. The newest is Current; each older one has Restore, which
 * puts it in the editor as a draft. Tapping a version shows what it said.
 */
struct SoulHistory: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var agent: Agent
  var canRestore = false
  /** puts an old version into the personality editor as an unsaved draft */
  var onRestore: (String) -> Void
  @State private var revisions: [NoteRevision]?
  @State private var error: String?
  @State private var restoring: String?

  var body: some View {
    AgentFrame(title: "History", subtitle: "Personality") {
      if let revisions {
        if revisions.isEmpty {
          AgentCard { Text("No changes yet.").font(.system(size: 15)).foregroundStyle(Palette.muted) }
        } else {
          CardGroup {
            ForEach(Array(revisions.enumerated()), id: \.element.id) { index, revision in
              HStack(spacing: 10) {
                NavigationLink {
                  SoulVersion(agent: agent, revision: revision, canRestore: canRestore) { onRestore($0); dismiss() }
                } label: {
                  VStack(alignment: .leading, spacing: 2) {
                    Text(when(revision)).font(.system(size: 15)).foregroundStyle(Palette.text)
                    Text(who(revision)).font(.system(size: 13)).foregroundStyle(Palette.faint)
                  }
                  .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                }.buttonStyle(.plain)
                if index == 0 {
                  Text("Current").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.green)
                } else if canRestore {
                  Button { restore(revision) } label: {
                    Text(restoring == revision.hash ? "…" : "Restore").font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.text)
                      .padding(.horizontal, 14).frame(height: 32).background(Capsule().fill(Color(light: 0xE3E3EA, dark: 0x2E2E32)))
                  }.buttonStyle(.plain).disabled(restoring != nil).accessibilityIdentifier("history-restore")
                }
              }
              .padding(.horizontal, 18).frame(minHeight: 64)
            }
          }
          CardCaption("Restoring a version puts it in the editor. Save it there to keep it; the newer ones stay in this list.")
        }
      } else if error == nil {
        ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
      }
      AgentError(text: error)
      if error != nil { PillButton(title: "Try again", kind: .secondary) { Task { await load() } } }
    }
    .task { await load() }
  }

  private func when(_ revision: NoteRevision) -> String {
    guard let date = revision.date.flatMap(Wire.date) else { return "Earlier" }
    let time = date.formatted(.dateTime.hour().minute())
    if Calendar.current.isDateInToday(date) { return "Today, \(time)" }
    if Calendar.current.isDateInYesterday(date) { return "Yesterday, \(time)" }
    return date.formatted(.dateTime.month(.abbreviated).day()) + ", " + time
  }

  private func who(_ revision: NoteRevision) -> String {
    let author = revision.author ?? ""
    if author == "@\(agent.handle)" { return "\(agent.name) refined it" }
    if author.isEmpty { return revision.message?.isEmpty == false ? revision.message! : "Edited" }
    return "\(author) edited it"
  }

  private func restore(_ revision: NoteRevision) {
    restoring = revision.hash
    Task {
      defer { restoring = nil }
      do { onRestore(try await store.noteAt(SoulText.path(agent.id), revision: revision.hash)); dismiss() }
      catch { self.error = error.localizedDescription }
    }
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
  var agent: Agent
  var revision: NoteRevision
  var canRestore: Bool
  var onRestore: (String) -> Void
  @State private var content: String?
  @State private var error: String?

  var body: some View {
    AgentFrame(title: "Earlier version", subtitle: agent.name) {
      if let content {
        AgentCard {
          Text(content.isEmpty ? "This version was empty." : content)
            .font(.system(size: 15, design: .monospaced)).foregroundStyle(Palette.text).textSelection(.enabled)
        }
        if canRestore {
          PillButton(title: "Use this version") { onRestore(content) }
          CardCaption("It goes into the editor as a draft; save it there to keep it.")
        }
      } else if error == nil {
        ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
      }
      AgentError(text: error)
    }
    .task {
      do { content = try await store.noteAt(SoulText.path(agent.id), revision: revision.hash) }
      catch { self.error = error.localizedDescription }
    }
  }
}
