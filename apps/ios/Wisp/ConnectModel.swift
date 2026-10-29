import SwiftUI

/** Which provider to connect: each one, with how it connects. */
struct ConnectModelList: View {
  @Environment(Store.self) private var store
  var open: (String) -> Void
  @State private var providers: [ModelProviderInfo]?
  @State private var error: String?

  var body: some View {
    PickerPage(title: "Connect a model", id: "connect-model") {
      if let providers {
        CardGroup {
          ForEach(providers) { p in
            Button { open(p.id) } label: {
              RowLabel(title: p.label, subtitle: p.canSignIn ? "Sign in or API key" : "API key")
            }.buttonStyle(.pressRow).accessibilityIdentifier("connect-\(p.id)")
          }
        }
        Footnote("Connect once. Every agent can use it, on any computer and in any harness that runs it.")
      } else if let error {
        InlineError(error: error)
      } else {
        ProgressView().frame(maxWidth: .infinity).padding(.top, 30)
      }
    }
    .task {
      do { providers = try await store.modelProviders().providers } catch { self.error = error.localizedDescription }
    }
  }
}

/**
 * Connect one provider (h-PhoneSignIn): Sign in | API key. A sign-in runs on one of your devices,
 * which shows a link and a code here; the hub keeps the result. A key is checked with the provider
 * by the hub before it's kept.
 */
struct ConnectProviderView: View {
  @Environment(Store.self) private var store
  @Environment(\.openURL) private var openURL
  var provider: String
  var done: (String) -> Void
  @State private var info: ModelProviderInfo?
  @State private var mode = "signin"
  @State private var login: ModelLogin?
  @State private var starting = false
  @State private var pasted = ""
  @State private var key = ""
  @State private var copied = false
  @State private var action = FormAction()
  @ReduceMotion private var reduceMotion

  private var label: String { info?.label ?? ModelWords.provider(provider) }

  var body: some View {
    PickerPage(title: "Connect \(label)", id: "connect-provider") {
      if let info {
        if info.canSignIn {
          EffortStyleSegments(options: [("signin", "Sign in"), ("key", "API key")], selection: $mode)
            .padding(.bottom, 2)
        }
        Group {
          if mode == "signin" && info.canSignIn { signIn } else { keyEntry(info) }
        }
        .transition(.opacity)
        .animation(Motion.pick(Motion.fade, reduceMotion), value: mode)
        Footnote("Connect once. Every agent can use \(label), on any computer and in any harness that runs it.")
      } else if let error = action.error {
        InlineError(error: error)
      } else {
        ProgressView().frame(maxWidth: .infinity).padding(.top, 30)
      }
    }
    .task {
      if info == nil, let all = try? await store.modelProviders().providers {
        info = all.first { $0.id == provider }
        mode = info?.canSignIn == true ? "signin" : "key"
      }
    }
    .task(id: mode) { if mode == "signin", info?.canSignIn == true, login == nil { await start() } }
    .task(id: login?.id) { await poll() }
    .onDisappear { if let login, login.running { Task { await store.cancelModelLogin(login.id) } } }
  }

  // MARK: sign in

  @ViewBuilder private var signIn: some View {
    VStack(alignment: .leading, spacing: 12) {
      if let login, login.status == "failed" {
        Text(login.error ?? "The sign-in didn't finish.").font(.system(size: 15)).foregroundStyle(Palette.red)
        Button("Try again") { self.login = nil; Task { await start() } }.font(.system(size: 13, weight: .semibold)).buttonStyle(.plain).foregroundStyle(Palette.blue)
      } else if let login, login.status == "done" {
        Label("Connected", systemImage: "checkmark").font(.system(size: 15, weight: .medium)).foregroundStyle(Palette.statusOnline)
      } else if let login, login.url != nil {
        if let code = login.code {
          Text("Open the link and enter this code.").font(.system(size: 15)).foregroundStyle(Palette.muted)
          Text(code).font(.system(size: 26, weight: .semibold, design: .monospaced)).tracking(1.5).textSelection(.enabled)
            .accessibilityIdentifier("login-code")
        } else {
          Text(login.wantsInput == true ? "Open the link, approve, then paste the code it shows." : "Open the link and approve.").font(.system(size: 15)).foregroundStyle(Palette.muted)
        }
        HStack(spacing: 8) {
          Button { if let u = login.url.flatMap(URL.init(string:)) { openURL(u) } } label: {
            Text("Open \(ModelWords.host(login.url) ?? "the link")").font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
              .padding(.horizontal, 12).frame(height: 30).background(Capsule().fill(Palette.blue))
          }.buttonStyle(.press).accessibilityIdentifier("login-open")
          if let code = login.code {
            Button {
              UIPasteboard.general.string = code
              copied = true
              Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
            } label: {
              Text(copied ? "Copied" : "Copy code").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.text)
                .padding(.horizontal, 12).frame(height: 30).background(Capsule().fill(Palette.control))
                .contentTransition(.opacity)
            }.buttonStyle(.press).animation(Motion.pick(Motion.fade, reduceMotion), value: copied)
          }
        }
        if login.wantsInput == true && login.code == nil {
          HStack(spacing: 8) {
            TextField("Paste the code", text: $pasted).font(.system(size: 15, design: .monospaced))
              .textInputAutocapitalization(.never).autocorrectionDisabled()
              .padding(.horizontal, 12).frame(height: 38)
              .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Palette.field))
              .accessibilityIdentifier("login-paste")
            Button("Connect") { send() }.font(.system(size: 13, weight: .semibold)).buttonStyle(.plain).foregroundStyle(Palette.blue)
              .disabled(pasted.trimmed.isEmpty || action.busy)
          }
        }
        LoginWaiting(text: "Waiting for you to finish…")
      } else {
        HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Starting the sign-in on your computer…").font(.system(size: 13)).foregroundStyle(Palette.muted) }
      }
      InlineError(error: action.error)
    }
    .padding(16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
  }

  private func start() async {
    guard !starting else { return }
    starting = true; action.error = nil
    defer { starting = false }
    do { login = try await store.startModelLogin(provider: provider) } catch { action.error = error.localizedDescription }
  }

  private func poll() async {
    guard let id = login?.id, login?.running == true else { return }
    while !Task.isCancelled {
      do { try await Task.sleep(for: .seconds(1.5)) } catch { return }
      guard let next = try? await store.modelLogin(id) else { continue }
      if next != login { login = next }
      if next.status == "done" {
        try? await Task.sleep(for: .milliseconds(600))
        done(next.connectionId ?? "")
        return
      }
      if !next.running { return }
    }
  }

  private func send() {
    guard let id = login?.id else { return }
    let text = pasted.trimmed
    action.run {
      login = try await store.sendModelLoginCode(id, text: text)
      pasted = ""
    }
  }

  // MARK: key

  private func keyEntry(_ info: ModelProviderInfo) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Paste a \(label) API key.").font(.system(size: 15)).foregroundStyle(Palette.muted)
      SecureField(info.keyPrefix.map { "\($0)…" } ?? "API key", text: $key)
        .font(.system(size: 15, design: .monospaced)).textInputAutocapitalization(.never).autocorrectionDisabled()
        .padding(.horizontal, 12).frame(height: 40)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Palette.field))
        .accessibilityIdentifier("key-field")
      HStack(spacing: 12) {
        Button { connectKey() } label: {
          HStack(spacing: 6) {
            if action.busy { ProgressView().controlSize(.mini).tint(.white) }
            Text(action.busy ? "Checking" : "Connect")
          }
          .font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
          .padding(.horizontal, 14).frame(height: 30).background(Capsule().fill(Palette.blue))
        }
        .buttonStyle(.press).disabled(key.trimmed.count < 8 || action.busy).opacity(key.trimmed.count < 8 ? 0.4 : 1)
        .accessibilityIdentifier("key-connect")
        if let url = URL(string: info.keyUrl) {
          Link("Get a key", destination: url).font(.system(size: 13)).foregroundStyle(Palette.muted)
        }
      }
      InlineError(error: action.error)
    }
    .padding(16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
  }

  private func connectKey() {
    let value = key.trimmed
    action.run {
      let c = try await store.connectKey(provider: provider, key: value, label: nil)
      key = ""
      done(c.id)
    }
  }
}

/** "● Waiting for you to finish…": the dot breathes unless motion is off. */
struct LoginWaiting: View {
  var text: String
  @ReduceMotion private var reduceMotion
  @State private var on = false

  var body: some View {
    HStack(spacing: 7) {
      Circle().fill(MarketColor.warn).frame(width: 7, height: 7)
        .opacity(reduceMotion ? 1 : (on ? 0.35 : 1))
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: on)
      Text(text).font(.system(size: 12)).foregroundStyle(Palette.faint)
    }
    .onAppear { on = true }
    .accessibilityElement(children: .combine)
  }
}

/** The same tight segmented look as the effort control, for two labeled choices. */
struct EffortStyleSegments: View {
  var options: [(String, String)]
  @Binding var selection: String
  @ReduceMotion private var reduceMotion
  @Namespace private var ns

  var body: some View {
    HStack(spacing: 2) {
      ForEach(options, id: \.0) { option in
        let on = option.0 == selection
        Button { selection = option.0 } label: {
          Text(option.1).font(.system(size: 13, weight: .medium))
            .foregroundStyle(on ? Palette.text : Palette.muted)
            .frame(maxWidth: .infinity, minHeight: 32)
            .background {
              if on { RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Palette.selected).matchedGeometryEffect(id: "on", in: ns) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("segment-\(option.0)")
      }
    }
    .padding(2)
    .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Palette.control))
    .animation(Motion.pick(Motion.soft, reduceMotion), value: selection)
  }
}
