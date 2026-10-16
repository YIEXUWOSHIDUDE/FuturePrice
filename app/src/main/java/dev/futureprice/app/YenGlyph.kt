package dev.futureprice.app

/**
 * 保守判断单个字形是否为 ¥：顶部左右分叉、中下部恰好两组横向长实线（中间为窄竖干）、下部窄竖干。
 * 输入为按行展开的笔画矩阵（true 为笔画）。纯 Kotlin，可单测。
 */
object YenGlyph {

    private const val BAR_RATIO = 0.65f
    private const val STEM_RATIO = 0.4f

    fun isYen(ink: BooleanArray, width: Int, height: Int): Boolean {
        if (width <= 0 || height <= 0 || ink.size != width * height) return false

        // 裁到笔画外框。
        var l = width; var r = -1; var t = height; var b = -1
        for (y in 0 until height) for (x in 0 until width) if (ink[y * width + x]) {
            if (x < l) l = x
            if (x > r) r = x
            if (y < t) t = y
            if (y > b) b = y
        }
        if (r < 0) return false
        val w = r - l + 1
        val h = b - t + 1
        if (w < 5 || h < 8) return false
        val runs = (t..b).map { y -> runsOf(ink, width, y, l, r) }

        // 顶部 25%：多数行为左右两段，左段在左半、右段在右半。
        val topRows = maxOf(1, h / 4)
        val forked = (0 until topRows).count { i ->
            val rr = runs[i]
            rr.size == 2 && rr[0].last < w / 2 && rr[1].first >= w / 2
        }
        if (forked * 2 < topRows || runs[0].size != 2) return false

        // 横线：单段且宽度 >= 65% 字宽。连续行归为一组。
        val isBar = runs.map { rr -> rr.size == 1 && rr[0].count() >= w * BAR_RATIO }
        val groups = ArrayList<IntRange>()
        var i = 0
        while (i < h) {
            if (isBar[i]) {
                val start = i
                while (i < h && isBar[i]) i++
                groups += start until i
            } else {
                i++
            }
        }
        if (groups.size != 2) return false
        for (g in groups) {
            val center = (g.first + g.last) / 2f
            if (center < h * 0.4f || center > h * 0.85f) return false
        }

        // 两线之间及第二线之下：单段窄竖干，大致居中。
        val between = (groups[0].last + 1) until groups[1].first
        val below = (groups[1].last + 1) until h
        if (between.isEmpty() || below.isEmpty()) return false
        for (y in between + below) {
            val rr = runs[y]
            if (rr.size != 1) return false
            val s = rr[0]
            if (s.count() > w * STEM_RATIO) return false
            val c = (s.first + s.last) / 2f
            if (c < w * 0.25f || c > w * 0.75f) return false
        }
        return true
    }

    /** 行内连续笔画段，坐标相对 left。 */
    private fun runsOf(ink: BooleanArray, width: Int, y: Int, left: Int, right: Int): List<IntRange> {
        val out = ArrayList<IntRange>()
        var x = left
        while (x <= right) {
            if (ink[y * width + x]) {
                val s = x
                while (x <= right && ink[y * width + x]) x++
                out += (s - left) until (x - left)
            } else {
                x++
            }
        }
        return out
    }
}
