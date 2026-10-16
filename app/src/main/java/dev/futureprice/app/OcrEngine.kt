package dev.futureprice.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Paint
import android.graphics.RectF
import android.util.TypedValue
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * 本地打包中文 OCR → 保守主价 → 标签位置。输入为完整屏幕像素 bitmap，结果为屏幕坐标。
 * 回调在主线程；调用方持有 bitmap 直到回调完成。
 */
class OcrEngine(context: Context) {

    private val recognizer = TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
    private val dm = context.resources.displayMetrics
    private fun dp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, dm)

    // 与 OverlayLayer 的 14sp 字号一致，用于测量标签宽度。
    private val paint = Paint().apply {
        textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 14f, dm)
    }
    private val labelHeight = dp(24f)
    private val padX = dp(8f)
    private val gap = dp(4f)
    private var closed = false

    private class Sym(val text: String, val box: RectF?)
    private class Elem(val text: String, val box: RectF?, val symbols: List<Sym>)
    private class Line(val text: String, val box: RectF, val elements: List<Elem> = emptyList())

    fun recognize(
        bitmap: Bitmap,
        multiplierMilli: Int,
        onResult: (List<PriceTag>) -> Unit,
        onError: () -> Unit,
    ) {
        // 每次调用恰好回调一次（关闭后为 onError），调用方据此回收 bitmap。
        var done = false
        fun finish(block: () -> Unit) {
            if (!done) {
                done = true
                block()
            }
        }
        if (closed) return finish(onError)
        try {
            recognizer.process(InputImage.fromBitmap(bitmap, 0))
                .addOnSuccessListener { text ->
                    if (closed) return@addOnSuccessListener finish(onError)
                    val lines = toLines(text)
                    val verified = verifyYenGlyphs(bitmap, lines)
                    finish {
                        // 只替换像素确认为 ¥ 的行；其余 OCR 文本全部保留用于避让。
                        val merged = lines.flatMap { l -> verified[l] ?: listOf(l) }
                        onResult(place(merged, multiplierMilli, bitmap.width, bitmap.height))
                    }
                }
                .addOnFailureListener { finish(onError) }
                .addOnCanceledListener { finish(onError) }
        } catch (e: RuntimeException) {
            finish(onError)
        }
    }

    private fun toLines(text: com.google.mlkit.vision.text.Text): List<Line> =
        text.textBlocks.flatMap { b ->
            b.lines.mapNotNull { l ->
                val box = l.boundingBox ?: return@mapNotNull null
                val elements = l.elements.map { e ->
                    Elem(e.text, e.boundingBox?.let { RectF(it) }, e.symbols.map { s -> Sym(s.text, s.boundingBox?.let { RectF(it) }) })
                }
                Line(l.text, RectF(box), elements)
            }
        }

    /**
     * 以下 OCR 行需在原图像素上确认真实 ¥ 才采纳，不凭 OCR 文本替换：
     * - 恰为 Y/y+金额：bbox 内首字形须为 ¥；
     * - 纯数字金额：先查 bbox 内首字形是否为 ¥；否则 bbox 紧邻左侧 1.6 倍行高内须有同基线 ¥，source 框扩到 ¥；
     * - 价格+严格销量后缀同行：按 Element 真实框拆成价格行与销量行，Y/y 前缀须在价格左缘附近按像素确认为 ¥。
     * 背景不一致、字形不可分离、比例异常、缺坐标或跨其它 OCR 行都拒绝。同步执行。
     * 返回值替换原行，可能拆成多行；所有文字仍保留用于避让。
     */
    private fun verifyYenGlyphs(bitmap: Bitmap, lines: List<Line>): Map<Line, List<Line>> {
        val verified = HashMap<Line, List<Line>>()
        for (line in lines) {
            val text = line.text.trim()
            try {
                SUSPECT.find(text)?.let { m ->
                    if (firstGlyphIsYen(bitmap, line.box)) verified[line] = listOf(Line("¥" + m.groupValues[1], line.box))
                }
                BARE.find(text)?.let { m ->
                    if (PriceRules.parse("¥" + m.groupValues[1]) !is PriceRules.Parse.Price) return@let
                    // OCR 文本可能漏掉 ¥ 但 bbox 仍包含它：先查框内首字形。
                    if (firstGlyphIsYen(bitmap, line.box)) {
                        verified[line] = listOf(Line("¥" + m.groupValues[1], line.box))
                        return@let
                    }
                    val yenBox = leftYenBox(bitmap, line, lines) ?: return@let
                    verified[line] = listOf(Line("¥" + m.groupValues[1], RectF(line.box).apply { union(yenBox) }))
                }
                splitSalesLine(bitmap, line, text, lines)?.let { verified[line] = it }
            } catch (e: RuntimeException) {
                // 像素读取异常按未确认处理。
            }
        }
        return verified
    }

    /**
     * 「¥/Y金额 Store sales:…」同行：价格部分必须恰好由开头若干 Element 组成，其余 Element 恰为销量后缀，
     * 各 Element 都要有真实框；Y/y 前缀须在价格 Element 左缘附近用像素找到完整独立的 ¥ 字形，
     * source 并入该像素框。否则返回 null（拒绝）。
     */
    private fun splitSalesLine(bitmap: Bitmap, line: Line, text: String, lines: List<Line>): List<Line>? {
        val m = SALES_LINE.find(text) ?: return null
        val prefix = m.groupValues[1]
        val amount = m.groupValues[2]
        val sales = m.groupValues[3]
        if (PriceRules.parse("¥$amount") !is PriceRules.Parse.Price) return null

        fun compact(s: String) = s.filterNot { it.isWhitespace() }
        val target = compact(prefix + amount)
        val priceEls = ArrayList<Elem>()
        var acc = ""
        for (e in line.elements) {
            if (acc.length >= target.length) break
            acc += compact(e.text)
            priceEls += e
        }
        if (acc != target) return null
        val rest = line.elements.drop(priceEls.size)
        if (rest.isEmpty() || rest.joinToString("") { compact(it.text) } != compact(sales)) return null
        val priceBox = unionOf(priceEls.map { it.box }) ?: return null
        val salesBox = unionOf(rest.map { it.box }) ?: return null

        var source = priceBox
        if (prefix == "Y" || prefix == "y") {
            // Symbol 框不等于笔画像素，只用作锚点确认 OCR 读的首字符位置。
            val sym = priceEls[0].symbols.firstOrNull()
            if (sym == null || sym.text != prefix || sym.box == null) return null
            val yen = leadingYenBox(bitmap, priceBox, line.box.height(), line, lines) ?: return null
            source = RectF(priceBox).apply { union(yen) }
        }
        return listOf(Line("¥$amount", source), Line(sales, salesBox))
    }

    /**
     * 在价格框左缘附近（左扩 0.5、右至 1.5 倍行高，上下各 0.15 倍行高）按空白列切出首个完整字形，
     * 须不触搜索左边界、后有空白列、通过 YenGlyph，且底部与紧随的数字字形底部对齐（同基线）。
     * 字形高度按实际像素判断（小号 ¥ 可低于金额）。区域碰到其它 OCR 行或背景不一致都拒绝。返回 ¥ 像素框。
     */
    private fun leadingYenBox(bitmap: Bitmap, anchor: RectF, lh: Float, self: Line, lines: List<Line>): RectF? {
        val left = max(0, (anchor.left - lh * 0.5f).toInt())
        val right = min(bitmap.width, min(anchor.right, anchor.left + lh * 1.5f).toInt())
        val top = max(0, (anchor.top - lh * 0.15f).toInt())
        val bottom = min(bitmap.height, (anchor.bottom + lh * 0.15f).toInt())
        val w = right - left
        val h = bottom - top
        if (w < 8 || h < 8) return null
        val region = RectF(left.toFloat(), top.toFloat(), right.toFloat(), bottom.toFloat())
        if (lines.any { it !== self && RectF.intersects(region, it.box) }) return null
        val ink = inkRegion(bitmap, left, top, w, h) ?: return null

        fun colHasInk(x: Int) = (0 until h).any { ink[it * w + x] }
        val start = (0 until w).firstOrNull { colHasInk(it) } ?: return null
        if (start == 0) return null
        val end = (start until w).firstOrNull { !colHasInk(it) } ?: return null
        val g = glyphAt(ink, w, h, start, end) ?: return null
        if (g.top == 0 || g.bottom == h - 1) return null
        if (g.height < lh * 0.3f || g.height > lh * 1.2f) return null
        if (g.width < g.height * 0.4f || g.width > g.height * 1.2f) return null
        if (!YenGlyph.isYen(g.ink, g.width, g.height)) return null

        // 紧随的数字字形（可被区域右缘截断，只用其底部）须与 ¥ 同基线。
        val nextStart = (end until w).firstOrNull { colHasInk(it) } ?: return null
        val nextEnd = (nextStart until w).firstOrNull { !colHasInk(it) } ?: w
        val digit = glyphAt(ink, w, h, nextStart, nextEnd) ?: return null
        if (abs(digit.bottom - g.bottom) > lh * 0.15f) return null

        return RectF(
            (left + start).toFloat(), (top + g.top).toFloat(),
            (left + end).toFloat(), (top + g.bottom + 1).toFloat(),
        )
    }

    private fun unionOf(boxes: List<RectF?>): RectF? {
        if (boxes.isEmpty() || boxes.any { it == null }) return null
        return RectF(boxes[0]).apply { boxes.drop(1).forEach { union(it!!) } }
    }

    private class Glyph(val top: Int, val bottom: Int, val width: Int, val height: Int, val ink: BooleanArray)

    /** 区域笔画矩阵；四角背景不一致（复杂背景）时返回 null。 */
    private fun inkRegion(bitmap: Bitmap, left: Int, top: Int, w: Int, h: Int): BooleanArray? {
        val px = IntArray(w * h)
        bitmap.getPixels(px, 0, w, left, top, w, h)
        val corners = intArrayOf(px[0], px[w - 1], px[(h - 1) * w], px[h * w - 1])
        for (a in corners) for (b in corners) if (colorDistance(a, b) > BG_TOLERANCE) return null
        val bg = corners[0]
        return BooleanArray(w * h) { colorDistance(px[it], bg) > INK_THRESHOLD }
    }

    /** 取列 [start, end) 内笔画的行外框，组成字形矩阵。 */
    private fun glyphAt(ink: BooleanArray, w: Int, h: Int, start: Int, end: Int): Glyph? {
        val rows = (0 until h).filter { y -> (start until end).any { ink[y * w + it] } }
        if (rows.isEmpty()) return null
        val gw = end - start
        val gh = rows.last() - rows.first() + 1
        val m = BooleanArray(gw * gh) { i -> ink[(rows.first() + i / gw) * w + start + i % gw] }
        return Glyph(rows.first(), rows.last(), gw, gh, m)
    }

    private fun plausibleYen(g: Glyph, lineHeight: Float): Boolean =
        g.height >= lineHeight * 0.6f && g.height <= lineHeight * 1.4f &&
            g.width >= g.height * 0.4f && g.width <= g.height * 1.2f &&
            YenGlyph.isYen(g.ink, g.width, g.height)

    private fun firstGlyphIsYen(bitmap: Bitmap, box: RectF): Boolean {
        val left = max(0, box.left.toInt() - 2)
        val top = max(0, box.top.toInt() - 2)
        val w = min(bitmap.width, box.right.toInt() + 2) - left
        val h = min(bitmap.height, box.bottom.toInt() + 2) - top
        if (w < 8 || h < 8) return false
        val ink = inkRegion(bitmap, left, top, w, h) ?: return false

        // 从左找第一个有笔画的列，到下一整列空白为止即首字形。
        fun colHasInk(x: Int) = (0 until h).any { ink[it * w + x] }
        val start = (0 until w).firstOrNull { colHasInk(it) } ?: return false
        val end = (start until w).firstOrNull { !colHasInk(it) } ?: return false
        val g = glyphAt(ink, w, h, start, end) ?: return false
        return plausibleYen(g, box.height())
    }

    /**
     * 纯数字行左侧找 ¥。从数字框向左按空白列切字形：最靠近数字、贴着框边的一个非 ¥ 字形视为
     * OCR 框漏掉的数字笔画；其余非 ¥ 笔画或触到搜索边界都拒绝。返回 ¥ 的屏幕框。
     */
    private fun leftYenBox(bitmap: Bitmap, line: Line, lines: List<Line>): RectF? {
        val box = line.box
        val lh = box.height()
        val left = max(0, (box.left - lh * 1.6f).toInt())
        val right = box.left.toInt()
        val top = max(0, (box.top - lh * 0.15f).toInt())
        val bottom = min(bitmap.height, (box.bottom + lh * 0.15f).toInt())
        val w = right - left
        val h = bottom - top
        if (w < 8 || h < 8) return null
        val region = RectF(left.toFloat(), top.toFloat(), right.toFloat(), bottom.toFloat())
        if (lines.any { it !== line && RectF.intersects(region, it.box) }) return null
        val ink = inkRegion(bitmap, left, top, w, h) ?: return null

        fun colHasInk(x: Int) = (0 until h).any { ink[it * w + x] }
        var x = w - 1
        var fragmentSeen = false
        while (x >= 0) {
            if (!colHasInk(x)) {
                x--
                continue
            }
            val end = x + 1
            while (x >= 0 && colHasInk(x)) x--
            val start = x + 1
            if (start == 0) return null
            val g = glyphAt(ink, w, h, start, end) ?: return null
            val baseline = top + g.bottom
            if (plausibleYen(g, lh) && abs(baseline - box.bottom) <= lh * 0.25f) {
                return RectF(
                    (left + start).toFloat(), (top + g.top).toFloat(),
                    (left + end).toFloat(), (baseline + 1).toFloat(),
                )
            }
            if (end != w || fragmentSeen) return null
            fragmentSeen = true
        }
        return null
    }

    private fun colorDistance(a: Int, b: Int): Int =
        abs((a shr 16 and 0xFF) - (b shr 16 and 0xFF)) +
            abs((a shr 8 and 0xFF) - (b shr 8 and 0xFF)) +
            abs((a and 0xFF) - (b and 0xFF))

    fun close() {
        closed = true
        recognizer.close()
    }

    private fun place(lines: List<Line>, multiplierMilli: Int, w: Int, h: Int): List<PriceTag> {
        val prices = lines.mapNotNull { line ->
            val p = PriceRules.parse(normalize(line.text)) as? PriceRules.Parse.Price ?: return@mapNotNull null
            line to p.cents
        }.filter { (line, _) -> lines.none { it !== line && sameRowNear(line.box, it.box) && hasContextWord(it.text) } }

        // 邻近有另一个价格时无法确定主价，两者都不标。
        val unambiguous = prices.filter { (line, _) ->
            prices.none { (other, _) -> other !== line && near(line.box, other.box) }
        }

        val screen = RectF(0f, 0f, w.toFloat(), h.toFloat())
        val placed = ArrayList<PriceTag>()
        // 依次尝试：正常（间距 4dp、高 24dp）→ 紧凑高（间距 4dp）→ 紧凑高（间距 2dp）。
        // 紧凑高为字体实际高度 + 上下各 2dp，不低于 20dp。同行文字（如销量）框底常略低于价格框底，
        // 2dp 间距可能碰到它，所以先保留 4dp。字号不变，所有布局碰撞检查相同。
        val fm = paint.fontMetrics
        val compactHeight = max(dp(20f), fm.descent - fm.ascent + dp(2f) * 2)
        val layouts = listOf(gap to labelHeight, gap to compactHeight, dp(2f) to compactHeight)
        for ((line, cents) in unambiguous) {
            val label = PriceRules.label(cents, multiplierMilli) ?: continue
            val width = paint.measureText(label) + padX * 2
            val left = max(0f, min(line.box.left, w - width))
            val bounds = layouts.asSequence()
                .map { (g, height) -> RectF(left, line.box.bottom + g, left + width, line.box.bottom + g + height) }
                .firstOrNull { b ->
                    screen.contains(b) &&
                        !RectF.intersects(b, line.box) &&
                        lines.none { RectF.intersects(b, it.box) } &&
                        placed.none { RectF.intersects(b, it.bounds) }
                } ?: continue
            placed += PriceTag(RectF(line.box), bounds, label)
        }
        return placed
    }

    /** OCR 可能输出半角/全角符号与空格，统一后交给 PriceRules。 */
    private fun normalize(s: String): String =
        s.replace('￥', '¥').replace('¥', '¥').replace('，', ',').replace('．', '.').trim()

    private fun hasContextWord(s: String) = CONTEXT_WORDS.any { s.contains(it) }

    /** 同一行且水平间距不超过两倍行高。 */
    private fun sameRowNear(a: RectF, b: RectF): Boolean {
        val overlapY = min(a.bottom, b.bottom) - max(a.top, b.top)
        if (overlapY < min(a.height(), b.height()) * 0.5f) return false
        val gapX = max(b.left - a.right, a.left - b.right)
        return gapX <= a.height() * 2
    }

    /** 同行近邻，或上下两行内且水平有重叠。 */
    private fun near(a: RectF, b: RectF): Boolean {
        if (sameRowNear(a, b)) return true
        val overlapX = min(a.right, b.right) - max(a.left, b.left)
        val gapY = max(b.top - a.bottom, a.top - b.bottom)
        return overlapX > 0 && gapY <= a.height() * 2
    }

    private companion object {
        const val BG_TOLERANCE = 30
        const val INK_THRESHOLD = 150
        // 价格 + 严格已知销量后缀（Store sales:数字[K/M/W/万][+]），前缀只能是 ¥/￥/Y/y。
        val SALES_LINE = Regex(
            """^([¥￥Yy])\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)\s+((?i:store\s*sales)\s*[:：]\s*\d+(?:\.\d+)?\s*[KkMmWw万]?\+?)$""",
        )
        val BARE =Regex("""^((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)$""")
        val SUSPECT = Regex("""^[Yy]\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)$""")

        val CONTEXT_WORDS = listOf(
            "月供", "/月", "每月", "期", "分期", "券", "优惠", "立减", "减", "原价", "划线",
            "会员", "PLUS", "plus", "到手", "起", "满", "运费", "总计", "合计", "月销", "已售",
        )
    }
}
