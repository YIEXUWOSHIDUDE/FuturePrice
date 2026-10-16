package dev.futureprice.app

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Bundle

/**
 * 合成回归：模拟拼多多列表价格行——红色小号 ¥ + 大号粗体金额，同基线右侧灰色「Store sales:…」。
 * 4 个正例须各得到正确标签；券后、区间和真实字母 Y100 负例不得出标签。全部内存绘制，不读真实页面。
 */
class SalesFixture(
    private val engine: (Bitmap) -> List<PriceTag>?,
    private val raw: (Bitmap) -> String,
    // tight：正例价格下方约 69px 处放一行合成中文，正常高标签会冲突、紧凑高可放。
    private val tight: Boolean = false,
) {

    private class Sample(val title: String, val prefix: String, val amount: String, val sales: String, val expected: String?) {
        var priceRect = RectF()
    }

    private val positives = listOf(
        Sample("合成商品 A", "¥", "100", "Store sales:1.2K", "10年≈150"),
        Sample("合成商品 B", "¥", "80", "Store sales:3M", "10年≈120"),
        Sample("合成商品 C", "¥", "199", "Store sales:860", "10年≈299"),
        Sample("合成商品 D", "¥", "49.90", "Store sales:10K+", "10年≈75"),
    )
    private val negatives = listOf(
        Sample("负例 券后", "券后¥", "79", "Store sales:2K", null),
        Sample("负例 区间", "¥", "59-99", "Store sales:5K", null),
        Sample("负例 型号", "Y", "100", "Store sales:1K", null),
    )

    fun run(): Bundle {
        val out = Bundle()
        val bitmap = Bitmap.createBitmap(WIDTH, HEIGHT, Bitmap.Config.ARGB_8888)
        try {
            draw(bitmap)
            out.putString("raw", raw(bitmap))
            val tags = engine(bitmap)
            if (tags == null) {
                out.putString("error", "engine error or timeout")
                out.putBoolean("passed", false)
                return out
            }
            val report = StringBuilder("\n")
            var ok = true
            for (s in positives) {
                val hit = tags.filter { RectF.intersects(it.source, s.priceRect) }
                val good = hit.size == 1 && hit[0].text == s.expected
                if (!good) ok = false
                report.appendLine("${if (good) "PASS" else "FAIL"} ${s.title} expect=${s.expected} got=${hit.map { it.text }}")
            }
            for (s in negatives) {
                val hit = tags.filter { RectF.intersects(it.source, s.priceRect) }
                if (hit.isNotEmpty()) ok = false
                report.appendLine("${if (hit.isEmpty()) "PASS" else "FAIL"} ${s.title} expect=none got=${hit.map { it.text }}")
            }
            if (tags.size != positives.size) ok = false
            report.appendLine("tags=${tags.size}")
            tags.forEach { report.appendLine("\"${it.text}\" source=${it.source.toShortString()} bounds=${it.bounds.toShortString()}") }
            out.putString("checks", report.toString())
            out.putBoolean("passed", ok)
            return out
        } finally {
            bitmap.recycle()
        }
    }

    private fun draw(bitmap: Bitmap) {
        val c = Canvas(bitmap)
        c.drawColor(Color.WHITE)
        val title = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(30, 30, 30); textSize = 40f }
        val small = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = RED; textSize = 34f }
        val big = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = RED; textSize = 60f; typeface = Typeface.DEFAULT_BOLD
        }
        val sales = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(150, 150, 150); textSize = 32f }
        val desc = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(60, 60, 60); textSize = 36f }

        (positives + negatives).forEachIndexed { i, s ->
            val x = if (i % 2 == 0) 40f else 580f
            val top = 260f + (i / 2) * 480f
            // 商品图占位。
            c.drawRect(x, top, x + 460f, top + 200f, Paint().apply { color = Color.rgb(230, 236, 245) })
            c.drawText(s.title, x, top + 260f, title)
            val baseline = top + 350f
            c.drawText(s.prefix, x, baseline, small)
            val ax = x + small.measureText(s.prefix) + 4f
            c.drawText(s.amount, ax, baseline, big)
            val priceRight = ax + big.measureText(s.amount)
            c.drawText(s.sales, priceRight + 24f, baseline, sales)
            // 价格下方留约 100px 空白供标签。
            s.priceRect = RectF(x, baseline + big.ascent(), priceRight, baseline + big.descent())
            if (tight && s in positives) {
                // 文字笔画顶部位于价格基线下方 TIGHT_GAP 像素（价格笔画底约在基线）。
                val note = "商品描述合成文字"
                val inkBounds = android.graphics.Rect()
                desc.getTextBounds(note, 0, note.length, inkBounds)
                c.drawText(note, x, baseline + TIGHT_GAP - inkBounds.top, desc)
            }
        }
    }

    private companion object {
        const val WIDTH = 1080
        const val HEIGHT = 2400
        const val TIGHT_GAP = 70f
        val RED = Color.rgb(226, 35, 26)
    }
}
