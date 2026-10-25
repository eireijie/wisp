import SwiftUI

/** What you did, a day at a time. Each day is one note you can edit in Memory. */
struct JournalDays: View {
  var items: [MemoryItem]

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
    ForEach(Self.days(items), id: \.day) { day, entries in
      Section {
        ForEach(entries) { entry in
          VStack(alignment: .leading, spacing: 2) {
            Text(entry.text).textSelection(.enabled)
            if let by = entry.by { Text("by \(by)").font(.caption).foregroundStyle(.secondary) }
          }
        }
      } header: {
        HStack {
          Text(Self.title(day))
          Spacer()
          if let first = entries.first { NavigationLink("Edit day") { NoteView(path: first.path) }.font(.caption).textCase(nil) }
        }
      }
    }
  }
}
