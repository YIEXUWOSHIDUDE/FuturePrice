package dev.futureprice.app

import android.app.Activity
import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.RectF
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.view.WindowManager
import kotlin.math.abs

/** MediaProjection 前台服务：采集最新帧 → 稳定后 OCR → 悬浮标签。全部在主线程运行。 */
class CaptureService : Service() {

    companion object {
        const val ACTION_STOP = "dev.futureprice.app.STOP"
        const val EXTRA_RESULT_CODE = "result_code"
        const val EXTRA_DATA = "data"

        @Volatile var running = false
            private set
        @Volatile var status = "未开启"
            private set

        private const val CHANNEL_ID = "capture"
        private const val NOTIFICATION_ID = 1
        private const val TICK_MS = 100L
        private const val GATE_MS = 100L
        private const val STABLE_MS = 300L
        private const val GRID_X = 48
        private const val GRID_Y = 96
        private const val PIXEL_DIFF = 48
        private const val CHANGE_RATIO = 0.01f
        private const val SOURCE_CHANGE_RATIO = 0.005f
    }

    private val handler = Handler(Looper.getMainLooper())
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var overlay: OverlayLayer? = null
    private var ocr: OcrEngine? = null
    private var gate: ForegroundGate? = null
    private var screenReceiver: BroadcastReceiver? = null

    private var width = 0
    private var height = 0
    private var generation = 0
    private var latest: Bitmap? = null
    private var prevSample: IntArray? = null
    private var lastChange = 0L
    private var pendingOcr = false
    private var ocrBusy = false
    private var allowed = false
    private var lastGateCheck = 0L
    private var shownMasks: List<RectF> = emptyList()
    private var previousMasks: List<RectF> = emptyList()
    // 当前标签对应价格源区域的像素快照，仅内存，随撤标清空。
    private var sourceSnapshots: List<Pair<Rect, IntArray>> = emptyList()

    private val tick = object : Runnable {
        override fun run() {
            if (!running) return
            step()
            handler.postDelayed(this, TICK_MS)
        }
    }

    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() = stopSession("已停止")
        override fun onCapturedContentResize(w: Int, h: Int) {
            if (w != width || h != height) stopSession("屏幕尺寸变化，请重新开启")
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSession("已停止")
            return START_NOT_STICKY
        }
        // 已有会话时不复用或替换 token，避免第二个 VirtualDisplay。
        if (running) return START_NOT_STICKY

        val code = intent?.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED) ?: Activity.RESULT_CANCELED
        val data = intent?.getParcelableExtra(EXTRA_DATA, Intent::class.java)
        if (code != Activity.RESULT_OK || data == null) return abort("未获得屏幕共享授权")

        // 先成为 mediaProjection 前台服务，再取 projection。
        try {
            startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } catch (e: RuntimeException) {
            return abort("无法启动前台服务")
        }

        if (!Settings.canDrawOverlays(this)) return abort("需要悬浮窗权限")
        val allowedPackages = buildSet {
            add("com.taobao.taobao")
            add("com.jingdong.app.mall")
            add("com.xunmeng.pinduoduo")
            if (BuildConfig.DEBUG) add("dev.futureprice.fixture")
        }
        val g = ForegroundGate(this, allowedPackages)
        if (!g.hasPermission()) return abort("需要使用情况访问权限")

        val bounds = getSystemService(WindowManager::class.java).maximumWindowMetrics.bounds
        width = bounds.width()
        height = bounds.height()

        try {
            val p = getSystemService(MediaProjectionManager::class.java).getMediaProjection(code, data)
                ?: return abort("屏幕共享授权无效")
            projection = p
            gate = g
            overlay = OverlayLayer(this)
            ocr = OcrEngine(this)
            running = true
            status = "运行中"

            p.registerCallback(projectionCallback, handler)
            val r = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
            reader = r
            display = p.createVirtualDisplay(
                "FuturePrice", width, height, resources.displayMetrics.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, r.surface, null, handler,
            ) ?: return abort("无法创建屏幕采集")
        } catch (e: RuntimeException) {
            return abort("无法开始屏幕采集，请重新开启")
        }
        if (!running) return START_NOT_STICKY

        screenReceiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) = stopSession("锁屏或息屏，已结束")
        }.also { registerReceiver(it, IntentFilter(Intent.ACTION_SCREEN_OFF)) }

        handler.post(tick)
        return START_NOT_STICKY
    }

    private fun abort(message: String): Int {
        stopSession(message)
        return START_NOT_STICKY
    }

    private fun step() {
        val now = SystemClock.uptimeMillis()
        if (!getSystemService(PowerManager::class.java).isInteractive ||
            getSystemService(KeyguardManager::class.java).isKeyguardLocked
        ) return stopSession("锁屏或息屏，已结束")

        val b = getSystemService(WindowManager::class.java).maximumWindowMetrics.bounds
        if (b.width() != width || b.height() != height) return stopSession("屏幕尺寸变化，请重新开启")

        if (now - lastGateCheck >= GATE_MS) {
            lastGateCheck = now
            val nowAllowed = gate?.isAllowed() == true
            if (!nowAllowed && allowed) invalidate()
            if (nowAllowed && !allowed) {
                pendingOcr = true
                lastChange = now
            }
            allowed = nowAllowed
            status = if (allowed) "运行中" else "运行中 · 等待支持的购物 App"
        }

        val frame = acquireFrame()
        if (!allowed) {
            frame?.recycle()
            return
        }
        if (frame != null) {
            val sample = sample(frame, shownMasks + previousMasks)
            val prev = prevSample
            // 全屏抽样可能漏掉一位数字的变化，另逐帧比对当前标签对应的价格源区域。
            val sourceMoved = sourceSnapshots.any { (r, px) -> sourceChanged(r, px, frame) }
            if (prev == null || sourceMoved || changed(prev, sample)) {
                if (prev != null) clearTags()
                generation++
                lastChange = now
                pendingOcr = true
            }
            prevSample = sample
            // 已撤标签的区域只在撤下后的这一帧比较中排除。
            previousMasks = emptyList()
            latest?.recycle()
            latest = frame
        }

        // 计时到期即识别，不依赖后续帧。
        if (pendingOcr && !ocrBusy && now - lastChange >= STABLE_MS) latest?.let { runOcr(it) }
    }

    private fun runOcr(source: Bitmap) {
        val engine = ocr ?: return
        val copy = source.copy(Bitmap.Config.ARGB_8888, true) ?: return
        // 只遮住当前仍显示的自身标签，避免自识别；已撤下的历史区域不遮。
        val masks = shownMasks
        if (masks.isNotEmpty()) {
            val canvas = Canvas(copy)
            val white = Paint().apply { color = Color.WHITE }
            masks.forEach { canvas.drawRect(it, white) }
        }
        val gen = generation
        val multiplier = getSharedPreferences("settings", MODE_PRIVATE)
            .getInt("multiplier_milli", PriceRules.DEFAULT_MULTIPLIER_MILLI)
        ocrBusy = true
        pendingOcr = false
        engine.recognize(copy, multiplier,
            onResult = { tags ->
                ocrBusy = false
                val current = latest
                if (running && allowed && gen == generation && gate?.isAllowed() == true && current != null) {
                    // 价格源区域快照取自 OCR 原图；识别期间若最新帧该区域已变，丢弃结果并待稳定重识别。
                    val snapshots = tags.mapNotNull { t ->
                        val r = sourceRect(t.source, copy)
                        pixels(copy, r)?.let { r to it }
                    }
                    if (snapshots.size != tags.size || snapshots.any { (r, px) -> sourceChanged(r, px, current) }) {
                        generation++
                        lastChange = SystemClock.uptimeMillis()
                        pendingOcr = true
                    } else {
                        previousMasks = shownMasks
                        shownMasks = tags.map { RectF(it.bounds) }
                        sourceSnapshots = snapshots
                        overlay?.show(tags)
                    }
                }
                copy.recycle()
            },
            onError = {
                copy.recycle()
                ocrBusy = false
            },
        )
    }

    /** 取最新一帧，按 rowStride 复制并裁剪成完整屏幕 Bitmap。 */
    private fun acquireFrame(): Bitmap? {
        val image = reader?.acquireLatestImage() ?: return null
        try {
            val plane = image.planes[0]
            val rowWidth = plane.rowStride / plane.pixelStride
            val full = Bitmap.createBitmap(rowWidth, image.height, Bitmap.Config.ARGB_8888)
            full.copyPixelsFromBuffer(plane.buffer)
            if (rowWidth == image.width) return full
            val cropped = Bitmap.createBitmap(full, 0, 0, image.width, image.height)
            full.recycle()
            return cropped
        } catch (e: RuntimeException) {
            return null
        } finally {
            image.close()
        }
    }

    /** 网格抽样；处于自身标签区域的点记为 0 并在比较中忽略。 */
    private fun sample(bmp: Bitmap, masks: List<RectF>): IntArray {
        val pad = 4 * resources.displayMetrics.density
        val inflated = masks.map { RectF(it.left - pad, it.top - pad, it.right + pad, it.bottom + pad) }
        val out = IntArray(GRID_X * GRID_Y)
        for (gy in 0 until GRID_Y) for (gx in 0 until GRID_X) {
            val x = (gx + 0.5f) * bmp.width / GRID_X
            val y = (gy + 0.5f) * bmp.height / GRID_Y
            out[gy * GRID_X + gx] =
                if (inflated.any { it.contains(x, y) }) 0 else bmp.getPixel(x.toInt(), y.toInt()) or 0xFF000000.toInt()
        }
        return out
    }

    private fun changed(a: IntArray, b: IntArray): Boolean {
        var compared = 0
        var diff = 0
        for (i in a.indices) {
            if (a[i] == 0 || b[i] == 0) continue
            compared++
            val d = abs((a[i] shr 16 and 0xFF) - (b[i] shr 16 and 0xFF)) +
                abs((a[i] shr 8 and 0xFF) - (b[i] shr 8 and 0xFF)) +
                abs((a[i] and 0xFF) - (b[i] and 0xFF))
            if (d > PIXEL_DIFF) diff++
        }
        return compared > 0 && diff > compared * CHANGE_RATIO
    }

    /** 价格源区域在 a、b 两图之间是否有小范围变化（RGB 差 > 48 的像素超过 0.5%）。 */
    private fun sourceChanged(rect: Rect, a: IntArray, frame: Bitmap): Boolean {
        val b = pixels(frame, rect) ?: return true
        if (b.size != a.size) return true
        var diff = 0
        for (i in a.indices) {
            val d = abs((a[i] shr 16 and 0xFF) - (b[i] shr 16 and 0xFF)) +
                abs((a[i] shr 8 and 0xFF) - (b[i] shr 8 and 0xFF)) +
                abs((a[i] and 0xFF) - (b[i] and 0xFF))
            if (d > PIXEL_DIFF) diff++
        }
        return diff > a.size * SOURCE_CHANGE_RATIO
    }

    private fun pixels(bmp: Bitmap, r: Rect): IntArray? {
        if (r.isEmpty || r.left < 0 || r.top < 0 || r.right > bmp.width || r.bottom > bmp.height) return null
        val out = IntArray(r.width() * r.height())
        bmp.getPixels(out, 0, r.width(), r.left, r.top, r.width(), r.height())
        return out
    }

    private fun sourceRect(r: RectF, bmp: Bitmap) = Rect(
        maxOf(0, r.left.toInt()), maxOf(0, r.top.toInt()),
        minOf(bmp.width, r.right.toInt()), minOf(bmp.height, r.bottom.toInt()),
    )

    private fun clearTags() {
        sourceSnapshots = emptyList()
        previousMasks = shownMasks
        shownMasks = emptyList()
        overlay?.clear()
    }

    /** 离开支持页面：清空标签和图像，作废在途结果。 */
    private fun invalidate() {
        clearTags()
        generation++
        latest?.recycle()
        latest = null
        prevSample = null
        pendingOcr = false
    }

    private fun stopSession(message: String) {
        running = false
        status = message
        handler.removeCallbacksAndMessages(null)
        generation++
        overlay?.close()
        overlay = null
        ocr?.close()
        ocr = null
        gate = null
        display?.release()
        display = null
        reader?.close()
        reader = null
        projection?.let {
            projection = null
            it.unregisterCallback(projectionCallback)
            it.stop()
        }
        screenReceiver?.let { unregisterReceiver(it) }
        screenReceiver = null
        latest?.recycle()
        latest = null
        prevSample = null
        shownMasks = emptyList()
        previousMasks = emptyList()
        sourceSnapshots = emptyList()
        pendingOcr = false
        allowed = false
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        if (running) stopSession("已停止")
        super.onDestroy()
    }

    private fun buildNotification(): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, "省钱提醒", NotificationManager.IMPORTANCE_LOW))
        val stop = PendingIntent.getService(
            this, 0, Intent(this, CaptureService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE)
        }
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle("省钱提醒运行中")
            .setContentText("正在购物页面显示10年情景")
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "停止", stop).build())
            .build()
    }
}
