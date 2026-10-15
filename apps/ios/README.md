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

## Change the project

The Xcode project is generated from `project.yml` with [XcodeGen](https://github.com/yonaskolb/XcodeGen). After adding or renaming files:

```bash
brew install xcodegen
cd apps/ios && xcodegen
```

The app icon comes from `swift apps/ios/scripts/icons.swift`, which also draws the desktop app's icons.
