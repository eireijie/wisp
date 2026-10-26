import SwiftUI

/** A row whose value is picked from a menu: title (and a line under it) on the left, the choice on the right. */
struct PickerRow<Value: Hashable>: View {
  var title: String
  var subtitle: String? = nil
  var options: [(Value, String)]
  @Binding var selection: Value
  var id: String? = nil

  var body: some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 15)).foregroundStyle(Palette.text)
        if let subtitle { Text(subtitle).font(.system(size: 13)).foregroundStyle(Palette.faint) }
      }
      Spacer(minLength: 8)
      Picker(title, selection: $selection) { ForEach(options.indices, id: \.self) { Text(options[$0].1).tag(options[$0].0) } }
        .pickerStyle(.menu).tint(Palette.faint).labelsHidden()
        .accessibilityLabel(title).accessibilityIdentifier(id ?? "")
    }
    .padding(.horizontal, 14).frame(minHeight: subtitle == nil ? 48 : 56)
  }
}

/** Numbered steps for a how-to page (Data and export: How to back up, How to restore). */
struct StepsCard: View {
  var steps: [String]
  var body: some View {
    CardGroup {
      ForEach(steps.indices, id: \.self) { i in
        HStack(alignment: .top, spacing: 12) {
          Text("\(i + 1)").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.muted).frame(width: 26, height: 26)
            .background(Circle().fill(Color(light: 0xE3E3EA, dark: 0x34343A)))
          Text(steps[i]).font(.system(size: 15)).foregroundStyle(Palette.text).fixedSize(horizontal: false, vertical: true)
          Spacer(minLength: 0)
        }.padding(.horizontal, 18).padding(.vertical, 14)
      }
    }
  }
}

/** A page of plain text points, for the "what is not in it" kind of answer. */
struct BulletsCard: View {
  var points: [String]
  var body: some View {
    CardGroup {
      ForEach(points.indices, id: \.self) { i in
        Text(points[i]).font(.system(size: 15)).foregroundStyle(Palette.text).fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 18).padding(.vertical, 14)
      }
    }
  }
}
