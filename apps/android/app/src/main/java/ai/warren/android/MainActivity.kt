package ai.warren.android

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.View
import android.view.WindowInsets
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.TextView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import org.json.JSONObject

/**
 * Warren for Android: pair with Warren on your computer by scanning the QR code in Settings → Mobile,
 * then use Warren's own phone layout in a web view, signed in with the session the pairing gave you.
 */
class MainActivity : Activity() {
    private val prefs by lazy { getSharedPreferences("warren", MODE_PRIVATE) }
    private var web: WebView? = null
    /** bumped to abandon a pairing in progress */
    @Volatile private var pairing = 0
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var micRequest: PermissionRequest? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val link = PairLink.parse(intent?.dataString)
        if (hub != null && token != null) showWorkspace() else showPairing()
        link?.let(::offer)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        PairLink.parse(intent.dataString)?.let(::offer)
    }

    private var hub: String?
        get() = prefs.getString("hub", null)
        set(v) = prefs.edit().putString("hub", v).apply()
    private var token: String?
        get() = prefs.getString("token", null)
        set(v) = prefs.edit().putString("token", v).apply()

    /** A pairing link from the camera app: pair now, or ask first if this phone is already signed in. */
    private fun offer(link: PairLink) {
        if (web == null) return pair(link)
        AlertDialog.Builder(this)
            .setTitle("Pair with another Warren?")
            .setMessage("This phone is signed in to a Warren already.")
            .setPositiveButton("Sign out and pair") { _, _ -> signOut(); pair(link) }
            .setNegativeButton("Cancel", null)
            .show()
    }

    // ---------------------------------------------------------------- pairing

    private fun showPairing() {
        web?.destroy()
        web = null
        setContentView(R.layout.pair)
        findViewById<TextView>(R.id.pairHelp).text = getString(R.string.pair_help, getString(R.string.github_repo))
        fitSystemBars(findViewById(R.id.root))
        findViewById<Button>(R.id.scan).setOnClickListener { scan() }
        findViewById<Button>(R.id.paste).setOnClickListener { askForLink() }
        findViewById<Button>(R.id.cancel).setOnClickListener { pairing++; step(Step.Start) }
        step(Step.Start)
    }

    private enum class Step { Start, Connecting, Code }

    private fun step(s: Step, code: String? = null, note: String? = null, error: String? = null) {
        findViewById<View>(R.id.steps).visibility = if (s == Step.Start) View.VISIBLE else View.GONE
        findViewById<View>(R.id.scan).visibility = if (s == Step.Start) View.VISIBLE else View.GONE
        findViewById<View>(R.id.paste).visibility = if (s == Step.Start) View.VISIBLE else View.GONE
        findViewById<View>(R.id.connecting).visibility = if (s == Step.Connecting) View.VISIBLE else View.GONE
        findViewById<View>(R.id.codeBox).visibility = if (s == Step.Code) View.VISIBLE else View.GONE
        findViewById<TextView>(R.id.code).text = code ?: ""
        findViewById<TextView>(R.id.waiting).text = note ?: ""
        findViewById<TextView>(R.id.error).apply {
            text = error ?: ""
            visibility = if (error == null) View.GONE else View.VISIBLE
        }
    }

    private fun scan() {
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(this, options)
            .startScan()
            .addOnSuccessListener { use(it.rawValue) }
            .addOnFailureListener { step(Step.Start, error = "Couldn't open the scanner. Paste the pairing link instead.") }
    }

    private fun askForLink() {
        val input = EditText(this).apply {
            hint = "warren://pair?…"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            isSingleLine = true
        }
        val box = FrameLayout(this).apply {
            val pad = (20 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad / 2, pad, 0)
            addView(input)
        }
        AlertDialog.Builder(this)
            .setTitle("Paste pairing link")
            .setMessage("In Warren on your computer: Settings → Mobile → Start pairing → Copy pairing link.")
            .setView(box)
            .setPositiveButton("Connect") { _, _ -> use(input.text.toString()) }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun use(text: String?) {
        val link = PairLink.parse(text) ?: return step(Step.Start, error = "That isn't a Warren pairing code. Scan the code in Warren → Settings → Mobile.")
        pair(link)
    }

    private fun pair(link: PairLink) {
        if (web != null) showPairing()
        val mine = ++pairing
        step(Step.Connecting)
        Thread {
            try {
                val at = Pairing.reachable(link.addresses)
                    ?: throw PairingError("Couldn't reach your computer. Make sure this phone is on the same Wi-Fi as it, then try again.")
                val claimed = Pairing.claim(link, at, deviceName())
                runOnUiThread {
                    if (pairing == mine) step(Step.Code, claimed.code, "Waiting for you to confirm in ${claimed.workspaceName ?: "Warren"} on your computer…")
                }
                val t = Pairing.waitForConfirm(link, at) { pairing == mine } ?: return@Thread
                runOnUiThread {
                    if (pairing != mine) return@runOnUiThread
                    hub = at
                    token = t
                    showWorkspace()
                }
            } catch (e: Exception) {
                runOnUiThread { if (pairing == mine) step(Step.Start, error = e.message ?: "Pairing didn't work. Try again.") }
            }
        }.start()
    }

    private fun deviceName(): String =
        Settings.Global.getString(contentResolver, Settings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() } ?: Build.MODEL

    // ---------------------------------------------------------------- the workspace

    @SuppressLint("SetJavaScriptEnabled")
    private fun showWorkspace() {
        val origin = hub ?: return showPairing()
        val signIn = token ?: return showPairing()
        val view = WebView(this)
        web = view
        // a web view ignores its own padding, so the space for the system bars goes on a frame around it
        val frame = FrameLayout(this).apply {
            setBackgroundColor(getColor(R.color.bg))
            addView(view, FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
        }
        setContentView(frame)
        fitSystemBars(frame)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
        }
        // Warren keeps its sign-in in localStorage; put the paired one there before the page runs
        // and hear about it when Warren drops it (signed out here, or this phone's sign-in was ended on the computer)
        val setToken = "if (!localStorage.getItem('warren.token')) localStorage.setItem('warren.token', ${JSONObject.quote(signIn)});" +
            "(function(){var r=Storage.prototype.removeItem;Storage.prototype.removeItem=function(k){r.apply(this,arguments);" +
            "if(k==='warren.token'&&window.WarrenAndroid)WarrenAndroid.signedOut();};})();"
        view.addJavascriptInterface(object {
            @JavascriptInterface
            fun signedOut() = runOnUiThread { if (web === view) signOut() }
        }, "WarrenAndroid")
        val early = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        if (early) WebViewCompat.addDocumentStartJavaScript(view, setToken, setOf(origin))
        var tokenSet = early
        var errorShown = false
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.toString().startsWith("$origin/") || url.toString() == origin) return false
                startActivity(Intent(Intent.ACTION_VIEW, url))
                return true
            }

            // the saved address stopped answering (the computer is off, or its address changed): offer a way out
            // instead of leaving the browser's own error page with nothing to tap
            override fun onReceivedError(v: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame || web !== v || errorShown) return
                errorShown = true
                AlertDialog.Builder(this@MainActivity)
                    .setTitle("Can't reach Warren")
                    .setMessage("Is your computer on, and is this phone on the same Wi-Fi as it (or on your private network)? You can also pair with it again.")
                    .setPositiveButton("Try again") { _, _ -> errorShown = false; v.loadUrl("$origin/") }
                    .setNegativeButton("Pair again") { _, _ -> errorShown = false; signOut() }
                    .setOnCancelListener { errorShown = false }
                    .show()
            }

            override fun onPageFinished(v: WebView, url: String) {
                if (tokenSet) return
                tokenSet = true
                v.evaluateJavascript(setToken) { v.reload() }
            }
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(v: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    startActivityForResult(params.createIntent(), PICK_FILES)
                    true
                } catch (e: Exception) {
                    fileCallback = null
                    false
                }
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE !in request.resources) return request.deny()
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) return request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                micRequest = request
                requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), ASK_MIC)
            }
        }
        view.loadUrl("$origin/")
    }

    private fun signOut() {
        pairing++
        prefs.edit().clear().apply()
        WebStorage.getInstance().deleteAllData()
        CookieManager.getInstance().removeAllCookies(null)
        showPairing()
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == PICK_FILES) {
            fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            fileCallback = null
        } else super.onActivityResult(requestCode, resultCode, data)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, results: IntArray) {
        if (requestCode != ASK_MIC) return
        val r = micRequest ?: return
        micRequest = null
        if (results.firstOrNull() == PackageManager.PERMISSION_GRANTED) r.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else r.deny()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        val v = web
        if (v != null && v.canGoBack()) v.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
    }

    /** Android 15 draws apps under the status and navigation bars; keep Warren clear of them and the keyboard. */
    private fun fitSystemBars(view: View) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        view.setOnApplyWindowInsetsListener { v, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime() or WindowInsets.Type.displayCutout())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsets.CONSUMED
        }
    }

    private companion object {
        const val PICK_FILES = 1
        const val ASK_MIC = 2
    }
}
