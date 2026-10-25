package ai.wisp.android

import android.app.Application

/** Starts Firebase (when the hub has given us its settings) before anything else, including when a push wakes the app. */
class WispApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Push.init(this)
    }
}
