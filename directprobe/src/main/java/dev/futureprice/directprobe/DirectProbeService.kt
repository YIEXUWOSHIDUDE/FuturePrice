package dev.futureprice.directprobe

import android.accessibilityservice.AccessibilityService
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.PixelFormat
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/**
 * 调试试验：纯无障碍节点直读价格候选。无截图、无 OCR、无投屏。
 * 主线程收事件立即请求撤框并递增 generation；后台单线程读树，同一时间最多一个真实在途读取，
 * 至多再挂一个待读请求；在途读取超预算只标记过期，仍占用 busy 直到 worker 真正返回（不假设能取消 Binder）。
 * 日志只含包名、事件类别、计数与耗时，不含文本、金额或坐标。
 */
class DirectProbeService : AccessibilityService() {

    companion object {
        const val ACTION_COMMAND = "dev.futureprice.directprobe.COMMAND"
        const val EXTRA_COMMAND = "command"
        private const val TAG = "FPDirect"
        private const val OVERLAY_TITLE = "FPDirectProbeOverlay"
        private const val DEBOUNCE_MS = 300L
        private const val READ_BUDGET_MS = 1000L
        private const val MAX_NODES = 2000
        private const val AUTO_STOP_MS = 5 * 60 * 1000L
        private const val MIN_W = 8
        private const val MIN_H = 12
        // 单个遮挡窗口覆盖屏幕比例超过此值时整屏不出候选。
        private const val LARGE_OCCLUDER_RATIO = 0.3f
        private val TARGETS = setOf("com.taobao.taobao", "com.xunmeng.pinduoduo", "dev.futureprice.fixture")

        @Volatile var connected = false
            private set
        @Volatile var active = false
            private set
    }

    private class ReadResult(
        val seq: Long,
        val gen: Long,
        val epoch: Int,
        val pkg: String,
        val strictBoxes: List<ProbeOverlay.Box>,
        val flatBoxes: List<ProbeOverlay.Box>,
        val adaptedBoxes: List<ProbeOverlay.Box>,
        // adapted 使用的规则（pdd_guest_list_en / flat_passthrough）与结果（accept 或拒绝原因）。
        val adaptedRule: String,
        val adaptedResult: String,
        val reject: String?,
        val nodes: Int,
        val truncated: Boolean,
        val rootMs: Long,
        val traverseMs: Long,
        val priceNodes: Int,
        val filtered: Map<String, Int>,
        val ownOverlayWindowId: Int,
    )

    private class Stats(val epoch: Int) {
        val events = LinkedHashMap<String, Int>()
        val outcomes = LinkedHashMap<String, Int>()
        val readMs = ArrayList<Long>()
        val eventToClearRequestMs = ArrayList<Long>()
        val filtered = LinkedHashMap<String, Int>()
        var reads = 0
        var truncated = 0
        var maxNodes = 0
        var maxCandidates = 0
        var expiredWhileBusy = 0

        fun add(map: MutableMap<String, Int>, key: String, n: Int = 1) {
            map[key] = (map[key] ?: 0) + n
        }

        fun sample(list: MutableList<Long>, v: Long) {
            if (list.size < 10_000) list += v
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private var executor: ExecutorService = Executors.newSingleThreadExecutor()
    private var stats = Stats(0)

    // 以下仅在主线程访问。
    private var generation = 0L
    private var readSeq = 0L
    private var busySeq = 0L          // 0 表示无真实在途读取；直到 worker 返回才清零
    private var busyStart = 0L
    private var busyExpired = false   // 在途读取已超预算，结果到达时按超时处理
    private var pendingRead = false   // 至多一个待读请求
    private var overlay: ProbeOverlay? = null
    @Volatile private var ownOverlayWindowId = -1
    // 显示模式：adapted（默认，页面适配规则）；flat / strict 保留为诊断。
    private var mode = "adapted"

    private val readRunnable = Runnable { startRead() }
    private val autoStop = Runnable { stop("auto_5min") }

    private val commandReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            when (i.getStringExtra(EXTRA_COMMAND)) {
                "start" -> start()
                "stop" -> stop("command")
                "reset" -> {
                    stats = Stats(stats.epoch + 1)
                    Log.i(TAG, "reset epoch=${stats.epoch}")
                }
                "summary" -> logSummary()
                "adapted", "flat", "strict" -> setMode(i.getStringExtra(EXTRA_COMMAND)!!)
                "fresh" -> fresh()
            }
        }
    }

    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            if (active) invalidate(SystemClock.uptimeMillis(), "screen_off")
        }
    }

    override fun onServiceConnected() {
        connected = true
        registerReceiver(commandReceiver, IntentFilter(ACTION_COMMAND), RECEIVER_EXPORTED)
        registerReceiver(screenReceiver, IntentFilter(Intent.ACTION_SCREEN_OFF), RECEIVER_NOT_EXPORTED)
        Log.i(TAG, "connected")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        val category = when (event.eventType) {
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> "state"
            AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED -> "content"
            AccessibilityEvent.TYPE_VIEW_SCROLLED -> "scroll"
            AccessibilityEvent.TYPE_WINDOWS_CHANGED -> "windows"
            AccessibilityEvent.TYPE_VIEW_CLICKED -> "click"
            else -> "other"
        }
        if (!active) return
        // 只忽略确定属于本服务的事件：本包，或已识别的本诊断层窗口。
        if (event.packageName?.toString() == packageName) return
        if (ownOverlayWindowId != -1 && event.windowId == ownOverlayWindowId) return
        // 注意：已订阅 click，但实测 PDD WebView 内点击与弹窗出现未送达本服务，事件缺失问题未修复；
        // 纯事件驱动不能保证及时撤框。未加轮询或截图。
        stats.add(stats.events, category)
        invalidate(event.eventTime, category)
        main.removeCallbacks(readRunnable)
        main.postDelayed(readRunnable, DEBOUNCE_MS)
    }

    override fun onInterrupt() {
        if (active) invalidate(SystemClock.uptimeMillis(), "interrupt")
    }

    override fun onUnbind(intent: Intent?): Boolean {
        shutdown()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        shutdown()
        super.onDestroy()
    }

    private fun shutdown() {
        if (!connected) return
        stop("service_end")
        connected = false
        try {
            unregisterReceiver(commandReceiver)
            unregisterReceiver(screenReceiver)
        } catch (e: IllegalArgumentException) {
            // 已注销。
        }
        executor.shutdownNow()
    }

    /** 立即作废在途结果并请求撤框（View 重绘尚未完成，不代表已在屏幕上清空）。 */
    private fun invalidate(eventUptime: Long, cause: String) {
        generation++
        overlay?.show(emptyList())
        stats.sample(stats.eventToClearRequestMs, SystemClock.uptimeMillis() - eventUptime)
        if (cause == "screen_off" || cause == "interrupt") Log.i(TAG, "clear cause=$cause gen=$generation")
    }

    private fun start() {
        if (!connected || active) return
        active = true
        generation++
        if (executor.isShutdown) executor = Executors.newSingleThreadExecutor()
        val view = ProbeOverlay(this)
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply { title = OVERLAY_TITLE }
        ownOverlayWindowId = -1
        getSystemService(WindowManager::class.java).addView(view, params)
        overlay = view
        main.postDelayed(autoStop, AUTO_STOP_MS)
        main.post(readRunnable)
        Log.i(TAG, "start gen=$generation")
    }

    /** 停止不清除真实 busy：在途 worker 返回前不会提交新读取。 */
    private fun stop(reason: String) {
        if (!active) return
        active = false
        generation++
        pendingRead = false
        main.removeCallbacks(readRunnable)
        main.removeCallbacks(autoStop)
        overlay?.let {
            it.show(emptyList())
            if (it.isAttachedToWindow) getSystemService(WindowManager::class.java).removeViewImmediate(it)
        }
        overlay = null
        ownOverlayWindowId = -1
        Log.i(TAG, "stop reason=$reason gen=$generation busy=${busySeq != 0L}")
    }

    /** 切换诊断显示模式：先作废并撤框，再重读，避免两种模式结果混在一起。 */
    private fun setMode(newMode: String) {
        mode = newMode
        Log.i(TAG, "mode=$mode")
        if (!active) return
        invalidate(SystemClock.uptimeMillis(), "mode")
        main.removeCallbacks(readRunnable)
        main.post(readRunnable)
    }

    /**
     * 诊断命令：清除无障碍节点缓存后作废并重读一次。仅供手动对照，不自动调用、不轮询，
     * 不是及时撤框的保障。
     */
    private fun fresh() {
        val cleared = try {
            clearCache()
        } catch (e: RuntimeException) {
            false
        }
        Log.i(TAG, "fresh cleared=$cleared")
        if (!active) return
        invalidate(SystemClock.uptimeMillis(), "fresh")
        main.removeCallbacks(readRunnable)
        main.post(readRunnable)
    }

    private fun versionCodeOf(pkg: String): Long? = try {
        packageManager.getPackageInfo(pkg, 0).longVersionCode
    } catch (e: Exception) {
        null
    }

    private fun screenUsable(): Boolean =
        getSystemService(PowerManager::class.java).isInteractive &&
            !getSystemService(KeyguardManager::class.java).isKeyguardLocked

    private fun startRead() {
        if (!active) return
        if (!screenUsable()) {
            invalidate(SystemClock.uptimeMillis(), "locked")
            return
        }
        if (busySeq != 0L) {
            // 已有真实在途读取：只挂一个待读请求，返回后再读最新状态。
            pendingRead = true
            return
        }
        val seq = ++readSeq
        val gen = generation
        val epoch = stats.epoch
        busySeq = seq
        busyStart = SystemClock.uptimeMillis()
        busyExpired = false
        pendingRead = false
        val screen = Rect(getSystemService(WindowManager::class.java).maximumWindowMetrics.bounds)
        try {
            executor.execute {
                val t0 = SystemClock.uptimeMillis()
                val r = try {
                    readTree(seq, gen, epoch, screen)
                } catch (e: RuntimeException) {
                    errorResult(seq, gen, epoch, SystemClock.uptimeMillis() - t0)
                }
                main.post { onReadDone(r) }
            }
        } catch (e: RejectedExecutionException) {
            busySeq = 0
            Log.i(TAG, "read rejected executor_shutdown")
            return
        }
        main.postDelayed({
            if (busySeq == seq && !busyExpired) {
                busyExpired = true
                stats.expiredWhileBusy++
                Log.i(TAG, "read expired_waiting seq=$seq gen=$gen")
            }
        }, READ_BUDGET_MS)
    }

    private fun errorResult(seq: Long, gen: Long, epoch: Int, ms: Long) =
        ReadResult(
            seq, gen, epoch, "none", emptyList(), emptyList(), emptyList(), "none", "worker_error",
            "worker_error", 0, false, ms, 0, 0, emptyMap(), -1,
        )

    private fun onReadDone(r: ReadResult) {
        if (r.seq != busySeq) return
        val expired = busyExpired
        busySeq = 0
        busyExpired = false
        if (r.ownOverlayWindowId != -1 && overlay != null) ownOverlayWindowId = r.ownOverlayWindowId

        val total = r.rootMs + r.traverseMs
        val outcome = when {
            expired || total > READ_BUDGET_MS -> "timeout"
            !active -> "inactive"
            r.gen != generation -> "stale"
            r.reject != null -> "reject_${r.reject}"
            else -> "shown"
        }
        val boxes = when (mode) {
            "flat" -> r.flatBoxes
            "strict" -> r.strictBoxes
            else -> r.adaptedBoxes
        }
        if (outcome == "shown") overlay?.show(boxes)
        else if (outcome.startsWith("reject_") && r.gen == generation) overlay?.show(emptyList())

        // 所有完成的读取（含超时、过期、拒绝）都按实际耗时统计；reset 之前提交的不计入本轮。
        if (r.epoch == stats.epoch) {
            stats.reads++
            stats.add(stats.outcomes, outcome)
            stats.sample(stats.readMs, total)
            stats.maxNodes = maxOf(stats.maxNodes, r.nodes)
            if (r.truncated) stats.truncated++
            if (outcome == "shown") stats.maxCandidates = maxOf(stats.maxCandidates, boxes.size)
            r.filtered.forEach { (k, v) -> stats.add(stats.filtered, k, v) }
        }
        Log.i(
            TAG,
            "read pkg=${r.pkg} gen=${r.gen} mode=$mode outcome=$outcome strict_candidates=${r.strictBoxes.size} " +
                "flat_candidates=${r.flatBoxes.size} adapted_candidates=${r.adaptedBoxes.size} " +
                "adapted_rule=${r.adaptedRule} adapted_result=${r.adaptedResult} " +
                "shown_candidates=${if (outcome == "shown") boxes.size else 0} " +
                "price_nodes=${r.priceNodes} filtered=${r.filtered} " +
                "nodes=${r.nodes} truncated=${r.truncated} root_ms=${r.rootMs} traverse_ms=${r.traverseMs} read_ms=$total",
        )
        if (pendingRead && active) main.post(readRunnable)
    }

    /** 后台线程：读取活动窗口节点树，文字只在本函数内存中使用。 */
    private fun readTree(seq: Long, gen: Long, epoch: Int, screen: Rect): ReadResult {
        val t0 = SystemClock.uptimeMillis()
        val wins: List<AccessibilityWindowInfo> = this.windows
        val root = rootInActiveWindow
        val t1 = SystemClock.uptimeMillis()

        // 本服务诊断层：按窗口标题识别；其它无障碍覆盖层不豁免，按遮挡处理。
        val own = wins.firstOrNull {
            it.type == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY && it.title?.toString() == OVERLAY_TITLE
        }
        val ownId = own?.id ?: -1
        fun reject(pkg: String, why: String) = ReadResult(
            seq, gen, epoch, pkg, emptyList(), emptyList(), emptyList(), "none", why,
            why, 0, false, t1 - t0, 0, 0, emptyMap(), ownId,
        )

        root ?: return reject("none", "no_root")
        val rawPkg = root.packageName?.toString()
        if (rawPkg !in TARGETS) return reject("other", "unsupported")
        val pkg = rawPkg!!
        val appWindow = wins.firstOrNull { it.id == root.windowId } ?: return reject(pkg, "no_window")

        // 目标窗口之上的其它窗口（含状态栏/导航栏/弹层/输入法/其它无障碍覆盖层）视为遮挡，
        // 只按矩形保守排除，不证明完整遮挡关系。
        val occluders = wins.filter { it.id != appWindow.id && it.id != ownId && it.layer > appWindow.layer }
            .map { w -> Rect().also { w.getBoundsInScreen(it) } }
        val screenArea = screen.width().toLong() * screen.height()
        if (occluders.any { it.width().toLong() * it.height() > screenArea * LARGE_OCCLUDER_RATIO }) {
            return reject(pkg, "large_occluder")
        }

        val filtered = LinkedHashMap<String, Int>()
        fun drop(k: String) {
            filtered[k] = (filtered[k] ?: 0) + 1
        }
        // 诊断：遍历不因祖先框无交集而剪枝，所有节点都访问（上限 2000）。
        // flat：完整币种 + 可见 + 正常屏内框 + 未被上层窗口遮挡，去重；
        // strict：在 flat 基础上，还要求沿途全部祖先框的交集完全包含本节点框。
        val strictBoxes = ArrayList<ProbeOverlay.Box>()
        val flatBoxes = ArrayList<ProbeOverlay.Box>()
        val seen = HashSet<String>()
        var priceNodes = 0
        var visited = 0
        // 页面适配用的全树快照（仅当前活动窗口、仅内存）。
        val snapNodes = ArrayList<SnapNode>()
        // clip 为祖先框交集；null 表示祖先框交集已为空（ancestor_invalid）。第三项为父节点快照 id。
        val queue = ArrayDeque<Triple<AccessibilityNodeInfo, Rect?, Int>>()
        queue.add(Triple(root, Rect(screen), -1))
        while (queue.isNotEmpty() && visited < MAX_NODES) {
            val (n, clip, parentId) = queue.removeFirst()
            val id = visited
            visited++
            val b = Rect()
            n.getBoundsInScreen(b)
            val childClip = clip?.let { c -> Rect(b).takeIf { it.intersect(c) } }

            val text = n.text?.toString()?.takeIf { it.isNotBlank() } ?: n.contentDescription?.toString()
            snapNodes += SnapNode(
                id, parentId, n.className?.toString(), text,
                IntBox(b.left, b.top, b.right, b.bottom), n.isVisibleToUser,
            )
            val cents = text?.let { DirectPrice.cents(it) }
            if (cents != null) {
                priceNodes++
                when {
                    !n.isVisibleToUser -> drop("not_visible")
                    b.width() < MIN_W || b.height() < MIN_H -> drop("too_small")
                    !screen.contains(b) -> drop("offscreen")
                    occluders.any { Rect.intersects(it, b) } -> drop("occluded")
                    !seen.add("${b.flattenToString()}|$cents") -> drop("duplicate")
                    else -> {
                        val future = DirectPrice.futureYuan(cents)
                        flatBoxes += ProbeOverlay.Box(flatBoxes.size + 1, Rect(b), future)
                        when {
                            clip == null -> drop("ancestor_invalid")
                            !clip.contains(b) -> drop("ancestor_clipped")
                            else -> strictBoxes += ProbeOverlay.Box(strictBoxes.size + 1, Rect(b), future)
                        }
                    }
                }
            }
            for (i in 0 until n.childCount) n.getChild(i)?.let { queue.add(Triple(it, childClip, id)) }
        }
        val truncated = queue.isNotEmpty()
        queue.clear()

        // adapted：PDD 只走已测游客列表规则，不匹配即拒绝（不回退 flat）；淘宝/测试商店沿用 flat。
        fun renumber(list: List<ProbeOverlay.Box>) = list.mapIndexed { i, x -> ProbeOverlay.Box(i + 1, x.rect, x.futureYuan) }
        fun ProbeOverlay.Box.intBox() = IntBox(rect.left, rect.top, rect.right, rect.bottom)
        var adaptedRule = "flat_passthrough"
        var adaptedResult = "accept"
        var adapted: List<ProbeOverlay.Box> = flatBoxes
        if (truncated) {
            adaptedResult = "truncated"
            adapted = emptyList()
        } else if (pkg == PddGuestListRule.PACKAGE) {
            adaptedRule = "pdd_guest_list_en"
            val snapshot = PageSnapshot(
                pkg, versionCodeOf(pkg), IntBox(screen.left, screen.top, screen.right, screen.bottom), snapNodes,
            )
            when (val d = PddGuestListRule.evaluate(snapshot, flatBoxes.map { it.intBox() })) {
                is PageDecision.Accept -> adapted = renumber(flatBoxes.filter { it.intBox() in d.prices })
                is PageDecision.Reject -> {
                    adaptedResult = d.reason
                    adapted = emptyList()
                }
            }
        }
        snapNodes.clear()
        val t2 = SystemClock.uptimeMillis()
        // 截断时不显示部分候选，避免冒充完整结果。
        return ReadResult(
            seq, gen, epoch, pkg,
            if (truncated) emptyList() else strictBoxes,
            if (truncated) emptyList() else flatBoxes,
            adapted, adaptedRule, adaptedResult,
            if (truncated) "truncated" else null,
            visited, truncated, t1 - t0, t2 - t1, priceNodes, filtered, ownId,
        )
    }

    private fun logSummary() {
        val s = stats
        fun pct(list: List<Long>, p: Double): Long {
            if (list.isEmpty()) return -1
            val sorted = list.sorted()
            return sorted[((sorted.size - 1) * p).toInt()]
        }
        val busyMs = if (busySeq != 0L) SystemClock.uptimeMillis() - busyStart else 0
        Log.i(
            TAG,
            "summary epoch=${s.epoch} active=$active busy_ms=$busyMs events=${s.events} reads=${s.reads} " +
                "outcomes=${s.outcomes} expired_while_busy=${s.expiredWhileBusy} truncated=${s.truncated} " +
                "filtered=${s.filtered} max_nodes=${s.maxNodes} max_candidates=${s.maxCandidates} " +
                "read_ms_p50=${pct(s.readMs, 0.5)} read_ms_p95=${pct(s.readMs, 0.95)} read_ms_max=${s.readMs.maxOrNull() ?: -1} " +
                "event_to_clear_request_ms_p50=${pct(s.eventToClearRequestMs, 0.5)} " +
                "event_to_clear_request_ms_p95=${pct(s.eventToClearRequestMs, 0.95)} " +
                "event_to_clear_request_ms_max=${s.eventToClearRequestMs.maxOrNull() ?: -1}",
        )
    }
}
