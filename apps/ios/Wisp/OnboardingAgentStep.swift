import SwiftUI

/**
 * First-run page 1, "Your agent" (canvas iPhone board): its bubble big at the top (tap it for
 * another shape), its name right under it in big type to type over, and its colour. Continue makes
 * the agent there and then (or renames one made before), so whatever happens next it exists.
 */
struct OnboardingAgentStep: View {
  @Environment(Store.self) private var store
  @Environment(HostStage.self) private var stage
  var workspaceId: String
  @Binding var look: GhostLook
  var onBusy: (Bool) -> Void
  var onContinue: (_ agentId: String) -> Void
  @State private var name = ""
  @State private var busy = false
  @State private var error: String?
  @State private var loaded = false
  /** where it runs (board 16c): the shared computer unless a device is picked */
  @State private var runsOn: RunsOn = .shared
  @FocusState private var naming: Bool
  @ReduceMotion private var reduceMotion

  private var person: String { store.me?.preferredName ?? store.me?.name ?? "" }
  private var existing: Agent? { OnboardingAnswers.load(workspaceId).agentId.flatMap { store.agent($0) } }

  var body: some View {
    ObScreen(top: 96) {
      VStack(spacing: 0) {
        ObSlot(size: 180)
        TextField("Name", text: $name)
          .font(.system(size: 34, weight: .bold)).tracking(-0.6).foregroundStyle(Palette.text)
          .multilineTextAlignment(.center)
          .autocorrectionDisabled().textInputAutocapitalization(.words).submitLabel(.done)
          .focused($naming)
          .onChange(of: name) { _, new in if new.count > 40 { name = String(new.prefix(40)) } }
          .onSubmit { Task { await save() } }
          .padding(.top, 26)
          .accessibilityLabel("Its name")
          .accessibilityIdentifier("ob-agent-name")
        HStack(spacing: 12) {
          ForEach(Array(OnboardingText.colors.enumerated()), id: \.element) { i, c in
            let on = look.color == c
            Button { pick(c) } label: {
              Circle().fill(Color(hex: c)).frame(width: 26, height: 26)
                .padding(4)
                .overlay(Circle().strokeBorder(on ? Color(hex: c) : .clear, lineWidth: 2))
                .contentShape(Circle())
            }
            .buttonStyle(.press)
            .accessibilityLabel(OnboardingText.colorNames[i]).accessibilityAddTraits(on ? .isSelected : [])
            .accessibilityIdentifier("ob-color-\(i)")
          }
        }
        .padding(.top, 14)
        .animation(Motion.pick(Motion.pop, reduceMotion), value: look.color)
        .accessibilityElement(children: .contain).accessibilityLabel("Colour")
        if existing == nil, store.nodes.contains(where: \.usable) {
          CardGroup { RunsOnRow(selection: runsOn, id: "ob-runs-on") { runsOn = $0 } }
            .padding(.top, 22)
        }
        if let error {
          Text(error).font(.system(size: 14)).foregroundStyle(Palette.red).multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true).padding(.top, 16).obPop()
        }
      }
    } bottom: {
      Button(busy ? "Making \(name.trimmed)…" : "Continue") { Task { await save() } }
        .buttonStyle(ObWide()).disabled(name.trimmed.isEmpty || busy)
        .accessibilityIdentifier("ob-agent-next")
    }
    .task {
      guard !loaded else { return }
      loaded = true
      let draft = OnboardingAnswers.load(workspaceId).agentDraft
      let me = OnboardingText.first(person).lowercased()
      name = existing?.name ?? draft?.name ?? OnboardingText.namePool.first { $0.lowercased() != me } ?? "Juno"
      try? await store.refreshNodes()
    }
  }

  private func pick(_ c: String) {
    look = OnboardingLook.agent(color: c, shape: look.shape ?? "classic")
    stage.answer(.hop, reduceMotion: reduceMotion)
  }

  /** Make the agent (or rename the one made before): on this phone's best computer and the AI found there, its hello held until its AI is chosen. */
  private func save() async {
    let n = name.trimmed
    guard !n.isEmpty, !busy else { return }
    naming = false
    busy = true; onBusy(true); error = nil
    defer { busy = false; onBusy(false) }
    let draft = FirstAgentDraft(name: n, handle: nil, role: "", color: look.color, shape: look.shape ?? "classic",
                                instructions: OnboardingText.instructions(agent: n, person: person, role: ""))
    OnboardingAnswers.save(workspaceId) { $0.agentDraft = draft }
    do {
      let agent: Agent
      if let existing {
        agent = try await store.updateAgent(existing.id, ["name": AnyEncodable(n), "settings": AnyEncodable(["appearance": AnyEncodable(look)] as Fields)])
      } else {
        let device = OnboardingAI.device(store.nodes)
        let harness = device.flatMap { AddAgent.preferredHarness(store, node: $0.id) } ?? "claude-code"
        var fields: Fields = ["name": AnyEncodable(n), "handle": AnyEncodable(OnboardingText.freeHandle(n, taken: store.agents.map(\.handle))),
                              "harness": AnyEncodable(harness), "greet": AnyEncodable("later"), "useDefaults": AnyEncodable(true),
                              "instructions": AnyEncodable(draft.instructions),
                              "settings": AnyEncodable(["appearance": AnyEncodable(look)] as Fields)]
        if let device { fields["nodeId"] = AnyEncodable(device.id) }
        if case .device(let id) = runsOn, let patch = RunsOn.patch(runsOn, sharedComputerId: nil, computers: store.computers, nodes: store.nodes) {
          // right on the picked device (its screen when it has one), not the shared computer
          fields.merge(patch) { _, new in new }
          fields["harness"] = AnyEncodable(AddAgent.preferredHarness(store, node: id) ?? harness)
        }
        agent = try await store.createAgent(fields)
      }
      OnboardingAnswers.save(workspaceId) { $0.agentId = agent.id }
      try? await store.refreshAgents()
      stage.react(.hop)
      onContinue(agent.id)
    } catch {
      self.error = error.localizedDescription
    }
  }
}
