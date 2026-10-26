import SwiftUI

/**
 * Give an agent a computer: a VM on one of your devices, your own screen, or an Orgo cloud computer
 * (comp-GiveComputer.dc.html). "Chat only" creates nothing.
 */
struct AddComputerView: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var onCreated: (Computer) -> Void
  /** an agent to give it to right away (from its page) */
  var agent: Agent? = nil

  @State private var chatOnly = false
  @State private var kind: ComputerKind = .vm
  @State private var agentId = ""
  @State private var nodeId = ""
  @State private var name = ""
  @State private var size: ComputerSize = .medium
  @State private var existingOrgo = ""
  @State private var orgoConfigured: Bool?
  @State private var busy = false
  @State private var error: String?
  @State private var more = false

  private var usable: [AgentNode] { ComputerAdd.usable(store.nodes) }
  private var mine: [AgentNode] { store.nodes.filter { $0.mine == true } }
  private var choices: [AgentNode] { kind == .device ? mine : usable }
  private var device: AgentNode? { choices.first { $0.id == nodeId } }
  private var picked: Agent? { store.agent(agentId) }

  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: "Give an agent a computer") { dismiss() }
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          if !store.agents.isEmpty {
            CardCaption("Which agent?")
            CardGroup {
              Picker(selection: $agentId) {
                Text("No one yet").tag("")
                ForEach(store.agents) { Text($0.name).tag($0.id) }
              } label: {
                HStack(spacing: 10) {
                  if let picked { AgentAvatar(agent: picked, size: 26, showStatus: false) }
                  Text("Agent").foregroundStyle(Palette.text)
                }
              }.pickerStyle(.menu).padding(.horizontal, 18).frame(minHeight: 54).accessibilityIdentifier("give-agent")
            }
          }

          CardCaption("What should it be able to do?")
          Picker("What should it be able to do?", selection: Binding(get: { chatOnly ? 0 : kind == .device ? 2 : 1 }, set: { v in
            chatOnly = v == 0
            if v == 1 { kind = .vm } else if v == 2 { kind = .device }
          })) {
            Text("Chat only").tag(0)
            Text("Computer").tag(1)
            if !mine.isEmpty { Text("Own device").tag(2) }
          }.pickerStyle(.segmented)

          if chatOnly {
            Text("The helper can chat, write and look things up without a desktop of its own. Nothing will be created. To set this, open the agent's page and choose Computer.").font(.system(size: 15)).foregroundStyle(Palette.muted)
          } else {
            if kind != .orgo {
              CardCaption("Where should it live?")
              CardGroup {
                if choices.isEmpty {
                  Text("Add a device first, from the Add button.").foregroundStyle(Palette.muted).padding(18)
                } else {
                  Picker(selection: $nodeId) {
                    ForEach(choices) { d in Text("\(d.name) (\(d.capabilities?.osName ?? "computer"), \(d.online ? "online" : "offline"))").tag(d.id) }
                  } label: { Text("Device").foregroundStyle(Palette.text) }
                    .pickerStyle(.menu).padding(.horizontal, 18).frame(minHeight: 54)
                }
              }
              if let note = deviceNote { Text(note.0).font(.footnote).foregroundStyle(note.1 ? Palette.faint : Palette.red).padding(.horizontal, 4) }
              else if kind == .vm, let vm = ComputerAdd.vmNote(usable) { Text(vm).font(.footnote).foregroundStyle(Palette.faint).padding(.horizontal, 4) }
            }
            CardCaption("Name")
            TextField(namePlaceholder, text: $name).autocorrectionDisabled()
              .padding(.horizontal, 18).frame(minHeight: 54)
              .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
              .accessibilityIdentifier("give-name")

            DisclosureGroup(isExpanded: $more) {
              VStack(alignment: .leading, spacing: 12) {
                kindRow(.orgo, "cloud", "Cloud computer", "Hosted for you with Orgo. Add your Orgo API key in Settings first.",
                  note: orgoConfigured == nil ? "Checking your Orgo connection…" : orgoConfigured == false ? "Add your Orgo API key on Wisp on your computer (Settings → Agent computers) first." : nil,
                  disabled: orgoConfigured != true)
                if kind == .orgo {
                  TextField("Or one you already have in Orgo (its ID)", text: $existingOrgo).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .padding(.horizontal, 14).frame(height: 46).background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Palette.field))
                }
                if kind != .device, existingOrgo.trimmingCharacters(in: .whitespaces).isEmpty {
                  Picker("Size and resources", selection: $size) { ForEach(ComputerSize.allCases) { Text($0.label(for: kind)).tag($0) } }.pickerStyle(.menu)
                }
              }.padding(.top, 10)
            } label: { Text("More options").font(.system(size: 15)).foregroundStyle(Palette.muted) }
              .tint(Palette.muted).padding(.horizontal, 4).accessibilityIdentifier("give-more")

            if kind == .vm { Text("The first VM on a device builds its image, which takes a few minutes. Its home folder keeps sign-ins and files between restarts.").font(.footnote).foregroundStyle(Palette.faint).padding(.horizontal, 4) }
          }
          if let error { Text(error).foregroundStyle(Palette.red).font(.footnote) }
          if chatOnly {
            Button { dismiss() } label: { Text("Close").frame(maxWidth: .infinity) }.secondaryButton()
          } else {
            Button { create() } label: { Group { if busy { ProgressView() } else { Text("Create computer") } }.frame(maxWidth: .infinity) }
              .primaryButton().disabled(!canAdd).accessibilityIdentifier("give-create")
          }
        }.padding(.horizontal, 18).padding(.top, 8).padding(.bottom, 24)
      }
    }
    .background(Palette.sheet.ignoresSafeArea())
    .presentationBackground(Palette.sheet)
    .presentationCornerRadius(Corner.sheet)
    .presentationDragIndicator(.hidden)
    .tint(Palette.text)
    .task {
      if let agent { agentId = agent.id }
      if store.nodes.isEmpty { try? await store.refreshNodes() }
      pickDevice()
      if let s = try? await store.computerSettings() { orgoConfigured = s.orgo.configured } else { orgoConfigured = false }
    }
    .onChange(of: kind) { _, _ in pickDevice() }
  }

  private var namePlaceholder: String {
    switch kind {
    case .device: device?.name ?? "My screen"
    case .vm: picked.map { "\($0.name)'s computer" } ?? "Research desk"
    case .orgo: "Cloud desk"
    }
  }

  private var canAdd: Bool {
    if busy { return false }
    if kind == .orgo { return orgoConfigured == true }
    return !nodeId.isEmpty
  }

  /** What the picked device says about running a VM or sharing its screen; the Bool is whether it's fine. */
  private var deviceNote: (String, Bool)? {
    guard let caps = device?.capabilities else { return nil }
    if kind == .device {
      if caps.screen?.off == true { return ("\(device?.name ?? "That device")'s screen is off. Only you can turn it on, at that computer: wisp node screen on", false) }
      guard let s = caps.screen, let detail = s.detail, !detail.isEmpty else { return nil }
      return (detail, s.ok)
    }
    guard let v = caps.vm, let detail = v.detail, !detail.isEmpty else { return nil }
    return (detail, v.ok)
  }

  private func pickDevice() {
    if choices.contains(where: { $0.id == nodeId }) { return }
    nodeId = (choices.first { $0.online } ?? choices.first)?.id ?? ""
  }

  private func kindRow(_ k: ComputerKind, _ symbol: String, _ title: String, _ body: String, note: String? = nil, disabled: Bool = false) -> some View {
    Button { kind = k } label: {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: symbol).font(.system(size: 18)).foregroundStyle(Palette.text).frame(width: 28)
        VStack(alignment: .leading, spacing: 2) {
          Text(title).font(.system(size: 16, weight: .medium)).foregroundStyle(Palette.text)
          Text(body).font(.footnote).foregroundStyle(Palette.faint)
          if let note { Text(note).font(.footnote).foregroundStyle(Color.orange) }
        }
        Spacer(minLength: 0)
        Image(systemName: kind == k ? "checkmark.circle.fill" : "circle").foregroundStyle(kind == k ? Palette.blue : Palette.faint)
      }
      .padding(14).frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(disabled)
    .opacity(disabled ? 0.6 : 1)
    .accessibilityAddTraits(kind == k ? .isSelected : [])
  }

  private func create() {
    busy = true
    error = nil
    let request = NewComputer.make(kind: kind, nodeId: nodeId, deviceName: device?.name, name: name, size: size, existingOrgo: existingOrgo)
    Task {
      defer { busy = false }
      do {
        let c = try await store.addComputer(request)
        // the agent it was made for gets to use it
        if !agentId.isEmpty { try? await store.updateAgent(agentId, ["computerId": AnyEncodable(c.id)]); await store.refreshComputers() }
        dismiss()
        onCreated(c)
      } catch { self.error = error.localizedDescription }
    }
  }
}
