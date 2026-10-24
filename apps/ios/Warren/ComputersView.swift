import SwiftUI

/** Agents' computers: watch any of them live, take control when one needs you, and hand it back. */
struct ComputersView: View {
  @Environment(Store.self) private var store
  @State private var path: [String] = []

  var body: some View {
    NavigationStack(path: $path) {
      ScrollView {
        if store.computers.isEmpty {
          ContentUnavailableView("No computers yet", systemImage: "desktopcomputer", description: Text("Give an agent a computer from Warren on your computer: a VM on one of your devices, or an Orgo cloud computer."))
            .padding(.top, 80)
        }
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 300), spacing: 16)], spacing: 16) {
          ForEach(store.computers) { c in
            NavigationLink(value: c.id) {
              VStack(alignment: .leading, spacing: 8) {
                ScreenThumb(computer: c)
                HStack(alignment: .firstTextBaseline) {
                  VStack(alignment: .leading, spacing: 2) {
                    Text(c.name).font(.headline)
                    Text(c.kindLabel).font(.caption).foregroundStyle(.secondary)
                  }
                  Spacer()
                  ComputerStatus(computer: c)
                }
                if let help = c.help {
                  Label("\(store.agent(help.agentId)?.name ?? "An agent") needs you: \(help.request)", systemImage: "hand.raised.fill")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.orange)
                    .lineLimit(2)
                }
              }
              .card(Corner.card, padding: 10)
            }
            .buttonStyle(.plain)
          }
        }
        .padding(16)
      }
      .navigationTitle("Computers")
      .refreshable { await store.refreshComputers() }
      .navigationDestination(for: String.self) { ComputerDetail(computerId: $0) }
    }
    .task(id: store.route) {
      // a tapped "needs you on its computer" notification
      guard case .computer(let id) = store.route else { return }
      store.route = nil
      if !store.computers.contains(where: { $0.id == id }) { await store.refreshComputers() }
      path = [id]
    }
  }
}

struct ComputerStatus: View {
  var computer: Computer
  var body: some View {
    let (word, color): (String, Color) = switch computer.status {
    case "ready": computer.controller != nil ? ("You're in control", .orange) : ("Ready", .green)
    case "starting": ("Starting", .blue)
    case "error": ("Problem", .red)
    case "stopped": ("Stopped", .gray)
    default: ("Offline", .gray)
    }
    HStack(spacing: 5) {
      GlowDot(color: color)
      Text(word).font(.caption.weight(.medium)).foregroundStyle(.secondary)
    }
  }
}

/** The latest screen, refreshed every few seconds while it's visible. */
struct ScreenThumb: View {
  @Environment(Store.self) private var store
  var computer: Computer
  @State private var image: UIImage?

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color(.secondarySystemBackground))
      if let image, computer.status == "ready", computer.code == nil {
        Image(uiImage: image).resizable().scaledToFit()
      } else {
        Image(systemName: computer.code != nil ? "lock" : computer.status == "ready" ? "display" : "moon.zzz")
          .font(.title)
          .foregroundStyle(.tertiary)
      }
    }
    .aspectRatio(16 / 10, contentMode: .fit)
    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Color(.separator).opacity(0.5)))
    .task(id: "\(computer.id):\(computer.status):\(computer.code ?? ""):\(store.session)") {
      image = nil
      // a screen with a code opens only with it, from its own page
      guard computer.status == "ready", computer.code == nil else { return }
      while !Task.isCancelled {
        do {
          let f = try await store.screen(computer, maxAge: 5000)
          try Task.checkCancellation()
          image = UIImage(data: f.image)
        } catch {
          if Task.isCancelled { return }
          image = nil
        }
        do { try await Task.sleep(for: .seconds(5)) } catch { return }
      }
    }
  }
}

struct ComputerDetail: View {
  @Environment(Store.self) private var store
  var computerId: String
  @State private var frame: Frame?
  @State private var image: UIImage?
  @State private var error: String?
  @State private var busy = false
  @State private var typing = ""
  @State private var sendingTyping = false
  @State private var imageCode: String?
  @State private var lastTap: CGPoint?

  private var computer: Computer? { store.computers.first { $0.id == computerId } }
  private var inControl: Bool { computer?.controller?.id == store.me?.id && computer?.controller != nil }

  @State private var keyboard = false
  @State private var note: String?
  @FocusState private var typingFocused: Bool
  /** a screen with a code: asking for it, what the device said about the last one, and a retry */
  @State private var needCode = false
  @State private var codeError: String?
  @State private var codeTry = 0

  var body: some View {
    if let c = computer {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          if let help = c.help {
            HStack(alignment: .top, spacing: 12) {
              AgentAvatar(agent: store.agent(help.agentId), size: 36, showStatus: false)
              VStack(alignment: .leading, spacing: 3) {
                Text("\(store.agent(help.agentId)?.name ?? "An agent") needs you").font(.subheadline.weight(.semibold))
                Text(help.request).font(.callout)
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).fill(Color.orange.opacity(0.14)))
          }

          screen(c)
            .overlay(alignment: .bottom) {
              if let note {
                Text(note).font(.footnote.weight(.medium)).padding(.horizontal, 14).padding(.vertical, 8).glassCapsule().padding(10).transition(.opacity)
              }
            }

          if inControl { controls(c) }

          if c.status == "ready" {
            controlButton(c)
          } else {
            HStack { ComputerStatus(computer: c); Spacer() }
          }
          Text(hint(c)).font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity)
          if let error { Text(error).font(.footnote).foregroundStyle(.red) }
          if c.kind == "device" { LendPanel(computer: c) }
        }
        .padding(16)
      }
      .navigationTitle(c.name)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .topBarTrailing) { ComputerStatus(computer: c) } }
      .toolbar(.hidden, for: .tabBar)
      .task(id: "\(c.status) \(c.code ?? "") \(codeTry) \(store.session)") { await stream(c) }
    } else {
      ContentUnavailableView("Computer not found", systemImage: "desktopcomputer.trianglebadge.exclamationmark")
    }
  }

  private func hint(_ c: Computer) -> String {
    if c.status != "ready" { return c.statusText.isEmpty ? "It starts when an agent next uses it." : c.statusText }
    if inControl { return "Tap the screen to click. Agents wait until you hand it back." }
    if c.controller != nil { return "Someone else is using it right now." }
    return c.help != nil ? "Take control, do it on the screen, then hand it back." : "Watching live. Take control to use it yourself."
  }

  /** While you're in control: a keyboard, scrolling, and the rest tucked in a menu. */
  @ViewBuilder private func controls(_ c: Computer) -> some View {
    VStack(spacing: 10) {
      if keyboard {
        HStack(spacing: 6) {
          TextField("Type on \(c.name)", text: $typing)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .focused($typingFocused)
            .submitLabel(.send)
            .disabled(sendingTyping)
            .onSubmit { sendTyping(c, enter: true) }
            .padding(.leading, 16)
            .padding(.vertical, 12)
          Button { sendTyping(c, enter: false) } label: {
            Image(systemName: "arrow.up").font(.body.weight(.bold)).foregroundStyle(Color(.systemBackground)).frame(width: 34, height: 34).background(Circle().fill(Color.primary))
          }
          .buttonStyle(.plain)
          .disabled(typing.isEmpty || sendingTyping)
          .opacity(typing.isEmpty ? 0.25 : 1)
          .padding(5)
        }
        .glass(22, interactive: true)
      }
      HStack(spacing: 10) {
        toolButton(keyboard ? "keyboard.chevron.compact.down" : "keyboard", "Keyboard") {
          keyboard.toggle()
          typingFocused = keyboard
        }
        toolButton("chevron.up", "Scroll up") { scroll(c, "up") }
        toolButton("chevron.down", "Scroll down") { scroll(c, "down") }
        Menu {
          Section("Keys") {
            Button("Return", systemImage: "return") { key(c, "Enter") }
            Button("Tab", systemImage: "arrow.right.to.line") { key(c, "Tab") }
            Button("Escape", systemImage: "escape") { key(c, "Escape") }
            Button("Delete", systemImage: "delete.left") { key(c, "Backspace") }
          }
          Section("Clipboard") {
            Button("Paste from iPhone", systemImage: "doc.on.clipboard") { pasteFromPhone(c) }
            Button("Copy to iPhone", systemImage: "iphone.and.arrow.forward") { copyToPhone(c) }
          }
        } label: {
          Image(systemName: "ellipsis").font(.title3.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
        }
        .glass(18, interactive: true)
        .accessibilityLabel("More")
      }
      .foregroundStyle(.primary)
    }
  }

  private func toolButton(_ symbol: String, _ label: String, _ action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: symbol).font(.title3.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .glass(18, interactive: true)
    .accessibilityLabel(label)
  }

  private func flash(_ text: String) {
    withAnimation { note = text }
    Task {
      try? await Task.sleep(for: .seconds(2))
      withAnimation { if note == text { note = nil } }
    }
  }

  /** What you copied on this iPhone goes onto the computer's clipboard, then pastes where its cursor is. */
  private func pasteFromPhone(_ c: Computer) {
    guard let text = UIPasteboard.general.string, !text.isEmpty else { return flash("Nothing copied on this iPhone") }
    Task {
      do {
        try await store.setClipboard(c, text)
        try await store.act(c, ["action": AnyEncodable("key"), "keys": AnyEncodable(await store.pasteKeys(c))])
        flash("Pasted from iPhone")
      } catch { self.error = error.localizedDescription }
    }
  }

  private func copyToPhone(_ c: Computer) {
    Task {
      do {
        let text = try await store.clipboard(c)
        if text.isEmpty { return flash("Nothing copied on \(c.name)") }
        UIPasteboard.general.string = text
        flash("Copied to iPhone")
      } catch { self.error = error.localizedDescription }
    }
  }

  @ViewBuilder private func screen(_ c: Computer) -> some View {
    ZStack {
      RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color.black)
      if let image, c.status == "ready", !needCode, imageCode == c.code {
        GeometryReader { geo in
          let fit = fitted(in: geo.size)
          Image(uiImage: image)
            .resizable()
            .frame(width: fit.width, height: fit.height)
            .position(x: geo.size.width / 2, y: geo.size.height / 2)
            .overlay {
              if let p = lastTap {
                Circle().stroke(Color.white, lineWidth: 2).frame(width: 26, height: 26).position(p).allowsHitTesting(false)
              }
            }
            .contentShape(Rectangle())
            .onTapGesture(coordinateSpace: .local) { pt in tap(c, at: pt, in: geo.size) }
        }
      } else if needCode && c.status == "ready" {
        CodePrompt(computer: c, error: codeError) { code in
          store.screenCodes[c.id] = code
          codeError = nil
          codeTry += 1
        }
        .padding(20)
      } else if c.status == "ready" {
        ProgressView().tint(.white)
      } else {
        Text(c.status == "starting" ? "Starting…" : "This computer isn't running").foregroundStyle(.white.opacity(0.7)).font(.callout)
      }
    }
    .aspectRatio(frame.map { CGFloat(max($0.width, 1)) / CGFloat(max($0.height, 1)) } ?? 16 / 10, contentMode: needCode ? .fill : .fit)
    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(inControl ? Color.blue : .clear, lineWidth: 3))
    .shadow(color: inControl ? Color.blue.opacity(0.35) : .clear, radius: 14)
  }

  @ViewBuilder private func controlButton(_ c: Computer) -> some View {
    let button = Button {
      busy = true
      Task {
        do { try await store.control(c, take: !inControl) } catch { self.error = error.localizedDescription }
        if !inControl { keyboard = false }
        busy = false
      }
    } label: {
      Label(inControl ? "Hand back" : "Take control", systemImage: inControl ? "hand.wave.fill" : "hand.point.up.left.fill")
        .fontWeight(.semibold)
        .frame(maxWidth: .infinity)
    }
    .disabled(busy || (c.controller != nil && !inControl))
    if inControl { button.secondaryButton().controlSize(.large) } else { button.primaryButton() }
  }

  private func fitted(in size: CGSize) -> CGSize {
    guard let f = frame, f.width > 0, f.height > 0 else { return size }
    let s = min(size.width / CGFloat(f.width), size.height / CGFloat(f.height))
    return CGSize(width: CGFloat(f.width) * s, height: CGFloat(f.height) * s)
  }

  /** About two frames a second while it's on screen; faster feels no better on a phone. */
  private func stream(_ c: Computer) async {
    image = nil; frame = nil; lastTap = nil
    imageCode = c.code
    guard c.status == "ready" else { return }
    if c.code != nil { return await streamWithCode(c) }
    needCode = false
    while !Task.isCancelled {
      do {
        let f = try await store.screen(c, maxAge: 1000)
        try Task.checkCancellation()
        if let img = UIImage(data: f.image) {
          frame = f.width > 0 ? f : Frame(image: f.image, width: Int(img.size.width), height: Int(img.size.height))
          image = img
          error = nil
        }
      } catch {
        if Task.isCancelled { return }
        image = nil; frame = nil
        self.error = error.localizedDescription
        try? await Task.sleep(for: .seconds(2))
      }
      try? await Task.sleep(for: .milliseconds(450))
    }
  }

  /**
   * A screen with a code: open it with the code (asked once while the app is open), and keep the
   * live view's socket open, which keeps it open. Its frames come over the socket; with Remote
   * Desktop the socket only holds the screen open and the picture comes from screenshots.
   */
  private func streamWithCode(_ c: Computer) async {
    guard let code = store.screenCodes[c.id] else {
      image = nil
      needCode = true
      return
    }
    needCode = false
    while !Task.isCancelled {
      let view: Store.LiveView, ws: URLSessionWebSocketTask
      do {
        (view, ws) = try await store.openView(c, code: code)
      } catch let f as API.Failure where f.status == 403 {
        guard !Task.isCancelled else { return }
        // a wrong code, or too many: ask again with what the device said
        store.screenCodes[c.id] = nil
        image = nil
        codeError = f.message
        needCode = true
        return
      } catch {
        if Task.isCancelled { return }
        image = nil; frame = nil
        self.error = error.localizedDescription
        try? await Task.sleep(for: .seconds(2))
        continue
      }
      await withTaskCancellationHandler {
        guard !Task.isCancelled else { return }
        ws.resume()
        error = nil
        if view.transport == "frames" {
          struct Msg: Decodable { var type: String; var image: String?; var width: Int?; var height: Int?; var message: String? }
          while !Task.isCancelled {
            guard let m = try? await ws.receive(), !Task.isCancelled else { break }
            guard case .string(let text) = m, let msg = try? JSONDecoder().decode(Msg.self, from: Data(text.utf8)) else { continue }
            if msg.type == "error" { self.error = msg.message; image = nil; frame = nil; break }
            guard msg.type == "frame", let b64 = msg.image, let data = Data(base64Encoded: b64), let img = UIImage(data: data) else { continue }
            frame = Frame(image: data, width: msg.width ?? Int(img.size.width), height: msg.height ?? Int(img.size.height))
            image = img
          }
        } else {
          let drain = Task { while (try? await ws.receive()) != nil {} }
          while !Task.isCancelled, ws.state == .running {
            do {
              let f = try await store.screen(c, maxAge: 1000)
              try Task.checkCancellation()
              if let img = UIImage(data: f.image) {
                frame = f.width > 0 ? f : Frame(image: f.image, width: Int(img.size.width), height: Int(img.size.height))
                image = img
                error = nil
              }
            } catch {
              if Task.isCancelled { break }
              image = nil; frame = nil
              self.error = error.localizedDescription
              try? await Task.sleep(for: .seconds(2))
            }
            try? await Task.sleep(for: .milliseconds(450))
          }
          drain.cancel()
        }
      } onCancel: {
        ws.cancel(with: .goingAway, reason: nil)
      }
      ws.cancel(with: .goingAway, reason: nil)
      if Task.isCancelled { return }
      image = nil; frame = nil
      try? await Task.sleep(for: .seconds(1))
    }
  }

  private func tap(_ c: Computer, at pt: CGPoint, in size: CGSize) {
    guard inControl, let f = frame else { return }
    let fit = fitted(in: size)
    let ox = (size.width - fit.width) / 2, oy = (size.height - fit.height) / 2
    let x = (pt.x - ox) / fit.width * CGFloat(f.width), y = (pt.y - oy) / fit.height * CGFloat(f.height)
    guard x >= 0, y >= 0, x <= CGFloat(f.width), y <= CGFloat(f.height) else { return }
    lastTap = pt
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    perform(c, ["action": AnyEncodable("click"), "x": AnyEncodable(Double(x)), "y": AnyEncodable(Double(y)), "space": AnyEncodable(["width": f.width, "height": f.height])])
    Task {
      try? await Task.sleep(for: .milliseconds(600))
      lastTap = nil
    }
  }

  private func sendTyping(_ c: Computer, enter: Bool) {
    guard !sendingTyping else { return }
    let text = typing
    sendingTyping = true
    Task {
      defer { sendingTyping = false }
      do {
        if !text.isEmpty { try await store.act(c, ["action": AnyEncodable("type"), "text": AnyEncodable(text)]) }
        typing = ""
        if enter { try await store.act(c, ["action": AnyEncodable("key"), "keys": AnyEncodable("Enter")]) }
        error = nil
      } catch { self.error = error.localizedDescription }
    }
  }

  private func key(_ c: Computer, _ k: String) { perform(c, ["action": AnyEncodable("key"), "keys": AnyEncodable(k)]) }

  private func scroll(_ c: Computer, _ dir: String) {
    guard let f = frame else { return }
    perform(c, ["action": AnyEncodable("scroll"), "x": AnyEncodable(f.width / 2), "y": AnyEncodable(f.height / 2), "direction": AnyEncodable(dir), "amount": AnyEncodable(3)])
  }

  private func perform(_ c: Computer, _ action: [String: AnyEncodable]) {
    Task {
      do { try await store.act(c, action) } catch { self.error = error.localizedDescription }
    }
  }
}

/** The box for a screen's code: six digits, or a password. Typed codes stay in memory only. */
struct ScreenCodeField: View {
  var kind: String
  @Binding var code: String
  var onSubmit: () -> Void = {}

  static func ready(_ kind: String?, _ code: String) -> Bool { kind == nil || (kind == "pin" ? code.count == 6 : !code.isEmpty) }

  var body: some View {
    SecureField(kind == "pin" ? "6-digit PIN" : "Password", text: $code)
      .keyboardType(kind == "pin" ? .numberPad : .default)
      .textContentType(.oneTimeCode) // keeps iOS from offering to save it as a password
      .textInputAutocapitalization(.never)
      .autocorrectionDisabled()
      .submitLabel(.go)
      .onSubmit { if Self.ready(kind, code) { onSubmit() } }
      .onChange(of: code) { _, v in
        if kind == "pin" {
          let digits = String(v.filter(\.isNumber).prefix(6))
          if digits != v { code = digits }
        } else if v.count > 200 { code = String(v.prefix(200)) }
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 11)
      .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color(.secondarySystemBackground)))
      .accessibilityLabel("The screen's \(kind == "pin" ? "PIN" : "password")")
  }
}

/** Asking for the code before a screen opens, on the dark screen background. */
private struct CodePrompt: View {
  var computer: Computer
  var error: String?
  var onSubmit: (String) -> Void
  @State private var code = ""

  var body: some View {
    VStack(spacing: 12) {
      Image(systemName: "lock").font(.title2).foregroundStyle(.white.opacity(0.7))
      Text("Enter \(computer.name)'s \(computer.codeLabel) to open it.").font(.callout).foregroundStyle(.white).multilineTextAlignment(.center)
      ScreenCodeField(kind: computer.code ?? "pin", code: $code) { submit() }
        .frame(maxWidth: 240)
        .environment(\.colorScheme, .light)
      // wraps instead of trailing off: the screen box proposes more width than it shows
      if let error { Text(error).font(.footnote).foregroundStyle(.red.opacity(0.9)).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true) }
      Button("Open") { submit() }
        .buttonStyle(.bordered)
        .tint(.white)
        .disabled(!ScreenCodeField.ready(computer.code, code))
    }
  }

  private func submit() {
    guard ScreenCodeField.ready(computer.code, code) else { return }
    onSubmit(code)
    code = ""
  }
}

/** Your own screen: lend it to agents for a while. They use it only for things you ask them. */
private struct LendPanel: View {
  @Environment(Store.self) private var store
  var computer: Computer
  @State private var code = ""
  @State private var busy = false
  @State private var error: String?

  private static let options: [(label: String, minutes: Int?, today: Bool)] = [("1 hour", 60, false), ("4 hours", 240, false), ("Today", nil, true), ("Until I stop it", nil, false)]

  var body: some View {
    let c = computer
    VStack(alignment: .leading, spacing: 10) {
      Label("Your own screen", systemImage: "lock").font(.subheadline.weight(.semibold))
      Text(c.lentNow ? "Only you can see it. Agents can use it \(Self.label(c.config?.lend?.until)), and only for things you ask them." : "Only you can see it. Agents can't use it right now; they work on their own VMs.")
        .font(.footnote)
        .foregroundStyle(.secondary)
      if c.lentNow {
        Button("Stop lending it") { run { try await store.stopLending(c) } }
          .secondaryButton()
          .disabled(busy)
      } else {
        if let kind = c.code { ScreenCodeField(kind: kind, code: $code) }
        Text("Lend it to agents for").font(.footnote.weight(.medium))
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), spacing: 8)], spacing: 8) {
          ForEach(Self.options, id: \.label) { o in
            Button {
              let minutes = o.today ? Self.untilTonight() : o.minutes
              let typed = c.code != nil ? code : nil
              run {
                try await store.lend(c, minutes: minutes, code: typed)
                code = ""
              }
            } label: {
              Text(o.label).frame(maxWidth: .infinity)
            }
            .secondaryButton()
            .disabled(busy || !ScreenCodeField.ready(c.code, code))
          }
        }
      }
      if let error { Text(error).font(.footnote).foregroundStyle(.red) }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .card(Corner.card, padding: 14)
  }

  private func run(_ work: @escaping () async throws -> Void) {
    busy = true
    error = nil
    Task {
      do { try await work() } catch { self.error = error.localizedDescription }
      busy = false
    }
  }

  static func untilTonight() -> Int {
    var end = Calendar.current.dateComponents([.year, .month, .day], from: Date())
    end.hour = 23
    end.minute = 59
    let t = Calendar.current.date(from: end) ?? Date()
    return max(1, Int((t.timeIntervalSinceNow / 60).rounded()))
  }

  static func label(_ until: String?) -> String {
    guard let until, let d = Wire.date(until) else { return "until you stop it" }
    let f = DateFormatter()
    f.setLocalizedDateFormatFromTemplate(Calendar.current.isDateInToday(d) ? "jmm" : "EEEjmm")
    return "until \(f.string(from: d))"
  }
}
