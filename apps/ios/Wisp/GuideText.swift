import Foundation

/** Keep guided editors' generated instructions identical to the web's. */
enum GuideText {
  static func routineName(_ name: String, goal: String) -> String {
    if !name.trimmed.isEmpty { return String(name.trimmed.prefix(80)) }
    let first = goal.trimmed.components(separatedBy: CharacterSet(charactersIn: ".!?\n")).first ?? ""
    let line = oneLine(first)
    if line.count <= 50 { return line }
    let cut = String(line.prefix(50))
    return (cut.lastIndex(of: " ").map { String(cut[..<$0]) } ?? cut).trimmed + "…"
  }
  static func routineSteps(goal: String, steps: String) -> String {
    guard !goal.trimmed.isEmpty else { return steps }
    return "Goal: \(goal.trimmed)\n\n" + (steps.trimmed.isEmpty ? "No steps were written. Work out the steps yourself, and adapt if something looks different next time." : steps.trimmed)
  }
  static func skill(name: String, what: String, when: String, result: String) -> (description: String, content: String) {
    let sections = [("What to do", what.trimmed), ("When to use it", when.trimmed), ("What a good result looks like", result.trimmed)]
    let heading = oneLine(name).isEmpty ? "New skill" : oneLine(name)
    let content = (["# " + heading] + sections.filter { !$0.1.isEmpty }.map { "## \($0.0)\n\($0.1)" }).joined(separator: "\n\n") + "\n"
    var lead = oneLine(when)
    if !lead.isEmpty && lead.range(of: "^use (when|for)\\b", options: [.regularExpression, .caseInsensitive]) == nil {
      if lead.range(of: "^[A-Z][a-z]", options: .regularExpression) != nil { lead = lead.prefix(1).lowercased() + lead.dropFirst() }
      lead = "Use when " + lead
    }
    return (String(lead.prefix(500)), content)
  }
  private static func oneLine(_ text: String) -> String { text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmed }
}
