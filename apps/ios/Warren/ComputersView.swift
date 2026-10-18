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
      if let image {
        Image(uiImage: image).resizable().scaledToFit()
      } else {
        Image(systemName: computer.status == "ready" ? "display" : "moon.zzz")
          .font(.title)
          .foregroundStyle(.tertiary)
      }
    }
    .aspectRatio(16 / 10, contentMode: .fit)
    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Color(.separator).opacity(0.5)))
    .task(id: computer.status) {
      guard computer.status == "ready" else { return }
      while !Task.isCancelled {
        if let f = try? await store.screen(computer, maxAge: 5000), let img = UIImage(data: f.image) { image = img }
        try? await Task.sleep(for: .seconds(5))
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
  @State private var lastTap: CGPoint?

  private var computer: Computer? { store.computers.first { $0.id == computerId } }
  private var inControl: Bool { computer?.controller?.id == store.me?.id && computer?.controller != nil }

  @State private var keyboard = false
  @State private var note: String?
  @FocusState private var typingFocused: Bool

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
        }
        .padding(16)
      }
      .navigationTitle(c.name)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .topBarTrailing) { ComputerStatus(computer: c) } }
      .toolbar(.hidden, for: .tabBar)
      .task(id: c.status) { await stream(c) }
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
            .onSubmit { sendTyping(c, enter: true) }
            .padding(.leading, 16)
            .padding(.vertical, 12)
          Button { sendTyping(c, enter: false) } label: {
            Image(systemName: "arrow.up").font(.body.weight(.bold)).foregroundStyle(Color(.systemBackground)).frame(width: 34, height: 34).background(Circle().fill(Color.primary))
          }
          .buttonStyle(.plain)
          .disabled(typing.isEmpty)
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
      if let image {
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
      } else if c.status == "ready" {
        ProgressView().tint(.white)
      } else {
        Text(c.status == "starting" ? "Starting…" : "This computer isn't running").foregroundStyle(.white.opacity(0.7)).font(.callout)
      }
    }
    .aspectRatio(frame.map { CGFloat(max($0.width, 1)) / CGFloat(max($0.height, 1)) } ?? 16 / 10, contentMode: .fit)
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
    guard c.status == "ready" else { return }
    while !Task.isCancelled {
      do {
        let f = try await store.screen(c, maxAge: 1000)
        if let img = UIImage(data: f.image) {
          frame = f.width > 0 ? f : Frame(image: f.image, width: Int(img.size.width), height: Int(img.size.height))
          image = img
          error = nil
        }
      } catch {
        self.error = error.localizedDescription
        try? await Task.sleep(for: .seconds(2))
      }
      try? await Task.sleep(for: .milliseconds(450))
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
    let text = typing
    typing = ""
    Task {
      if !text.isEmpty { try? await store.act(c, ["action": AnyEncodable("type"), "text": AnyEncodable(text)]) }
      if enter { try? await store.act(c, ["action": AnyEncodable("key"), "keys": AnyEncodable("Enter")]) }
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
