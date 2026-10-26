package com.smartbot702.togetherwatch

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.Manifest
import android.content.pm.PackageManager
import android.content.Intent
import android.media.projection.MediaProjection
import android.os.Build
import android.os.IBinder
import android.content.pm.ServiceInfo
import io.socket.client.IO
import io.socket.client.Socket
import org.json.JSONObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import java.net.URI
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

class NativeScreenShareService : Service() {
    private var socket: Socket? = null
    private var capturer: ScreenCapturerAndroid? = null
    private var egl: EglBase? = null
    private var factory: PeerConnectionFactory? = null
    private var source: VideoSource? = null
    private var track: VideoTrack? = null
    private var audioSource: AudioSource? = null
    private var audioTrack: AudioTrack? = null
    private var textureHelper: SurfaceTextureHelper? = null
    private val peers = ConcurrentHashMap<String, PeerConnection>()
    private val pendingIce = ConcurrentHashMap<String, MutableList<IceCandidate>>()
    private var roomId: String = ""
    private var started = false
    @Volatile private var iceServers: List<PeerConnection.IceServer> = defaultIceServers()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSharing()
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent?.action != ACTION_START || started) return START_NOT_STICKY
        val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
        @Suppress("DEPRECATION")
        val data = intent.getParcelableExtra<Intent>(EXTRA_RESULT_DATA)
        val base = intent.getStringExtra(EXTRA_SERVER_URL).orEmpty().trimEnd('/')
        roomId = intent.getStringExtra(EXTRA_ROOM_ID).orEmpty()
        val displayName = intent.getStringExtra(EXTRA_NAME).orEmpty().take(20)
        if (data == null || base.isBlank() || roomId.isBlank()) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification("TogetherWatch ekran uzatmoqda"), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIFICATION_ID, notification("TogetherWatch ekran uzatmoqda"))
        }
        started = true
        try {
            initializeWebRtc()
            startCapture(data)
            connectRoom(base, displayName)
        } catch (e: Exception) {
            android.util.Log.e(TAG, "Screen share setup failed", e)
            report("Ekran uzatishni ishga tushirib bo‘lmadi: " + (e.message ?: "xatolik"))
            stopSharing()
            stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun initializeWebRtc() {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(this).createInitializationOptions()
        )
        egl = EglBase.create()
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl!!.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl!!.eglBaseContext))
            .createPeerConnectionFactory()
        source = factory!!.createVideoSource(true)
        textureHelper = SurfaceTextureHelper.create("TW-ScreenCapture", egl!!.eglBaseContext)
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            audioSource = factory!!.createAudioSource(MediaConstraints())
            audioTrack = factory!!.createAudioTrack("togetherwatch-screen-audio", audioSource)
            audioTrack?.setEnabled(true)
        }
    }

    private fun startCapture(permissionData: Intent) {
        val videoSource = source ?: error("Video source not ready")
        capturer = ScreenCapturerAndroid(permissionData, object : MediaProjection.Callback() {
            override fun onStop() {
                stopSharing()
                stopSelf()
            }
        })
        capturer!!.initialize(textureHelper, this, videoSource.capturerObserver)
        val metrics = resources.displayMetrics
        val width = (metrics.widthPixels.coerceAtMost(1280) / 2 * 2).coerceAtLeast(320)
        val height = (metrics.heightPixels.coerceAtMost(720) / 2 * 2).coerceAtLeast(240)
        capturer!!.startCapture(width, height, 15)
        track = factory!!.createVideoTrack("togetherwatch-screen", videoSource)
        track?.setEnabled(true)
    }

    private fun connectRoom(base: String, displayName: String) {
        Thread {
            loadIceServers(base)
            connectRoomSocket(base, displayName)
        }.apply { name = "TW-SignalingSetup"; isDaemon = true; start() }
    }

    private fun loadIceServers(base: String) {
        val discovered = mutableListOf<PeerConnection.IceServer>()
        try {
            val connection = (URL(base.trimEnd('/') + "/api/rtc-config").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 3000
                readTimeout = 3000
            }
            try {
                if (connection.responseCode in 200..299) {
                    val root = JSONObject(connection.inputStream.bufferedReader().use { reader -> reader.readText() })
                    val entries = root.optJSONArray("iceServers")
                    if (entries != null) for (i in 0 until entries.length()) {
                        val entry = entries.optJSONObject(i) ?: continue
                        val urls = entry.opt("urls")
                        val urlList = when (urls) {
                            is String -> listOf(urls)
                            is org.json.JSONArray -> (0 until urls.length()).mapNotNull { index -> urls.optString(index).takeIf { value -> value.isNotBlank() } }
                            else -> emptyList()
                        }
                        for (iceUrl in urlList) {
                            val builder = PeerConnection.IceServer.builder(iceUrl)
                            val username = entry.optString("username")
                            val credential = entry.optString("credential")
                            if (username.isNotBlank()) builder.setUsername(username)
                            if (credential.isNotBlank()) builder.setPassword(credential)
                            discovered.add(builder.createIceServer())
                        }
                    }
                }
            } finally {
                connection.disconnect()
            }
        } catch (e: Exception) {
            android.util.Log.w(TAG, "Could not load server ICE configuration; using STUN fallback", e)
        }
        iceServers = if (discovered.isNotEmpty()) discovered else defaultIceServers()
    }

    private fun defaultIceServers(): List<PeerConnection.IceServer> = listOf(
        PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
        PeerConnection.IceServer.builder("stun:stun.cloudflare.com:3478").createIceServer()
    )

    private fun connectRoomSocket(base: String, displayName: String) {
        val opts = IO.Options().apply {
            reconnection = true
            timeout = 15000
        }
        socket = IO.socket(URI.create(base), opts)
        socket?.on(Socket.EVENT_CONNECT) {
            socket?.emit("room:join", JSONObject().put("roomId", roomId).put("name", (displayName + " screen").take(28)))
        }
        socket?.on("room:joined") { args ->
            val payload = args.firstOrNull() as? JSONObject ?: return@on
            if (payload.optString("roomId") != roomId) {
                report("Server boshqa xona qaytardi.")
                return@on
            }
            socket?.emit("screen:started")
            report("Xonaga ulandi: $roomId. Ekran uzatilmoqda.")
        }
        socket?.on("room:error") { args -> report(args.firstOrNull()?.toString() ?: "Xonaga ulanishda xatolik") }
        socket?.on("room:people") { args ->
            val list = args.firstOrNull() as? org.json.JSONArray ?: return@on
            for (i in 0 until list.length()) {
                val member = list.optJSONObject(i) ?: continue
                val id = member.optString("id")
                if (id.isNotBlank() && id != socket?.id() && !peers.containsKey(id)) createOffer(id)
            }
        }
        socket?.on("rtc:answer") { args ->
            val p = args.firstOrNull() as? JSONObject ?: return@on
            if (p.optString("kind") != "screen") return@on
            val pc = peers[p.optString("from")] ?: return@on
            val sdp = p.optJSONObject("answer") ?: return@on
            pc.setRemoteDescription(SimpleSdpObserver(), SessionDescription(
                SessionDescription.Type.fromCanonicalForm(sdp.optString("type")),
                sdp.optString("sdp")
            ))
            flushIce(p.optString("from"), pc)
        }
        socket?.on("rtc:ice") { args ->
            val p = args.firstOrNull() as? JSONObject ?: return@on
            if (p.optString("kind") != "screen") return@on
            val id = p.optString("from")
            val candidate = p.optJSONObject("candidate") ?: return@on
            val ice = IceCandidate(candidate.optString("sdpMid"), candidate.optInt("sdpMLineIndex"), candidate.optString("candidate"))
            val pc = peers[id]
            if (pc == null || pc.remoteDescription == null) pendingIce.computeIfAbsent(id) { mutableListOf() }.add(ice)
            else pc.addIceCandidate(ice)
        }
        socket?.on("screen:error") { args -> report(args.firstOrNull()?.toString() ?: "Ekran ulashish xatosi") }
        socket?.connect()
    }

    private fun createOffer(peerId: String) {
        val pc = makePeer(peerId) ?: return
        val video = track ?: return
        pc.addTrack(video, listOf("togetherwatch-screen"))
        audioTrack?.let { pc.addTrack(it, listOf("togetherwatch-screen")) }
        pc.createOffer(object : SimpleSdpObserver() {
            override fun onCreateSuccess(desc: SessionDescription?) {
                if (desc == null) return
                pc.setLocalDescription(object : SimpleSdpObserver() {
                    override fun onSetSuccess() {
                        val sdp = JSONObject().put("type", desc.type.canonicalForm()).put("sdp", desc.description)
                        socket?.emit("rtc:offer", JSONObject().put("to", peerId).put("kind", "screen").put("offer", sdp))
                    }
                }, desc)
            }
        }, MediaConstraints())
    }

    private fun makePeer(peerId: String): PeerConnection? {
        val config = PeerConnection.RTCConfiguration(iceServers).apply { sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN }
        val pc = factory?.createPeerConnection(config, object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate?) {
                if (candidate != null) {
                    val json = JSONObject().put("candidate", candidate.sdp)
                        .put("sdpMid", candidate.sdpMid).put("sdpMLineIndex", candidate.sdpMLineIndex)
                    socket?.emit("rtc:ice", JSONObject().put("to", peerId).put("kind", "screen").put("candidate", json))
                }
            }
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
            override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {}
            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {}
            override fun onAddStream(stream: org.webrtc.MediaStream?) {}
            override fun onRemoveStream(stream: org.webrtc.MediaStream?) {}
            override fun onDataChannel(channel: org.webrtc.DataChannel?) {}
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(receiver: org.webrtc.RtpReceiver?, streams: Array<out org.webrtc.MediaStream>?) {}
            override fun onConnectionChange(state: PeerConnection.PeerConnectionState?) {}
            override fun onTrack(transceiver: org.webrtc.RtpTransceiver?) {}
        })
        if (pc != null) peers[peerId] = pc
        return pc
    }

    private fun flushIce(peerId: String, pc: PeerConnection) {
        val items = pendingIce.remove(peerId) ?: return
        items.forEach { pc.addIceCandidate(it) }
    }

    private fun report(message: String) {
        android.util.Log.i(TAG, message)
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIFICATION_ID, notification(message.take(100)))
    }

    private fun notification(message: String): Notification {
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "TogetherWatch ekran ulashish", NotificationManager.IMPORTANCE_LOW))
        }
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID).setContentTitle("TogetherWatch").setContentText(message)
                .setSmallIcon(android.R.drawable.presence_video_online).setOngoing(true).build()
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this).setContentTitle("TogetherWatch").setContentText(message)
                .setSmallIcon(android.R.drawable.presence_video_online).setOngoing(true).build()
        }
    }

    private fun stopSharing() {
        try { socket?.emit("screen:stop"); socket?.emit("room:leave"); socket?.disconnect(); socket?.off() } catch (_: Exception) {}
        peers.values.forEach { try { it.close() } catch (_: Exception) {} }
        peers.clear()
        try { capturer?.stopCapture() } catch (_: Exception) {}
        try { capturer?.dispose() } catch (_: Exception) {}
        capturer = null
        try { track?.dispose() } catch (_: Exception) {}
        track = null
        try { audioTrack?.dispose() } catch (_: Exception) {}
        audioTrack = null
        try { audioSource?.dispose() } catch (_: Exception) {}
        audioSource = null
        try { source?.dispose() } catch (_: Exception) {}
        source = null
        try { textureHelper?.dispose() } catch (_: Exception) {}
        textureHelper = null
        try { factory?.dispose() } catch (_: Exception) {}
        factory = null
        try { egl?.release() } catch (_: Exception) {}
        egl = null
        started = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE) else {
            @Suppress("DEPRECATION") stopForeground(true)
        }
    }

    override fun onDestroy() {
        stopSharing()
        super.onDestroy()
    }

    private open class SimpleSdpObserver : SdpObserver {
        override fun onCreateSuccess(desc: SessionDescription?) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String?) { android.util.Log.e(TAG, "SDP create failed: $error") }
        override fun onSetFailure(error: String?) { android.util.Log.e(TAG, "SDP set failed: $error") }
    }

    companion object {
        const val ACTION_START = "com.smartbot702.togetherwatch.START_SCREEN_SHARE"
        const val ACTION_STOP = "com.smartbot702.togetherwatch.STOP_SCREEN_SHARE"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"
        const val EXTRA_SERVER_URL = "serverUrl"
        const val EXTRA_ROOM_ID = "roomId"
        const val EXTRA_NAME = "displayName"
        private const val CHANNEL_ID = "togetherwatch_screen_share"
        private const val NOTIFICATION_ID = 7210
        private const val TAG = "TWNativeScreen"
    }
}
