package dev.futureprice.directprobe

/**
 * 拼多多 8.26.0（versionCode 82600）英文游客列表页适配规则。只覆盖已实测的这一页，不代表其它页面或中文界面。
 *
 * - 包名与版本必须匹配，否则拒绝。
 * - 锚点只取文字完全相等、可见、框有效且在屏内的节点。
 * - 应用内弹窗：恰好一个「Agree」与一个「Disagree & stay in browsing mode」，其最低共同容器内还有
 *   「Exit browsing mode」标题，三者自上而下排列，且该容器子树不含页面顶部搜索锚点 → 整页拒绝。
 *   只出现部分弹窗锚点或结构不符 → 拒绝（歧义）。
 * - 顶部固定栏：「Search for items you want」与「All」各恰好一个，其最低共同祖先须为全宽有效框并包含两者，取其底边。
 * - 底部固定栏：恰好一个可见全宽「Exit browsing mode」，顶边在屏内且位于顶部栏底边之下，取其顶边；
 *   只有该锚点允许框超出屏幕。
 * - 浮动「顶部」按钮框为排除区。
 * - 只保留完全位于顶部栏底边与底部栏顶边之间、且不与排除区相交的候选。
 * 全宽容差（屏宽 2%）是试验阈值，不是通用结论。
 */
object PddGuestListRule {
    const val PACKAGE = "com.xunmeng.pinduoduo"
    const val VERSION_CODE = 82600L

    private const val SEARCH = "Search for items you want"
    private const val ALL = "All"
    private const val EXIT = "Exit browsing mode"
    private const val AGREE = "Agree"
    private const val DISAGREE = "Disagree & stay in browsing mode"
    private const val TOP_BUTTON = "顶部"
    private const val FULL_WIDTH_TOLERANCE = 0.02f

    object Reason {
        const val NOT_IMPLEMENTED = "not_implemented"
        const val WRONG_PACKAGE = "wrong_package"
        const val VERSION_UNKNOWN = "version_unknown"
        const val VERSION_MISMATCH = "version_mismatch"
        const val TREE_INVALID = "tree_invalid"
        const val POPUP = "popup"
        const val POPUP_AMBIGUOUS = "popup_ambiguous"
        const val HEADER_MISSING = "header_missing"
        const val HEADER_AMBIGUOUS = "header_ambiguous"
        const val HEADER_INVALID = "header_invalid"
        const val FOOTER_MISSING = "footer_missing"
        const val FOOTER_AMBIGUOUS = "footer_ambiguous"
        const val FOOTER_INVALID = "footer_invalid"
    }

    /** candidates 为 flat 读取后的价格框；返回其子集或拒绝原因。 */
    fun evaluate(snapshot: PageSnapshot, candidates: List<IntBox>): PageDecision {
        if (snapshot.packageName != PACKAGE) return PageDecision.Reject(Reason.WRONG_PACKAGE)
        val version = snapshot.versionCode ?: return PageDecision.Reject(Reason.VERSION_UNKNOWN)
        if (version != VERSION_CODE) return PageDecision.Reject(Reason.VERSION_MISMATCH)

        val tree = Tree.of(snapshot) ?: return PageDecision.Reject(Reason.TREE_INVALID)
        val screen = snapshot.screen
        fun anchors(text: String) = snapshot.nodes.filter {
            it.visible && it.text == text && it.bounds != null && it.bounds.isValid && screen.contains(it.bounds)
        }
        val tol = (screen.width * FULL_WIDTH_TOLERANCE).toInt()
        fun fullWidth(b: IntBox) = b.left <= screen.left + tol && b.right >= screen.right - tol

        val search = anchors(SEARCH)
        val all = anchors(ALL)

        // 弹窗优先：一旦出现弹窗按钮锚点，必须确认结构，否则按歧义拒绝。
        val agree = anchors(AGREE)
        val disagree = anchors(DISAGREE)
        val exits = anchors(EXIT)
        if (agree.isNotEmpty() || disagree.isNotEmpty()) {
            val confirmed = agree.size == 1 && disagree.size == 1 && run {
                val a = agree[0]
                val d = disagree[0]
                val container = tree.lca(a.id, d.id)?.let { tree.node(it) } ?: return@run false
                val cb = container.bounds ?: return@run false
                if (!cb.isValid || !cb.contains(a.bounds!!) || !cb.contains(d.bounds!!)) return@run false
                if (search.any { tree.isDescendant(it.id, container.id) }) return@run false
                exits.any { e ->
                    tree.isDescendant(e.id, container.id) && cb.contains(e.bounds!!) &&
                        e.bounds.bottom <= a.bounds.top && a.bounds.bottom <= d.bounds.top
                }
            }
            return PageDecision.Reject(if (confirmed) Reason.POPUP else Reason.POPUP_AMBIGUOUS)
        }

        if (search.isEmpty() || all.isEmpty()) return PageDecision.Reject(Reason.HEADER_MISSING)
        if (search.size > 1 || all.size > 1) return PageDecision.Reject(Reason.HEADER_AMBIGUOUS)
        val header = tree.lca(search[0].id, all[0].id)?.let { tree.node(it) }?.bounds
            ?: return PageDecision.Reject(Reason.HEADER_INVALID)
        if (!header.isValid || !fullWidth(header) || !header.contains(search[0].bounds!!) || !header.contains(all[0].bounds!!)) {
            return PageDecision.Reject(Reason.HEADER_INVALID)
        }
        val headerBottom = header.bottom

        // 固定底栏是唯一允许框超出屏幕的锚点（真实服务读到其框越出屏幕）：须可见、框有效、全宽、
        // 与屏幕有交集、顶边在屏内且低于顶部栏底边。其它锚点与候选仍要求完全在屏内。
        val footers = snapshot.nodes.filter { it.visible && it.text == EXIT && it.bounds != null && it.bounds.isValid }
        if (footers.isEmpty()) return PageDecision.Reject(Reason.FOOTER_MISSING)
        if (footers.size > 1) return PageDecision.Reject(Reason.FOOTER_AMBIGUOUS)
        val footer = footers[0].bounds!!
        val footerUsable = footer.intersects(screen) && footer.top >= screen.top && footer.top < screen.bottom &&
            fullWidth(footer) && footer.top > headerBottom
        if (!footerUsable) return PageDecision.Reject(Reason.FOOTER_INVALID)
        val footerTop = footer.top

        val excluded = anchors(TOP_BUTTON).map { it.bounds!! }
        return PageDecision.Accept(
            candidates.filter { c ->
                c.isValid && screen.contains(c) && c.top >= headerBottom && c.bottom <= footerTop &&
                    excluded.none { it.intersects(c) }
            },
        )
    }

    /** 父子关系索引；id 重复、缺根、父节点缺失或成环时返回 null。 */
    private class Tree private constructor(private val byId: Map<Int, SnapNode>) {
        fun node(id: Int): SnapNode? = byId[id]

        fun ancestors(id: Int): List<Int> {
            val out = ArrayList<Int>()
            var cur: Int? = id
            while (cur != null && cur != -1) {
                out += cur
                cur = byId[cur]?.parentId
            }
            return out
        }

        fun lca(a: Int, b: Int): Int? {
            val pa = ancestors(a).toHashSet()
            return ancestors(b).firstOrNull { it in pa }
        }

        fun isDescendant(id: Int, ancestor: Int) = ancestor in ancestors(id)

        companion object {
            fun of(s: PageSnapshot): Tree? {
                if (!s.screen.isValid || s.nodes.isEmpty()) return null
                val byId = s.nodes.associateBy { it.id }
                if (byId.size != s.nodes.size) return null
                if (s.nodes.count { it.parentId == -1 } != 1) return null
                if (s.nodes.any { it.parentId != -1 && it.parentId !in byId }) return null
                // 成环检测：每条祖先链长度不超过节点数。
                for (n in s.nodes) {
                    var cur = n.parentId
                    var steps = 0
                    while (cur != -1) {
                        if (++steps > s.nodes.size) return null
                        cur = byId[cur]?.parentId ?: return null
                    }
                }
                return Tree(byId)
            }
        }
    }
}
