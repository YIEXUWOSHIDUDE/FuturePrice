package dev.futureprice.app

import dev.futureprice.app.PriceRules.Parse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PriceRulesTest {

    private fun cents(text: String) = (PriceRules.parse(text) as Parse.Price).cents
    private fun assertRejected(text: String) =
        assertTrue("应拒绝：$text", PriceRules.parse(text) is Parse.Rejected)

    @Test fun extractsExplicitRmbPrices() {
        assertEquals(9990L, cents("¥99.90"))
        assertEquals(10000L, cents("￥100"))
        assertEquals(1250L, cents("¥ 12.5"))
        assertEquals(129900L, cents("¥1,299.00"))
        assertEquals(5800L, cents("58元"))
    }

    @Test fun rejectsNonExplicit() {
        assertRejected("")
        assertRejected("99.90")
        assertRejected("$99")
        assertRejected("¥99.999")
        assertRejected("¥0")
    }

    @Test fun rejectsInstallmentDiscountRangeAndConditional() {
        assertRejected("月供¥33.30")
        assertRejected("¥33.30/月")
        assertRejected("¥33.3×12期")
        assertRejected("优惠¥20")
        assertRejected("立减¥20")
        assertRejected("券后¥79")
        assertRejected("会员价¥88")
        assertRejected("满199减20")
        assertRejected("¥59起")
        assertRejected("¥59-¥99")
        assertRejected("¥59~99")
        assertRejected("月销1万+")
        assertRejected("运费¥8")
        assertRejected("合计¥300")
    }

    @Test fun multiplePricesOnScreenBecomeCandidates() {
        val lines = listOf("商品A", "¥99.90", "月销2000+", "商品B", "￥45", "券后¥39", "¥10-¥20")
        assertEquals(listOf(9990L, 4500L), PriceRules.candidates(lines))
    }

    @Test fun fixedPointMultiplication() {
        assertEquals(150L, PriceRules.futureYuan(9990, 1500))
        assertEquals("10年≈150", PriceRules.label(9990, 1500))
        assertEquals("10年≈150", PriceRules.label(10000, 1500))
        assertEquals(2L, PriceRules.futureYuan(100, 1500)) // 1.50 -> 2
        assertEquals(1L, PriceRules.futureYuan(99, 1500))  // 1.485 -> 1
        assertEquals(148L, PriceRules.futureYuan(10000, 1480))
    }

    @Test fun multiplierParsing() {
        assertEquals(1500, PriceRules.parseMultiplier("1.5"))
        assertEquals(1480, PriceRules.parseMultiplier("1.48"))
        assertEquals(10000, PriceRules.parseMultiplier("10"))
        assertNull(PriceRules.parseMultiplier("0.9"))
        assertNull(PriceRules.parseMultiplier("10.001"))
        assertNull(PriceRules.parseMultiplier("1.2345"))
        assertNull(PriceRules.parseMultiplier("abc"))
        assertEquals("1.5", PriceRules.formatMultiplier(1500))
        assertEquals("2", PriceRules.formatMultiplier(2000))
    }

    @Test fun rejectsOutOfRangeAndOverflow() {
        assertRejected("¥10000000.01")
        assertRejected("¥99999999999999999999")
        assertEquals(1_000_000_000L, cents("¥10000000"))
        assertNull(PriceRules.futureYuan(0, 1500))
        assertNull(PriceRules.futureYuan(-1, 1500))
        assertNull(PriceRules.futureYuan(Long.MAX_VALUE, 1500))
        assertNull(PriceRules.futureYuan(9990, 999))
        assertNull(PriceRules.futureYuan(9990, 10_001))
        assertEquals(100_000_000L, PriceRules.futureYuan(1_000_000_000L, 10_000))
    }
}
