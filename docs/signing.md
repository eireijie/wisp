# Signing the Apple apps

Everything is set up. These steps add the credentials. Until they're done, Mac builds are signed ad hoc and the iPhone app runs only from Xcode.

## You need once

1. Join the [Apple Developer Program](https://developer.apple.com/programs/enroll/) ($99 a year). The name you enroll under is shown publicly as the developer.
2. Note your **Team ID** from [Membership details](https://developer.apple.com/account).

## Mac app

1. In Xcode, **Settings → Accounts → Manage Certificates → + → Developer ID Application**.
2. In Keychain Access, export that certificate with its private key as a `.p12` and choose a password.
3. Create an [app-specific password](https://account.apple.com) for notarizing.
4. Add these as repository secrets (**Settings → Secrets and variables → Actions**):

| Secret | Value |
| --- | --- |
| `MAC_CERT_P12_BASE64` | the output of `base64 -i Wisp.p12` |
| `MAC_CERT_PASSWORD` | the `.p12` password |
| `APPLE_ID` | your Apple account's email |
| `APPLE_APP_SPECIFIC_PASSWORD` | the password from step 3 |
| `APPLE_TEAM_ID` | your Team ID |

5. Push a tag like `desktop-v0.1.0`. The release fails if the build doesn't pass Gatekeeper.
6. Remove the "isn't signed" note for Macs from `README.md` and `site/src/pages/download.astro`.

## iPhone app

1. Under [Identifiers](https://developer.apple.com/account/resources/identifiers/list), register `ai.wisp.ios` with **Push Notifications** on.
2. In [App Store Connect](https://appstoreconnect.apple.com), create the app with that bundle ID.
3. Under **Users and Access → Integrations**, create a team key with the **App Manager** role. Save the `.p8`, the Key ID and the Issuer ID.
4. Upload a build:

```bash
APPLE_TEAM_ID=… ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_PATH=~/AuthKey_….p8 apps/ios/scripts/testflight.sh
```

Before App Store review, you also need a privacy policy link and a hub the reviewer can sign in to.

Push notifications also need an APNs key on the hub: see [the deploy guide](deploy.md#push-notifications-for-the-ios-app).
