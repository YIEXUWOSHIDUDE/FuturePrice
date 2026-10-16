package dev.futureprice.app

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RectF
import android.hardware.input.InputManager
import android.util.TypedValue
import android.view.View
import android.view.WindowManager

/** 坐标均为完整屏幕像素。 */
data class PriceTag(val source: RectF, val bounds: RectF, val text: String)

/** 单个不可触摸悬浮窗，多标签绘制。仅在主线程使用。 */
class OverlayLayer(private val context: Context) {

    private val windowManager = context.getSystemService(WindowManager::class.java)
    private var view: TagView? = null

    fun show(tags: List<PriceTag>) {
        val v = view ?: attach()
        v.tags = tags
        v.invalidate()
    }

    fun clear() {
        view?.let {
            it.tags = emptyList()
            it.drawn = emptyList()
            it.invalidate()
        }
    }

    /** 最近一次实际画出的标签矩形（屏幕坐标），供采集排除自识别区域。 */
    fun maskRects(): List<RectF> = view?.drawn?.map { RectF(it) } ?: emptyList()

    fun close() {
        view?.let {
            it.tags = emptyList()
            it.drawn = emptyList()
            if (it.isAttachedToWindow) windowManager.removeViewImmediate(it)
        }
        view = null
    }

    private fun attach(): TagView {
        val im = context.getSystemService(InputManager::class.java)
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT,
        ).apply {
            // 默认避开系统栏区域；落在窗口外的标签不画。
            alpha = minOf(0.75f, im.maximumObscuringOpacityForTouch)
            title = "FuturePriceOverlay"
        }
        val v = TagView(context)
        windowManager.addView(v, params)
        view = v
        return v
    }

    private class TagView(context: Context) : View(context) {
        var tags: List<PriceTag> = emptyList()
        var drawn: List<RectF> = emptyList()

        private val dm = context.resources.displayMetrics
        private val radius = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 6f, dm)
        private val bg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(170, 230, 180) }
        private val fg = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.rgb(20, 50, 30)
            textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 14f, dm)
            textAlign = Paint.Align.CENTER
        }
        private val loc = IntArray(2)

        override fun onDraw(canvas: Canvas) {
            getLocationOnScreen(loc)
            val ox = loc[0].toFloat()
            val oy = loc[1].toFloat()
            val visible = RectF(ox, oy, ox + width, oy + height)
            val out = ArrayList<RectF>(tags.size)
            for (tag in tags) {
                if (!visible.contains(tag.bounds)) continue
                val r = RectF(tag.bounds).apply { offset(-ox, -oy) }
                canvas.drawRoundRect(r, radius, radius, bg)
                val baseline = r.centerY() - (fg.descent() + fg.ascent()) / 2
                canvas.drawText(tag.text, r.centerX(), baseline, fg)
                out += RectF(tag.bounds)
            }
            drawn = out
        }
    }
}
