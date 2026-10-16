package dev.futureprice.app

/** 纯 Kotlin 价格规则：不引用 Android 类，可直接单测。金额一律用整数分，倍数用千分位定点数。 */
object PriceRules {
    const val DEFAULT_MULTIPLIER_MILLI = 1500
    const val MIN_MULTIPLIER_MILLI = 1000
    const val MAX_MULTIPLIER_MILLI = 10_000
    const val MAX_PRICE_CENTS = 1_000_000_000L // ¥10,000,000.00

    sealed interface Parse {
        data class Price(val cents: Long) : Parse
        data class Rejected(val reason: String) : Parse
    }

    // 月供、分期、优惠额、条件价、销量、运费、总计、划线价等不能冒充商品主价。
    private val rejectWords = listOf(
        "月供", "/月", "每月", "期", "分期",
        "优惠", "立减", "减", "省", "券", "折", "返",
        "会员", "plus", "PLUS", "满", "起", "到手",
        "月销", "已售", "运费", "总计", "合计", "原价", "划线",
    )
    private val rangeRegex = Regex("""\d\s*[-~～—至到]\s*[¥￥]?\s*\d""")
    private val number = """(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?"""
    private val prefixed = Regex("""^[¥￥]\s*$number$""")
    private val suffixed = Regex("""^$number\s*元$""")

    /** 只接受整段文字恰为一个带人民币标记的明确价格。 */
    fun parse(text: String): Parse {
        val t = text.trim()
        if (t.isEmpty()) return Parse.Rejected("空文本")
        rejectWords.firstOrNull { t.contains(it) }?.let { return Parse.Rejected("含条件或非主价词：$it") }
        if (rangeRegex.containsMatchIn(t)) return Parse.Rejected("价格区间")
        val m = prefixed.find(t) ?: suffixed.find(t) ?: return Parse.Rejected("非明确人民币价格")
        val yuan = m.groupValues[1].replace(",", "").toLongOrNull() ?: return Parse.Rejected("超出范围")
        val frac = m.groupValues[2].padEnd(2, '0').ifEmpty { "00" }.toLong()
        if (yuan > MAX_PRICE_CENTS / 100) return Parse.Rejected("超出范围")
        val cents = yuan * 100 + frac
        if (cents <= 0 || cents > MAX_PRICE_CENTS) return Parse.Rejected("超出范围")
        return Parse.Price(cents)
    }

    /** 同屏多行文字中的候选价格，保持原顺序；商品归属由后续识别逻辑决定。 */
    fun candidates(lines: List<String>): List<Long> =
        lines.mapNotNull { (parse(it) as? Parse.Price)?.cents }

    /** "1.5" -> 1500；最多三位小数，超出 [1, 10] 返回 null。 */
    fun parseMultiplier(text: String): Int? {
        val m = Regex("""^(\d{1,2})(?:\.(\d{1,3}))?$""").find(text.trim()) ?: return null
        val milli = m.groupValues[1].toInt() * 1000 + m.groupValues[2].padEnd(3, '0').ifEmpty { "000" }.toInt()
        return milli.takeIf { it in MIN_MULTIPLIER_MILLI..MAX_MULTIPLIER_MILLI }
    }

    fun formatMultiplier(milli: Int): String =
        "%d.%03d".format(milli / 1000, milli % 1000).trimEnd('0').trimEnd('.')

    /** 未来价值四舍五入到整元；参数越界或溢出返回 null。 */
    fun futureYuan(cents: Long, multiplierMilli: Int): Long? {
        if (cents <= 0 || cents > MAX_PRICE_CENTS) return null
        if (multiplierMilli !in MIN_MULTIPLIER_MILLI..MAX_MULTIPLIER_MILLI) return null
        return try {
            val scaled = Math.multiplyExact(cents, multiplierMilli.toLong()) // 单位：分 × 1/1000
            Math.addExact(scaled, 50_000L) / 100_000L
        } catch (e: ArithmeticException) {
            null
        }
    }

    fun label(cents: Long, multiplierMilli: Int): String? =
        futureYuan(cents, multiplierMilli)?.let { "10年≈$it" }
}
