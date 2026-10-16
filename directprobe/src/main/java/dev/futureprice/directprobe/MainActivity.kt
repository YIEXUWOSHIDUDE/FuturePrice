package dev.futureprice.directprobe

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.view.WindowInsets
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * 调试试验入口。也可用 adb 带 command 启动：start|stop|reset|summary，转发给服务后立即结束。
 */
class MainActivity : Activity() {

    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (forwardCommand(intent)) return finish()

        val pad = (16 * resources.displayMetrics.density).toInt()
        status = TextView(this).apply { textSize = 16f }
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            addView(TextView(context).apply {
                text = "FP直读试验（调试）"
                textSize = 22f
            })
            addView(TextView(context).apply {
                text = "读取淘宝、拼多多、测试商店当前窗口的价格文字节点，画出编号诊断框。" +
                    "显示的只是实验候选，不代表商品主价归属或支持；不截图、不联网、不保存内容。" +
                    "停止试验不会关闭你其它的无障碍服务；要完全关闭本服务请在无障碍设置中关闭。"
                setPadding(0, pad / 2, 0, pad / 2)
            })
            addView(status)
            addView(button("打开无障碍设置") { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) })
            addView(button("开始（5 分钟后自动停止）") { send("start") })
            addView(button("停止") { send("stop") })
            addView(button("重置统计") { send("reset") })
            addView(button("输出统计到 Logcat（FPDirect）") { send("summary") })
        }
        setContentView(ScrollView(this).apply {
            addView(column)
            setOnApplyWindowInsetsListener { v, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                insets
            }
        })
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        forwardCommand(intent)
    }

    override fun onResume() {
        super.onResume()
        render()
    }

    private fun render() {
        if (!::status.isInitialized) return
        status.text = when {
            !DirectProbeService.connected -> "状态：服务未启用（请在无障碍设置中开启「FP直读试验」）"
            DirectProbeService.active -> "状态：试验进行中"
            else -> "状态：服务已启用，试验未开始"
        }
    }

    private fun forwardCommand(i: Intent?): Boolean {
        val cmd = i?.getStringExtra(DirectProbeService.EXTRA_COMMAND) ?: return false
        send(cmd)
        return true
    }

    private fun send(cmd: String) {
        sendBroadcast(
            Intent(DirectProbeService.ACTION_COMMAND)
                .setPackage(packageName)
                .putExtra(DirectProbeService.EXTRA_COMMAND, cmd),
        )
        if (::status.isInitialized) status.postDelayed({ render() }, 300)
    }

    private fun button(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        setOnClickListener { onClick() }
    }
}
