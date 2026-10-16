package dev.futureprice.directprobe

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.view.View

/** 诊断框：价格节点细边框 + 编号 + 10年近似值。不是产品贴标，不做避让。 */
class ProbeOverlay(context: Context) : View(context) {

    class Box(val index: Int, val rect: Rect, val futureYuan: Long)

    private var boxes: List<Box> = emptyList()
    private val density = context.resources.displayMetrics.density
    private val stroke = Paint().apply {
        style = Paint.Style.STROKE
        strokeWidth = 2 * density
        color = Color.rgb(0, 160, 60)
    }
    private val labelBg = Paint().apply { color = Color.argb(200, 0, 120, 40) }
    private val labelText = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = 11 * density
    }
    private val loc = IntArray(2)

    fun show(list: List<Box>) {
        boxes = list
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        if (boxes.isEmpty()) return
        getLocationOnScreen(loc)
        val ox = loc[0].toFloat()
        val oy = loc[1].toFloat()
        val header = "实验候选 ${boxes.size} 个 · 非产品贴标"
        drawLabel(canvas, header, 8 * density, 8 * density)
        for (b in boxes) {
            val l = b.rect.left - ox
            val t = b.rect.top - oy
            canvas.drawRect(l, t, b.rect.right - ox, b.rect.bottom - oy, stroke)
            val text = "#${b.index} 10年≈${b.futureYuan}"
            val th = labelText.textSize + 4 * density
            drawLabel(canvas, text, l, if (t - th >= 0) t - th else b.rect.bottom - oy)
        }
    }

    private fun drawLabel(canvas: Canvas, text: String, x: Float, y: Float) {
        val pad = 2 * density
        val w = labelText.measureText(text) + pad * 2
        val h = labelText.textSize + pad * 2
        canvas.drawRect(x, y, x + w, y + h, labelBg)
        canvas.drawText(text, x + pad, y + pad - labelText.ascent(), labelText)
    }
}
