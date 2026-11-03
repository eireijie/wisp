import SwiftUI

// Open loops in the chat (loops-*.dc.html): the reminder pill under an agent's reply and its
// sheet, "Checking back" with quick replies, the wrap-up card and the "Closed" line. The logic is
// in Loops.swift.

/** "Check the build · 4:35 PM" under the reply that promised it; a tap changes or cancels it. Done or cancelled ones stay, muted. */
struct FollowupPillView: View {
  var pill: FollowupPill
  var message: Message
  @State private var open: ReminderTarget?

  var body: some View {
    let time = pill.date.map { Loops.pillTime($0) } ?? ""
    Button {
      open = ReminderTarget(followupId: pill.followupId, label: pill.label, dueAt: pill.dueAt, agentId: message.author.kind == .agent ? message.author.id : nil)
    } label: {
      HStack(spacing: 7) {
        Image(systemName: pill.pending ? "clock" : pill.status == "done" ? "checkmark" : "minus")
          .font(.system(size: 12, weight: .medium))
          .foregroundStyle(pill.pending ? Palette.blue : Palette.faint)
        (Text(pill.label).fontWeight(.medium).foregroundStyle(pill.pending ? Palette.text : Palette.faint)
          + Text(" · " + (pill.pending ? time : pill.status == "done" ? "done" : "cancelled")))
          .lineLimit(1)
      }
      .font(.system(size: 13))
      .foregroundStyle(pill.pending ? Color(light: 0x5F5F68, dark: 0xC7C7CC) : Palette.faint)
      .padding(.leading, 9).padding(.trailing, 11)
      .frame(height: 28)
      .background(Capsule().fill(Palette.sheet))
      .overlay(Capsule().strokeBorder(Palette.cardBorder))
    }
    .buttonStyle(.press)
    .disabled(!pill.pending)
    .padding(.top, 2).padding(.bottom, 4)
    .loopEntrance(.pop, fresh: Loops.fresh(message))
    .accessibilityLabel(pill.pending ? "Reminder: \(pill.label), \(time). Change or cancel" : "\(pill.label), \(pill.status == "done" ? "done" : "cancelled")")
    .accessibilityIdentifier("followup-pill")
    .sheet(item: $open) { ReminderSheet(target: $0) }
  }
}

/**
 * Changing a reminder (loops-ReminderSheet.dc.html): its label and when, then In 1 hour, Tonight,
 * Tomorrow morning or Pick a time, and Already done or Don't remind me.
 */
struct ReminderSheet: View {
  @Environment(Store.self) private var store
  @Environment(\.dismiss) private var dismiss
  var target: ReminderTarget
  @State private var picking = false
  @State private var picked = Date().addingTimeInterval(3600)
  @State private var action = FormAction()
  @State private var detent: PresentationDetent = .medium
  @ReduceMotion private var reduceMotion

  /** the condition, when the pill didn't carry it: from the agent's Background list */
  private var condition: String? {
    target.condition ?? target.agentId.flatMap { store.backgrounds[$0]?.followups?.first { $0.id == target.followupId }?.condition }
  }

  var body: some View {
    let due = Wire.date(target.dueAt)
    let options = Loops.options()
    let current = Loops.current(options, dueAt: due)
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        HStack(alignment: .top, spacing: 12) {
          Image(systemName: "clock").font(.system(size: 18)).foregroundStyle(Palette.blue).padding(.top, 2)
          VStack(alignment: .leading, spacing: 3) {
            Text(target.label).font(.system(size: 17, weight: .semibold)).foregroundStyle(Palette.text)
            let line = Loops.sheetLine(due, condition: condition)
            if !line.isEmpty { Text(line).font(.system(size: 13)).foregroundStyle(Palette.faint) }
          }
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 2).padding(.top, 4)
        CardGroup {
          ForEach(options) { option in
            Button { move(to: option.date) } label: {
              HStack(spacing: 6) {
                Text(option.title).foregroundStyle(Palette.text)
                Spacer(minLength: 8)
                Text(Loops.clock(option.date)).foregroundStyle(option == current ? Palette.blue : Palette.faint)
                if option == current { Image(systemName: "checkmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.blue) }
              }
              .font(.system(size: 15))
              .padding(.horizontal, 14).frame(minHeight: 48).contentShape(Rectangle())
            }
            .buttonStyle(.pressRow)
            .accessibilityIdentifier("reminder-\(option.title)")
          }
          Button {
            withAnimation(Motion.pick(Motion.soft, reduceMotion)) { picking.toggle(); detent = picking ? .large : .medium }
          } label: {
            HStack {
              Text("Pick a time").foregroundStyle(Palette.text)
              Spacer(minLength: 8)
              Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.faint)
                .rotationEffect(.degrees(picking ? 90 : 0))
            }
            .font(.system(size: 15))
            .padding(.horizontal, 14).frame(minHeight: 48).contentShape(Rectangle())
          }
          .buttonStyle(.pressRow)
          .accessibilityIdentifier("reminder-pick")
          if picking {
            VStack(spacing: 10) {
              DatePicker("When", selection: $picked, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                .datePickerStyle(.wheel).labelsHidden()
              PillButton(title: "Remind me then", busy: action.busy, id: "reminder-set") { move(to: picked) }
            }
            .padding(14)
            .transition(.opacity)
          }
        }
        CardGroup {
          Button { finish("done") } label: {
            HStack(spacing: 12) {
              Image(systemName: "checkmark").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.statusOnline).frame(width: 20)
              Text("Already done").foregroundStyle(Palette.text)
              Spacer(minLength: 0)
            }
            .font(.system(size: 15)).padding(.horizontal, 14).frame(minHeight: 48).contentShape(Rectangle())
          }
          .buttonStyle(.pressRow).accessibilityIdentifier("reminder-done")
          Button { finish("cancelled") } label: {
            HStack(spacing: 12) {
              Image(systemName: "bell.slash").font(.system(size: 15)).frame(width: 20)
              Text("Don't remind me")
              Spacer(minLength: 0)
            }
            .font(.system(size: 15)).foregroundStyle(Palette.red).padding(.horizontal, 14).frame(minHeight: 48).contentShape(Rectangle())
          }
          .buttonStyle(.pressRow).accessibilityIdentifier("reminder-cancel")
        }
        if let error = action.error { Text(error).font(.system(size: 13)).foregroundStyle(Palette.red).padding(.horizontal, 4) }
      }
      .padding(.horizontal, 16).padding(.top, 20).padding(.bottom, 24)
      .disabled(action.busy)
    }
    .scrollBounceBehavior(.basedOnSize)
    .presentationDetents([.medium, .large], selection: $detent)
    .presentationDragIndicator(.visible)
    .presentationBackground(Palette.sheet)
    .presentationCornerRadius(14)
    .task {
      if let id = target.agentId, target.condition == nil, store.backgrounds[id] == nil { try? await store.refreshBackground(id) }
    }
  }

  private func move(to date: Date) {
    action.run {
      try await store.rescheduleFollowup(target, to: date)
      dismiss()
    }
  }

  private func finish(_ status: String) {
    action.run {
      try await store.finishFollowup(target, status: status)
      dismiss()
    }
  }
}

/**
 * The small "Checking back" line over a bubble the agent wrote on its own; "Checking back on the
 * 9:14 AM chat" when it picks up an earlier chat, and a tap goes to where that chat starts.
 */
struct CheckbackLabel: View {
  @Environment(Store.self) private var store
  @Environment(\.scrollToMessage) private var scrollTo
  var message: Message? = nil

  private var context: MessageContext? { message?.context }
  /** the chat's first message is loaded here, so there's somewhere to go */
  private var reachable: Bool {
    guard let message, let context else { return false }
    return scrollTo != nil && store.message(context.conversationId, in: message.channelId) != nil
  }

  var body: some View {
    let icon = Image(systemName: "arrow.uturn.backward").font(.system(size: 11, weight: .medium))
    Group {
      if let context {
        let name = ChatFormat.chatName(context.date)
        if reachable {
          Button { scrollTo?(context.conversationId) } label: {
            HStack(spacing: 5) {
              icon
              Text("Checking back on ") + Text(name).foregroundStyle(Palette.muted).underline(true, color: Palette.faint.opacity(0.5))
            }
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Checking back on \(name)")
          .accessibilityHint("Goes to where that chat starts")
        } else {
          HStack(spacing: 5) { icon; Text("Checking back on \(name)") }
        }
      } else {
        HStack(spacing: 5) { icon; Text("Checking back") }
      }
    }
    .lineLimit(1)
    .font(.system(size: 12))
    .foregroundStyle(Palette.faint)
    .padding(.leading, 4).padding(.top, 6)
  }
}

/** A check-back's quick answers; a tap sends that answer as your message. */
struct QuickReplies: View {
  @Environment(Store.self) private var store
  var replies: [String]
  var message: Message
  @State private var sending: String?
  @State private var error: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      FlowLayout(spacing: 8) {
        ForEach(Array(replies.enumerated()), id: \.offset) { i, reply in
          Button { send(reply) } label: {
            Text(reply)
              .font(.system(size: 14, weight: .medium))
              .foregroundStyle(Palette.text)
              .lineLimit(1)
              .padding(.horizontal, 14).frame(height: 34)
              .background(Capsule().fill(Palette.sheet))
              .overlay(Capsule().strokeBorder(Palette.hairline))
              .opacity(sending == nil || sending == reply ? 1 : 0.5)
          }
          .buttonStyle(.press)
          .disabled(sending != nil)
          .loopEntrance(.chip(i), fresh: Loops.fresh(message))
          .accessibilityIdentifier("quick-reply")
        }
      }
      if let error { Text(error).font(.system(size: 12)).foregroundStyle(Palette.red) }
    }
    .padding(.top, 4)
    .frame(maxWidth: 340, alignment: .leading)
  }

  private func send(_ reply: String) {
    sending = reply; error = nil
    Task {
      do { try await store.send(reply, in: message.channelId) } catch { self.error = error.localizedDescription }
      sending = nil
    }
  }
}

/** "Done": what got done, what was saved, what's next. */
struct WrapUpCard: View {
  var wrap: WrapUp
  var message: Message

  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      Label { Text("Done") } icon: { Image(systemName: "checkmark").font(.system(size: 12, weight: .semibold)) }
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(Palette.statusOnlineText)
      ForEach(Array(wrap.rows.enumerated()), id: \.offset) { i, row in
        HStack(alignment: .firstTextBaseline, spacing: 9) {
          Text(row.key).foregroundStyle(Palette.faint).frame(width: 44, alignment: .leading)
          Text(row.text).foregroundStyle(Palette.text).fixedSize(horizontal: false, vertical: true)
        }
        .font(.system(size: 14))
        .loopEntrance(.line(i), fresh: Loops.fresh(message))
      }
    }
    .padding(.horizontal, 14).padding(.vertical, 12)
    .frame(maxWidth: 300, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).fill(Palette.sheet))
    .overlay(RoundedRectangle(cornerRadius: Corner.card, style: .continuous).strokeBorder(Palette.cardBorder))
    .padding(.top, 2)
    .loopEntrance(.unfold, fresh: Loops.fresh(message))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Wrap-up. " + wrap.rows.map { "\($0.key): \($0.text)" }.joined(separator: ". "))
  }
}

/** "Closed · not answered", centered under the message where the agent let it go. */
struct ClosedLine: View {
  var message: Message

  var body: some View {
    Label { Text("Closed · not answered") } icon: { Image(systemName: "minus").font(.system(size: 11, weight: .semibold)) }
      .font(.system(size: 12))
      .foregroundStyle(Palette.faint)
      .frame(maxWidth: .infinity)
      .padding(.top, 4).padding(.bottom, 10)
      .loopEntrance(.line(1), fresh: Loops.fresh(message))
  }
}

// MARK: motion (loops-Motion.dc.html)

enum LoopEntrance {
  /** the pill: scales up from 0.7 with a spring */
  case pop
  /** a quick reply: rises 8pt from 0.9, 50ms after the one before */
  case chip(Int)
  /** the wrap-up card: unfolds from the top */
  case unfold
  /** a wrap-up line or the closed line: a short fade and rise, after the card */
  case line(Int)
}

extension View {
  /** Plays once when a just-posted piece appears; older history shows as is, and Reduce Motion only fades. */
  func loopEntrance(_ kind: LoopEntrance, fresh: Bool) -> some View { modifier(LoopEntranceModifier(kind: kind, fresh: fresh)) }
}

private struct LoopEntranceModifier: ViewModifier {
  var kind: LoopEntrance
  var fresh: Bool
  @ReduceMotion private var reduceMotion
  @State private var shown: Bool?

  func body(content: Content) -> some View {
    let on = shown ?? !fresh
    let still = on || reduceMotion
    content
      .opacity(on ? 1 : 0)
      .scaleEffect(x: still ? 1 : scale.x, y: still ? 1 : scale.y, anchor: anchor)
      .offset(y: still ? 0 : rise)
      .onAppear {
        guard shown == nil else { return }
        shown = !fresh
        guard fresh else { return }
        withAnimation(reduceMotion ? Motion.reduced : animation) { shown = true }
      }
  }

  private var scale: (x: CGFloat, y: CGFloat) {
    switch kind {
    case .pop: (0.7, 0.7)
    case .chip: (0.9, 0.9)
    case .unfold: (1, 0.6)
    case .line: (1, 1)
    }
  }

  private var anchor: UnitPoint {
    switch kind {
    case .pop: .leading
    case .unfold: .top
    default: .center
    }
  }

  private var rise: CGFloat {
    switch kind {
    case .pop: 0
    case .chip: 8
    case .unfold: -6
    case .line: 4
    }
  }

  private var animation: Animation {
    switch kind {
    case .pop: .spring(response: 0.42, dampingFraction: 0.58).delay(0.1)
    case .chip(let i): .spring(response: 0.36, dampingFraction: 0.66).delay(Double(min(i, 6)) * 0.05)
    case .unfold: .spring(response: 0.4, dampingFraction: 0.78).delay(0.1)
    case .line(let i): .easeOut(duration: 0.3).delay(0.25 + Double(i) * 0.07)
    }
  }
}
