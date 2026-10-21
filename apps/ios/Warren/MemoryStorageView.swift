import SwiftUI

struct MemoryStorageView: View {
  @Environment(Store.self) private var store
  @State private var path = ""
  @State private var label = ""
  @State private var token: String?
  @State private var restarting = false
  @State private var revoking: MemoryToken?
  @State private var action = FormAction()
  private var storage: MemoryStorage? { store.memoryStorage }
  var body: some View {
    Form {
      Text("Everything your agents and people remember is kept as plain markdown notes in one folder.").font(.subheadline)
      if store.isOwner, let storage {
        Section("Where memory is kept") {
          LabeledContent("Current folder", value: storage.path ?? "")
          if storage.source == "env" { Text("Set by WARREN_VAULT_DIR where Warren runs, so it can only be changed there.").font(.footnote) }
          else {
            TextField("Use a different folder", text: $path).textInputAutocapitalization(.never).autocorrectionDisabled()
            Text("Type the full path on the computer that runs Warren. Earlier notes are copied across the next time Warren starts; the earlier folder is left as it was.").font(.footnote)
            Button("Save") { action.run { try await store.saveMemoryStorage(path.trimmed) } }.disabled(action.busy || path.count > 1000)
            Button("Use the default") { action.run { try await store.saveMemoryStorage(""); path = "" } }.disabled(action.busy)
          }
          if storage.pendingRestart == true {
            Text("Warren will use \(storage.nextPath ?? "the new folder") after it restarts. Nothing changes until then.")
            if storage.restartable == true { Button("Restart Warren now") { restarting = true } }
            else { Text("Stop Warren and start it again on the computer to switch.") }
          }
          if let previous = storage.previous { Text("Your earlier memory is still in \(previous). Warren never deletes it.").font(.footnote) }
        }
      }
      NavigationLink("Who can see and edit what") { MemoryRulesView() }
      TechnicalDetails(title: "Use another notes app (Obsidian) and sync") {
        Section("Obsidian") {
          if let sync = storage?.sync {
            if sync.allowed {
              Text("Use Obsidian's Git plugin to sync this vault. Set it up on the computer where you use Obsidian.")
              Text((store.api?.base.absoluteString ?? "") + (sync.urlPath ?? "")).textSelection(.enabled)
              LabeledContent("Branch", value: sync.branch ?? "")
              TextField("Token label", text: $label)
              Button("Create token") { action.run { token = try await store.createMemoryToken(label).token } }.disabled(action.busy || label.count > 60)
              if let token { Text("Copy this token now; it is shown once.").font(.footnote); Text(token).font(.caption.monospaced()).textSelection(.enabled); Button("Copy token") { UIPasteboard.general.string = token } }
            } else { Text(sync.reason ?? "Sync is not available for this account.") }
          }
          ForEach(storage?.tokens ?? []) { token in
            HStack { Text(token.label ?? "Obsidian"); Spacer(); Button("Revoke", role: .destructive) { revoking = token } }
          }
        }
      }
      InlineError(error: action.error)
    }.sectionScreen("Memory storage", id: "memory-storage")
      .task { do { try await store.refreshMemoryStorage(); path = storage?.setting ?? "" } catch { action.error = error.localizedDescription } }
      .confirmationDialog("Restart Warren now? Everyone will briefly disconnect.", isPresented: $restarting, titleVisibility: .visible) {
        Button("Restart Warren") { action.run { try await store.connection().post("/api/memory/storage/restart", Empty()) } }
      }
      .confirmationDialog("Revoke this sync token?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible) {
        Button("Revoke", role: .destructive) { if let token = revoking { action.run { try await store.revokeMemoryToken(token.id) } } }
      }
  }
}

struct MemoryRulesView: View {
  @Environment(Store.self) private var store
  @State private var rules: [MemoryRule] = []
  @State private var path = ""
  @State private var action = FormAction()
  var body: some View {
    List {
      Section {
        TextField("Folder or note", text: $path).textInputAutocapitalization(.never).autocorrectionDisabled()
        NavigationLink("Manage access") { MemoryAccessView(path: path.trimmed) }
      }
      ForEach(rules) { rule in NavigationLink(rule.path.isEmpty ? "Whole vault" : rule.path) { MemoryAccessView(path: rule.path) } }
      InlineError(error: action.error)
    }.navigationTitle("Who can see and edit what")
      .task { do { rules = try await store.connection().get("/api/access/rules") } catch { action.error = error.localizedDescription } }
  }
}
