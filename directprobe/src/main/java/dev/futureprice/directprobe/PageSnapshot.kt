package dev.futureprice.directprobe

/** 纯 Kotlin 几何与节点快照，不依赖 Android 类，可单测。坐标为屏幕像素。 */
data class IntBox(val left: Int, val top: Int, val right: Int, val bottom: Int) {
    val width: Int get() = right - left
    val height: Int get() = bottom - top
    val isValid: Boolean get() = width > 0 && height > 0

    fun contains(o: IntBox) = o.left >= left && o.top >= top && o.right <= right && o.bottom <= bottom
    fun intersects(o: IntBox) = left < o.right && o.left < right && top < o.bottom && o.top < bottom
}

/** 节点文字只在内存中用于锚点匹配；parentId = -1 为根。visible 为 isVisibleToUser。 */
data class SnapNode(
    val id: Int,
    val parentId: Int,
    val className: String?,
    val text: String?,
    val bounds: IntBox?,
    val visible: Boolean = true,
)

data class PageSnapshot(
    val packageName: String,
    val versionCode: Long?,
    val screen: IntBox,
    val nodes: List<SnapNode>,
)

sealed interface PageDecision {
    /** 通过页面适配后的价格框（输入候选的子集）。 */
    data class Accept(val prices: List<IntBox>) : PageDecision

    /** 整页不给候选，并给出拒绝原因。 */
    data class Reject(val reason: String) : PageDecision
}
