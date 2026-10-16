package dev.futureprice.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class YenGlyphTest {

    private class Canvas(val w: Int, val h: Int) {
        val px = BooleanArray(w * h)
        fun fill(x0: Int, y0: Int, x1: Int, y1: Int) {
            for (y in maxOf(0, y0) until minOf(h, y1)) for (x in maxOf(0, x0) until minOf(w, x1)) px[y * w + x] = true
        }
    }

    /** 两条斜分叉在 forkEnd 汇合，再接竖干；bars 为横线中心比例。 */
    private fun glyph(w: Int, h: Int, bars: List<Float>, fork: Boolean = true, topBar: Boolean = false): Canvas {
        val c = Canvas(w, h)
        val t = maxOf(2, w / 8)
        val cx = w / 2
        val forkEnd = (h * 0.42f).toInt()
        if (fork) {
            for (y in 0 until forkEnd) {
                val f = y.toFloat() / forkEnd
                val xl = (f * (cx - t / 2)).toInt()
                val xr = (w - t - f * (w - t - (cx - t / 2))).toInt()
                c.fill(xl, y, xl + t, y + 1)
                c.fill(xr, y, xr + t, y + 1)
            }
        }
        if (topBar) c.fill(0, 0, w, t)
        c.fill(cx - t / 2, if (fork) forkEnd else 0, cx - t / 2 + t, h)
        val bt = maxOf(2, h / 12)
        val bw = (w * 0.85f).toInt()
        for (b in bars) {
            val y = (h * b).toInt() - bt / 2
            c.fill((w - bw) / 2, y, (w - bw) / 2 + bw, y + bt)
        }
        return c
    }

    private fun yen(c: Canvas) = YenGlyph.isYen(c.px, c.w, c.h)

    @Test fun acceptsYenTwoSizes() {
        assertTrue(yen(glyph(26, 38, listOf(0.55f, 0.75f))))
        assertTrue(yen(glyph(52, 76, listOf(0.55f, 0.75f))))
    }

    @Test fun rejectsLetterY() {
        assertFalse(yen(glyph(26, 38, emptyList())))
    }

    @Test fun rejectsT() {
        assertFalse(yen(glyph(26, 38, emptyList(), fork = false, topBar = true)))
    }

    @Test fun rejectsSingleBar() {
        assertFalse(yen(glyph(26, 38, listOf(0.6f))))
    }

    @Test fun rejectsNoiseAndEmpty() {
        val rnd = Random(7)
        repeat(20) {
            val w = 26
            val h = 38
            assertFalse(YenGlyph.isYen(BooleanArray(w * h) { rnd.nextFloat() < 0.4f }, w, h))
        }
        assertFalse(YenGlyph.isYen(BooleanArray(26 * 38), 26, 38))
        assertFalse(YenGlyph.isYen(BooleanArray(3), 26, 38))
    }
}
