# Wisp for Android

Wisp on Android phones and tablets. It pairs with Wisp on your computer by scanning a QR code, then shows Wisp's own phone layout (chats, agents, requests that need your OK, watching or taking over computers) in a web view, signed in with the sign-in the pairing gave it.

## Pair it

1. In Wisp on your computer, open **Settings → Mobile** and click **Start pairing**.
2. In the app, tap **Scan QR code** (Google's scanner from Play services reads it; Wisp itself never gets camera access). Scanning with the camera app also works: the code is a `wisp://pair` link, which opens Wisp.
3. Check that both screens show the same six digits and click **Yes, pair it** on the computer.

The phone must be able to reach the computer: the same Wi-Fi, Tailscale, or a public address (see [Deploying](../../docs/deploy.md)). Plain `http://` is allowed, since most Wisp hubs live on a home network. Without a camera (like in the emulator), click **Copy pairing link** on the computer and choose **Paste a pairing link instead**, or send it with `adb shell am start -a android.intent.action.VIEW -d '"wisp://pair?..."'`.

Signing out in Wisp, or signing the phone out from the computer (**Settings → Security → Sign-ins**), brings the app back to the pairing screen.

## Notifications

The app can tell you about agent replies, @mentions, approvals and agents that need you on their computer while it's closed, through Firebase Cloud Messaging. It's optional and **the person running the hub sets it up**: make a Firebase project and give the hub its service-account key (see [Push notifications for the Android app](../../docs/deploy.md#push-notifications-for-the-android-app)). Nothing about Firebase is baked into this app (no `google-services.json`, no Gradle plugin): after you sign in, the hub hands the app its project's client settings, the app starts Firebase with them, and uploads its push token to the hub. A hub without Firebase set up gets no prompts and no pushes.

On Android 13 and newer the app asks to allow notifications once, after Wisp has loaded and only if the hub can send them. **Settings → Notifications** (inside the app) shows the status and has a test button. Tapping a notification opens that chat, approval or computer. A notification isn't shown while the app is open on screen. Notifications are split into Messages, Approvals and Needs-you-on-a-computer channels you can tune in Android's settings.

## Build it

Needs JDK 17 or newer and the Android SDK (platform 35). With Homebrew:

```bash
brew install openjdk@21 && brew install --cask android-commandlinetools
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ANDROID_HOME=~/Library/Android/sdk
sdkmanager --sdk_root=$ANDROID_HOME --licenses
sdkmanager --sdk_root=$ANDROID_HOME "platform-tools" "platforms;android-35" "build-tools;35.0.0"
cd apps/android && ./gradlew assembleDebug    # app/build/outputs/apk/debug/app-debug.apk
```

Install it on a phone with USB debugging on: `adb install -r app/build/outputs/apk/debug/app-debug.apk`, or send the APK to the phone and open it (Android asks to allow installing from that app).

Release builds (`./gradlew assembleRelease`) are signed with the debug key for now, so testers can sideload them; tagged releases attach `Wisp-android.apk` (see [apps/desktop](../desktop/README.md#release-it)). Each CI build has its own debug key, so testers may need to uninstall before installing a newer one. Google Play needs a real upload key, Play App Signing, a target SDK Play currently accepts, and (for new personal developer accounts) a 14-day closed test with 12 testers.

## Not yet

- Per-kind notification switches inside Wisp (use Android's own notification channels for now), and the unread count as an app badge.
- Watching an agent's computer uses the web app's viewer, which works but isn't tuned for touch like the iPhone app's.
