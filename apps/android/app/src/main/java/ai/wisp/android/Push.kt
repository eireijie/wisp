package ai.wisp.android

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Push notifications for agent replies, @mentions, approvals and "needs you on its computer",
 * through Firebase Cloud Messaging (the iPhone app's APNs, for Android).
 *
 * There is no google-services.json in this open-source build: whoever runs the hub makes their own
 * Firebase project and gives the hub its key (docs/deploy.md). The hub then hands this app the
 * project's client settings over `GET /api/me/push`, the app starts Firebase with them at runtime,
 * and uploads its FCM token to the hub. A hub without Firebase set up answers "not available" and
 * the app does nothing, quietly.
 */
object Push {
    /** true while the app is on screen, so a push about what you're looking at doesn't also buzz */
    @Volatile var foreground = false

    private const val FIREBASE = "firebase"
    private const val TOKEN = "fcmToken"

    private fun prefs(c: Context) = c.applicationContext.getSharedPreferences("wisp", Context.MODE_PRIVATE)

    fun hasPermission(c: Context) =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** Starts Firebase from the settings the hub gave us last time (also when a push wakes the app). Safe to call often. */
    fun init(c: Context): Boolean {
        val ctx = c.applicationContext
        if (FirebaseApp.getApps(ctx).isNotEmpty()) return true
        val saved = prefs(ctx).getString(FIREBASE, null) ?: return false
        return try {
            val j = JSONObject(saved)
            val options = FirebaseOptions.Builder()
                .setProjectId(j.getString("projectId"))
                .setApplicationId(j.getString("applicationId"))
                .setApiKey(j.getString("apiKey"))
                .setGcmSenderId(j.getString("senderId"))
                .build()
            FirebaseApp.initializeApp(ctx, options)
            true
        } catch (e: Exception) {
            false
        }
    }

    /** What this phone knows about push, for the web app's Settings → Notifications. */
    fun state(c: Context): JSONObject = JSONObject()
        .put("available", prefs(c).getString(FIREBASE, null) != null)
        .put("permission", hasPermission(c))
        .put("registered", prefs(c).getString(TOKEN, null) != null)

    /**
     * Learns from the hub whether it can send to Android. If so, remembers the Firebase settings and
     * (when notifications are allowed) uploads this phone's token. Returns whether the hub can push.
     * Blocks; call it off the main thread.
     */
    fun sync(c: Context, hub: String, signIn: String): Boolean {
        val ctx = c.applicationContext
        val android = try {
            val (status, body) = call("GET", "$hub/api/me/push", signIn, null)
            if (status != 200) return false
            JSONObject(body).optJSONObject("android")
        } catch (e: Exception) {
            return false
        }
        val firebase = android?.optJSONObject("firebase")
        if (android == null || !android.optBoolean("available") || firebase == null) {
            prefs(ctx).edit().remove(FIREBASE).apply()
            return false
        }
        // Firebase can only be started once per run; new settings take effect the next time the app starts
        prefs(ctx).edit().putString(FIREBASE, firebase.toString()).apply()
        if (hasPermission(ctx)) register(ctx, hub, signIn)
        return true
    }

    /** Fetches this install's FCM token and gives it to the hub. */
    fun register(c: Context, hub: String, signIn: String) {
        val ctx = c.applicationContext
        if (!init(ctx)) return
        try {
            FirebaseMessaging.getInstance().token.addOnSuccessListener { token -> Thread { upload(ctx, hub, signIn, token) }.start() }
        } catch (e: Exception) {
        }
    }

    /** A fresh token from Firebase (the service's onNewToken): upload it if this phone is signed in. */
    fun refreshed(c: Context, token: String) {
        val p = prefs(c)
        val hub = p.getString("hub", null)
        val signIn = p.getString("token", null)
        if (hub != null && signIn != null && p.getString(FIREBASE, null) != null) upload(c, hub, signIn, token)
    }

    private fun upload(c: Context, hub: String, signIn: String, token: String) {
        val body = JSONObject().put("platform", "android").put("token", token).put("bundleId", c.packageName)
        // one retry: the hub may be waking up
        for (attempt in 0..1) {
            try {
                if (call("POST", "$hub/api/me/push", signIn, body).first in 200..299) {
                    prefs(c).edit().putString(TOKEN, token).apply()
                    return
                }
            } catch (e: Exception) {
            }
            if (attempt == 0) Thread.sleep(2_000)
        }
    }

    /** Signing out: stop pushes for this sign-in and forget the token. Best effort; the hub also forgets phones when their sign-in ends. */
    fun forget(c: Context, hub: String?, signIn: String?) {
        val ctx = c.applicationContext
        val hadToken = prefs(ctx).getString(TOKEN, null) != null
        Thread {
            if (hub != null && signIn != null) try {
                call("DELETE", "$hub/api/me/push", signIn, null)
            } catch (e: Exception) {
            }
            if (hadToken && FirebaseApp.getApps(ctx).isNotEmpty()) try {
                FirebaseMessaging.getInstance().deleteToken()
            } catch (e: Exception) {
            }
        }.start()
    }

    private fun call(method: String, url: String, signIn: String, body: JSONObject?): Pair<Int, String> {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method
            c.connectTimeout = 10_000
            c.readTimeout = 15_000
            c.setRequestProperty("Authorization", "Bearer $signIn")
            if (body != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            val status = c.responseCode
            val stream = if (status >= 400) c.errorStream else c.inputStream
            return status to (stream?.bufferedReader()?.use { it.readText() } ?: "")
        } finally {
            c.disconnect()
        }
    }
}
