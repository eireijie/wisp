import SwiftUI

// Making a team: its name, how it starts (from scratch, a template, or an agent builds it), the
// flowchart, and a last look before it is created.

/** What a new team is made of while its screens are open. */
@MainActor @Observable
final class NewTeamDraft {
  var name = ""
  var topic = ""
  var section = ""
  var isPrivate = false
  var team = ChannelTeam(nodes: [], edges: [], roles: [], steps: [])
  var description = ""
  var builder: String?
  var draft: TeamDraft?
  var more = false
}

private enum NewTeamRoute: Hashable { case start, templates, describe, building, preview, builder, review }

struct NewChannel: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  /** a link to look through existing teams instead */
  var onBrowse: (() -> Void)?
  var onCreated: (Channel) -> Void
  @State private var model = NewTeamDraft()
  @State private var path: [NewTeamRoute] = []
  @State private var action = FormAction()
  @State private var addingAgent = false

  private var slug: String { ManagementText.channelName(model.name) }
  /** the name as the person typed it, for headings; the slug is only what gets sent */
  private var shownName: String { let t = model.name.trimmingCharacters(in: .whitespacesAndNewlines); return t.isEmpty ? slug : t }
  private var exists: Bool { store.channels.contains { $0.name == slug } }
  private var validName: Bool { slug.range(of: "^[a-z0-9][a-z0-9_-]{0,79}$", options: .regularExpression) != nil && !exists && model.topic.count <= 250 }
  /** a team needs at least two agents; with fewer, the person is sent to make another */
  private var needsAgents: Bool { store.agents.count < ChannelTeam.minAgents }

  var body: some View {
    NavigationStack(path: $path) {
      namePage
        .navigationDestination(for: NewTeamRoute.self) { route in
          switch route {
          case .start: startPage
          case .templates: TemplateBrowser(title: "Templates", onClose: { pop() }) { template in
              model.team = template.team(agents: store.agents)
              path.append(.builder)
            }.navigationBarHidden(true)
          case .describe: DescribePage(model: model, slug: slug, back: pop) { path.append(.building) }
          case .building: BuildingPage(model: model, back: pop) { ready in
              path.removeLast()
              if ready { path.append(.preview) }
            }
          case .preview: PreviewPage(model: model, slug: slug, busy: action.busy, error: action.error, back: pop, edit: { path.append(.builder) }, create: { createTeam() })
          case .builder: TeamBuilder(team: Bindable(model).team, name: slug, saving: action.busy, error: action.error, onBack: pop) { path.append(.review) }
          case .review: ReviewPage(model: model, slug: slug, busy: action.busy, error: action.error, back: pop, create: { createTeam() })
          }
        }
    }
    .interactiveDismissDisabled(action.busy)
    .sheet(isPresented: $addingAgent) { AddAgent { _ in } }
    .presentationBackground(Palette.sheet)
  }

  private func pop() { if !path.isEmpty { path.removeLast() } }

  // MARK: 1. name

  private var namePage: some View {
    VStack(spacing: 0) {
      TopBar {
        CircleButton(symbol: "xmark", label: "Close", id: "create-close") { dismiss() }
      } center: {
        Text("New team").font(.system(size: 19, weight: .semibold)).foregroundStyle(Palette.text)
      } trailing: { Color.clear.frame(width: 52, height: 52) }
      ScrollView {
        VStack(alignment: .leading, spacing: 22) {
          Text("Step 1 of 2 · Name and description").font(.system(size: 15)).foregroundStyle(Palette.muted).padding(.horizontal, 18)
          if needsAgents {
            VStack(alignment: .leading, spacing: 6) {
              Text("A team needs at least \(ChannelTeam.minAgents) agents, and you have \(store.agents.isEmpty ? "none" : String(store.agents.count)).").font(.system(size: 15)).foregroundStyle(Palette.text)
              Button(store.agents.isEmpty ? "Make an agent" : "Make another agent") { addingAgent = true }
                .font(.system(size: 15)).foregroundStyle(Palette.blue).accessibilityIdentifier("create-add-agent")
            }
            .padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
            .accessibilityIdentifier("create-needs-agents")
          }
          VStack(alignment: .leading, spacing: 8) {
            Text("Name").font(.system(size: 15)).foregroundStyle(Palette.muted).padding(.horizontal, 18)
            TextField("Release crew", text: $model.name).textInputAutocapitalization(.never).autocorrectionDisabled()
              .font(.system(size: 15)).padding(.horizontal, 18).frame(minHeight: 56)
              .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
              .accessibilityIdentifier("create-name")
            if !slug.isEmpty && (exists || slug != model.name) {
              Text(exists ? "\(slug) already exists." : slug).font(.system(size: 13)).foregroundStyle(exists ? Palette.red : Palette.faint).padding(.horizontal, 18)
            }
          }
          VStack(alignment: .leading, spacing: 8) {
            Text("What is it for?").font(.system(size: 15)).foregroundStyle(Palette.muted).padding(.horizontal, 18)
            TextField("Ship releases on time, checked before they go out.", text: $model.topic, axis: .vertical).lineLimit(3...8)
              .font(.system(size: 15)).padding(18).frame(maxWidth: .infinity, minHeight: 110, alignment: .topLeading)
              .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
              .accessibilityIdentifier("create-topic")
            Text("Agents on the team read this so they know what the team is for.").font(.system(size: 13)).foregroundStyle(Palette.faint).padding(.horizontal, 18)
          }
          moreOptions
        }
        .padding(.horizontal, 18).padding(.top, 6).padding(.bottom, 24)
      }
      .scrollDismissesKeyboard(.interactively)
      Button { path.append(.start) } label: { Text("Next").frame(maxWidth: .infinity) }
        .primaryButton().disabled(!validName || needsAgents).padding(.horizontal, 36).padding(.vertical, 10)
        .accessibilityIdentifier("create-next")
    }
    .background(Palette.sheet.ignoresSafeArea())
    .navigationBarHidden(true)
  }

  private var moreOptions: some View {
    VStack(alignment: .leading, spacing: 8) {
      Button { withAnimation(.snappy) { model.more.toggle() } } label: {
        HStack {
          Text("More options").font(.system(size: 15)).foregroundStyle(Palette.text)
          Spacer()
          Image(systemName: model.more ? "chevron.up" : "chevron.down").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.faint)
        }
        .padding(.horizontal, 18).frame(minHeight: 54).contentShape(Rectangle())
        .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("create-more")
      if model.more {
        CardGroup {
          SectionPicker(selection: $model.section).padding(.horizontal, 18).frame(minHeight: 54)
          Toggle("Private", isOn: $model.isPrivate).padding(.horizontal, 18).frame(minHeight: 54)
          if let onBrowse {
            Button("Browse existing teams") { dismiss(); onBrowse() }.padding(.horizontal, 18).frame(maxWidth: .infinity, minHeight: 54, alignment: .leading)
          }
        }
        CardCaption("Private teams are only seen by people and agents you add.")
      }
    }
  }

  // MARK: 2. how to start

  private var startPage: some View {
    VStack(spacing: 0) {
      TopBar {
        CircleButton(symbol: "chevron.left", label: "Back", action: pop)
      } center: {
        Text("New team").font(.system(size: 19, weight: .semibold)).foregroundStyle(Palette.text)
      } trailing: { Color.clear.frame(width: 52, height: 52) }
      ScrollView {
        VStack(alignment: .leading, spacing: 22) {
          VStack(alignment: .leading, spacing: 6) {
            Text("How should \(shownName) work?").font(.system(size: 22, weight: .semibold)).foregroundStyle(Palette.text)
            Text("Pick a start. You can change every step later.").font(.system(size: 15)).foregroundStyle(Palette.muted)
          }
          .padding(.horizontal, 6)
          CardGroup {
            startRow("Start from scratch", "An empty canvas. Draw it your way.", "square.and.pencil", "start-scratch") {
              model.team = ChannelTeam(nodes: [], edges: [], roles: [], steps: [])
              path.append(.builder)
            }
            startRow("Browse templates", "\(TeamTemplate.builtIn.count) ready-made teams.", "square.grid.2x2", "start-templates") { path.append(.templates) }
            startRow("Have an agent build it", "Say it in one sentence.", "sparkles", "start-agent") { path.append(.describe) }
          }
          InlineError(error: action.error)
        }
        .padding(.horizontal, 18).padding(.top, 10)
      }
    }
    .background(Palette.sheet.ignoresSafeArea())
    .navigationBarHidden(true)
  }

  private func startRow(_ title: String, _ subtitle: String, _ symbol: String, _ id: String, _ go: @escaping () -> Void) -> some View {
    Button(action: go) {
      RowLabel(title: title, subtitle: subtitle) {
        Image(systemName: symbol).font(.system(size: 20)).foregroundStyle(Palette.muted).frame(width: 30)
      }
    }
    .buttonStyle(.plain).accessibilityIdentifier(id)
  }

  // MARK: creating

  private func createTeam() {
    var team = model.team.migrated
    team.roles = team.roles ?? []
    team = team.withChart
    action.run { try await create(team: team) }
  }

  private func create(team: ChannelTeam?) async throws {
    var settings: [String: AnyEncodable] = ["replyInThread": AnyEncodable(true)]
    if let team { settings["team"] = AnyEncodable(team) }
    let channel = try await store.createChannel([
      "name": AnyEncodable(slug), "topic": AnyEncodable(model.topic), "sectionId": .nullable(model.section),
      "private": AnyEncodable(model.isPrivate), "settings": AnyEncodable(settings),
    ])
    dismiss()
    onCreated(channel)
  }
}

// MARK: pages

/** The top bar and bottom button every page after the first one shares. */
private struct PageFrame<Content: View, Bottom: View>: View {
  var title: String
  var back: () -> Void
  @ViewBuilder var content: Content
  @ViewBuilder var bottom: Bottom
  var body: some View {
    VStack(spacing: 0) {
      TopBar {
        CircleButton(symbol: "chevron.left", label: "Back", id: "page-back", action: back)
      } center: {
        Text(title).font(.system(size: 19, weight: .semibold)).foregroundStyle(Palette.text)
      } trailing: { Color.clear.frame(width: 52, height: 52) }
      content
      bottom
    }
    .background(Palette.sheet.ignoresSafeArea())
    .navigationBarHidden(true)
  }
}

private struct DescribePage: View {
  @Environment(Store.self) private var store
  @Bindable var model: NewTeamDraft
  var slug: String
  var back: () -> Void
  var build: () -> Void
  @FocusState private var focused: Bool

  private var builder: Agent? { store.agent(model.builder ?? "") ?? store.agents.first }
  private let tries = ["One builds, one reviews", "Research, then I approve", "Triage, reply, check"]

  var body: some View {
    PageFrame(title: "Describe", back: back) {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          VStack(alignment: .leading, spacing: 6) {
            Text("Describe how it works").font(.system(size: 22, weight: .semibold)).foregroundStyle(Palette.text)
            Text("One sentence is enough. You can fix the result.").font(.system(size: 15)).foregroundStyle(Palette.muted)
          }
          TextField("Opus plans, GPT pokes holes until it approves, then Opus hands out the work", text: $model.description, axis: .vertical)
            .lineLimit(4...10).focused($focused)
            .font(.system(size: 15)).padding(18).frame(maxWidth: .infinity, minHeight: 130, alignment: .topLeading)
            .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
            .accessibilityIdentifier("describe-field")
          VStack(alignment: .leading, spacing: 8) {
            Text("Try").font(.system(size: 15)).foregroundStyle(Palette.muted).padding(.horizontal, 6)
            ForEach(tries, id: \.self) { t in
              Button { model.description = t } label: {
                Text(t).font(.system(size: 15)).foregroundStyle(Palette.text).padding(.horizontal, 16).frame(minHeight: 44)
                  .background(Capsule().fill(Palette.card))
              }
              .buttonStyle(.plain)
            }
          }
          if store.agents.isEmpty {
            Text("Add an agent first: it draws the team.").font(.system(size: 15)).foregroundStyle(Palette.red)
          } else {
            HStack {
              Text("Built by").font(.system(size: 15)).foregroundStyle(Palette.muted)
              Menu {
                ForEach(store.agents) { a in Button(a.name) { model.builder = a.id } }
              } label: {
                HStack(spacing: 8) {
                  if let b = builder { AgentAvatar(agent: b, size: 24, showStatus: false); Text(b.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text) }
                  Image(systemName: "chevron.up.chevron.down").font(.system(size: 12)).foregroundStyle(Palette.faint)
                }
                .padding(.horizontal, 14).frame(height: 44).glassPill()
              }
              Spacer()
            }
            .padding(.horizontal, 6)
          }
        }
        .padding(.horizontal, 18).padding(.top, 10).padding(.bottom, 20)
      }
      .scrollDismissesKeyboard(.interactively)
    } bottom: {
      Button { focused = false; build() } label: { Label("Build it", systemImage: "sparkles").frame(maxWidth: .infinity) }
        .primaryButton().padding(.horizontal, 36).padding(.vertical, 10)
        .disabled(model.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.agents.isEmpty)
        .accessibilityIdentifier("describe-build")
    }
  }
}

/** An agent draws the team: waits, polling the hub, until the draft is ready or failed. */
private struct BuildingPage: View {
  @Environment(Store.self) private var store
  @Bindable var model: NewTeamDraft
  var back: () -> Void
  var finished: (Bool) -> Void
  @State private var failure: String?
  @State private var attempt = 0

  private var builder: Agent? { store.agent(model.builder ?? "") ?? store.agents.first }

  var body: some View {
    PageFrame(title: "Building", back: back) {
      VStack(spacing: 18) {
        Spacer()
        if failure == nil {
          if let builder { AgentAvatar(agent: builder, size: 84, showStatus: false) }
          ProgressView()
          Text("\(builder?.name ?? "An agent") is drawing your team").font(.system(size: 22, weight: .semibold)).foregroundStyle(Palette.text).multilineTextAlignment(.center)
          Text(model.description).font(.system(size: 15)).foregroundStyle(Palette.muted).multilineTextAlignment(.center).lineLimit(5).padding(.horizontal, 30)
        } else {
          Image(systemName: "exclamationmark.circle").font(.system(size: 34)).foregroundStyle(Palette.red)
          Text("It couldn't draw that").font(.system(size: 22, weight: .semibold)).foregroundStyle(Palette.text)
          Text(failure ?? "").font(.system(size: 15)).foregroundStyle(Palette.muted).multilineTextAlignment(.center).padding(.horizontal, 30)
          Button("Try again") { failure = nil; attempt += 1 }.secondaryButton().controlSize(.large)
        }
        Spacer(); Spacer()
      }
      .frame(maxWidth: .infinity)
    } bottom: {
      Button("Cancel", action: back).font(.system(size: 15)).foregroundStyle(Palette.muted).frame(minHeight: 50).padding(.bottom, 10)
        .accessibilityIdentifier("building-cancel")
    }
    .task(id: attempt) { await draw() }
  }

  private func draw() async {
    do {
      var draft = try await store.startTeamDraft(model.description, agentId: builder?.id)
      while draft.status == "working" {
        try await Task.sleep(for: .seconds(1.5))
        draft = try await store.teamDraft(draft.id)
      }
      if draft.status == "ready", draft.steps?.isEmpty == false {
        model.draft = draft
        model.team = ChannelTeam(nodes: [], edges: [], roles: [], steps: ChannelTeam.layoutSteps(ChannelTeam.normalizeSteps(draft.steps ?? [])))
        finished(true)
      } else {
        failure = draft.problem ?? "Try saying it another way."
      }
    } catch is CancellationError {
      // the person went back
    } catch {
      failure = error.localizedDescription
    }
  }
}

private struct PreviewPage: View {
  @Environment(Store.self) private var store
  @Bindable var model: NewTeamDraft
  var slug: String
  var busy: Bool
  var error: String?
  var back: () -> Void
  var edit: () -> Void
  var create: () -> Void

  var body: some View {
    let team = model.team
    let lines = model.draft?.lines ?? team.flowLines(store)
    PageFrame(title: "Preview", back: back) {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          Text("Here is your team").font(.system(size: 22, weight: .semibold)).foregroundStyle(Palette.text).padding(.horizontal, 6)
          VStack(spacing: 10) {
            ForEach(team.orderedSteps) { s in PreviewStepRow(team: team, step: s) }
          }
          Text("How it works").font(.system(size: 15)).foregroundStyle(Palette.muted).padding(.horizontal, 6).padding(.top, 6)
          VStack(alignment: .leading, spacing: 14) {
            ForEach(lines) { line in TeamHowLine(team: team, line: line, size: 26) }
          }
          .padding(16).frame(maxWidth: .infinity, alignment: .leading)
          .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
          if let problem = team.createProblem ?? error {
            Text(problem).font(.system(size: 15)).foregroundStyle(Palette.red).padding(.horizontal, 6)
          }
        }
        .padding(.horizontal, 18).padding(.top, 6).padding(.bottom, 16)
      }
    } bottom: {
      HStack(spacing: 12) {
        Button(action: edit) { Text("Edit").frame(maxWidth: .infinity) }.secondaryButton().controlSize(.large).accessibilityIdentifier("preview-edit")
        Button(action: create) { Text("Create team").frame(maxWidth: .infinity) }.primaryButton().disabled(busy || team.createProblem != nil)
          .accessibilityIdentifier("preview-create")
      }
      .padding(.horizontal, 24).padding(.vertical, 10)
    }
    .overlay { if busy { SavingOverlay() } }
  }
}

/** A step in a short list: its number, title and who does it. */
struct PreviewStepRow: View {
  @Environment(Store.self) private var store
  var team: ChannelTeam
  var step: ChannelTeam.Step

  var body: some View {
    HStack(spacing: 12) {
      Text("\(team.number(of: step.id))").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.muted)
        .frame(width: 26, height: 26).background(Circle().fill(Palette.badge))
      VStack(alignment: .leading, spacing: 3) {
        if let mark = step.kindMark { Label(mark.text, systemImage: mark.symbol).labelStyle(CompactLabel()).font(.system(size: 13)).foregroundStyle(Palette.muted) }
        Text(step.action.isEmpty ? "Untitled step" : step.action).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text)
      }
      Spacer(minLength: 8)
      if let agent = team.agentId(of: step).flatMap({ store.agent($0) }) {
        HStack(spacing: 6) {
          AgentAvatar(agent: agent, size: 22, showStatus: false)
          Text(agent.name).font(.system(size: 15)).foregroundStyle(Palette.muted)
        }
      } else if step.kind == .ask {
        Text("You").font(.system(size: 15)).foregroundStyle(Palette.muted)
      }
    }
    .padding(.horizontal, 16).frame(minHeight: 62)
    .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
    .accessibilityElement(children: .combine)
  }
}

private struct ReviewPage: View {
  @Environment(Store.self) private var store
  @Bindable var model: NewTeamDraft
  var slug: String
  var busy: Bool
  var error: String?
  var back: () -> Void
  var create: () -> Void

  var body: some View {
    let team = model.team
    let agents = Array(NSOrderedSet(array: team.orderedSteps.compactMap { team.agentId(of: $0) })).compactMap { $0 as? String }.compactMap { store.agent($0) }
    PageFrame(title: "Ready to create", back: back) {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          HStack(spacing: 14) {
            TeamGhosts(agents: agents, seed: slug, size: 56)
            VStack(alignment: .leading, spacing: 4) {
              Text(model.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? slug : model.name.trimmingCharacters(in: .whitespacesAndNewlines)).font(.system(size: 22, weight: .semibold)).foregroundStyle(Palette.text)
              if !model.topic.isEmpty { Text(model.topic).font(.system(size: 15)).foregroundStyle(Palette.muted) }
            }
          }
          .padding(.horizontal, 6)
          Text("How it works").font(.system(size: 15)).foregroundStyle(Palette.muted).padding(.horizontal, 6)
          VStack(alignment: .leading, spacing: 14) {
            ForEach(team.flowLines(store)) { line in TeamHowLine(team: team, line: line, size: 26) }
          }
          .padding(16).frame(maxWidth: .infinity, alignment: .leading)
          .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
          Button(action: back) {
            RowLabel(title: "See the flowchart", value: "\(team.steps?.count ?? 0) steps") {
              Image(systemName: "point.3.connected.trianglepath.dotted").font(.system(size: 18)).foregroundStyle(Palette.muted).frame(width: 28)
            }
            .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
          }
          .buttonStyle(.plain)
          if let problem = team.createProblem, error == nil {
            Text(problem).font(.system(size: 15)).foregroundStyle(Palette.red).padding(.horizontal, 6).accessibilityIdentifier("review-problem")
          }
          if let problem = error {
            VStack(alignment: .leading, spacing: 4) {
              Label("Couldn't create it", systemImage: "exclamationmark.circle").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.red)
              Text(problem).font(.system(size: 15)).foregroundStyle(Palette.text)
            }
            .padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.red.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .accessibilityIdentifier("review-error")
          }
        }
        .padding(.horizontal, 18).padding(.top, 6).padding(.bottom, 16)
      }
    } bottom: {
      HStack(spacing: 12) {
        Button(action: back) { Text("Edit steps").frame(maxWidth: .infinity) }.secondaryButton().controlSize(.large)
        Button(action: create) { Text("Create team").frame(maxWidth: .infinity) }.primaryButton().disabled(busy || team.createProblem != nil)
          .accessibilityIdentifier("review-create")
      }
      .padding(.horizontal, 24).padding(.vertical, 10)
    }
    .overlay { if busy { SavingOverlay() } }
  }
}

// MARK: templates

/** Ready-made teams, one at a time: a small flowchart and a sample of how it sounds. */
struct TemplateBrowser: View {
  @Environment(Store.self) private var store
  var title: String
  var onClose: () -> Void
  var onUse: (TeamTemplate) -> Void
  @State private var own: [TeamTemplate] = []
  @State private var page = 0
  @State private var action = FormAction()

  private var all: [TeamTemplate] { TeamTemplate.builtIn + own.filter { o in !TeamTemplate.builtIn.contains { $0.id == o.id } } }

  var body: some View {
    VStack(spacing: 0) {
      TopBar {
        CircleButton(symbol: "chevron.left", label: "Back", id: "templates-back", action: onClose)
      } center: {
        Text("\(title) \(min(page + 1, max(all.count, 1)))/\(all.count)").font(.system(size: 19, weight: .semibold)).foregroundStyle(Palette.text)
      } trailing: { Color.clear.frame(width: 52, height: 52) }
      TabView(selection: $page) {
        ForEach(Array(all.enumerated()), id: \.element.id) { i, t in
          ScrollView {
            TemplatePage(template: t, own: own.contains { $0.id == t.id }, onDelete: { delete(t) })
              .padding(.horizontal, 18).padding(.bottom, 24)
          }
          .tag(i)
        }
      }
      .tabViewStyle(.page(indexDisplayMode: .never))
      InlineError(error: action.error).padding(.horizontal, 24)
      Button {
        if page < all.count { onUse(all[page]) }
      } label: { Text("Use this template").frame(maxWidth: .infinity) }
        .primaryButton().padding(.horizontal, 36).padding(.vertical, 10)
        .accessibilityIdentifier("templates-use")
    }
    .background(Palette.sheet.ignoresSafeArea())
    .task { own = (try? await store.teamTemplates()) ?? [] }
  }

  private func delete(_ t: TeamTemplate) {
    action.run {
      try await store.deleteTeamTemplate(t.id)
      own.removeAll { $0.id == t.id }
      page = min(page, max(all.count - 1, 0))
    }
  }
}

private struct TemplatePage: View {
  var template: TeamTemplate
  var own: Bool
  var onDelete: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      VStack(alignment: .leading, spacing: 6) {
        Text(template.name).font(.system(size: 22, weight: .semibold)).foregroundStyle(Palette.text)
        Text(template.blurb).font(.system(size: 15)).foregroundStyle(Palette.muted)
      }
      Text("Who hands to whom").font(.system(size: 15)).foregroundStyle(Palette.muted).padding(.horizontal, 6)
      MiniFlow(template: template)
        .padding(16).frame(maxWidth: .infinity)
        .background(Palette.card, in: RoundedRectangle(cornerRadius: Corner.card, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
      if let sample = template.sample, !sample.isEmpty {
        Text("How a request goes").font(.system(size: 15)).foregroundStyle(Palette.muted).padding(.horizontal, 6)
        VStack(alignment: .leading, spacing: 10) {
          ForEach(Array(sample.enumerated()), id: \.offset) { _, line in SampleBubble(line: line, template: template) }
        }
      }
      if own {
        Button("Delete this template", role: .destructive, action: onDelete).font(.system(size: 15)).frame(minHeight: 44)
      }
    }
    .padding(.top, 8)
  }
}

/** A template's steps as small chips, parallel steps side by side. */
private struct MiniFlow: View {
  var template: TeamTemplate

  var body: some View {
    let rows = ChannelTeam.stepRows(template.steps)
    VStack(spacing: 6) {
      ForEach(Array(rows.enumerated()), id: \.offset) { i, row in
        if i > 0 { Image(systemName: "arrow.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(Palette.faint) }
        HStack(spacing: 8) { ForEach(row) { s in chip(s) } }
      }
    }
  }

  private func chip(_ s: ChannelTeam.Step) -> some View {
    VStack(spacing: 4) {
      HStack(spacing: 6) {
        icon(s)
        Text(s.action).font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.text).lineLimit(2).multilineTextAlignment(.leading)
      }
      .padding(.horizontal, 12).padding(.vertical, 8)
      .background(Capsule().fill(Palette.badge))
      if s.kind == .review {
        Label("until approved", systemImage: "arrow.triangle.2.circlepath").labelStyle(CompactLabel()).font(.system(size: 12)).foregroundStyle(Palette.muted)
      }
    }
  }

  @ViewBuilder private func icon(_ s: ChannelTeam.Step) -> some View {
    if let mark = s.kindMark, s.kind != .review, s.kind != .custom { Image(systemName: mark.symbol).font(.system(size: 13)).foregroundStyle(Palette.muted) }
    else { GhostView(look: nil, seed: s.roleId.isEmpty ? s.id : s.roleId, size: 18) }
  }
}

private struct SampleBubble: View {
  var line: TeamTemplate.Line
  var template: TeamTemplate

  var body: some View {
    let you = line.who == "You"
    HStack(alignment: .bottom, spacing: 8) {
      if you { Spacer(minLength: 40) } else { GhostView(look: nil, seed: line.who, size: 26) }
      VStack(alignment: you ? .trailing : .leading, spacing: 3) {
        if !you { Text(line.who).font(.system(size: 13)).foregroundStyle(Palette.faint).padding(.horizontal, 6) }
        Text(line.text).font(.system(size: 15)).foregroundStyle(you ? Color.white : Palette.text)
          .padding(.horizontal, 14).padding(.vertical, 10)
          .background(you ? Palette.blue : Palette.bubble, in: BubbleShape(mine: you))
      }
      if !you { Spacer(minLength: 40) }
    }
    .accessibilityElement(children: .combine)
  }
}
