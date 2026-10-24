# Warren for iPhone and iPad

A native SwiftUI app for your Warren hub:

- **Chats**: laid out like Warren's sidebar (agents, starred, your sections), with your agents' DMs and channels with unread counts, live replies, threads, and what each agent is doing while it works ("Reading the vault…").
- **Agents**: every agent as its animated ghost, in the same look as on the computer, with its mood. Add agents, open an agent's page to rename it, change its look, personality, instructions, model or device, or remove it.
- **Computers**: watch any agent's computer live, **Take control** to tap and type on it, and **Hand back**.
- **Inbox**: approve or decline what agents ask your OK for, and see which agents need you on their computer.

It connects by **pairing with Warren on your computer**: open **Settings → Mobile → Start pairing** there, scan the QR code with the app (or with the Camera app, which opens Warren), check that both screens show the same six digits, and confirm on the computer. The phone gets a sign-in of its own, kept in the Keychain, which shows under **Settings → Security → Sign-ins** and can be signed out there. There's no address or password to type. Create, edit, archive and delete channels and sections from the **+** menu and a channel's details. Devices, memory, tasks, routines and skills still happen in Warren on a computer or in Safari.

The QR code is a `warren://pair` link with the pairing's one-time secret and the addresses the phone might reach the hub at (the address the page was opened at, then the computer's Wi-Fi and Tailscale addresses); the app tries them in order. On a device without a camera (like the Simulator), click **Copy pairing link** on the computer and choose **Paste a pairing link instead**. In the Simulator you can also open it directly: `xcrun simctl openurl booted 'warren://pair?...'`.

## Run it

Open `Warren.xcodeproj` in Xcode 26 or newer, pick a simulator or your iPhone, and Run. Running on your iPhone needs your Apple developer team under **Signing & Capabilities**. The app needs iOS 18.

Unsigned simulator builds (`CODE_SIGNING_ALLOWED=NO`) can't pair, because they can't use the Keychain (error -34018); use Xcode's normal signing.

Your phone must be able to reach the hub: the same network, Tailscale, or a public address (see [Deploying](../../docs/deploy.md)). Plain `http://` addresses work too, since many self-hosted hubs live on a home network.

## Push notifications

The app can notify you about agent replies, @mentions, approval requests and agents that need you on their computer while it's closed. Tapping one opens that chat or thread, the Inbox, or the computer. The badge on the app icon is your unread count.

Push needs **your own Apple developer account**, because Apple only delivers pushes signed with a key from the same team that signed the app:

1. Under **Signing & Capabilities**, pick your team. The project already has the **Push Notifications** capability (`Warren/Warren.entitlements`); Xcode adds it to your App ID. If `ai.warren.ios` is taken, change the bundle ID in `project.yml` and run `xcodegen`.
2. Make an APNs key (`.p8`) in your developer account and give it to your hub; see [Push notifications in the deploy guide](../../docs/deploy.md#push-notifications-for-the-ios-app).
3. Run the app and pair it. It asks for permission the first time you send a message, never at launch, and only if the hub has a key. You can also turn it on under **You → Notifications**.

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
