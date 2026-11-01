import SwiftUI

/** What an agent may do on its own device, from the chip in a chat's message bar. */
enum AccessLevel: String, CaseIterable, Identifiable {
  case readOnly = "read-only"
  case edit
  case full

  var id: String { rawValue }
  var label: String {
    switch self {
    case .readOnly: "Read only"
    case .edit: "Can edit files"
    case .full: "Full access"
    }
  }
  var detail: String {
    switch self {
    case .readOnly: "Reads files and answers; changes nothing."
    case .edit: "Edits files in its own working folder."
    case .full: "No sandbox."
    }
  }
  /** the extra line for people who see the technical side */
  var technical: String? { self == .full ? "Needs a device started with --allow-full-access." : nil }
  var symbol: String {
    switch self {
    case .readOnly: "eye"
    case .edit: "shield"
    case .full: "exclamationmark.shield"
    }
  }
  init(_ raw: String?) { self = raw.flatMap(AccessLevel.init(rawValue:)) ?? .edit }
}

/** What you're talking to (GET /api/agents/:id/context): permissions, model and how full its context is. */
struct AgentContextInfo: Decodable, Equatable {
  var harness: String?
  var model: String?
  var effort: String?
  var access: String?
  var contextUsed: Int?
  var contextWindow: Int?
  var harnessVersion: String?
  /** effort levels the model in use offers (else the harness's) */
  var efforts: [String]?
  /** the model connection it runs on; nil on its computer's own sign-in */
  var connection: RunConnection?
  /** the subscription's usage as last reported */
  var plan: PlanUsage?

  var level: AccessLevel { AccessLevel(access) }
  /** 0...1, nil before the first reply */
  var fraction: Double? {
    guard let used = contextUsed, let window = contextWindow, window > 0 else { return nil }
    return min(1, Double(used) / Double(window))
  }
  var summary: String {
    if let f = fraction { return "\(f < 0.01 ? "<1" : String(Int((f * 100).rounded())))% of context used" }
    if let w = contextWindow { return "\(ContextCard.tokens(w)) context window" }
    return "Context appears after the first reply"
  }
}

extension Store {
  func agentContext(_ agentId: String, channel: String, thread: String?) async throws -> AgentContextInfo {
    var query = ["channel": channel]
    if let thread { query["thread"] = thread }
    return try await fetch { try await $0.get("/api/agents/\(agentId)/context", query) }
  }

  func setAccess(_ agentId: String, _ level: AccessLevel) async throws {
    try await updateAgent(agentId, ["settings": AnyEncodable(["access": level.rawValue])])
  }
}

/** In a chat with one agent: what it may do, and how full its conversation is. */
struct ChatControls: View {
  @Environment(Store.self) private var store
  var agent: Agent
  var channelId: String
  var thread: String?
  /** changes when a message arrives, so the ring catches up */
  var refresh: Int
  @State private var info: AgentContextInfo?
  @State private var showContext = false
  @State private var error: String?

  private var canEdit: Bool { store.role != "guest" }

  var body: some View {
    HStack(spacing: 4) {
      if let info {
        accessChip(info.level)
        Spacer(minLength: 0)
        Button { showContext = true } label: { ContextRing(fraction: info.fraction).frame(width: 36, height: 28) }
          .buttonStyle(.plain)
          .accessibilityLabel(info.summary)
          .popover(isPresented: $showContext) { contextPanel(info).presentationCompactAdaptation(.popover) }
      }
    }
    .padding(.horizontal, 12)
    .padding(.top, 4)
    .task(id: "\(agent.id)/\(channelId)/\(thread ?? "")/\(refresh)") {
      if let fresh = try? await store.agentContext(agent.id, channel: channelId, thread: thread) { info = fresh }
    }
    .alert("Couldn't change it", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
      Button("OK") {}
    } message: { Text(error ?? "") }
  }

  @ViewBuilder private func accessChip(_ level: AccessLevel) -> some View {
    let label = Label(level.label, systemImage: level.symbol)
      .font(.caption.weight(.medium))
      .foregroundStyle(level == .full ? Color.accentColor : .secondary)
      .padding(.horizontal, 8).padding(.vertical, 5)
    if canEdit {
      Menu {
        Section("What \(agent.name) can do") {
          ForEach(AccessLevel.allCases) { k in
            Button {
              guard k != level else { return }
              Task {
                do {
                  try await store.setAccess(agent.id, k)
                  info = try await store.agentContext(agent.id, channel: channelId, thread: thread)
                } catch { self.error = error.localizedDescription }
              }
            } label: {
              Label("\(k.label) — \(k.detail)", systemImage: k == level ? "checkmark" : k.symbol)
            }
          }
        }
      } label: { label }
        .accessibilityLabel("What \(agent.name) can do: \(level.label)")
    } else {
      label.accessibilityLabel("\(agent.name) can: \(level.label)")
    }
  }

  private func contextPanel(_ info: AgentContextInfo) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline) {
        Text("Context window").font(.subheadline.weight(.semibold))
        Spacer()
        if let f = info.fraction { Text("\(Int((f * 100).rounded()))%").font(.caption).monospacedDigit().foregroundStyle(ContextRing.color(f)) }
      }
      if let f = info.fraction { ProgressView(value: f).tint(ContextRing.color(f)) }
      Text(detail(info)).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      if let f = info.fraction, f > 0.6 {
        Text("It's getting full. Start a new thread to give the agent a fresh start; its memory carries over.").font(.caption).foregroundStyle(.secondary)
      }
    }
    .padding(14)
    .frame(width: 280)
  }

  private func detail(_ info: AgentContextInfo) -> String {
    let on = info.model.map { " on \($0)" } ?? ""
    if let used = info.contextUsed {
      return "\(used.formatted())\(info.contextWindow.map { " of \($0.formatted())" } ?? "") tokens used in this conversation\(on)."
    }
    if let w = info.contextWindow { return "This model has a \(w.formatted())-token window. Usage shows up after the first reply." }
    return "Usage shows up after the first reply."
  }
}

/** How full the conversation is, as a small ring (grey until the first reply). */
struct ContextRing: View {
  var fraction: Double?

  static func color(_ f: Double) -> Color { f > 0.85 ? .red : f > 0.6 ? .orange : .green }

  var body: some View {
    ZStack {
      Circle().stroke(Color(.tertiarySystemFill), lineWidth: 2.6)
      if let fraction {
        Circle().trim(from: 0, to: max(fraction, 0.03))
          .stroke(Self.color(fraction), style: StrokeStyle(lineWidth: 2.6, lineCap: .round))
          .rotationEffect(.degrees(-90))
      }
    }
    .frame(width: 18, height: 18)
  }
}
