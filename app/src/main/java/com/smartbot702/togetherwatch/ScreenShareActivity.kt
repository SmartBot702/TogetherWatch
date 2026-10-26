package com.smartbot702.togetherwatch

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

class ScreenShareActivity : Activity() {
    private lateinit var server: EditText
    private lateinit var room: EditText
    private lateinit var name: EditText
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(18), dp(18), dp(12))
            setBackgroundColor(android.graphics.Color.rgb(18, 18, 30))
        }
        fun field(hintText: String, value: String = "") = EditText(this).apply {
            hint = hintText
            setSingleLine(true)
            setText(value)
            setTextColor(android.graphics.Color.WHITE)
            setHintTextColor(android.graphics.Color.LTGRAY)
            textSize = 16f
        }
        val title = TextView(this).apply {
            text = "Telefon ekranini ulashish"
            textSize = 22f
            setTextColor(android.graphics.Color.WHITE)
        }
        server = field("TogetherWatch server URL", intent.getStringExtra("serverUrl") ?: "https://togetherwatch.onrender.com")
        room = field("6 belgili xona kodi")
        name = field("Ismingiz", "Android ekran")
        status = TextView(this).apply {
            text = "Xonaga ulang, so‘ng Android ekran ulashish ruxsatini tasdiqlang."
            setTextColor(android.graphics.Color.LTGRAY)
            textSize = 14f
        }
        val start = Button(this).apply {
            text = "Xonaga ulanish va ekran ulashish"
            setOnClickListener { requestScreenCapture() }
        }
        val stop = Button(this).apply {
            text = "Ulashishni to‘xtatish"
            setOnClickListener {
                startService(Intent(this@ScreenShareActivity, NativeScreenShareService::class.java).setAction(NativeScreenShareService.ACTION_STOP))
                status.text = "Ulashishni to‘xtatish buyrug‘i yuborildi."
            }
        }
        root.addView(title)
        root.addView(server, params())
        root.addView(room, params())
        root.addView(name, params())
        root.addView(start, params())
        root.addView(stop, params())
        root.addView(status, params())
        setContentView(root)
    }

    private fun requestScreenCapture() {
        val base = server.text.toString().trim().trimEnd('/')
        val roomCode = room.text.toString().trim().uppercase()
        val displayName = name.text.toString().trim()
        if (!base.startsWith("https://")) {
            server.error = "HTTPS manzilini kiriting"
            return
        }
        if (!roomCode.matches(Regex("[A-Z0-9]{6}"))) {
            room.error = "Xona kodi 6 ta harf yoki raqamdan iborat"
            return
        }
        if (displayName.isBlank()) {
            name.error = "Ismingizni kiriting"
            return
        }
        val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        status.text = "Android ekran ulashish ruxsati kutilmoqda…"
        @Suppress("DEPRECATION")
        startActivityForResult(manager.createScreenCaptureIntent(), REQUEST_CAPTURE)
    }

    @Deprecated("Android MediaProjection permission callback")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_CAPTURE) return
        if (resultCode != RESULT_OK || data == null) {
            status.text = "Ekran ulashish uchun ruxsat berilmadi."
            return
        }
        val intent = Intent(this, NativeScreenShareService::class.java).apply {
            action = NativeScreenShareService.ACTION_START
            putExtra(NativeScreenShareService.EXTRA_RESULT_CODE, resultCode)
            putExtra(NativeScreenShareService.EXTRA_RESULT_DATA, data)
            putExtra(NativeScreenShareService.EXTRA_SERVER_URL, server.text.toString().trim().trimEnd('/'))
            putExtra(NativeScreenShareService.EXTRA_ROOM_ID, room.text.toString().trim().uppercase())
            putExtra(NativeScreenShareService.EXTRA_NAME, name.text.toString().trim())
        }
        startForegroundService(intent)
        status.text = "Xizmat ishga tushirildi. Boshqa qurilmadagi xonada ekran paydo bo‘lishini tekshiring."
    }

    private fun params() = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(54)).apply {
        bottomMargin = dp(8)
    }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    companion object { private const val REQUEST_CAPTURE = 7204 }
}
