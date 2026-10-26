import SwiftUI

// One computer, live: its screen, taking control and handing back, keys, clipboard, files, details
// and the activity log, teaching a task (comp-Detail.dc.html, comp-Control.dc.html and friends).
// The Computers tab itself is in ComputersHome.swift.

/** The latest screen, refreshed every few seconds while it's visible. */
struct ScreenThumb: View {
  @Environment(Store.self) private var store
  var computer: Computer
  var radius: CGFloat = 18
  @State private var image: UIImage?

  var body: some View {
    let live = image != nil && computer.status == "ready" && computer.code == nil
    ZStack {
      RoundedRectangle(cornerRadius: radius, style: .continuous).fill(Color(hex: 0x0D0D0F))
      if let image, live {
        Image(uiImage: image).resizable().scaledToFit()
      } else {
        Image(systemName: computer.code != nil ? "lock" : computer.status == "ready" ? "display" : "moon.zzz")
          .font(.system(size: radius > 14 ? 26 : 16))
          .foregroundStyle(Color.white.opacity(0.35))
      }
    }
    .aspectRatio(16 / 10, contentMode: .fit)
    .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Palette.hairline))
    .opacity(computer.isOnline ? 1 : 0.6)
    .task(id: "\(computer.id):\(computer.status):\(computer.code ?? ""):\(store.session)") {
      image = nil
      // a screen with a code opens only with it, from its own page
      guard store.canViewComputers, computer.status == "ready", computer.code == nil else { return }
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
  @State private var showCodeSheet = false
  @State private var codeError: String?
  @State private var codeTry = 0
  /** the menu's sheets and questions */
  @Environment(\.dismiss) private var dismiss
  @State private var showDetails = false
  @State private var showFiles = false
  @State private var showClipboard = false
  @State private var renaming = false
  @State private var newName = ""
  @State private var removing = false
  @State private var sharing: SharedFile?
  @State private var handingBack = false
  @State private var helpLater = false
  /** teaching a task: choosing who learns it, recording, naming it, and where to look afterwards */
  @State private var pickingTeacher = false
  @State private var teach: TeachSession?
  @State private var savingLesson = false
  @State private var lessonAgent: Agent?

  var body: some View {
    if store.canViewComputers, let c = computer {
      VStack(spacing: 0) {
        TopBar {
          CircleButton(symbol: "chevron.left", label: "Back", id: "computer-back") { dismiss() }
        } center: {
          NamePill(title: c.name) {
            if let a = c.agentIds.first.flatMap({ store.agent($0) }) { AgentAvatar(agent: a, size: 24, showStatus: false) }
          }
        } trailing: {
          moreMenu(c)
        }
        ScrollView {
          VStack(alignment: .leading, spacing: 14) {
            if let help = c.help, !helpLater, !inControl { helpCard(c, help) }
            if let teach { TeachBar(session: teach, cancel: { stopTeaching(c) }, done: { savingLesson = true }) }

            screen(c)
              .overlay(alignment: .bottom) {
                if let note {
                  Text(note).font(.footnote.weight(.medium)).padding(.horizontal, 14).padding(.vertical, 8).glassCapsule().padding(10).transition(.opacity)
                }
              }

            statusLine(c)
            if inControl { controls(c) }
            if c.status == "ready", teach == nil { controlButton(c) }
            if c.isOnline { chips(c) }
            rows(c)
            Text(hint(c)).font(.footnote).foregroundStyle(Palette.faint).frame(maxWidth: .infinity)
            if let error { Text(error).font(.footnote).foregroundStyle(Palette.red) }
            if c.kind == "device" { OwnScreenNote() }
          }
          .padding(.horizontal, 18).padding(.top, 6).padding(.bottom, 30)
        }
      }
      .background(Palette.ground.ignoresSafeArea())
      .toolbar(.hidden, for: .navigationBar)
      .toolbar(.hidden, for: .tabBar)
      .tint(Palette.text)
      .task(id: "\(c.status) \(c.code ?? "") \(codeTry) \(store.session)") { await stream(c) }
      .task { if store.nodes.isEmpty { try? await store.refreshNodes() } }
      .onDisappear { if let c = computer, teach != nil { stopTeaching(c) } }
      .onChange(of: needCode) { _, now in showCodeSheet = now }
      .sheet(isPresented: $showDetails) { ComputerDetailsView(computerId: c.id) }
      .sheet(isPresented: $showFiles) { ComputerFilesView(computerId: c.id) }
      .sheet(isPresented: $showClipboard) { ComputerClipboardView(computerId: c.id) }
      .sheet(item: $sharing) { ShareSheet(items: [$0.url]).ignoresSafeArea() }
      .sheet(isPresented: $pickingTeacher) { TeachAgentPicker(computer: c) { startTeaching(c, with: $0) } }
      .sheet(isPresented: $showCodeSheet) {
        ScreenCodeSheet(computer: c, deviceName: store.nodes.first { $0.id == c.nodeId }?.name ?? c.name, error: codeError) { code in
          store.screenCodes[c.id] = code
          codeError = nil
          codeTry += 1
        }
      }
      .sheet(isPresented: $handingBack) {
        HandBackSheet(agentName: store.agent(c.help?.agentId ?? c.agentIds.first ?? "")?.name ?? "the agent") { handBack(c, note: $0) }
      }
      .sheet(isPresented: $savingLesson) {
        if let teach { TeachSaveSheet(session: teach, computer: c) { lessonSaved(c, teach.agent) } }
      }
      .sheet(item: $lessonAgent) { a in NavigationStack { RoutinesView(agent: a).toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { lessonAgent = nil } } } } }
      .alert("Rename", isPresented: $renaming) {
        TextField("Name", text: $newName)
        Button("Cancel", role: .cancel) {}
        Button("Save") { rename(c) }
      }
      .confirmationDialog("Remove \(c.name)?", isPresented: $removing, titleVisibility: .visible) {
        Button(c.kind == "device" ? "Stop sharing this screen" : "Remove", role: .destructive) { remove(c) }
      } message: {
        Text(ComputerRights.removeWarning(c))
      }
    } else if store.canViewComputers {
      ContentUnavailableView("Computer not found", systemImage: "desktopcomputer.trianglebadge.exclamationmark")
    }
  }

  // MARK: pieces

  /** "Ghosty needs you on this computer": take over, or not now. */
  private func helpCard(_ c: Computer, _ help: Computer.Help) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 12) {
        AgentAvatar(agent: store.agent(help.agentId), size: 36, showStatus: false)
        VStack(alignment: .leading, spacing: 3) {
          Text("\(store.agent(help.agentId)?.name ?? "An agent") needs you on this computer").font(.system(size: 16, weight: .semibold)).foregroundStyle(Palette.text)
          Text(help.request).font(.system(size: 14)).foregroundStyle(Palette.muted)
        }
      }
      HStack(spacing: 10) {
        Button { takeControl(c) } label: { Text("Take over").frame(maxWidth: .infinity) }.primaryButton().controlSize(.large).disabled(busy || c.status != "ready" || c.controller != nil)
        Button { helpLater = true } label: { Text("Not now").frame(maxWidth: .infinity) }.secondaryButton().controlSize(.large)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).fill(Palette.card))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.blue.opacity(0.5)))
    .accessibilityIdentifier("computer-help")
  }

  /** What's happening, in one line, with the state pill. */
  @ViewBuilder private func statusLine(_ c: Computer) -> some View {
    let s = store.state(of: c)
    HStack(spacing: 10) {
      if s.working { WorkingDots(color: Palette.faint) }
      Text(statusText(c, s)).font(.system(size: 14)).foregroundStyle(Palette.muted).frame(maxWidth: .infinity, alignment: .leading).lineLimit(2)
      ComputerPill(text: s.label, tone: s.tone)
    }
    .padding(.horizontal, 4)
  }

  private func statusText(_ c: Computer, _ s: ComputerState) -> String {
    let who = c.agentIds.first.flatMap { store.agent($0)?.name } ?? "The agent"
    if inControl { return "You are in control. \(who) is paused." }
    if s.working, let a = c.activity { return "\(store.agent(a.agentId)?.name ?? who) is working · \(a.text)" }
    if c.status != "ready" { return c.statusText.isEmpty ? "It starts when an agent next uses it." : c.statusText }
    return store.doing(c)
  }

  /** Keys, Clipboard, Files, Screenshot. */
  @ViewBuilder private func chips(_ c: Computer) -> some View {
    HStack(spacing: 10) {
      if inControl {
        Menu {
          Button("Return", systemImage: "return") { key(c, "Enter") }
          Button("Tab", systemImage: "arrow.right.to.line") { key(c, "Tab") }
          Button("Escape", systemImage: "escape") { key(c, "Escape") }
          Button("Delete", systemImage: "delete.left") { key(c, "Backspace") }
        } label: { ChipFace(symbol: "keyboard", title: "Keys") }
          .accessibilityIdentifier("chip-keys")
      } else {
        ChipFace(symbol: "keyboard", title: "Keys").opacity(0.4).accessibilityHidden(true)
      }
      if c.canTransfer {
        if inControl {
          Menu {
            Button("Paste from iPhone", systemImage: "doc.on.clipboard") { pasteFromPhone(c) }
            Button("Copy to iPhone", systemImage: "iphone.and.arrow.forward") { copyToPhone(c) }
            Button("Send text or open a link…", systemImage: "link") { showClipboard = true }
          } label: { ChipFace(symbol: "doc.on.clipboard", title: "Clipboard") }
            .accessibilityIdentifier("chip-clipboard")
        } else {
          Button { showClipboard = true } label: { ChipFace(symbol: "doc.on.clipboard", title: "Clipboard") }.buttonStyle(.plain).accessibilityIdentifier("chip-clipboard")
        }
        Button { showFiles = true } label: { ChipFace(symbol: "folder", title: "Files") }.buttonStyle(.plain).accessibilityIdentifier("chip-files")
        if c.status == "ready" { Button { screenshot(c) } label: { ChipFace(symbol: "camera", title: "Screenshot") }.buttonStyle(.plain).accessibilityIdentifier("chip-screenshot") }
      }
    }
  }

  /** Details, the agents on it, and Teach a task. */
  @ViewBuilder private func rows(_ c: Computer) -> some View {
    let agents = c.agentIds.compactMap { store.agent($0) }
    CardGroup {
      Button { showDetails = true } label: { RowLabel(title: "Details", value: store.state(of: c).label) }.buttonStyle(.plain).accessibilityIdentifier("computer-details")
      Button { showDetails = true } label: {
        RowLabel(title: "Agents on this computer", value: agents.isEmpty ? "None" : agents.map(\.name).joined(separator: ", "))
      }.buttonStyle(.plain)
      if store.features.teach, c.canTransfer, c.status == "ready", teach == nil, c.controller == nil || inControl {
        Button { pickingTeacher = true } label: {
          RowLabel(title: "Teach a task", subtitle: "Show \(agents.first?.name ?? "an agent") once, it learns")
        }.buttonStyle(.plain).accessibilityIdentifier("computer-teach")
      }
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
      }
      .foregroundStyle(Palette.text)
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

  // MARK: the menu

  private func canRemove(_ c: Computer) -> Bool {
    ComputerRights.canRemove(c, userId: store.me?.id, role: store.role, nodes: store.nodes)
  }

  @ViewBuilder private func moreMenu(_ c: Computer) -> some View {
    Menu {
      Button("Rename", systemImage: "pencil") { newName = c.name; renaming = true }
      if c.canTransfer, c.status == "ready" {
        Button("Save a screenshot", systemImage: "camera") { screenshot(c) }
      }
      if c.kind != "device" {
        let stopped = c.status == "stopped"
        Button(stopped ? "Start this computer" : "Stop this computer", systemImage: stopped ? "play" : "power") { setRunning(c, stopped) }
      }
      if canRemove(c) {
        Divider()
        Button(c.kind == "device" ? "Stop sharing this screen" : "Remove", systemImage: "trash", role: .destructive) { removing = true }
      }
    } label: {
      CircleLabel(symbol: "ellipsis")
    }
    .accessibilityLabel("More")
    .accessibilityIdentifier("computer-more")
  }

  private func screenshot(_ c: Computer) {
    Task {
      do { sharing = SharedFile(url: try await store.screenshotFile(c)) } catch is Store.Stale {} catch { self.error = error.localizedDescription }
    }
  }

  private func rename(_ c: Computer) {
    let name = newName.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty, name != c.name else { return }
    Task {
      do { try await store.renameComputer(c, to: name); error = nil } catch is Store.Stale {} catch { self.error = error.localizedDescription }
    }
  }

  private func setRunning(_ c: Computer, _ running: Bool) {
    Task {
      do { try await store.setComputerRunning(c, running); error = nil } catch is Store.Stale {} catch { self.error = error.localizedDescription }
    }
  }

  private func remove(_ c: Computer) {
    Task {
      do {
        try await store.removeComputer(c)
        dismiss()
      } catch is Store.Stale {} catch { self.error = error.localizedDescription }
    }
  }

  private func handBack(_ c: Computer, note: String?) {
    busy = true
    keyboard = false
    Task {
      do { try await store.handBack(c, note: note); error = nil } catch is Store.Stale {} catch { self.error = error.localizedDescription }
      busy = false
    }
  }

  // MARK: teaching

  /** Teaching needs control, so take it first if you don't have it. */
  private func startTeaching(_ c: Computer, with agent: Agent) {
    busy = true
    Task {
      do {
        if !inControl { try await store.control(c, take: true) }
        teach = TeachSession(agent: agent)
        error = nil
      } catch is Store.Stale {} catch { self.error = error.localizedDescription }
      busy = false
    }
  }

  /** Cancel: forget what was recorded and give the computer back. */
  private func stopTeaching(_ c: Computer) {
    teach = nil
    savingLesson = false
    keyboard = false
    Task { try? await store.handBack(c, note: nil) }
  }

  private func lessonSaved(_ c: Computer, _ agent: Agent) {
    teach = nil
    keyboard = false
    Task {
      try? await store.handBack(c, note: nil)
      if store.features.routines { lessonAgent = agent } else { flash("Saved. \(agent.name) is learning it") }
    }
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
        let paste = await store.pasteKeys(c)
        teach?.record(store, c, kind: "key", keys: paste)
        try await store.act(c, ["action": AnyEncodable("key"), "keys": AnyEncodable(paste)])
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
      RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Color(hex: 0x0D0D0F))
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
        VStack(spacing: 10) {
          Image(systemName: "lock").font(.title2).foregroundStyle(.white.opacity(0.7))
          Text("Enter \(c.name)'s \(c.codeLabel) to open it.").font(.callout).foregroundStyle(.white).multilineTextAlignment(.center)
          Button("Enter \(c.codeLabel)") { showCodeSheet = true }.buttonStyle(.bordered).tint(.white).accessibilityIdentifier("computer-enter-code")
        }.padding(20)
      } else if c.status == "ready" {
        ProgressView().tint(.white)
      } else {
        Text(c.status == "starting" ? "Starting…" : "This computer isn't running").foregroundStyle(.white.opacity(0.7)).font(.callout)
      }
    }
    .aspectRatio(frame.map { CGFloat(max($0.width, 1)) / CGFloat(max($0.height, 1)) } ?? 16 / 10, contentMode: .fit)
    .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(inControl ? Palette.blue : Palette.hairline, lineWidth: inControl ? 3 : 1))
    .shadow(color: inControl ? Palette.blue.opacity(0.35) : .clear, radius: 14)
  }

  /** Take control (white pill), or hand back to the agent. */
  @ViewBuilder private func controlButton(_ c: Computer) -> some View {
    let who = c.agentIds.first.flatMap { store.agent($0)?.name }
    Button {
      if inControl {
        if !c.agentIds.isEmpty { handingBack = true } else { handBack(c, note: nil) }
        return
      }
      takeControl(c)
    } label: {
      Label(inControl ? "Hand back\(who.map { " to \($0)" } ?? "")" : "Take control", systemImage: inControl ? "hand.wave" : "hand.point.up.left")
        .font(.system(size: 17, weight: .semibold))
        .frame(maxWidth: .infinity, minHeight: 28)
    }
    .primaryButton()
    .disabled(busy || (c.controller != nil && !inControl))
    .accessibilityIdentifier("computer-control")
  }

  private func takeControl(_ c: Computer) {
    busy = true
    Task {
      do { try await store.control(c, take: true); error = nil } catch is Store.Stale {} catch { self.error = error.localizedDescription }
      busy = false
    }
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
    teach?.record(store, c, kind: "click", frame: f, x: Int(x.rounded()), y: Int(y.rounded()))
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
        if !text.isEmpty {
          teach?.record(store, c, kind: "type", text: text)
          try await store.act(c, ["action": AnyEncodable("type"), "text": AnyEncodable(text)])
        }
        typing = ""
        if enter {
          teach?.record(store, c, kind: "key", frame: frame, keys: "Enter")
          try await store.act(c, ["action": AnyEncodable("key"), "keys": AnyEncodable("Enter")])
        }
        error = nil
      } catch { self.error = error.localizedDescription }
    }
  }

  private func key(_ c: Computer, _ k: String) {
    teach?.record(store, c, kind: "key", frame: frame, keys: k)
    perform(c, ["action": AnyEncodable("key"), "keys": AnyEncodable(k)])
  }

  private func scroll(_ c: Computer, _ dir: String) {
    guard let f = frame else { return }
    teach?.record(store, c, kind: "scroll", x: f.width / 2, y: f.height / 2, direction: dir)
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

/** Your own screen: only agents that run on it can use it. */
private struct OwnScreenNote: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Label("Your own screen", systemImage: "lock").font(.subheadline.weight(.semibold))
      Text("Only you can see it. Only agents that run on it can use it, and only for things you ask them.")
        .font(.footnote)
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .card(Corner.card, padding: 14)
  }
}
