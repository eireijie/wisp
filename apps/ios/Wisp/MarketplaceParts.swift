import SwiftUI

/** A chat to open, with the request to start it with. */
struct ChatTarget: Hashable {
  var channel: Channel
  var draft: String
}

/** After a skill is added: a request ready in a chat with a helper that has it. */
struct TryItSection: View {
  @Environment(Store.self) private var store
  var skill: HelperSkill
  @State private var pick = ""
  @State private var action = FormAction()
  @State private var target: ChatTarget?
  @State private var copied = false
  private var holders: [Agent] { store.agents.filter { skill.agentIds?.contains($0.id) == true } }
  var body: some View {
    let helper = holders.first { $0.id == pick } ?? holders.first
    Group {
      if let helper {
        let text = MarketText.trySuggestion(name: skill.name, description: skill.description ?? "")
        Section("Try it") {
          Text("Start a chat with this request ready. Add your own details, then send.").font(.footnote).foregroundStyle(.secondary)
          Text(text).textSelection(.enabled)
          if holders.count > 1 {
            Picker("Agent", selection: Binding(get: { helper.id }, set: { pick = $0 })) { ForEach(holders) { Text($0.name).tag($0.id) } }
          }
          Button("Open chat with \(helper.name)", systemImage: "bubble.left") {
            action.run { target = ChatTarget(channel: try await store.dm(with: helper), draft: text) }
          }.disabled(action.busy)
          Button(copied ? "Copied" : "Copy request", systemImage: "doc.on.doc") { UIPasteboard.general.string = text; copied = true }
          InlineError(error: action.error)
        }
      }
    }.navigationDestination(item: $target) { ChannelView(channel: $0.channel, draft: $0.draft) }
  }
}

/** A public skill before it's added: who made it, its license, its instructions, and its source. */
struct StoreSkillDetail: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var skill: StoreSkill
  @State private var content: String?
  @State private var loaded = false
  @State private var adding = false
  private var instructions: String? {
    content.map { $0.replacingOccurrences(of: #"^---\r?\n[\s\S]*?\r?\n---\r?\n?"#, with: "", options: .regularExpression) }
  }
  var body: some View {
    List {
      Section { Text(skill.name).font(.title2.bold()); Text(skill.description) }
      Section {
        LabeledContent("From", value: skill.source.label)
        LabeledContent("License", value: skill.license.label)
        if let url = URL(string: skill.url) { Link("Source", destination: url) }
      }
      if skill.license.open {
        if store.canManage { Button("Add") { adding = true }.primaryButton() }
      } else {
        Section { Text("Its license doesn't allow copying it, so read it where it lives: \(skill.source.label)'s repo.").font(.footnote) }
      }
      if let instructions, !instructions.isEmpty {
        Section { TechnicalDetails(title: "Full instructions") { NoteMarkdown(text: instructions) } }
      } else if !loaded && skill.license.open {
        Section { ProgressView() }
      }
    }.sectionScreen(skill.name, id: "store-skill")
      .sheet(isPresented: $adding) { SkillInstallSheet(title: "Add \(skill.name)", request: ["storeId": AnyEncodable(skill.id)]) { _ in dismiss() } }
      .task { content = try? await store.skillStoreContent(skill.id); loaded = true }
  }
}

/** The registry's word on who publishes an app. */
struct TrustBadge: View {
  var trust: TrustLabel
  var body: some View {
    Label(trust.text, systemImage: trust.kind == .unverified ? "questionmark.shield" : "checkmark.seal")
      .font(.caption).foregroundStyle(trust.kind == .unverified ? Color.secondary : Color.accentColor)
      .accessibilityLabel("\(trust.text). \(trust.explanation)")
  }
}

/** One app or skill in a list. */
struct MarketRow: View {
  var symbol: String
  var title: String
  var sub: String
  var badge: String?
  var body: some View {
    HStack(spacing: 12) {
      IconTile(symbol: symbol, color: .secondary, size: 38)
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.body.weight(.semibold)).lineLimit(1)
        Text(sub).font(.caption).foregroundStyle(.secondary).lineLimit(2)
      }
      Spacer(minLength: 4)
      if let badge { Text(badge).font(.footnote).foregroundStyle(.secondary) }
    }.accessibilityElement(children: .combine)
  }
}

/** A row of pills to narrow a list, or pick a tab. */
struct ChipRow: View {
  var options: [String]
  var selection: String
  var counts: [String: Int] = [:]
  var onPick: (String) -> Void
  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(options, id: \.self) { option in
          let on = option == selection
          Button { onPick(option) } label: {
            HStack(spacing: 5) {
              Text(option)
              if let n = counts[option], n > 0 { Text("\(n)").foregroundStyle(on ? Color(.systemBackground).opacity(0.7) : .secondary) }
            }.font(.subheadline.weight(on ? .semibold : .regular)).padding(.horizontal, 14).padding(.vertical, 7)
              .foregroundStyle(on ? Color(.systemBackground) : Color.primary)
              .background(Capsule().fill(on ? Color.primary : Color(.secondarySystemFill)))
          }.buttonStyle(.plain).accessibilityAddTraits(on ? .isSelected : [])
        }
      }.padding(.horizontal, 16)
    }.listRowInsets(EdgeInsets()).listRowBackground(Color.clear)
  }
}
