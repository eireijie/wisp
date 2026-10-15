import SwiftUI

/** Agents' computers: watch any of them live, take control when one needs you, and hand it back. */
struct ComputersView: View {
  @Environment(Store.self) private var store

  var body: some View {
    NavigationStack {
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
                  Label("\(store.agent(help.agentId)?.name ?? "An agent") needs you: \(help.request)", systemImage: "person.fill.questionmark")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.orange)
                    .lineLimit(2)
                }
              }
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
      Circle().fill(color).frame(width: 7, height: 7).shadow(color: color.opacity(0.6), radius: 3)
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
      RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color(.secondarySystemBackground))
      if let image {
        Image(uiImage: image).resizable().scaledToFit()
      } else {
        Image(systemName: computer.status == "ready" ? "display" : "moon.zzz")
          .font(.title)
          .foregroundStyle(.tertiary)
      }
    }
    .aspectRatio(16 / 10, contentMode: .fit)
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color(.separator).opacity(0.5)))
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

  var body: some View {
    if let c = computer {
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          if let help = c.help {
            VStack(alignment: .leading, spacing: 4) {
              Text("\(store.agent(help.agentId)?.name ?? "An agent") needs you").font(.subheadline.weight(.semibold))
              Text(help.request).font(.callout)
              Text("Take control, do it on the screen below, then hand it back.").font(.caption).foregroundStyle(.secondary)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.orange.opacity(0.12)))
          }

          screen(c)

          HStack {
            ComputerStatus(computer: c)
            Spacer()
            if c.status == "ready" { controlButton(c) }
          }
          if !c.statusText.isEmpty && c.status != "ready" {
            Text(c.statusText).font(.footnote).foregroundStyle(.secondary)
          }

          if inControl {
            VStack(alignment: .leading, spacing: 8) {
              Text("Tap the screen to click. Type here to send keys.").font(.caption).foregroundStyle(.secondary)
              HStack {
                TextField("Type on \(c.name)", text: $typing)
                  .textInputAutocapitalization(.never)
                  .autocorrectionDisabled()
                  .onSubmit { sendTyping(c, enter: true) }
                  .padding(.horizontal, 12)
                  .frame(minHeight: 40)
                  .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color(.secondarySystemBackground)))
                Button("Send") { sendTyping(c, enter: false) }.disabled(typing.isEmpty)
              }
              HStack(spacing: 8) {
                ForEach(["Enter", "Tab", "Escape", "Backspace"], id: \.self) { k in
                  Button(k == "Backspace" ? "⌫" : k) { key(c, k) }
                    .font(.caption.weight(.medium))
                    .buttonStyle(.bordered)
                }
                Spacer()
                Button { scroll(c, "up") } label: { Image(systemName: "chevron.up") }.buttonStyle(.bordered)
                Button { scroll(c, "down") } label: { Image(systemName: "chevron.down") }.buttonStyle(.bordered)
              }
            }
          }
          if let error { Text(error).font(.footnote).foregroundStyle(.red) }
        }
        .padding(16)
      }
      .navigationTitle(c.name)
      .navigationBarTitleDisplayMode(.inline)
      .task(id: c.status) { await stream(c) }
    } else {
      ContentUnavailableView("Computer not found", systemImage: "desktopcomputer.trianglebadge.exclamationmark")
    }
  }

  @ViewBuilder private func screen(_ c: Computer) -> some View {
    ZStack {
      RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.black)
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
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(inControl ? Color.orange : .clear, lineWidth: 2))
  }

  private func controlButton(_ c: Computer) -> some View {
    Button {
      busy = true
      Task {
        do { try await store.control(c, take: !inControl) } catch { self.error = error.localizedDescription }
        busy = false
      }
    } label: {
      Text(inControl ? "Hand back" : "Take control")
        .font(.subheadline.weight(.semibold))
        .padding(.horizontal, 16)
        .frame(minHeight: 36)
        .foregroundStyle(inControl ? Color.primary : Color(.systemBackground))
        .background(Capsule().fill(inControl ? Color(.secondarySystemFill) : Color.primary))
    }
    .buttonStyle(.plain)
    .disabled(busy || (c.controller != nil && !inControl))
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
