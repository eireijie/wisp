import SwiftUI

enum WispRepo {
  static let github = "eireijie/wisp"
  static let url = "https://github.com/\(github)"
}

/** A commit line ("8f380af Settings pages share one look") without its hash. */
private func changeText(_ line: String) -> String {
  guard let space = line.firstIndex(of: " ") else { return line }
  return String(line[line.index(after: space)...])
}

/** Settings → About (set-About.dc.html): the version, what's new, and the update flow (available, confirm, updating, failed). */
struct UpdatesView: View {
  @Environment(Store.self) private var store
  @State private var info: HubUpdate?
  @State private var confirming = false
  @State private var checking = false
  @State private var action = FormAction()
  private var state: String { info?.update?.state ?? "idle" }
  private var updating: Bool { ["updating", "restarting"].contains(state) }
  private var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "" }

  var body: some View {
    Group {
      if updating { UpdatingView(state: state, line: info?.update?.log?.last) }
      else if state == "failed" { UpdateFailedView(message: info?.update?.message, canRetry: store.isOwner, retry: { confirming = true }, back: { action.run { info = try await store.connection().post("/api/updates/check", Empty()) } }) }
      else { page }
    }
    .task { do { info = try await store.connection().get("/api/updates") } catch { action.error = error.localizedDescription } }
    .task(id: updating) {
      guard updating else { return }
      while !Task.isCancelled {
        do { try await Task.sleep(for: .seconds(3)); info = try await store.connection().get("/api/updates"); action.error = nil }
        catch { if !Task.isCancelled { action.error = "Wisp is restarting. It will reconnect when the hub is back." } }
      }
    }
    .confirmCard($confirming, title: "Update and restart the hub?", message: "Everyone will briefly disconnect. Wisp comes back by itself.", confirm: "Update and restart", destructive: false) {
      action.run {
        let result: HubUpdate = try await store.connection().post("/api/updates/hub", Empty())
        info?.update = result.update
      }
    }
  }

  private var page: some View {
    let check = info?.check
    let canUpdate = check?.canUpdate == true
    return SettingsPage("About", subtitle: "Wisp \(version)", id: "about") {
      if let commit = info?.version?.commit {
        CardLabel("This hub runs Wisp \(commit)\(info?.version?.date.flatMap(Wire.date).map { " from " + $0.formatted(.dateTime.month().day()) } ?? "")")
      }
      CardGroup {
        HStack(spacing: 12) {
          VStack(alignment: .leading, spacing: 2) {
            Text(canUpdate ? "Update available" : check?.behind == 0 ? "Up to date" : check == nil ? (checking ? "Checking…" : "Not checked yet") : "Can't update here")
              .font(.system(size: 15)).foregroundStyle(canUpdate ? Palette.blue : check?.behind == 0 ? Palette.statusOnline : Palette.text)
            if let reason = check?.reason { Text(reason).font(.system(size: 13)).foregroundStyle(Palette.faint).fixedSize(horizontal: false, vertical: true) }
          }
          Spacer(minLength: 8)
          Button(checking ? "Checking…" : "Check now") {
            checking = true
            action.run { defer { checking = false }; info = try await store.connection().post("/api/updates/check", Empty()) }
          }.buttonStyle(.pill(.secondary, small: true)).disabled(checking || action.busy).accessibilityIdentifier("about-check")
        }.padding(.horizontal, 18).padding(.vertical, 12).frame(minHeight: 62)
        if canUpdate, let changes = check?.changes, !changes.isEmpty {
          VStack(alignment: .leading, spacing: 8) {
            Text("What's changed").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.faint)
            ForEach(Array(changes.prefix(5)), id: \.self) { Text(changeText($0)).font(.system(size: 15)).foregroundStyle(Palette.text) }
            if changes.count > 5 { Text("…and \(changes.count - 5) more").font(.system(size: 13)).foregroundStyle(Palette.faint) }
          }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 18).padding(.vertical, 14)
        }
      }
      if canUpdate && store.isOwner {
        Button("Update hub") { confirming = true }.buttonStyle(.pill(.primary)).disabled(action.busy).accessibilityIdentifier("about-update")
        CardHint("Everyone will briefly disconnect while the hub restarts.")
      }
      if let message = info?.update?.message, !message.isEmpty { CardHint(message) }
      CardGroup {
        NavigationLink { WhatsNewView(info: info) } label: { RowLabel(title: "What's new") }.accessibilityIdentifier("about-whats-new")
        if let url = URL(string: WispRepo.url) { Link(destination: url) { RowLabel(title: "Source code", chevron: false) { EmptyView() }.overlay(alignment: .trailing) { Image(systemName: "arrow.up.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.faint).padding(.trailing, 18) } } }
        ValueRow(title: "License", value: "Apache-2.0")
      }
      if !store.isOwner { CardHint("Only owners can update the hub.") }
      if let lines = info?.update?.log, !lines.isEmpty {
        CardGroup { MoreOptionsRow { Text(lines.joined(separator: "\n")).font(.system(size: 12, design: .monospaced)).foregroundStyle(Palette.muted).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(18) } }
      }
      StatusLine(error: action.error)
    }
    .task { if info?.check == nil, !checking { checking = true; defer { checking = false }; info = try? await store.connection().post("/api/updates/check", Empty()) } }
  }
}

/** What's new (set-WhatsNew.dc.html): what the hub's next update changes, or that you're on the newest. */
struct WhatsNewView: View {
  var info: HubUpdate?
  var body: some View {
    SettingsPage("What's new", subtitle: info?.version?.commit.map { "Wisp \($0)" }, id: "whats-new") {
      let changes = info?.check?.changes ?? []
      if changes.isEmpty {
        CardGroup { RowLabel(title: "Nothing new right now", chevron: false) }
      } else {
        CardGroup {
          ForEach(changes, id: \.self) { line in
            Text(changeText(line)).font(.system(size: 15)).foregroundStyle(Palette.text).fixedSize(horizontal: false, vertical: true)
              .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 18).padding(.vertical, 14)
          }
        }
      }
    }
  }
}

/** The hub is updating; this page follows along and the app reconnects when it's back (set-Updating.dc.html). */
struct UpdatingView: View {
  var state: String
  var line: String?
  var body: some View {
    VStack(spacing: 14) {
      Spacer()
      ProgressView().controlSize(.large)
      Text("Updating Wisp").font(.system(size: 22, weight: .semibold)).foregroundStyle(Palette.text)
      Text("Everyone is briefly disconnected. This page reloads by itself when the hub is back.").font(.system(size: 15)).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
      Text(state == "restarting" ? "Restarting the hub…" : (line ?? "Updating…")).font(.system(size: 13)).foregroundStyle(Palette.faint)
      Spacer()
    }
    .padding(.horizontal, 32).frame(maxWidth: .infinity)
    .background(Palette.sheet.ignoresSafeArea())
    .toolbar(.hidden, for: .navigationBar)
    .accessibilityIdentifier("screen-updating")
  }
}

/** The update didn't finish; nothing was lost (set-UpdateFailed.dc.html). */
struct UpdateFailedView: View {
  var message: String?
  var canRetry: Bool
  var retry: () -> Void
  var back: () -> Void
  var body: some View {
    VStack(spacing: 14) {
      Spacer()
      Image(systemName: "exclamationmark.triangle").font(.system(size: 34)).foregroundStyle(Palette.red)
      Text("The update didn't finish").font(.system(size: 22, weight: .semibold)).foregroundStyle(Palette.text).multilineTextAlignment(.center)
      Text("Wisp is still running the version it had. Nothing was lost. You can try again, or ask the person who runs the hub.").font(.system(size: 15)).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
      if let message, !message.isEmpty { Text(message).font(.system(size: 13, design: .monospaced)).foregroundStyle(Palette.faint).multilineTextAlignment(.leading).textSelection(.enabled) }
      if canRetry { Button("Try again", action: retry).buttonStyle(.pill(.primary)).accessibilityIdentifier("update-retry") }
      Button("Back to About", action: back).buttonStyle(.pill(.ghost))
      Spacer()
    }
    .padding(.horizontal, 32).frame(maxWidth: .infinity)
    .background(Palette.sheet.ignoresSafeArea())
    .toolbar(.hidden, for: .navigationBar)
    .accessibilityIdentifier("screen-update-failed")
  }
}

struct AgentRuntimesView: View {
  @Environment(Store.self) private var store
  @State private var action = FormAction()
  var body: some View {
    SettingsPage("Agent runtimes", id: "runtimes") {
      CardLabel("On this device")
      CardGroup {
        ForEach(store.nodes.filter(\.usable)) { node in NavigationLink { DeviceDetail(node: node) } label: { RowLabel(title: node.name) } }
        if !store.nodes.contains(where: \.usable) { RowLabel(title: "Connect a device first.", chevron: false) }
      }
      CardLabel("Inside your agents' VMs")
      CardGroup { ForEach(["claude-code", "codex", "hermes", "kimi"], id: \.self) { RowLabel(title: HarnessChoice.label($0), chevron: false) } }
      CardLabel("Connect from anywhere")
      CardGroup { ForEach(HarnessChoice.all.filter { $0.protocolName == "mcp" }) { RowLabel(title: $0.label, chevron: false) } }
      StatusLine(error: action.error)
    }
    .task { do { try await store.refreshNodes() } catch { action.error = error.localizedDescription } }
  }
}
