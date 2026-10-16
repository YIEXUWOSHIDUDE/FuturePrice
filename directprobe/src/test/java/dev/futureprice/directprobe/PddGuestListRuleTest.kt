package dev.futureprice.directprobe

import dev.futureprice.directprobe.PddGuestListRule.Reason
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 树结构取自 /private/tmp/fp-list-structure.json 与 fp-popup-structure.json（真实文字/金额已脱敏）。
 * 价格节点文字保留脱敏占位 "price"；规则只用锚点文字与几何。
 */
class PddGuestListRuleTest {

    private val screen = IntBox(0, 0, 1080, 2400)

    private fun b(l: Int, t: Int, r: Int, bt: Int) = IntBox(l, t, r, bt)
    private fun n(id: Int, parent: Int, cls: String?, text: String?, box: IntBox?) = SnapNode(id, parent, cls, text, box)

    private val tv = "android.widget.TextView"
    private val v = "android.view.View"

    /** 列表页：顶部 header [0,128][1080,540]，底部 Exit [0,2196][1080,2339]，浮动「顶部」按钮。 */
    private fun listNodes(): List<SnapNode> = listOf(
        n(0, -1, null, null, null),
        n(1, 0, "android.widget.FrameLayout", null, b(0, 128, 1080, 2400)),
        n(8, 1, "android.webkit.WebView", null, b(0, 128, 1080, 2337)),
        n(9, 8, "android.webkit.WebView", null, b(0, 128, 1080, 2339)),
        n(11, 9, v, null, b(0, 128, 1080, 674)),
        n(12, 11, v, null, b(0, 128, 1080, 540)),
        n(13, 12, v, null, b(39, 290, 1042, 403)),
        n(15, 13, tv, "Search for items you want", b(296, 311, 855, 382)),
        n(17, 12, v, null, b(0, 416, 1080, 540)),
        n(18, 17, "android.widget.ListView", null, b(0, 416, 1080, 566)),
        n(19, 18, v, "All", b(39, 416, 97, 540)),
        n(20, 18, v, "Food & Grocery", b(152, 416, 469, 540)),
        n(41, 11, v, null, b(18, 128, 1063, 2339)),
        n(42, 41, v, null, b(0, 0, 0, 0)),
        n(47, 42, tv, "price", b(0, 0, 0, 0)),
        n(59, 41, v, null, b(18, 128, 532, 414)),
        n(65, 59, tv, "price", b(42, 332, 168, 385)),
        n(72, 41, v, null, b(548, 128, 1063, 414)),
        n(78, 72, tv, "price", b(572, 332, 727, 385)),
        n(81, 41, v, null, b(18, 432, 532, 1185)),
        n(87, 81, tv, "price", b(42, 1104, 196, 1157)),
        n(90, 41, v, null, b(548, 432, 1063, 1185)),
        n(95, 90, tv, "price", b(572, 1104, 698, 1157)),
        n(98, 41, v, null, b(18, 1201, 532, 1957)),
        n(104, 98, tv, "price", b(42, 1873, 196, 1926)),
        n(107, 41, v, null, b(548, 1201, 1063, 1957)),
        n(113, 107, tv, "price", b(572, 1873, 698, 1926)),
        n(116, 41, v, null, b(18, 1973, 532, 2339)),
        n(126, 116, tv, "price", b(0, 0, 0, 0)),
        n(232, 41, tv, "顶部", b(905, 2031, 1031, 2157)),
        n(233, 11, tv, "Exit browsing mode", b(0, 2196, 1080, 2339)),
    )

    /** 弹窗：WebView 下另一子树，最低共同容器 [120,679][960,1787]。 */
    private fun popupNodes(): List<SnapNode> = listNodes() + listOf(
        n(235, 9, v, null, b(0, 128, 1080, 2339)),
        n(236, 235, v, null, b(0, 128, 1080, 2339)),
        n(238, 236, v, null, b(120, 679, 960, 1787)),
        n(240, 238, v, null, b(120, 679, 960, 1787)),
        n(241, 240, tv, "Exit browsing mode", b(301, 750, 782, 823)),
        n(243, 240, tv, "privacy_body", b(178, 831, 871, 954)),
        n(246, 240, tv, "Agree", b(178, 1524, 903, 1658)),
        n(247, 240, v, null, b(178, 1689, 903, 1752)),
        n(248, 247, tv, "Disagree & stay in browsing mode", b(246, 1689, 837, 1750)),
    )

    /** flat 读取得到的 6 个候选：2 个在 header 下（隐藏旧价），4 个可见。 */
    private val hidden = listOf(b(42, 332, 168, 385), b(572, 332, 727, 385))
    private val visible = listOf(
        b(42, 1104, 196, 1157), b(572, 1104, 698, 1157),
        b(42, 1873, 196, 1926), b(572, 1873, 698, 1926),
    )
    private val flat = hidden + visible

    private fun snap(nodes: List<SnapNode>, version: Long? = PddGuestListRule.VERSION_CODE, scr: IntBox = screen) =
        PageSnapshot(PddGuestListRule.PACKAGE, version, scr, nodes)

    private fun accepted(d: PageDecision): List<IntBox> {
        assertTrue("应通过适配，实际 $d", d is PageDecision.Accept)
        return (d as PageDecision.Accept).prices
    }

    private fun assertReject(d: PageDecision, reason: String) {
        assertEquals(PageDecision.Reject(reason), d)
    }

    private fun IntBox.map(f: (Int) -> Int, g: (Int) -> Int) = IntBox(f(left), g(top), f(right), g(bottom))
    private fun transform(nodes: List<SnapNode>, f: (Int) -> Int, g: (Int) -> Int) =
        nodes.map { it.copy(bounds = it.bounds?.let { bx -> if (bx.isValid) bx.map(f, g) else bx }) }

    @Test fun listSixFlatCandidatesBecomeFour() {
        assertEquals(visible, accepted(PddGuestListRule.evaluate(snap(listNodes()), flat)))
    }

    @Test fun popupRejectsWholePage() {
        assertReject(PddGuestListRule.evaluate(snap(popupNodes()), flat), Reason.POPUP)
    }

    @Test fun popupClosedRestoresFour() {
        assertReject(PddGuestListRule.evaluate(snap(popupNodes()), flat), Reason.POPUP)
        assertEquals(visible, accepted(PddGuestListRule.evaluate(snap(listNodes()), flat)))
    }

    @Test fun headerFooterShiftedStillDerivedFromAnchors() {
        // header 底边下移 100px（只移动 header 子树与 footer 不变）：原先可见的第一行价格若跨越新底边须排除。
        val shiftedHeader = setOf(12, 13, 15, 17, 18, 19, 20)
        val nodes = listNodes().map {
            if (it.id in shiftedHeader && it.bounds != null) it.copy(bounds = it.bounds.copy(bottom = it.bounds.bottom + 100, top = if (it.id == 12) it.bounds.top else it.bounds.top + 100)) else it
        }
        val straddle = b(42, 600, 196, 653) // 跨过新底边 640
        val inside = b(42, 700, 196, 753)
        val result = accepted(PddGuestListRule.evaluate(snap(nodes), listOf(straddle, inside) + visible))
        assertEquals(listOf(inside) + visible, result)
    }

    @Test fun differentResolutionScaled() {
        val scale = { x: Int -> x * 3 / 2 }
        val nodes = transform(listNodes(), scale, scale)
        val scr = IntBox(0, 0, 1620, 3600)
        val cands = flat.map { it.map(scale, scale) }
        val expect = visible.map { it.map(scale, scale) }
        assertEquals(expect, accepted(PddGuestListRule.evaluate(snap(nodes, scr = scr), cands)))
    }

    @Test fun missingHeaderAnchorRejects() {
        val nodes = listNodes().filterNot { it.id == 19 }
        assertReject(PddGuestListRule.evaluate(snap(nodes), flat), Reason.HEADER_MISSING)
    }

    @Test fun missingFooterRejects() {
        val nodes = listNodes().filterNot { it.id == 233 }
        assertReject(PddGuestListRule.evaluate(snap(nodes), flat), Reason.FOOTER_MISSING)
    }

    @Test fun duplicateFooterWithoutPopupIsAmbiguous() {
        val nodes = listNodes() + n(300, 41, tv, "Exit browsing mode", b(0, 1990, 1080, 2100))
        assertReject(PddGuestListRule.evaluate(snap(nodes), flat), Reason.FOOTER_AMBIGUOUS)
    }

    @Test fun invalidHeaderGeometryRejects() {
        // header 公共祖先不再全宽。
        val nodes = listNodes().map { if (it.id == 12) it.copy(bounds = b(200, 128, 900, 540)) else it }
        assertReject(PddGuestListRule.evaluate(snap(nodes), flat), Reason.HEADER_INVALID)
    }

    @Test fun productTitlesMentioningButtonsAreNotAnchors() {
        val nodes = listNodes() + listOf(
            n(301, 81, tv, "Agree All-in-one pack", b(42, 900, 500, 960)),
            n(302, 90, tv, "Disagree & stay in browsing mode kit", b(572, 900, 1040, 960)),
        )
        assertEquals(visible, accepted(PddGuestListRule.evaluate(snap(nodes), flat)))
    }

    @Test fun partialPopupAnchorsAreAmbiguous() {
        val nodes = listNodes() + n(310, 9, tv, "Disagree & stay in browsing mode", b(246, 1689, 837, 1750))
        assertReject(PddGuestListRule.evaluate(snap(nodes), flat), Reason.POPUP_AMBIGUOUS)
    }

    @Test fun floatingTopButtonAndPartialClipExcluded() {
        val underButton = b(900, 2050, 1000, 2100)
        val straddleHeader = b(42, 520, 196, 573)
        val straddleFooter = b(572, 2170, 698, 2223)
        val result = accepted(
            PddGuestListRule.evaluate(snap(listNodes()), visible + listOf(underButton, straddleHeader, straddleFooter)),
        )
        assertEquals(visible, result)
    }

    @Test fun incompleteOrInvalidTreeRejects() {
        // 父节点缺失。
        val orphan = listNodes().filterNot { it.id == 12 }
        assertReject(PddGuestListRule.evaluate(snap(orphan), flat), Reason.TREE_INVALID)
        // 多个根。
        val twoRoots = listNodes() + n(400, -1, null, null, null)
        assertReject(PddGuestListRule.evaluate(snap(twoRoots), flat), Reason.TREE_INVALID)
        // 空树。
        assertReject(PddGuestListRule.evaluate(snap(emptyList()), flat), Reason.TREE_INVALID)
    }

    @Test fun hiddenAnchorsAreIgnored() {
        // 不可见的旧「All」不能充当锚点。
        val nodes = listNodes().map { if (it.id == 19) it.copy(visible = false) else it }
        assertReject(PddGuestListRule.evaluate(snap(nodes), flat), Reason.HEADER_MISSING)
    }

    // ---- 固定底栏框超出屏幕（真实服务读到 exit in_screen=0）----

    private fun withFooter(box: IntBox, visible: Boolean = true) =
        listNodes().map { if (it.id == 233) it.copy(bounds = box, visible = visible) else it }

    @Test fun footerOverflowingBottomStillAccepts() {
        val nodes = withFooter(b(0, 2196, 1080, 2500))
        assertEquals(visible, accepted(PddGuestListRule.evaluate(snap(nodes), flat)))
    }

    @Test fun footerOverflowingRightStillAccepts() {
        val nodes = withFooter(b(0, 2196, 1100, 2339))
        assertEquals(visible, accepted(PddGuestListRule.evaluate(snap(nodes), flat)))
    }

    @Test fun footerFullyOffscreenRejects() {
        val nodes = withFooter(b(0, 2450, 1080, 2600))
        assertReject(PddGuestListRule.evaluate(snap(nodes), flat), Reason.FOOTER_INVALID)
    }

    @Test fun footerOverflowingButNotFullWidthRejects() {
        val nodes = withFooter(b(200, 2196, 1100, 2339))
        assertReject(PddGuestListRule.evaluate(snap(nodes), flat), Reason.FOOTER_INVALID)
    }

    @Test fun footerOverflowingWithTopAboveHeaderRejects() {
        val nodes = withFooter(b(0, 500, 1080, 2500))
        assertReject(PddGuestListRule.evaluate(snap(nodes), flat), Reason.FOOTER_INVALID)
    }

    @Test fun invisibleOverflowingFooterIsNotAnAnchor() {
        val nodes = withFooter(b(0, 2196, 1080, 2500), visible = false)
        assertReject(PddGuestListRule.evaluate(snap(nodes), flat), Reason.FOOTER_MISSING)
    }

    @Test fun popupAnchorsStayStrictlyInScreen() {
        // 弹窗锚点不放宽：Agree 越出屏幕即不算锚点，只剩 Disagree → 歧义拒绝。
        val nodes = popupNodes().map { if (it.id == 246) it.copy(bounds = b(178, 1524, 1100, 1658)) else it }
        assertReject(PddGuestListRule.evaluate(snap(nodes), flat), Reason.POPUP_AMBIGUOUS)
    }

    @Test fun candidatesMustStayFullyInScreen() {
        val overflow = b(572, 1104, 1100, 1157)
        val result = accepted(PddGuestListRule.evaluate(snap(withFooter(b(0, 2196, 1080, 2500))), visible + overflow))
        assertEquals(visible, result)
    }

    @Test fun versionAndPackageBound() {
        assertReject(PddGuestListRule.evaluate(snap(listNodes(), version = null), flat), Reason.VERSION_UNKNOWN)
        assertReject(PddGuestListRule.evaluate(snap(listNodes(), version = 82700), flat), Reason.VERSION_MISMATCH)
        val other = PageSnapshot("com.taobao.taobao", 1, screen, listNodes())
        assertReject(PddGuestListRule.evaluate(other, flat), Reason.WRONG_PACKAGE)
    }
}
