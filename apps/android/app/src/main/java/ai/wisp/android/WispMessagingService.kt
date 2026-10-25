package ai.wisp.android

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Shows the pushes the hub sends (apps/hub/src/fcm.ts). They arrive as data messages, so this runs
 * whether the app is open or not: `kind` (message, approval, computer, test) picks the channel,
 * and the ids say where a tap goes.
 */
class WispMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) = Push.refreshed(this, token)

    override fun onMessageReceived(message: RemoteMessage) {
        val d = message.data
        val kind = d["kind"] ?: "message"
        val title = d["title"]?.takeIf { it.isNotBlank() } ?: return
        // the person is looking at Wisp: they'll see it there (a test is the exception)
        if (Push.foreground && kind != "test") return
        if (!Push.hasPermission(this)) return
        val manager = getSystemService(NotificationManager::class.java)
        val channel = ensureChannel(manager, kind)
        val route = route(d)
        val open = PendingIntent.getActivity(
            this,
            route.hashCode(),
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP).putExtra(MainActivity.ROUTE, route),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, channel)
            .setSmallIcon(R.drawable.ic_stat_wisp)
            .setContentTitle(title)
            .setContentText(d["body"])
            .setStyle(NotificationCompat.BigTextStyle().bigText(d["body"]))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setCategory(if (kind == "approval") NotificationCompat.CATEGORY_REMINDER else NotificationCompat.CATEGORY_MESSAGE)
            .setNumber(d["badge"]?.toIntOrNull() ?: 0)
            .build()
        // one notification per chat, approval or computer: a newer one replaces the older
        manager.notify(route.hashCode(), notification)
    }

    private fun ensureChannel(manager: NotificationManager, kind: String): String {
        val (id, name) = when (kind) {
            "approval" -> "approvals" to "Approvals"
            "computer" -> "computers" to "Needs you on a computer"
            else -> "messages" to "Messages"
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(id) == null) {
            val importance = if (kind == "approval" || kind == "computer") NotificationManager.IMPORTANCE_HIGH else NotificationManager.IMPORTANCE_DEFAULT
            manager.createNotificationChannel(NotificationChannel(id, name, importance))
        }
        return id
    }

    private companion object {
        /** Where a tap goes, as the web app's hash route (apps/web/src/router.ts); "" opens the app as it was. */
        fun route(d: Map<String, String>): String {
            val channel = d["channelId"]?.takeIf { it.isNotEmpty() }
            val thread = d["threadId"]?.takeIf { it.isNotEmpty() }
            return when (d["kind"]) {
                "message", "task" -> if (channel != null) "#/c/$channel" + (thread?.let { "/t/$it" } ?: "") else ""
                "approval" -> if (channel != null) "#/c/$channel" + (thread?.let { "/t/$it" } ?: "") else "#/dashboard"
                "computer" -> d["computerId"]?.let { "#/computers/$it" } ?: ""
                else -> ""
            }
        }
    }
}
