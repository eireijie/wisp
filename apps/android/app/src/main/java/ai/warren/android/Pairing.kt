package ai.warren.android

import android.net.Uri
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * What a pairing QR code from Warren → Settings → Mobile carries:
 * `warren://pair?v=1&id=…&s=…&u=http://192.168.1.20:4747&u=…` (the pairing, its one-time secret,
 * and the addresses this phone might reach the computer at, best first).
 */
data class PairLink(val id: String, val secret: String, val addresses: List<String>) {
    companion object {
        fun parse(text: String?): PairLink? {
            val uri = text?.trim()?.let(Uri::parse) ?: return null
            if (uri.scheme != "warren" || uri.host != "pair") return null
            val id = uri.getQueryParameter("id") ?: return null
            val secret = uri.getQueryParameter("s") ?: return null
            val addresses = uri.getQueryParameters("u").mapNotNull(::normalize)
            return if (addresses.isEmpty()) null else PairLink(id, secret, addresses)
        }

        /** "http://192.168.1.20:4747/" → "http://192.168.1.20:4747"; anything else that isn't http(s) → null */
        fun normalize(address: String): String? {
            val u = Uri.parse(address.trim())
            if (u.scheme != "http" && u.scheme != "https" || u.host.isNullOrEmpty()) return null
            return "${u.scheme}://${u.encodedAuthority}"
        }
    }
}

class PairingError(message: String) : IOException(message)

/** The phone's half of pairing: find the computer, claim the pairing, wait for the person to confirm. All calls block. */
object Pairing {
    data class Claimed(val code: String, val workspaceName: String?)

    /** The first of the QR code's addresses (in its order) that answers as a Warren hub, or null. */
    fun reachable(addresses: List<String>): String? {
        val pool = Executors.newFixedThreadPool(addresses.size.coerceAtLeast(1))
        try {
            val checks = addresses.map { a -> pool.submit(Callable { runCatching { request("GET", "$a/api/setup", null, 5_000).first == 200 }.getOrDefault(false) }) }
            return addresses.indices.firstOrNull { i -> runCatching { checks[i].get(6, TimeUnit.SECONDS) }.getOrDefault(false) }?.let { addresses[it] }
        } finally {
            pool.shutdownNow()
        }
    }

    fun claim(link: PairLink, hub: String, deviceName: String): Claimed {
        val body = JSONObject().put("secret", link.secret).put("deviceName", deviceName).put("platform", "android")
        val json = call("POST", "$hub/api/pair/${link.id}/claim", body)
        return Claimed(json.getString("code"), json.optString("workspaceName").ifEmpty { null })
    }

    /** Asks every second and a half until the person confirms on the computer (returns the sign-in), cancels, or time runs out. */
    fun waitForConfirm(link: PairLink, hub: String, stillWanted: () -> Boolean): String? {
        val body = JSONObject().put("secret", link.secret)
        while (stillWanted()) {
            val json = call("POST", "$hub/api/pair/${link.id}/status", body)
            when (json.getString("state")) {
                "approved" -> json.optString("token").takeIf { it.isNotEmpty() }?.let { return it }
                "rejected" -> throw PairingError("Pairing was cancelled on your computer.")
                "expired" -> throw PairingError("The code expired. Show a new one on your computer and scan again.")
            }
            Thread.sleep(1500)
        }
        return null
    }

    private fun call(method: String, url: String, body: JSONObject?): JSONObject {
        val (status, text) = try {
            request(method, url, body, 15_000)
        } catch (e: IOException) {
            throw PairingError("Couldn't reach your computer. ${e.message ?: ""}".trim())
        }
        val json = runCatching { JSONObject(text) }.getOrNull()
        if (status !in 200..299) throw PairingError(json?.optString("error")?.ifEmpty { null } ?: "Warren said $status")
        return json ?: throw PairingError("Warren sent something this app doesn't understand. Is Warren up to date?")
    }

    private fun request(method: String, url: String, body: JSONObject?, timeoutMs: Int): Pair<Int, String> {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method
            c.connectTimeout = timeoutMs
            c.readTimeout = timeoutMs
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
