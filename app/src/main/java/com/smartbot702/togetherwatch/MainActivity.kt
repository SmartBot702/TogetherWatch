package com.smartbot702.togetherwatch

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var address: EditText

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = android.graphics.Color.rgb(18, 18, 30)
        window.navigationBarColor = android.graphics.Color.rgb(18, 18, 30)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(8), dp(12), dp(4))
            setBackgroundColor(android.graphics.Color.rgb(18, 18, 30))
        }
        val title = TextView(this).apply {
            text = "TogetherWatch"
            textSize = 22f
            setTextColor(android.graphics.Color.WHITE)
            setPadding(dp(4), dp(8), dp(4), dp(8))
        }
        address = EditText(this).apply {
            setSingleLine(true)
            textSize = 14f
            hint = "Sayt manzili (https://...)"
            setText(DEFAULT_URL)
            setTextColor(android.graphics.Color.WHITE)
            setHintTextColor(android.graphics.Color.LTGRAY)
            setSelectAllOnFocus(true)
        }
        val open = Button(this).apply {
            text = "Saytni ochish"
            setOnClickListener { loadAddress() }
        }
        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.javaScriptCanOpenWindowsAutomatically = false
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
                    runOnUiThread {
                        val allowed = request.resources.filter {
                            it == android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE ||
                            it == android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE
                        }
                        if (allowed.isNotEmpty()) request.grant(allowed.toTypedArray()) else request.deny()
                    }
                }
            }
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val scheme = request.url.scheme
                    return scheme != "https" && scheme != "http"
                }
            }
            setBackgroundColor(android.graphics.Color.WHITE)
        }
        root.addView(title)
        root.addView(address, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(52)
        ))
        root.addView(open, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(48)
        ))
        root.addView(webView, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f
        ))
        setContentView(root)
        CookieManager.getInstance().setAcceptCookie(true)
        if (savedInstanceState == null) webView.loadUrl(DEFAULT_URL)
    }

    private fun loadAddress() {
        var url = address.text.toString().trim()
        if (url.isBlank()) return
        if (!url.startsWith("https://") && !url.startsWith("http://")) url = "https://$url"
        if (!url.startsWith("https://")) {
            address.error = "Xavfsizlik uchun HTTPS manzilidan foydalaning"
            return
        }
        address.setText(url)
        webView.loadUrl(url)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) webView.goBack()
        else super.onBackPressed()
    }

    companion object {
        // Edit this default if your Render service has a different generated hostname.
        private const val DEFAULT_URL = "https://togetherwatch.onrender.com"
    }
}
