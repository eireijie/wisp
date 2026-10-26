import SwiftUI

/**
 * The agents working in a conversation right now, as a pill above the message bar. In a thread,
 * the ones working in it or in a sub-thread under it; at the top, everyone in the channel.
 */
struct ActivityPill: View {
  @Environment(Store.self) private var store
  var channel: Channel
  var thread: String? = nil
  @State private var open: Agent?
  @State private var choosing = false
  @State private var stopping = false
  @State private var error: String?

  private var working: [Agent] {
    if let thread { return store.working(in: channel.id, thread: thread) }
    return store.agents.filter { a in
      a.status == .busy && (store.activityChannel[a.id] == channel.id || (store.activityChannel[a.id] == nil && store.dmAgent(channel)?.id == a.id))
    }
  }

  var body: some View {
    let list = working
    if let first = list.first {
      HStack(spacing: 8) {
      Button { open = first } label: {
        HStack(spacing: 8) {
          HStack(spacing: -8) {
            ForEach(list.prefix(3)) { a in
              AgentAvatar(agent: a, size: 22, showStatus: false)
                .padding(2)
                .background(Circle().fill(Color(.systemBackground)))
            }
          }
          (Text(first.name).fontWeight(.semibold) + Text(" \(ActivityText.phrase(store.activity[first.id]))"))
            .lineLimit(1)
          if list.count > 1 {
            Text("· \(list[1].name)\(list.count > 2 ? " +\(list.count - 2)" : "")").foregroundStyle(Palette.muted).lineLimit(1)
          }
          PulseDots().scaleEffect(0.7)
        }
        .font(.system(size: 14))
        .foregroundStyle(Palette.text)
        .padding(.leading, 8)
        .padding(.trailing, 14)
        .padding(.vertical, 7)
        .glassCapsule(interactive: true)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("\(first.name) \(ActivityText.phrase(store.activity[first.id]))\(list.count > 1 ? ", and \(list.count - 1) more" : ""). Show what it's doing")
      Spacer(minLength: 0)
      stopButton(list)
      }
      .padding(.horizontal, 14)
      .transition(.move(edge: .bottom).combined(with: .opacity))
      .sheet(item: $open) { AgentWorkSheet(agentId: $0.id, others: list.map(\.id), hereThread: thread) }
      .confirmationDialog("Stop which agent?", isPresented: $choosing, titleVisibility: .visible) {
        ForEach(list) { a in Button("Stop \(a.name)", role: .destructive) { stop([a]) } }
        Button("Stop all \(list.count)", role: .destructive) { stop(list) }
      } message: { Text("It stops what it's doing now. Anything it already changed stays changed.") }
      .alert("Couldn't stop it", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
        Button("OK") {}
      } message: { Text(error ?? "") }
    }
  }

  /** Stop the reply in progress: right away with one agent working here, after picking with several. */
  private func stopButton(_ list: [Agent]) -> some View {
    Button {
      if list.count == 1 { stop(list) } else { choosing = true }
    } label: {
      Image(systemName: "stop.fill")
        .font(.footnote.weight(.bold))
        .foregroundStyle(.red)
        .frame(width: 32, height: 32)
        // the whole capsule is the target, not just the small glyph (a plain button only hits its drawn content)
        .contentShape(Capsule())
        .glassCapsule(interactive: true)
    }
    .buttonStyle(.plain)
    .disabled(stopping)
    .opacity(stopping ? 0.4 : 1)
    .accessibilityLabel(list.count == 1 ? "Stop \(list[0].name)" : "Stop an agent")
  }

  private func stop(_ agents: [Agent]) {
    stopping = true
    Task {
      for a in agents {
        do { try await store.stopAgent(a.id) } catch { self.error = error.localizedDescription }
      }
      stopping = false
    }
  }
}

enum ActivityText {
  /** "Editing files" → "is editing files"; anything else reads as a status after the name. */
  static func phrase(_ activity: String?) -> String {
    guard var text = activity?.trimmed, !text.isEmpty, text != "started" else { return "is working" }
    if text.hasSuffix("…") || text.hasSuffix("...") { text = text.replacingOccurrences(of: "…", with: "").replacingOccurrences(of: "...", with: "") }
    let first = text.split(separator: " ").first.map(String.init) ?? text
    let lowered = text.prefix(1).lowercased() + text.dropFirst()
    return first.lowercased().hasSuffix("ing") ? "is \(lowered)" : "· \(lowered)"
  }
}

/** What an agent is doing: its steps so far, a Stop button, and its computer. */
struct AgentWorkSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State var agentId: String
  var others: [String] = []
  /** the thread the pill was opened in, which needn't be named again */
  var hereThread: String? = nil
  @State private var action = FormAction()
  @State private var stopping = false

  private var agent: Agent? { store.agent(agentId) }
  private var computer: Computer? { store.computers.first { $0.id == agent?.computerId } }

  var body: some View {
    NavigationStack {
      if let agent {
        List {
          if others.count > 1 {
            Section {
              ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 14) {
                  ForEach(others, id: \.self) { id in
                    Button { agentId = id } label: {
                      VStack(spacing: 4) {
                        AgentAvatar(agent: store.agent(id), size: 40, showStatus: false)
                        Text(store.agent(id)?.name ?? "Agent").font(.caption).lineLimit(1)
                      }
                      .padding(6)
                      .background(RoundedRectangle(cornerRadius: Corner.tile, style: .continuous).fill(id == agentId ? Color(.tertiarySystemFill) : .clear))
                    }.buttonStyle(.plain)
                  }
                }
              }
            }
          }
          Section {
            HStack(spacing: 14) {
              AgentAvatar(agent: agent, size: 56, showStatus: false, interactive: true)
              VStack(alignment: .leading, spacing: 3) {
                Text(agent.name).font(.title3.weight(.semibold))
                if let d = agent.settings?.description, !d.isEmpty { Text(d).font(.subheadline).foregroundStyle(.secondary) }
                HStack(spacing: 5) {
                  GlowDot(color: agent.status == .busy ? .green : .gray)
                  if agent.status == .busy, let since = store.activitySince[agent.id] {
                    Text("Working · ") + Text(since, style: .relative)
                  } else {
                    Text(agent.status == .busy ? "Working" : agent.status == .online ? "Done for now" : "Offline")
                  }
                }.font(.caption).foregroundStyle(.secondary)
              }
            }.padding(.vertical, 4)
            if agent.status == .busy {
              Button(role: .destructive) { stopping = true } label: {
                Label("Stop", systemImage: "stop.fill").frame(maxWidth: .infinity).foregroundStyle(.red)
              }
              .secondaryButton()
              .disabled(action.busy)
            }
          }
          if agent.status == .busy, let spot = place(agent) {
            Section("Where") {
              Text(spot.text).font(.subheadline)
              NavigationLink("Open thread") { ThreadView(ref: ThreadRef(channelId: spot.channelId, rootId: spot.thread)) }
            }
          }
          Section("What it's doing") {
            let steps = store.activitySteps[agent.id] ?? []
            if steps.isEmpty {
              StepRow(text: ActivityText.phrase(store.activity[agent.id]).replacingOccurrences(of: "is ", with: "").capitalizedFirst, state: agent.status == .busy ? .now : .done)
            }
            ForEach(Array(steps.enumerated()), id: \.offset) { i, step in
              StepRow(text: step, state: i == steps.count - 1 && agent.status == .busy ? .now : .done)
            }
          }
          if store.canViewComputers, let computer {
            Section("Its computer") {
              NavigationLink { ComputerDetail(computerId: computer.id) } label: {
                VStack(alignment: .leading, spacing: 8) {
                  ScreenThumb(computer: computer).frame(maxHeight: 180)
                  Label("Watch or take over", systemImage: "hand.point.up.left").font(.subheadline.weight(.semibold))
                }.padding(.vertical, 4)
              }
            }
          }
          Section {
            LabeledContent("Answers", value: answersLabel(agent))
          }
        }
        .navigationTitle("Agent")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        .confirmationDialog("Stop \(agent.name)?", isPresented: $stopping, titleVisibility: .visible) {
          Button("Stop", role: .destructive) { action.run { try await store.stopAgent(agent.id) } }
        } message: { Text("It stops what it's doing now. Anything it already changed stays changed.") }
        .managementAlert(action)
      } else {
        ContentUnavailableView("This agent was removed", systemImage: "questionmark.circle")
      }
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
  }

  /** Which thread it's working in, when that's not the one on screen: "In a sub-thread of “Plan the launch”". */
  private func place(_ agent: Agent) -> (text: String, channelId: String, thread: String)? {
    guard let channelId = store.activityChannel[agent.id], let thread = store.activityThread[agent.id], thread != hereThread else { return nil }
    let path = store.activityPath[agent.id] ?? []
    let top = path.first ?? thread
    return ("In \(path.isEmpty ? "" : "a sub-thread of ")“\(ThreadTitle.of(store.message(top, in: channelId)))”", channelId, thread)
  }

  private func answersLabel(_ agent: Agent) -> String {
    switch agent.settings?.respondTo {
    case "me": "Only you"
    case "people": "Picked people"
    default: "Anyone"
    }
  }
}

private struct StepRow: View {
  enum Phase { case done, now }
  var text: String
  var state: Phase

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: state == .done ? "checkmark.circle.fill" : "circle.dotted.circle")
        .foregroundStyle(state == .done ? Color.secondary : Color.green)
        .symbolEffect(.pulse, isActive: state == .now)
      Text(text).font(.subheadline.weight(state == .now ? .semibold : .regular))
        .foregroundStyle(state == .now ? .primary : .secondary)
    }
    .listRowBackground(state == .now ? Color.green.opacity(0.12) : nil)
  }
}

extension String {
  var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}

/** A thread's first words, to say where an agent is working. */
enum ThreadTitle {
  static func of(_ message: Message?) -> String {
    guard let body = message?.body else { return "a thread" }
    let text = body.replacing(/@[\w-]+\s*/, with: "").replacing(/[*_`#>]/, with: "").replacing(/\s+/, with: " ").trimmed
    if text.isEmpty { return "a thread" }
    return text.count > 36 ? String(text.prefix(34)) + "…" : text
  }
}
