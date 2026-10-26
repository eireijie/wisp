import SwiftUI

/**
 * Edit (agent-Edit.dc.html): the ghost with Edit look, Display name, Handle, and rows for
 * Personality, Instructions and Voice. Save keeps the name and handle.
 */
struct AgentEditSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var agent: Agent
  @State private var name = ""
  @State private var handle = ""
  @State private var loaded = false
  @State private var editingLook = false
  @State private var voiceSheet = false
  @State private var soul = ""
  @State private var action = FormAction()

  private var current: Agent { store.agent(agent.id) ?? agent }
  private var handleTaken: Bool { store.agents.contains { $0.handle == handle && $0.id != current.id } }
  private var handleValid: Bool { handle.range(of: "^[a-z][a-z0-9-]{0,31}$", options: .regularExpression) != nil }
  private var valid: Bool { !name.trimmed.isEmpty && name.count <= 80 && handleValid && !handleTaken }
  private var changed: Bool { name.trimmed != current.name || handle != current.handle }

  var body: some View {
    NavigationStack {
      AgentFrame(title: "Edit \(current.name)", close: true) {
        VStack(spacing: 12) {
          AgentAvatar(agent: current, size: 96, showStatus: false)
          SmallPill(title: "Edit look", symbol: "paintpalette", id: "edit-look") { editingLook = true }
        }.frame(maxWidth: .infinity).padding(.vertical, 4)
        FieldCard(label: "Display name", text: $name, prompt: current.name)
        FieldCard(label: "Handle", text: Binding(get: { handle.isEmpty ? "" : "@" + handle }, set: { handle = ManagementText.handle($0.replacingOccurrences(of: "@", with: "")) }), prompt: "@handle", lowercase: true)
        if handleTaken { AgentError(text: "@\(handle) is taken. Pick another.") }
        else if !handle.isEmpty && !handleValid { AgentError(text: "Start with a letter a to z. Use letters, numbers and dashes.") }
        else { CardCaption("Letters a to z. Teammates type this to mention it.") }
        CardGroup {
          NavigationLink { AgentPersonalityPage(agent: current) } label: {
            RowLabel(title: "Personality", subtitle: soul.isEmpty ? "Who it is and how it sounds" : soul)
          }.buttonStyle(.plain).accessibilityIdentifier("edit-personality")
          NavigationLink { AgentInstructionsPage(agent: current) } label: {
            RowLabel(title: "Instructions", subtitle: instructionsLine)
          }.buttonStyle(.plain).accessibilityIdentifier("edit-instructions")
          if store.features.voice {
            Button { voiceSheet = true } label: {
              RowLabel(title: "Voice", subtitle: voiceLine, leading: { rowIcon("waveform") })
            }.buttonStyle(.plain).accessibilityIdentifier("edit-voice")
          }
        }
        AgentError(text: action.error)
        PillButton(title: "Save", busy: action.busy, id: "edit-save") { save() }
          .disabled(!valid || action.busy)
      }
      .disabled(!store.canManage)
      .sheet(isPresented: $editingLook) { LookEditor(agent: current) }
      .sheet(isPresented: $voiceSheet) { AgentVoiceSheet(agent: current) }
    }
    .agentSheet()
    .interactiveDismissDisabled(action.busy)
    .task {
      guard !loaded else { return }
      name = current.name; handle = current.handle; loaded = true
      if let text = try? await store.personality(current.id) { soul = AgentEditText.firstLine(text) }
    }
  }

  private var instructionsLine: String {
    if let role = current.settings?.role, !role.isEmpty { return role }
    let text = AgentEditText.firstLine(current.instructions ?? "")
    return text.isEmpty ? "What it is responsible for" : text
  }

  private var voiceLine: String {
    let voice = current.settings?.voice
    if let id = voice?.elevenlabs, !id.isEmpty { return "Saved voice · ElevenLabs" }
    if let id = voice?.openai, !id.isEmpty { return "\(id.prefix(1).uppercased() + id.dropFirst()) · OpenAI" }
    if let id = voice?.device, !id.isEmpty, let named = AVSpeechSynthesisVoice(identifier: id) { return "\(named.name) · on device" }
    return "Automatic for \(current.name)"
  }

  private func save() {
    action.run {
      var fields: Fields = [:]
      if name.trimmed != current.name { fields["name"] = AnyEncodable(name.trimmed) }
      if handle != current.handle { fields["handle"] = AnyEncodable(handle) }
      if !fields.isEmpty { _ = try await store.updateAgent(current.id, fields) }
      dismiss()
    }
  }
}

import AVFoundation

enum AgentEditText {
  /** The first line that says something (not a heading), shortened for a row. */
  static func firstLine(_ text: String) -> String {
    let line = text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
      .first { !$0.isEmpty && !$0.hasPrefix("#") } ?? ""
    let plain = line.replacingOccurrences(of: "^[-*]\\s*", with: "", options: .regularExpression)
    return plain.count > 60 ? String(plain.prefix(57)) + "…" : plain
  }

  /** A heading and an empty list item, added where the cursor would be: the snippet chips on Instructions. */
  static func insert(_ heading: String, into text: String) -> String {
    let block = "## \(heading)\n- "
    return text.trimmed.isEmpty ? block : text.trimmingCharacters(in: .newlines) + "\n\n" + block
  }

  static let snippets = ["What it owns", "You decide", "Ask before", "Memory habits", "Handoffs", "Reply style"]
}

// MARK: personality

/** Personality (agent-Personality.dc.html): write it or preview it, let the agent refine it, its history, a template. */
struct AgentPersonalityPage: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var agent: Agent
  @State private var text = ""
  @State private var savedText = ""
  @State private var preview = false
  @State private var loaded = false
  @State private var loadError: String?
  @State private var action = FormAction()

  private var current: Agent { store.agent(agent.id) ?? agent }

  var body: some View {
    AgentFrame(title: "Personality", subtitle: current.name) {
      Segments(options: [(false, "Write"), (true, "Preview")], selection: $preview, id: "personality-mode")
      if preview {
        AgentCard {
          if text.trimmed.isEmpty { Text("Nothing written yet.").font(.system(size: 15)).foregroundStyle(Palette.faint) }
          else { Text((try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)).font(.system(size: 16)).foregroundStyle(Palette.text) }
        }.frame(minHeight: 200, alignment: .topLeading)
      } else {
        FieldCard(label: "Personality, voice, values and boundaries", text: $text, lines: 9...30)
          .disabled(!store.canManage || !loaded)
      }
      CardCaption("Read at the start of every conversation. Keep it short; every line should change how the agent behaves.")
      CardGroup {
        SwitchRow(title: "Let @\(current.handle) refine its own personality", subtitle: "It tweaks this as it learns how you work",
                  isOn: Binding(get: { current.settings?.soulLocked != true }, set: { value in
                    action.run { _ = try await store.updateAgent(current.id, ["settings": AnyEncodable(["soulLocked": !value])]) }
                  }), id: "personality-refine")
          .disabled(!store.canManage || action.busy)
        NavigationLink { SoulHistory(agent: current, canRestore: store.canManage) { text = $0; preview = false } } label: {
          RowLabel(title: "History", leading: { rowIcon("clock.arrow.circlepath") })
        }.buttonStyle(.plain).accessibilityIdentifier("personality-history")
        if store.canManage {
          Button { text = SoulText.template(name: current.name, handle: current.handle); preview = false } label: {
            RowLabel(title: "Start from a template", leading: { rowIcon("sparkles") })
          }.buttonStyle(.plain).accessibilityIdentifier("personality-template")
        }
      }
      AgentError(text: loadError ?? action.error)
      if store.canManage {
        PillButton(title: "Save", busy: action.busy, id: "personality-save") {
          action.run { try await store.savePersonality(current, content: text); savedText = text; dismiss() }
        }.disabled(!loaded || action.busy || text == savedText)
      }
    }
    .task { await load() }
    .task(id: store.memoryVersion) {
      guard loaded, text == savedText else { return }
      if let fresh = try? await store.personality(agent.id) { text = fresh; savedText = fresh }
    }
  }

  private func load() async {
    guard !loaded else { return }
    do { text = try await store.personality(current.id); savedText = text; loaded = true; loadError = nil }
    catch { loadError = error.localizedDescription }
  }
}

// MARK: instructions

/** Instructions (agent-Instructions.dc.html): the role, what it covers, snippet chips and the text. */
struct AgentInstructionsPage: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var agent: Agent
  @State private var role = ""
  @State private var roleNotes = ""
  @State private var text = ""
  @State private var loaded = false
  @State private var action = FormAction()

  private var current: Agent { store.agent(agent.id) ?? agent }

  var body: some View {
    AgentFrame(title: "Instructions", subtitle: current.name) {
      FieldCard(label: "Role", text: $role, prompt: "Release manager")
      FieldCard(label: "What the role covers", text: $roleNotes, prompt: "What it is in charge of", lines: 2...8)
      FlowLayout(spacing: 8) {
        ForEach(AgentEditText.snippets, id: \.self) { snippet in
          AgentChip(title: snippet, symbol: "plus") { text = AgentEditText.insert(snippet, into: text) }
        }
      }
      FieldCard(label: "Instructions", text: $text, prompt: "What should it do, and how?", lines: 6...30)
      CardCaption("@\(current.handle)'s job: what it's responsible for, how it should work, and who to hand things to. Sent with every request.")
      AgentError(text: action.error)
      PillButton(title: "Save", busy: action.busy, id: "instructions-save") {
        action.run {
          var fields: Fields = ["instructions": AnyEncodable(text)]
          var settings: Fields = [:]
          if role.trimmed != (current.settings?.role ?? "") { settings["role"] = AnyEncodable(role.trimmed) }
          if roleNotes != (current.settings?.roleNotes ?? "") { settings["roleNotes"] = AnyEncodable(roleNotes) }
          if !settings.isEmpty { fields["settings"] = AnyEncodable(settings) }
          _ = try await store.updateAgent(current.id, fields)
          dismiss()
        }
      }.disabled(action.busy || text.count > 20000 || role.count > 80)
    }
    .disabled(!store.canManage)
    .onAppear {
      guard !loaded else { return }
      role = current.settings?.role ?? ""; roleNotes = current.settings?.roleNotes ?? ""; text = current.instructions ?? ""; loaded = true
    }
  }
}

// MARK: voice

/** Voice (agent-Voice.dc.html), in a sheet: pick how the agent sounds, then Use this voice. */
struct AgentVoiceSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var agent: Agent
  @State private var voice = AgentVoice()
  @State private var action = FormAction()

  var body: some View {
    NavigationStack {
      AgentFrame(title: "Voice", subtitle: agent.name, close: true) {
        AgentVoicePicker(agent: agent, voice: $voice)
        AgentError(text: action.error)
        PillButton(title: "Use this voice", busy: action.busy, id: "voice-save") {
          action.run { try await store.saveVoice(voice, for: agent); dismiss() }
        }.disabled(action.busy)
      }
    }
    .agentSheet()
    .onAppear { voice = agent.settings?.voice ?? AgentVoice() }
  }
}
