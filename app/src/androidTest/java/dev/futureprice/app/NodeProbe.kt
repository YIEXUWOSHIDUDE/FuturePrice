package dev.futureprice.app

import android.app.Instrumentation
import android.app.UiAutomation
import android.graphics.Rect
import android.os.Bundle
import android.os.SystemClock
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * UIAutomator 层诊断（仅测试 APK）：统计目标购物 App 前台节点中可见的精确价格节点数量与读取耗时。
 * 不是产品 AccessibilityService 验证。只输出计数与耗时，不输出商品文本、价格或截图。
 */
class NodeProbe(private val instrumentation: Instrumentation) {

    private val allowed = setOf("com.taobao.taobao", "com.jingdong.app.mall", "com.xunmeng.pinduoduo")
    private val price = Regex(
        """^(?:[¥￥]\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?|(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?\s*元)$""",
    )

    private class Scan(val ms: Long, val prices: Int, val visited: Int, val truncated: Boolean)

    fun run(args: Bundle): Bundle {
        val seconds = (args.getString("seconds")?.toIntOrNull() ?: DEFAULT_SECONDS).coerceIn(5, 40)
        val ui = instrumentation.uiAutomation
        val screen = instrumentation.targetContext.getSystemService(WindowManager::class.java)
            .maximumWindowMetrics.bounds
        // 容量 1：冗余事件合并为一个待处理信号，events 仍逐个计数。
        val signals = LinkedBlockingQueue<Unit>(1)
        var events = 0
        var pkg: String? = null

        ui.setOnAccessibilityEventListener { e ->
            val p = e.packageName?.toString()
            if (p != null && p in allowed && e.eventType in WATCHED) {
                synchronized(this) { events++ }
                signals.offer(Unit)
            }
        }

        val scans = ArrayList<Scan>()
        val start = SystemClock.elapsedRealtime()
        val deadline = start + seconds * 1000L
        try {
            scan(ui, screen)?.let { (p, s) -> pkg = p; scans += s }
            while (true) {
                val remaining = deadline - SystemClock.elapsedRealtime()
                if (remaining <= 0) break
                signals.poll(remaining, TimeUnit.MILLISECONDS) ?: break
                // debounce：连续 300ms 无新事件再读，期间仍受总时限约束。
                while (SystemClock.elapsedRealtime() < deadline &&
                    signals.poll(DEBOUNCE_MS, TimeUnit.MILLISECONDS) != null
                ) Unit
                if (SystemClock.elapsedRealtime() >= deadline) break
                scan(ui, screen)?.let { (p, s) -> pkg = p; scans += s }
            }
        } finally {
            ui.setOnAccessibilityEventListener(null)
        }

        return Bundle().apply {
            putString("package", pkg ?: "none")
            putInt("scan_count", scans.size)
            putInt("event_count", synchronized(this@NodeProbe) { events })
            putString("scans_ms_prices", scans.joinToString(",") { "${it.ms}ms:${it.prices}" })
            putLong("duration_ms", SystemClock.elapsedRealtime() - start)
            putInt("max_visited", scans.maxOfOrNull { it.visited } ?: 0)
            putInt("truncated_count", scans.count { it.truncated })
        }
    }

    /** 仅在前台为允许的包时遍历；节点读完即丢弃。 */
    private fun scan(ui: UiAutomation, screen: Rect): Pair<String, Scan>? {
        // 计时包含获取 root 的耗时。
        val t0 = SystemClock.elapsedRealtime()
        val root = ui.rootInActiveWindow ?: return null
        val p = root.packageName?.toString() ?: return null
        if (p !in allowed) return null

        val seen = HashSet<String>()
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0
        val bounds = Rect()
        while (queue.isNotEmpty() && visited < MAX_NODES) {
            val n = queue.removeFirst()
            visited++
            val text = n.text?.toString()?.takeIf { it.isNotBlank() } ?: n.contentDescription?.toString()
            if (text != null && n.isVisibleToUser) {
                val v = text.trim()
                if (price.matches(v)) {
                    n.getBoundsInScreen(bounds)
                    if (bounds.width() > 0 && bounds.height() >= 12 && screen.contains(bounds)) {
                        seen += "${bounds.flattenToString()}|$v"
                    }
                }
            }
            for (i in 0 until n.childCount) n.getChild(i)?.let { queue.add(it) }
        }
        val truncated = queue.isNotEmpty()
        queue.clear()
        return p to Scan(SystemClock.elapsedRealtime() - t0, seen.size, visited, truncated)
    }

    private companion object {
        const val DEFAULT_SECONDS = 20
        const val MAX_NODES = 2000
        const val DEBOUNCE_MS = 300L
        val WATCHED = setOf(
            AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED,
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
            AccessibilityEvent.TYPE_VIEW_SCROLLED,
        )
    }
}
