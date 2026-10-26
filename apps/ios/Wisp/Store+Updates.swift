import Foundation

extension Store {
  /** Whether the hub now runs a different build than the one this app first saw. Unknown counts as no. */
  nonisolated static func hubChanged(baseline: String?, now: String?) -> Bool {
    guard let baseline, !baseline.isEmpty, let now, !now.isEmpty else { return false }
    return baseline != now
  }

  /**
   * Notices that the hub was updated while the app was open (Settings → Updates & about, `wisp update`),
   * so it can offer a reload instead of running old data. The first look is the baseline; a later
   * look (after the connection comes back, which is what an update looks like) compares to it.
   */
  func checkHubUpdated() async {
    let info: HubUpdate? = try? await fetch { try await $0.get("/api/updates") }
    guard let commit = info?.version?.commit, !commit.isEmpty else { return }
    if hubCommit == nil { hubCommit = commit; return }
    if Store.hubChanged(baseline: hubCommit, now: commit) { hubUpdated = true }
  }

  /** "Reload": load everything again from the updated hub and start watching from its version. */
  func reloadAfterUpdate() async {
    hubUpdated = false
    hubCommit = nil
    await load()
    await checkHubUpdated()
  }
}
