package dev.futureprice.fixture

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** 纯生成画面的合成商品页，只供屏幕识别测试，不向任何应用提供数据。 */
class MainActivity : Activity() {

    private data class Item(val title: String, val price: String)

    private val products = listOf(
        Item("合成商品 A 保温杯", "¥100"),
        Item("合成商品 B 帆布包", "¥80"),
        Item("合成商品 C 耳机", "¥199"),
        Item("合成商品 D 毛巾", "¥49.90"),
        Item("合成商品 E 台灯", "¥128"),
        Item("合成商品 F 雨伞", "¥39.90"),
        Item("合成商品 G 收纳盒", "¥25"),
        Item("合成商品 H 键盘", "¥259"),
        Item("合成商品 I 拖鞋", "¥19.90"),
        Item("合成商品 J 水杯", "¥66"),
    )

    private val ambiguous = listOf(
        Item("歧义样本 月供", "月供¥33"),
        Item("歧义样本 券后", "券后¥79"),
        Item("歧义样本 区间", "¥59-¥99"),
        Item("对照 正常价格", "¥100"),
        Item("歧义样本 型号", "Y100"),
    )

    private var viewCount = 0
    private lateinit var counter: TextView
    private lateinit var content: LinearLayout
    private var firstPrice: TextView? = null

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(12), dp(16), dp(8))
            addView(TextView(context).apply {
                text = "测试商店·合成商品"
                textSize = 22f
                setTextColor(Color.BLACK)
            })
            counter = TextView(context).apply { textSize = 14f; setTextColor(Color.DKGRAY) }
            addView(counter)
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                val lp = { LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f) }
                addView(headerButton("无价格页面") { showNoPrice() }, lp())
                addView(headerButton("歧义样本") { showCards(ambiguous) }, lp())
                addView(headerButton("恢复商品") { showCards(products) }, lp())
                // 只改商品 A 的价格文字，不重建页面、不滚动，用于验证小范围变化。
                addView(headerButton("改首价") { firstPrice?.text = "¥101" }, lp())
            })
        }

        content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(8), 0, dp(8), dp(16))
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
            addView(header)
            addView(ScrollView(context).apply { addView(content) },
                LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
            // API 35 默认边到边，按系统栏留边距。
            setOnApplyWindowInsetsListener { v, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                insets
            }
        }
        setContentView(root)
        updateCounter()
        showCards(products)
    }

    private fun button(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        setOnClickListener { onClick() }
    }

    /** 顶部横排紧凑按钮，四个并排不额外占行。 */
    private fun headerButton(label: String, onClick: () -> Unit) = button(label, onClick).apply {
        textSize = 12f
        minWidth = 0
        minimumWidth = 0
        setPadding(dp(2), paddingTop, dp(2), paddingBottom)
    }

    private fun updateCounter() {
        counter.text = "查看点击次数：$viewCount"
    }

    private fun showCards(items: List<Item>) {
        content.removeAllViews()
        firstPrice = null
        items.chunked(2).forEach { pair ->
            val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
            pair.forEach { row.addView(card(it), LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)) }
            if (pair.size == 1) row.addView(View(this), LinearLayout.LayoutParams(0, 0, 1f))
            content.addView(row)
        }
    }

    private fun card(item: Item) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(12), dp(12), dp(12), dp(12))
        setBackgroundColor(Color.WHITE)
        // 色块代替商品图。
        addView(View(context).apply { setBackgroundColor(Color.rgb(230, 236, 245)) },
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(96)))
        addView(TextView(context).apply {
            text = item.title
            textSize = 15f
            setTextColor(Color.BLACK)
            setPadding(0, dp(8), 0, dp(4))
        })
        addView(TextView(context).apply {
            text = item.price
            textSize = 20f
            setTextColor(Color.rgb(220, 50, 30))
            if (item === products[0]) firstPrice = this
        })
        // 价格下方留给提醒标签的空白。
        addView(View(context), LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(36)))
        addView(button("查看") {
            viewCount++
            updateCounter()
        })
    }

    private fun showNoPrice() {
        content.removeAllViews()
        firstPrice = null
        listOf(
            "这里是没有商品价格的普通页面。",
            "用于检查提醒标签在无价格画面中不会出现。",
            "店铺公告：本店全部商品均为合成样本，仅供测试。",
            "客服时间：每天上午九点至晚上九点。",
        ).forEach {
            content.addView(TextView(this).apply {
                text = it
                textSize = 16f
                setTextColor(Color.BLACK)
                setPadding(dp(8), dp(12), dp(8), dp(12))
            })
        }
    }
}
