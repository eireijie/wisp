# Warren for iPhone and iPad

A native SwiftUI app for your Warren hub:

- **Chats**: your agents' DMs and channels with unread counts, live replies, threads, and what each agent is doing while it works ("Reading the vault…").
- **Agents**: every agent as its ghost, in its own colors, with its status. Tap one to chat.
- **Computers**: watch any agent's computer live, **Take control** to tap and type on it, and **Hand back**.
- **Inbox**: approve or decline what agents ask your OK for, and see which agents need you on their computer.

It signs in to your hub with your Warren email and password. The session token is kept in the Keychain. Setting up agents, devices and memory still happens in Warren on a computer or in Safari.

## Run it

Open `Warren.xcodeproj` in Xcode 26 or newer, pick a simulator or your iPhone, and Run. Running on your iPhone needs your Apple developer team under **Signing & Capabilities**. The app needs iOS 18.

Your phone must be able to reach the hub: the same network, Tailscale, or a public address (see [Deploying](../../docs/deploy.md)). Plain `http://` addresses work too, since many self-hosted hubs live on a home network.

## Push notifications

The app can notify you about agent replies, @mentions, approval requests and agents that need you on their computer while it's closed. Tapping one opens that chat or thread, the Inbox, or the computer. The badge on the app icon is your unread count.

Push needs **your own Apple developer account**, because Apple only delivers pushes signed with a key from the same team that signed the app:

1. Under **Signing & Capabilities**, pick your team. The project already has the **Push Notifications** capability (`Warren/Warren.entitlements`); Xcode adds it to your App ID. If `ai.warren.ios` is taken, change the bundle ID in `project.yml` and run `xcodegen`.
2. Make an APNs key (`.p8`) in your developer account and give it to your hub; see [Push notifications in the deploy guide](../../docs/deploy.md#push-notifications-for-the-ios-app).
3. Run the app and sign in. It asks for permission the first time you send a message, never at launch, and only if the hub has a key. You can also turn it on under **You → Notifications**.

Debug builds from Xcode get development (sandbox) tokens and TestFlight or App Store builds get production ones. The app tells the hub which, so one key covers both.

### Try it in the Simulator

The Simulator can't receive real pushes from your hub without your key, but you can drop one in to check where a tap lands. Edit the IDs in a sample under `push-samples/`, then:

```bash
xcrun simctl push booted ai.warren.ios apps/ios/push-samples/thread.apns
```

The `warren` part of a payload says where it goes: `{"kind": "message", "channelId", "threadId"}`, `{"kind": "approval", "approvalId"}` or `{"kind": "computer", "computerId"}`.

## Change the project

The Xcode project is generated from `project.yml` with [XcodeGen](https://github.com/yonaskolb/XcodeGen). After adding or renaming files:

```bash
brew install xcodegen
cd apps/ios && xcodegen
```

The app icon comes from `swift apps/ios/scripts/icons.swift`, which also draws the desktop app's icons.
