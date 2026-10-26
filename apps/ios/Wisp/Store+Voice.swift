import Foundation

extension Store {
  /** What was said in a voice call, sent to the agent's DM and marked as a voice message like the web does. */
  func sendVoiceMessage(_ text: String, in channelId: String) async throws {
    struct Body: Encodable { var body: String; var voice = true }
    // the hub echoes it back over the socket, which puts it in the channel
    let _: Message = try await fetch { try await $0.post("/api/channels/\(channelId)/messages", Body(body: text)) }
  }
}
