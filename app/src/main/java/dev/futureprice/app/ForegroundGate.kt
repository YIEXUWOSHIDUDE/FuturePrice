package dev.futureprice.app

import android.app.AppOpsManager
import android.app.KeyguardManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.os.PowerManager
import android.os.Process

/**
 * 用 UsageStats 生命周期事件推断前台包。只是推断，不是实时保证；
 * 无权限、锁屏、息屏、未知或查询异常都返回 false。只在内存中保留当前状态，不保存使用历史。
 */
class ForegroundGate(context: Context, private val allowedPackages: Set<String>) {

    private val appOps = context.getSystemService(AppOpsManager::class.java)
    private val usage = context.getSystemService(UsageStatsManager::class.java)
    private val keyguard = context.getSystemService(KeyguardManager::class.java)
    private val power = context.getSystemService(PowerManager::class.java)
    private val ownPackage = context.packageName

    private var currentPackage: String? = null
    private var currentClass: String? = null
    private var queriedUntil = 0L
    private var lastEventTime = 0L
    private val seenAtLastTime = HashSet<String>()

    fun hasPermission(): Boolean =
        appOps.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ownPackage) ==
            AppOpsManager.MODE_ALLOWED

    fun isAllowed(): Boolean {
        if (!hasPermission() || !power.isInteractive || keyguard.isKeyguardLocked) {
            reset()
            return false
        }
        if (!update()) {
            reset()
            return false
        }
        return currentPackage in allowedPackages
    }

    private fun reset() {
        currentPackage = null
        currentClass = null
        queriedUntil = 0L
        lastEventTime = 0L
        seenAtLastTime.clear()
    }

    /** 首次查询较长窗口初始化，之后从上次末尾稍作重叠增量查询，按时间顺序应用事件。 */
    private fun update(): Boolean {
        val now = System.currentTimeMillis()
        val start = if (queriedUntil == 0L) now - INIT_WINDOW_MS else queriedUntil - OVERLAP_MS
        return try {
            val events = usage.queryEvents(start, now) ?: return false
            val e = UsageEvents.Event()
            while (events.getNextEvent(e)) {
                val t = e.timeStamp
                if (t < lastEventTime) continue
                val key = "${e.eventType}|${e.packageName}|${e.className}"
                if (t == lastEventTime && !seenAtLastTime.add(key)) continue
                if (t > lastEventTime) {
                    lastEventTime = t
                    seenAtLastTime.clear()
                    seenAtLastTime.add(key)
                }
                applyEvent(e)
            }
            queriedUntil = now
            true
        } catch (ex: RuntimeException) {
            false
        }
    }

    private fun applyEvent(e: UsageEvents.Event) {
        when (e.eventType) {
            UsageEvents.Event.ACTIVITY_RESUMED -> {
                currentPackage = e.packageName
                currentClass = e.className
            }
            UsageEvents.Event.ACTIVITY_PAUSED, UsageEvents.Event.ACTIVITY_STOPPED -> {
                if (e.packageName == currentPackage && e.className == currentClass) {
                    currentPackage = null
                    currentClass = null
                }
            }
            UsageEvents.Event.SCREEN_NON_INTERACTIVE, UsageEvents.Event.KEYGUARD_SHOWN -> {
                currentPackage = null
                currentClass = null
            }
        }
    }

    private companion object {
        const val INIT_WINDOW_MS = 60 * 60 * 1000L
        const val OVERLAP_MS = 2_000L
    }
}
