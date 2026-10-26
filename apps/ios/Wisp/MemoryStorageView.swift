import SwiftUI

/** The same `obsidian://` link the web builds: opens the vault, or one note, in Obsidian on the computer that has the folder. */
enum ObsidianLink {
  static func url(root: String, note: String? = nil) -> URL? {
    let slashed = root.replacingOccurrences(of: "\\", with: "/")
    let clean = slashed.hasSuffix("/") ? String(slashed.dropLast()) : slashed
    let full = note.map { "\(clean)/\($0)" } ?? clean
    var allowed = CharacterSet.urlQueryAllowed
    allowed.remove(charactersIn: "&=+/?#")
    guard let encoded = full.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
    return URL(string: "obsidian://open?path=\(encoded)")
  }
}

/** Memory storage: where the notes are kept, how to use them in Obsidian, and who can see what. */
struct MemoryStorageView: View {
  @Environment(Store.self) private var store
  @State private var path = ""
  @State private var changing = false
  @State private var restarting = false
  @State private var action = FormAction()
  private var storage: MemoryStorage? { store.memoryStorage }
  private var fixed: Bool { storage?.source == "env" }

  var body: some View {
    MemoryScreen(title: "Memory storage", id: "memory-storage") {
      InlineError(error: action.error)
      if store.isOwner, let storage {
        SectionCaption("Where memory is kept")
        VStack(alignment: .leading, spacing: 4) {
          Text("Folder on this computer").font(.system(size: 13)).foregroundStyle(Palette.faint)
          Text(storage.path ?? "").font(.system(size: 16, design: .monospaced)).foregroundStyle(Palette.text).textSelection(.enabled)
        }.padding(.horizontal, 18).padding(.vertical, 14).frame(maxWidth: .infinity, alignment: .leading).background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
        if fixed { CardCaption("Set by WISP_VAULT_DIR where Wisp runs, so it can only be changed there.") }
        else {
          HStack(spacing: 10) {
            pill("Use a different folder") { changing.toggle() }
            pill("Use the default") { action.run { try await store.saveMemoryStorage(""); path = ""; changing = false } }.opacity(storage.source == "default" ? 0.5 : 1).disabled(storage.source == "default" || action.busy)
          }
          if changing {
            MemoryFieldCard { TextField("/Users/you/Documents/My Obsidian vault", text: $path).textInputAutocapitalization(.never).autocorrectionDisabled().foregroundStyle(Palette.text).accessibilityIdentifier("memory-folder-field") }
            HStack { Spacer(); PillAction(title: "Save", symbol: "checkmark", enabled: !action.busy && path.trimmed != (storage.setting ?? "") && path.count <= 1000) { action.run { try await store.saveMemoryStorage(path.trimmed); changing = false } } }
            CardCaption("Type the full path on the computer that runs Wisp. If it's an Obsidian vault, its notes are used as they are.")
          }
          CardCaption("Wisp restarts to pick up a new folder. Your notes stay where they are.")
        }
        if storage.pendingRestart == true {
          VStack(alignment: .leading, spacing: 10) {
            Text("Wisp will use \(storage.nextPath ?? "the new folder") after it restarts. Nothing changes until then.").font(.system(size: 15)).foregroundStyle(Palette.text)
            if storage.restartable == true { Button { restarting = true } label: { Text("Restart Wisp now").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.sheet).padding(.horizontal, 20).frame(height: 44).background(Capsule().fill(Palette.text)) }.buttonStyle(.plain) }
            else { Text("Stop Wisp and start it again on the computer to switch.").font(.system(size: 13)).foregroundStyle(Palette.muted) }
          }.padding(18).frame(maxWidth: .infinity, alignment: .leading).background(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).fill(Color(light: 0xDCE9FF, dark: 0x1F3A66)))
        }
        if let previous = storage.previous { CardCaption("Your earlier memory is still in \(previous). Wisp never deletes it.") }
      } else {
        CardCaption("Everything your agents and people remember is kept as plain markdown notes in one folder.")
      }
      SectionCaption("Obsidian")
      CardGroup {
        NavigationLink { ObsidianSyncView() } label: { RowLabel(title: "Use it in Obsidian") { Image(systemName: "arrow.up.right.square").font(.system(size: 18)).foregroundStyle(Palette.muted).frame(width: 26) } }.buttonStyle(.plain).accessibilityIdentifier("memory-obsidian")
        NavigationLink { ObsidianSyncView() } label: { RowLabel(title: "On another computer") { Image(systemName: "arrow.triangle.2.circlepath").font(.system(size: 18)).foregroundStyle(Palette.muted).frame(width: 26) } }.buttonStyle(.plain)
        NavigationLink { ObsidianSyncView() } label: { RowLabel(title: "Your sign-in tokens", value: storage?.tokens.map { $0.isEmpty ? nil : String($0.count) } ?? nil) { Image(systemName: "key").font(.system(size: 18)).foregroundStyle(Palette.muted).frame(width: 26) } }.buttonStyle(.plain)
      }
      CardCaption("Memory is plain markdown in git, so you can also write in Obsidian.")
      SectionCaption("Everyone")
      CardGroup {
        NavigationLink { MemoryAccessRulesView() } label: { RowLabel(title: "Who can see and edit what") { Image(systemName: "lock").font(.system(size: 18)).foregroundStyle(Palette.muted).frame(width: 26) } }.buttonStyle(.plain)
      }
    }
    .task { do { try await store.refreshMemoryStorage(); path = storage?.setting ?? "" } catch { action.error = error.localizedDescription } }
    .confirmationDialog("Restart Wisp now? Everyone will briefly disconnect.", isPresented: $restarting, titleVisibility: .visible) {
      Button("Restart Wisp") { action.run { try await store.connection().post("/api/memory/storage/restart", Empty()) } }
    }
  }

  private func pill(_ title: String, _ run: @escaping () -> Void) -> some View {
    Button(action: run) {
      Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text).multilineTextAlignment(.center).frame(maxWidth: .infinity).frame(minHeight: 52).padding(.horizontal, 8)
        .background(Capsule().fill(Palette.control)).overlay(Capsule().strokeBorder(Palette.hairline))
    }.buttonStyle(.plain)
  }
}

/** Obsidian sync: the branch, the three steps for another computer, and your sign-in tokens. */
struct ObsidianSyncView: View {
  @Environment(Store.self) private var store
  @State private var label = ""
  @State private var token: String?
  @State private var copied = false
  @State private var revoking: MemoryToken?
  @State private var action = FormAction()
  private var storage: MemoryStorage? { store.memoryStorage }

  private func cloneCommand(_ token: String) -> String {
    guard let base = store.api?.base, var parts = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return "" }
    parts.user = "wisp"; parts.password = token; parts.path = storage?.sync?.urlPath ?? ""
    return "git clone \"\(parts.string ?? "")\" \"Wisp memory\""
  }

  var body: some View {
    MemoryScreen(title: "Obsidian sync", id: "memory-obsidian") {
      InlineError(error: action.error)
      CardGroup {
        HStack {
          VStack(alignment: .leading, spacing: 2) {
            Text("Branch").font(.system(size: 13)).foregroundStyle(Palette.faint)
            Text(storage?.sync?.branch ?? "main").font(.system(size: 15, weight: .bold)).foregroundStyle(Palette.text)
          }
          Spacer()
          if let root = storage?.path, let url = ObsidianLink.url(root: root) {
            Button { UIApplication.shared.open(url) { ok in if !ok { Task { @MainActor in action.error = "Obsidian isn't on this iPhone." } } } } label: {
              HStack(spacing: 6) { Image(systemName: "arrow.up.right.square"); Text("Open in Obsidian") }.font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text).padding(.horizontal, 14).frame(height: 44)
                .background(Capsule().fill(Palette.control)).overlay(Capsule().strokeBorder(Palette.hairline))
            }.buttonStyle(.plain).accessibilityIdentifier("open-in-obsidian")
          }
        }.padding(.horizontal, 18).padding(.vertical, 12)
      }
      SectionCaption("On another computer")
      if storage?.sync?.allowed == false {
        CardCaption(storage?.sync?.reason ?? "Sync is not available for this account.")
      } else {
        CardGroup {
          step(1, "Create a token", "Name it after the computer.")
          step(2, "Copy the token", "You see it once.")
          step(3, "Paste it into the Obsidian Git plugin", "Then pull. Notes appear as files.")
        }
        HStack(spacing: 10) {
          TextField("Token name", text: $label).foregroundStyle(Palette.text).padding(.horizontal, 18).frame(height: 52)
            .background(Palette.card, in: Capsule()).overlay(Capsule().strokeBorder(Palette.hairline)).accessibilityIdentifier("token-name")
          Button { action.run { token = try await store.createMemoryToken(label).token; label = ""; copied = false } } label: {
            Text("Create token").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.sheet).padding(.horizontal, 18).frame(height: 52).background(Capsule().fill(Palette.text)).opacity(action.busy || label.count > 60 ? 0.4 : 1)
          }.buttonStyle(.plain).disabled(action.busy || label.count > 60).accessibilityIdentifier("create-token")
        }
        if let token {
          VStack(alignment: .leading, spacing: 8) {
            Text("Copy this token now. It is shown once.").font(.system(size: 13)).foregroundStyle(Palette.muted)
            Text(token).font(.system(size: 14, design: .monospaced)).foregroundStyle(Palette.text).textSelection(.enabled)
            Button { UIPasteboard.general.string = token; copied = true } label: { Label(copied ? "Copied" : "Copy token", systemImage: "doc.on.doc").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text) }.buttonStyle(.plain)
            Button { UIPasteboard.general.string = cloneCommand(token); copied = true } label: { Label("Copy the git clone command", systemImage: "terminal").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text) }.buttonStyle(.plain)
          }.padding(18).frame(maxWidth: .infinity, alignment: .leading).background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
        }
      }
      if let tokens = storage?.tokens, !tokens.isEmpty {
        SectionCaption("Your sign-in tokens")
        CardGroup {
          ForEach(tokens) { item in
            HStack(spacing: 10) {
              VStack(alignment: .leading, spacing: 2) {
                Text(item.label ?? "Obsidian").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text)
                Text(item.createdAt.flatMap { Wire.date($0) }.map { "Created \($0.formatted(.dateTime.month(.abbreviated).day()))" } ?? "").font(.system(size: 13)).foregroundStyle(Palette.faint)
              }
              Spacer()
              Button { revoking = item } label: { Text("Revoke").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.red).padding(.horizontal, 14).frame(height: 38).background(Capsule().fill(Palette.control)).overlay(Capsule().strokeBorder(Palette.hairline)) }.buttonStyle(.plain)
            }.padding(.horizontal, 18).padding(.vertical, 12)
          }
        }
        CardCaption("Tokens work only for syncing memory, not for signing in to Wisp.")
      }
    }
    .task { try? await store.refreshMemoryStorage() }
    .confirmationDialog("Revoke this sync token?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible) {
      Button("Revoke", role: .destructive) { if let item = revoking { action.run { try await store.revokeMemoryToken(item.id) } } }
    }
  }

  private func step(_ n: Int, _ title: String, _ subtitle: String) -> some View {
    HStack(spacing: 14) {
      Text("\(n)").font(.system(size: 15, weight: .bold)).foregroundStyle(Palette.text).frame(width: 30, height: 30).background(Circle().fill(Palette.control))
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text)
        Text(subtitle).font(.system(size: 13)).foregroundStyle(Palette.faint)
      }
      Spacer(minLength: 0)
    }.padding(.horizontal, 18).padding(.vertical, 14).frame(maxWidth: .infinity, alignment: .leading)
  }
}
