import SwiftUI

/** What you did, a day at a time. Each day is one note you can edit in Memory. */
struct JournalDays: View {
  var items: [MemoryItem]
  /** only the days, each a row that opens its note (the Plans page); otherwise every entry too (Activity) */
  var compact = false

  /** Newest day first; entries without a date go last as "Undated". */
  static func days(_ items: [MemoryItem]) -> [(day: String, entries: [MemoryItem])] {
    let keys = Set(items.map { $0.date ?? "" }).sorted { a, b in a.isEmpty != b.isEmpty ? !a.isEmpty : a > b }
    return keys.map { key in (key, items.filter { ($0.date ?? "") == key }) }
  }
  static func title(_ day: String) -> String {
    guard !day.isEmpty, let date = Wire.date(day) else { return "Undated" }
    return date.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
  }

  var body: some View {
    if compact {
      CardGroup {
        ForEach(Self.days(items), id: \.day) { day, entries in
          if let first = entries.first {
            NavigationLink { NoteView(path: first.path) } label: {
              RowLabel(title: Self.title(day), value: "Edit day") { Image(systemName: "calendar").font(.system(size: 18)).foregroundStyle(Palette.muted) }
            }.buttonStyle(.plain)
          }
        }
      }
    } else {
      ForEach(Self.days(items), id: \.day) { day, entries in
        SectionCaption(Self.title(day), trailing: entries.first.map { first in
          AnyView(NavigationLink { NoteView(path: first.path) } label: { Text("Edit day").font(.system(size: 14, weight: .medium)).foregroundStyle(Color(light: 0x0A64D6, dark: 0x9EC5FF)) })
        })
        CardGroup {
          ForEach(entries) { entry in
            VStack(alignment: .leading, spacing: 2) {
              Text(entry.text).font(.system(size: 17)).foregroundStyle(Palette.text).textSelection(.enabled)
              if let by = entry.by { Text("by \(by)").font(.system(size: 14)).foregroundStyle(Palette.faint) }
            }.padding(.horizontal, 18).padding(.vertical, 12).frame(maxWidth: .infinity, alignment: .leading)
          }
        }
      }
    }
  }
}
