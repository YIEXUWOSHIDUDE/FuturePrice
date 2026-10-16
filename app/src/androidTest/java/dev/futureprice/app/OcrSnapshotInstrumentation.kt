package dev.futureprice.app

import android.app.Activity
import android.app.Instrumentation
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Bundle
import android.os.SystemClock
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 仅测试 APK 的验证通道：对 androidTest 资产中的合成截图运行原始中文 OCR，并可选运行产品 OcrEngine。
 *
 * adb shell am instrument -w -e asset scroll-middle.png [-e mode raw|both] [-e multiplier 1500] \
 *   dev.futureprice.app.test/dev.futureprice.app.OcrSnapshotInstrumentation
 */
class OcrSnapshotInstrumentation : Instrumentation() {

    private var args: Bundle = Bundle()

    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        args = arguments ?: Bundle()
        start()
    }

    override fun onStart() {
        super.onStart()
        val out = Bundle()
        val asset = args.getString("asset")
        val mode = args.getString("mode") ?: "both"
        if (mode == "nodes") {
            val result = try {
                NodeProbe(this).run(args)
            } catch (e: Exception) {
                Bundle().apply { putString("error", e.javaClass.simpleName) }
            }
            return finish(if (result.containsKey("error")) Activity.RESULT_CANCELED else Activity.RESULT_OK, result)
        }
        if (mode == "sales_fixture") {
            val result = try {
                SalesFixture(
                    engine = { runEngine(it, PriceRules.DEFAULT_MULTIPLIER_MILLI).tags },
                    raw = { rawOcr(it) },
                    tight = args.getString("tight") == "true",
                ).run()
            } catch (e: Exception) {
                Bundle().apply {
                    putBoolean("passed", false)
                    putString("error", e.javaClass.simpleName)
                }
            }
            val ok = result.getBoolean("passed", false)
            return finish(if (ok) Activity.RESULT_OK else Activity.RESULT_CANCELED, result)
        }
        if (mode == "live") {
            val result = try {
                live()
            } catch (e: Exception) {
                Bundle().apply {
                    putBoolean("passed", false)
                    putString("error", e.javaClass.simpleName)
                }
            }
            val ok = result.getBoolean("passed", false)
            return finish(if (ok) Activity.RESULT_OK else Activity.RESULT_CANCELED, result)
        }
        val multiplier = args.getString("multiplier")?.toIntOrNull() ?: PriceRules.DEFAULT_MULTIPLIER_MILLI
        if (asset == null) {
            out.putString("error", "missing -e asset <file.png>")
            return finish(Activity.RESULT_CANCELED, out)
        }

        // context 为测试 APK 自身，只能读到 androidTest 资产。
        val bitmap = try {
            context.assets.open(asset).use {
                BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply {
                    inPreferredConfig = Bitmap.Config.ARGB_8888
                })
            }
        } catch (e: Exception) {
            null
        }
        if (bitmap == null) {
            out.putString("error", "cannot decode asset $asset")
            return finish(Activity.RESULT_CANCELED, out)
        }
        out.putString("image", "${bitmap.width}x${bitmap.height}")

        try {
            out.putString("raw", rawOcr(bitmap))
            if (mode == "both") out.putString("labels", engineLabels(bitmap, multiplier))
            finish(Activity.RESULT_OK, out)
        } catch (e: Exception) {
            out.putString("error", e.toString())
            finish(Activity.RESULT_CANCELED, out)
        } finally {
            bitmap.recycle()
        }
    }

    private fun rawOcr(bitmap: Bitmap): String {
        val recognizer = TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
        try {
            val text = Tasks.await(recognizer.process(InputImage.fromBitmap(bitmap, 0)), 20, TimeUnit.SECONDS)
            return buildString {
                appendLine()
                var i = 0
                for (block in text.textBlocks) for (line in block.lines) {
                    val b = line.boundingBox
                    appendLine("#${i++} ${b?.let { "[${it.left},${it.top},${it.right},${it.bottom}]" } ?: "[]"} " +
                        "text=\"${line.text.replace("\n", "\\n")}\"")
                }
            }
        } finally {
            recognizer.close()
        }
    }

    private fun engineLabels(bitmap: Bitmap, multiplier: Int): String {
        val r = runEngine(bitmap, multiplier)
        val tags = r.tags ?: return "\n${r.failure}"
        return buildString {
            appendLine()
            appendLine("tags=${tags.size}")
            tags.forEach { t ->
                appendLine("\"${t.text}\" source=${t.source.toShortString()} bounds=${t.bounds.toShortString()}")
            }
        }
    }

    private class EngineRun(val tags: List<PriceTag>?, val failure: String?)

    /** 在主线程运行产品 OcrEngine，最多等 20s；返回前保证 engine 已关闭且回调已结束或超时。 */
    private fun runEngine(bitmap: Bitmap, multiplier: Int): EngineRun {
        val latch = CountDownLatch(1)
        var tags: List<PriceTag>? = null
        var failure: String? = null
        var engine: OcrEngine? = null
        runOnMainSync {
            val e = OcrEngine(targetContext)
            engine = e
            e.recognize(bitmap, multiplier,
                onResult = {
                    tags = it
                    latch.countDown()
                },
                onError = {
                    failure = "engine error"
                    latch.countDown()
                },
            )
        }
        val completed = latch.await(20, TimeUnit.SECONDS)
        runOnMainSync { engine?.close() }
        // close 后 OcrEngine 仍保证回调一次，等待它结束再让调用方回收 bitmap。
        if (!completed) latch.await(5, TimeUnit.SECONDS)
        return if (completed) EngineRun(tags, failure ?: if (tags == null) "no result" else null)
        else EngineRun(null, "timeout")
    }

    /**
     * 真实前台页面验证：仅淘宝/拼多多。截图只在内存，跑产品 OcrEngine 与原始中文 OCR，
     * 只输出计数，不输出文本、价格或截图。
     */
    private fun live(): Bundle {
        val out = Bundle()
        val t0 = SystemClock.elapsedRealtime()
        val minTags = (args.getString("min_tags")?.toIntOrNull() ?: 1).coerceIn(0, 20)
        val multiplier = args.getString("multiplier")?.toIntOrNull() ?: PriceRules.DEFAULT_MULTIPLIER_MILLI
        out.putBoolean("passed", false)
        out.putInt("min_tags", minTags)

        val ui = uiAutomation
        try {
            ui.waitForIdle(300, 5000)
        } catch (e: Exception) {
            // 页面持续有动画时可能等不到空闲，忽略后继续有限重试。
        }
        // 最多 3 秒，每 300ms 重取 root，直到根包为允许的包。
        var pkg: String? = null
        var attempts = 0
        var sawRoot = false
        val rootDeadline = SystemClock.elapsedRealtime() + 3000
        while (true) {
            attempts++
            val root = ui.rootInActiveWindow
            if (root != null) sawRoot = true
            pkg = root?.packageName?.toString()
            if (pkg in LIVE_PACKAGES || SystemClock.elapsedRealtime() >= rootDeadline) break
            SystemClock.sleep(300)
        }
        out.putInt("root_attempts", attempts)
        out.putBoolean("root_missing", !sawRoot)
        out.putString("package", if (pkg in LIVE_PACKAGES) pkg else "other")
        if (pkg !in LIVE_PACKAGES) {
            out.putString("error", "foreground not taobao/pinduoduo")
            return out
        }

        val shot = ui.takeScreenshot() ?: run {
            out.putString("error", "screenshot null")
            return out
        }
        // takeScreenshot 可能返回硬件位图，复制为可读像素的软件位图。
        val bitmap = try {
            shot.copy(Bitmap.Config.ARGB_8888, false)
        } finally {
            shot.recycle()
        }
        if (bitmap == null) {
            out.putString("error", "screenshot copy failed")
            return out
        }
        try {
            out.putString("image", "${bitmap.width}x${bitmap.height}")
            val c = rawCounts(bitmap)
            out.putInt("raw_line_count", c.lines)
            out.putInt("raw_currency_line_count", c.currency)
            out.putInt("raw_currency_parse_ok_count", c.currencyParsed)
            out.putInt("raw_prefix_store_sales_count", c.prefixStoreSales)
            out.putInt("raw_prefix_whitespace_count", c.prefixWhitespace)
            val r = runEngine(bitmap, multiplier)
            val count = r.tags?.size ?: -1
            out.putInt("engine_tag_count", count)
            r.failure?.let { out.putString("error", it) }
            out.putBoolean("passed", r.tags != null && count >= minTags)
        } finally {
            bitmap.recycle()
            out.putLong("elapsed_ms", SystemClock.elapsedRealtime() - t0)
        }
        return out
    }

    private class RawCounts(
        val lines: Int,
        val currency: Int,
        val currencyParsed: Int,
        val prefixStoreSales: Int,
        val prefixWhitespace: Int,
    )

    /** 原始中文 OCR 的脱敏分类计数，仅在内存统计，不保留文本。 */
    private fun rawCounts(bitmap: Bitmap): RawCounts {
        val recognizer = TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
        try {
            val text = Tasks.await(recognizer.process(InputImage.fromBitmap(bitmap, 0)), 20, TimeUnit.SECONDS)
            val lines = text.textBlocks.flatMap { it.lines }.map { it.text.trim() }
            val currency = lines.filter { t -> t.any { it == '¥' || it == '￥' || it == '元' } }
            // 以币种符号或 Y/y 开头的行。
            val prefixed = lines.filter { it.firstOrNull() in PREFIX_CHARS }
            return RawCounts(
                lines = lines.size,
                currency = currency.size,
                currencyParsed = currency.count { PriceRules.parse(it) is PriceRules.Parse.Price },
                prefixStoreSales = prefixed.count {
                    it.contains("store", ignoreCase = true) || it.contains("sales", ignoreCase = true)
                },
                prefixWhitespace = prefixed.count { t -> t.any { it.isWhitespace() } },
            )
        } finally {
            recognizer.close()
        }
    }

    private companion object {
        val LIVE_PACKAGES = setOf("com.taobao.taobao", "com.xunmeng.pinduoduo")
        val PREFIX_CHARS = setOf('¥', '￥', 'Y', 'y')
    }
}
