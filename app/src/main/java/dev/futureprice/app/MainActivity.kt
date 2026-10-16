package dev.futureprice.app

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.view.WindowInsets
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

class MainActivity : Activity() {

    private companion object {
        const val REQ_NOTIFICATION = 1
        const val REQ_CAPTURE = 2
        const val REFRESH_MS = 500L
        const val FIXTURE_PACKAGE = "dev.futureprice.fixture"
    }

    private val handler = Handler(Looper.getMainLooper())
    private lateinit var status: TextView
    private lateinit var scenario: TextView
    private lateinit var hint: TextView
    private lateinit var overlayButton: Button
    private lateinit var usageButton: Button
    private lateinit var toggle: Button

    private val refresh = object : Runnable {
        override fun run() {
            render()
            handler.postDelayed(this, REFRESH_MS)
        }
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private val prefs get() = getSharedPreferences("settings", MODE_PRIVATE)
    private fun multiplierMilli() = prefs.getInt("multiplier_milli", PriceRules.DEFAULT_MULTIPLIER_MILLI)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = dp(24)

        val title = TextView(this).apply {
            text = "FuturePrice"
            textSize = 28f
        }
        val intro = TextView(this).apply {
            text = "在购物 App 的价格下方显示「10年≈金额」：这笔钱若留下来，10 年后按倍数估算约值多少。" +
                "这是按今天购买力理解的假设情景，不是折扣、今天省下的金额或收益承诺。"
            setPadding(0, dp(8), 0, dp(8))
        }
        status = TextView(this).apply {
            textSize = 16f
            setPadding(0, dp(8), 0, dp(8))
        }
        scenario = TextView(this)
        val multiplierInput = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL
            setText(PriceRules.formatMultiplier(multiplierMilli()))
        }
        hint = TextView(this).apply { setPadding(0, dp(4), 0, dp(4)) }
        val save = Button(this).apply {
            text = "保存倍数"
            setOnClickListener {
                val milli = PriceRules.parseMultiplier(multiplierInput.text.toString())
                if (milli == null) {
                    this@MainActivity.hint.text = "请输入 1 到 10 之间、最多三位小数的倍数"
                    return@setOnClickListener
                }
                prefs.edit().putInt("multiplier_milli", milli).apply()
                multiplierInput.setText(PriceRules.formatMultiplier(milli))
                this@MainActivity.hint.text = if (CaptureService.running) {
                    stopCapture()
                    "倍数已保存，提醒已停止，请重新开启以使用新倍数"
                } else {
                    "倍数已保存"
                }
                render()
            }
        }
        overlayButton = Button(this).apply {
            setOnClickListener {
                startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
            }
        }
        usageButton = Button(this).apply {
            setOnClickListener {
                try {
                    startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS, Uri.parse("package:$packageName")))
                } catch (e: ActivityNotFoundException) {
                    startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))
                }
            }
        }
        toggle = Button(this).apply {
            setOnClickListener { if (CaptureService.running) stopCapture() else startFlow() }
        }

        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            addView(title)
            addView(intro)
            addView(status)
            addView(toggle)
            addView(overlayButton)
            addView(usageButton)
            addView(TextView(context).apply {
                text = "10年倍数（默认 1.5，范围 1–10）"
                setPadding(0, dp(16), 0, 0)
            })
            addView(scenario)
            addView(multiplierInput)
            addView(save)
            addView(hint)
            if (BuildConfig.DEBUG) {
                addView(Button(context).apply {
                    text = "打开测试商店"
                    setOnClickListener {
                        val launch = packageManager.getLaunchIntentForPackage(FIXTURE_PACKAGE)
                        if (launch == null) this@MainActivity.hint.text = "未安装测试商店" else startActivity(launch)
                    }
                })
            }
        }
        setContentView(ScrollView(this).apply {
            addView(column)
            setOnApplyWindowInsetsListener { v, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                insets
            }
        })
    }

    override fun onResume() {
        super.onResume()
        handler.post(refresh)
    }

    override fun onPause() {
        handler.removeCallbacks(refresh)
        super.onPause()
    }

    private fun hasOverlay() = Settings.canDrawOverlays(this)
    private fun hasUsage() = ForegroundGate(this, emptySet()).hasPermission()

    private fun render() {
        val running = CaptureService.running
        status.text = "状态：${CaptureService.status}"
        toggle.text = if (running) "停止省钱提醒" else "开启省钱提醒"
        overlayButton.text = if (hasOverlay()) "悬浮窗权限：已授权" else "授予悬浮窗权限"
        usageButton.text = if (hasUsage()) "使用情况访问：已授权" else "授予使用情况访问权限"
        val milli = multiplierMilli()
        scenario.text = if (milli == PriceRules.DEFAULT_MULTIPLIER_MILLI) {
            "默认10年情景：近似年化实际回报 4% 持续 10 年（1.04^10≈1.48），仅为假设"
        } else {
            "自定10年情景：倍数 ${PriceRules.formatMultiplier(milli)}，仅为假设"
        }
    }

    private fun startFlow() {
        if (!hasOverlay()) {
            hint.text = "请先授予悬浮窗权限"
            return
        }
        if (!hasUsage()) {
            hint.text = "请先授予使用情况访问权限"
            return
        }
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            // 无论是否允许通知都继续；停止入口在首页也可用。
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFICATION)
            return
        }
        requestCapture()
    }

    private fun requestCapture() {
        val mpm = getSystemService(MediaProjectionManager::class.java)
        val intent = mpm.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
        startActivityForResult(intent, REQ_CAPTURE)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_NOTIFICATION) requestCapture()
    }

    @Deprecated("Activity result API")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_CAPTURE) return
        if (resultCode != RESULT_OK || data == null) {
            hint.text = "已取消屏幕共享，提醒未开启"
            render()
            return
        }
        startForegroundService(
            Intent(this, CaptureService::class.java)
                .putExtra(CaptureService.EXTRA_RESULT_CODE, resultCode)
                .putExtra(CaptureService.EXTRA_DATA, data),
        )
        hint.text = "正在开启…"
    }

    private fun stopCapture() {
        startService(Intent(this, CaptureService::class.java).setAction(CaptureService.ACTION_STOP))
    }
}
