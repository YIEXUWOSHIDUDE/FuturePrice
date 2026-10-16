package dev.futureprice.directprobe

/**
 * 复制自产品 PriceRules 的严格整段价格语义：节点文字必须恰为「¥/￥金额」或「金额元」。
 * 只解析数值，不判断主价归属。
 */
object DirectPrice {
    private const val MAX_CENTS = 1_000_000_000L
    private const val NUMBER = """(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?"""
    private val prefixed = Regex("""^[¥￥]\s*$NUMBER$""")
    private val suffixed = Regex("""^$NUMBER\s*元$""")

    fun cents(text: String): Long? {
        val t = text.trim()
        val m = prefixed.find(t) ?: suffixed.find(t) ?: return null
        val yuan = m.groupValues[1].replace(",", "").toLongOrNull() ?: return null
        if (yuan > MAX_CENTS / 100) return null
        val cents = yuan * 100 + m.groupValues[2].padEnd(2, '0').toLong()
        return cents.takeIf { it in 1..MAX_CENTS }
    }

    /** 固定 1.5 倍，四舍五入到整元。 */
    fun futureYuan(cents: Long): Long = (cents * 1500 + 50_000) / 100_000
}
