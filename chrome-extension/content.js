/*
 * 内容脚本（isolated world）：在已启用站点识别商品卡片主价，并在价格所在行下方插入独立一行提醒
 * 「不买，10年后 ≈ $7」。每条提醒是一个独立的 closed-shadow <futureprice-hint> 宿主，只插入、不移动或替换商家节点；
 * 唯一改动商家节点的地方：提醒造成 overflow:hidden/clip 祖先裁切时，临时提高其 min-height，提醒移除或停用时恢复。
 * 识别是单一通用路径，不按域名分支：
 *   金额候选（可见完整金额文本 / microdata 金额+货币代码）→ 卡片关联 → 局部上下文过滤 → 每卡片一个明确主价。
 * 金额与上下文规则在 lib/rules.js；本文件负责 DOM 候选、可见性、卡片关联、插入位置与遮挡检查。
 * 自身宿主从价格扫描、上下文文字、卡片文字量与 MutationObserver 中排除，避免自我识别与反馈循环。
 * 不接受网页 postMessage；只响应本扩展消息与存储变化。重复注入幂等。
 * 不支持：跨域 iframe、closed shadow root 内的价格、图片中的价格、逗号作小数点的金额。
 */
(() => {
  'use strict';
  const R = globalThis.FPRules;
  if (!R || typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;

  const KEY = '__futurePriceHint';
  if (globalThis[KEY]) {
    globalThis[KEY].sync();
    return;
  }

  const site = R.sitePatternFor(location.href);
  const HOST_TAG = 'futureprice-hint';
  const HOST_NAME = HOST_TAG.toUpperCase();
  const MAX_PRICE_TEXT = 24;
  // 价格所在行：向上找最近块级祖先的层数上限，以及行源码长度上限（过大时不取上下文）。
  const MAX_LINE_DEPTH = 6;
  // 行内上下文：最多遍历的可见节点数、前后缀各自保留的字符数（规则只用紧邻约 24 字）。
  const MAX_LINE_NODES = 400;
  const MAX_CONTEXT_COLLECT = 120;
  const BLOCK_DISPLAYS = new Set(['block', 'flex', 'grid', 'list-item', 'table', 'table-row', 'table-cell', 'flow-root']);
  // 详情页：唯一 h1 商品标题到价格之间的可见文字上限（评分、销量、徽标等）。
  const MAX_TITLE_TO_PRICE_TEXT = 400;
  const NON_TEXT_ELEMENTS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  // 无标题标签的详情页：通用商品名语义（class/id 词组合）与购买动作文本。
  const TITLE_CANDIDATES = '[class*="title" i],[class*="name" i],[id*="title" i],[id*="name" i],[itemprop="name"]';
  const PRODUCT_TITLE_RE = /(?:product|sku|goods|item|prod)[\w-]*(?:title|name)|(?:title|name)[\w-]*(?:product|sku|goods|item)/i;
  const STRONG_TITLE_RE = /(?:product|sku|goods|prod)[\w-]*(?:title|name)|(?:title|name)[\w-]*(?:product|sku|goods)/i;
  const PURCHASE_TEXT = /^(?:加入购物车|加入購物車|加入购物袋|立即购买|立即購買|立即抢购|马上抢|去购买|购买|buy now|buy it now|add to cart|add to bag|add to basket|add to trolley|purchase)$/i;
  const MAX_PURCHASE_SCAN = 4000;
  // 独立购买区：渲染文字上限，以及向上寻找含商品标题与商品图的公共祖先的层数上限。
  const MAX_BUYBOX_TEXT = 1500;
  const MAX_PANEL_CONTEXT_DEPTH = 12;
  const PRICE_SEMANTIC_RE = /price|current|sale|now|final/i;
  const SUBTOTAL_RE = /\b(?:subtotal|item total)\b|小计/i;
  // 价格所在的单个选项容器：向上层数与渲染文字上限（只含一个单选/复选控件）。
  const MAX_OPTION_DEPTH = 3;
  const MAX_OPTION_TEXT = 120;
  // CSS 生成币种与拆分价。
  const NUMERIC_TEXT = /^\s*\d[\d,]*(?:\.\d{1,2})?\s*$/;
  const MAX_NUMERIC_NODES = 3000;
  const PSEUDO_SYMBOLS = new Set(['¥', '￥', '$', '€', '£']);
  // 无链接/按钮时的重复商品块：块内渲染文字上限。
  const MAX_TILE_TEXT = 200;
  // 提醒插入锚点：越过不换行横向 flex 行的层数上限。
  const MAX_ANCHOR_DEPTH = 4;
  // 数量控件：number 输入框，或 name/id/aria-label 含 qty/quantity/数量 的输入框与下拉框（不把任意 select 当数量）。
  const QTY_SELECTOR = 'input[type="number"],' +
    ['input', 'select'].map((tag) =>
      [`${tag}[name*="qty" i]`, `${tag}[name*="quantity" i]`, `${tag}[id*="qty" i]`, `${tag}[id*="quantity" i]`,
        `${tag}[aria-label*="quantity" i]`, `${tag}[aria-label*="数量"]`].join(',')).join(',');
  const MAX_ROW_TEXT = 60;
  const MAX_ROW_DEPTH = 8;
  const MAX_CARD_TEXT = 400;
  const MAX_DETAIL_TEXT = 800;
  // 深层详情布局有多层纯价格包装，搜索仍须有界。
  const MAX_CARD_DEPTH = 32; // 详情页可能有多层纯布局包装；仍由商品证据和文字量限制范围。
  const MAX_TEXT_NODES = 20000;
  const SCAN_DEBOUNCE_MS = 250;
  const SCAN_MAX_WAIT_MS = 1000;
  const MONEY_HINT = /[¥￥$€£元]|\b(?:CNY|RMB|USD|EUR|GBP|HKD|CAD|AUD)\b/;
  const SCHEMA_CARD = '[itemscope][itemtype*="schema.org/Product"]';
  // 少量通用、可维护的商品卡片选择器（不针对具体网站）。
  const CARD_SELECTORS = [SCHEMA_CARD, '[data-product-card]', '.product-card', '.goods-item'];
  const PURCHASE = 'button,[role="button"],input[type="submit"],input[type="button"]';
  const MAX_EVIDENCE_DEPTH = 4;
  const MIN_MEDIA_PX = 32;
  const MAX_MEDIA_CHECK = 50;
  const MEDIA = 'img,picture,svg,video,canvas';
  // 纯价格组不能含这些：标题、控件、图片类元素。
  const NOT_PRICE_GROUP = 'h1,h2,h3,h4,h5,h6,button,input,select,textarea,[role="button"],[role="img"],' + MEDIA;
  // 这些父元素下不能插入兄弟块元素，改为插在价格组内部末尾。
  const APPEND_INSIDE_PARENTS = new Set(['TR', 'TBODY', 'THEAD', 'TFOOT', 'TABLE', 'UL', 'OL', 'DL', 'SELECT']);
  // 渲染文字中属于本扩展提醒的部分，计算卡片文字量时剔除。
  const OWN_TEXT = /不买，10年后\s*≈\s*\S+/g;
  const LEAD_TEXT = '不买，10年后 ≈ ';
  const CSS = `
    :host {
      all: initial; display: block; box-sizing: border-box; max-width: 100%; margin: 4px 0 6px;
      /* 默认不参与 flex 伸缩（列向 flex 中 100% 主轴基准会按整卡高度挤压图片）；
         只有父元素是横向可换行 flex 时，由脚本设置 flex-basis:100% 独占一行。grid 中跨整行。 */
      flex: none; min-width: 0; grid-column: 1 / -1;
    }
    .badge {
      display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 0 4px;
      max-width: 100%; box-sizing: border-box;
      background: #FFF0D9; border: 1px solid #EA580C; border-radius: 8px; padding: 7px 9px;
      color: #7C2D12; font: 600 14px/1.35 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    .lead { white-space: nowrap; }
    .amt { white-space: nowrap; font-size: 19px; font-weight: 800; line-height: 1.1; }`;

  let running = false;
  let milli = R.DEFAULT_MILLI;
  let observer = null;
  let resizeObserver = null;
  let entries = []; // { el, card, row, text, minor, currency }
  const badges = new Map(); // 价格元素 -> { host, badge, lead, amt, key }
  let scanStats = emptyScanStats();
  let renderStats = emptyRenderStats();
  let scanTimer = 0;
  let firstPendingAt = 0;
  let rafId = 0;

  function emptyScanStats() {
    return { cards: 0, ambiguous: 0, rejected: 0, none: 0 };
  }
  function emptyRenderStats() {
    return { labeled: 0, occluded: 0, offscreen: 0, noRoom: 0 };
  }

  function contextAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  // ---------- 生命周期 ----------

  function start(newMilli) {
    if (R.isValidMilli(newMilli)) milli = newMilli;
    if (running) {
      scheduleRender();
      return;
    }
    if (!document.documentElement) return;
    running = true;
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      // 选中状态与数量也会改变主价判定（checked/selected/aria-* 属性）。
      attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-hidden', 'checked', 'selected', 'aria-checked', 'aria-selected', 'value'],
    });
    // 用户切换规格/数量多为属性不变的属性值变化：监听 change/input 事件节流重扫。
    document.addEventListener('change', onControlEvent, true);
    document.addEventListener('input', onControlEvent, true);
    addEventListener('scroll', scheduleRender, { capture: true, passive: true });
    addEventListener('resize', scheduleRender, { passive: true });
    // 不改 DOM 文字的重排（图片/媒体加载完成或失败、字体加载、尺寸变化）也要重新检查。
    document.addEventListener('load', onMediaEvent, true);
    document.addEventListener('error', onMediaEvent, true);
    if (document.fonts) document.fonts.addEventListener('loadingdone', scheduleRender);
    resizeObserver = new ResizeObserver(() => scheduleRender());
    scanNow();
  }

  function onControlEvent(ev) {
    const t = ev.target;
    if (running && t instanceof Element && !isOwn(t) && t.matches('input,select,textarea,[role="radio"],[role="checkbox"],[role="option"]')) {
      scheduleScan();
    }
  }

  function onMediaEvent(ev) {
    const t = ev.target;
    if (t instanceof Element && !isOwn(t)) {
      scheduleRender();
      // 图片加载后尺寸变化可能改变商品图判定，节流重扫。
      scheduleScan();
    }
  }

  /** 重新设置尺寸观察范围：body 加当前已标注的卡片。 */
  function observeSizes() {
    if (!resizeObserver) return;
    resizeObserver.disconnect();
    if (document.body) resizeObserver.observe(document.body);
    for (const card of new Set(entries.map((e) => e.card))) resizeObserver.observe(card);
  }

  function stop() {
    running = false;
    if (observer) observer.disconnect();
    observer = null;
    removeEventListener('scroll', scheduleRender, { capture: true });
    removeEventListener('resize', scheduleRender);
    document.removeEventListener('load', onMediaEvent, true);
    document.removeEventListener('error', onMediaEvent, true);
    document.removeEventListener('change', onControlEvent, true);
    document.removeEventListener('input', onControlEvent, true);
    if (document.fonts) document.fonts.removeEventListener('loadingdone', scheduleRender);
    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = null;
    clearTimeout(scanTimer);
    scanTimer = 0;
    firstPendingAt = 0;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    for (const b of badges.values()) b.host.remove();
    badges.clear();
    for (const [a, fix] of [...clipFixes]) restoreClipFix(a, fix);
    for (const [a, fix] of [...positionFixes]) restorePosition(a, fix);
    entries = [];
    scanStats = emptyScanStats();
    renderStats = emptyRenderStats();
  }

  async function sync() {
    if (!site.ok || !contextAlive()) {
      stop();
      return;
    }
    let data;
    try {
      data = await chrome.storage.local.get({ sites: {}, milli: R.DEFAULT_MILLI });
    } catch (e) {
      stop();
      return;
    }
    if (data.sites && data.sites[site.pattern]) start(data.milli);
    else stop();
  }

  function status() {
    return { running, site: site.ok ? site.pattern : null, ...scanStats, ...renderStats };
  }

  // ---------- 变化处理 ----------

  /** 节点属于本扩展的提醒宿主（或在其内）。 */
  function isOwn(node) {
    if (!node) return false;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return !!el && !!el.closest(HOST_TAG);
  }

  /** 只由本扩展插入/移动/移除宿主引起的变化。 */
  function isOwnMutation(m) {
    if (isOwn(m.target) || isOwnStyleMutation(m)) return true;
    if (m.type !== 'childList') return false;
    const nodes = [...m.addedNodes, ...m.removedNodes];
    return nodes.length > 0 && nodes.every((n) => n.nodeName === HOST_NAME);
  }

  function onMutations(mutations) {
    if (!running) return;
    if (!contextAlive()) {
      stop();
      return;
    }
    if (mutations.every(isOwnMutation)) return;
    // 价格文字变化或节点被删除/替换：立即撤下失效提醒，再节流重扫。
    const before = entries.length;
    entries = entries.filter(isEntryValid);
    if (entries.length !== before) render();
    else scheduleRender();
    scheduleScan();
  }

  function isEntryValid(e) {
    return e.el.isConnected && e.card.isConnected && e.row.isConnected && R.normalize(e.el.textContent) === e.text;
  }

  function scheduleScan() {
    const now = performance.now();
    if (!firstPendingAt) firstPendingAt = now;
    clearTimeout(scanTimer);
    const wait = Math.max(0, Math.min(SCAN_DEBOUNCE_MS, SCAN_MAX_WAIT_MS - (now - firstPendingAt)));
    scanTimer = setTimeout(scanNow, wait);
  }

  function scheduleRender() {
    if (!running || rafId) return;
    rafId = requestAnimationFrame(render);
  }

  // ---------- 识别 ----------

  function scanNow() {
    scanTimer = 0;
    firstPendingAt = 0;
    if (!running || !document.body) return;
    textLengthCache = new Map();
    mediaCache = new Map();
    purchaseCache = new Map();
    const candidates = collectCandidates();
    // 含价格候选的祖先（有界），供「重复商品块」判定兄弟块是否也带价格。
    const candidateAncestors = new Set();
    for (const el of candidates.keys()) {
      for (let a = el.parentElement, d = 0; a && a !== document.body && d < MAX_CARD_DEPTH; a = a.parentElement, d++) {
        candidateAncestors.add(a);
      }
    }
    const byCard = new Map();
    for (const [el, money] of candidates) {
      const card = findCard(el, candidateAncestors);
      if (!card) continue;
      if (!byCard.has(card)) byCard.set(card, []);
      byCard.get(card).push({ el, money, reject: null });
    }
    // 先对每张卡片独立完成过滤与主价选择，再做同商品重复区域的抑制。
    const results = new Map(); // card -> { entry, reason }
    for (const [card, list] of byCard) {
      for (const c of list) {
        c.option = optionState(c.el, card);
        if (c.option === 'addon' || c.option === 'unselected') c.reject = c.option;
        else c.reject = outsideTitleSection(card, c.el) ? 'section' : rejectReason(c.el, card, candidates);
      }
      let pick = R.pickMainPrice(list);
      if (pick.reason === 'ambiguous') pick = resolveSameAmount(list);
      let lineTotal = false;
      if (pick.reason === 'ambiguous') {
        const line = resolveQuantityLine(list, card);
        if (line) { pick = line; lineTotal = true; }
      }
      // 商品行有数量控件且有语义「小计」时，应付的是该行小计（不是单价）。
      const subtotalPick = resolveLineSubtotal(list, card, candidates);
      if (subtotalPick) { pick = subtotalPick; lineTotal = true; }
      if (pick.reason) {
        results.set(card, { entry: null, reason: pick.reason });
        continue;
      }
      const c = list[pick.index];
      results.set(card, {
        reason: null,
        entry: {
          el: c.el,
          card,
          row: priceRow(c.el, card),
          text: R.normalize(c.el.textContent),
          minor: c.money.minor,
          lineTotal,
          currency: c.money.currency,
        },
      });
    }
    // 同一商品的外层区域（如详情页侧栏重复价）不另算一件商品：外层唯一的 h1/h2 位于内层卡片中，且内层
    // 有有效主价、或内层持有的是 h1 商品标题时，外层被抑制。只有附加服务等无有效主价、以 h2 为标题的
    // 内层辅助区，不能压掉外层真正的主价。
    const next = [];
    const stats = emptyScanStats();
    const cards = [...results.keys()];
    for (const [card, res] of results) {
      const suppressed = cards.some((inner) => inner !== card && card.contains(inner) &&
        sharesProductHeading(card, inner) && (results.get(inner).entry || inner.querySelector('h1')));
      if (suppressed) continue;
      stats.cards++;
      if (res.entry) next.push(res.entry);
      else stats[res.reason]++;
    }
    entries = resolveCartTotals(next, candidates, stats);
    scanStats = stats;
    textLengthCache = new Map();
    mediaCache = new Map();
    purchaseCache = new Map();
    observeSizes();
    render();
  }

  /**
   * 金额候选：文字恰为完整金额的最小可见元素。拆开的币种/整数/小数按 textContent 合并
   * （包括用 visibility:hidden 隐藏的小数点）。读屏专用的重复文本（极小尺寸/裁切/不可见）不作候选。
   * microdata：itemprop=price 的可见纯数字 + 有效 priceCurrency。
   * 提醒宿主的内容在 closed shadow 内，TreeWalker 与 textContent 都不会读到。
   */
  /**
   * CSS 生成的币种：元素文字恰为纯数字金额，且其 ::before 实际显示币种符号（或 ::after 显示「元」）。
   * 只检查纯数字文字节点（有界），符号必须来自计算样式中的生成内容，不凭类名推测。
   */
  function collectPseudoCurrency(body, found) {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (NUMERIC_TEXT.test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    let count = 0;
    for (let n = walker.nextNode(); n && count < MAX_NUMERIC_NODES; n = walker.nextNode(), count++) {
      const digits = R.normalize(n.data);
      let el = n.parentElement;
      // 只在文字完全相同的包装层中寻找（最多 2 层），不跨到含其它文字的容器。
      for (let d = 0; el && el !== body && d < 2 && R.normalize(el.textContent) === digits; d++, el = el.parentElement) {
        if (found.has(el) || isOwn(el) || el.closest('script,style,noscript,template,textarea')) break;
        const money = pseudoMoney(el, digits);
        if (money) {
          if (isRendered(el) && !inPageLandmark(el)) found.set(el, money);
          break;
        }
      }
    }
  }

  function pseudoMoney(el, digits) {
    const before = generatedText(el, '::before');
    if (before && PSEUDO_SYMBOLS.has(before)) return R.parseMoney(before + digits);
    const after = generatedText(el, '::after');
    if (after === '元') return R.parseMoney(digits + '元');
    return null;
  }

  /** 伪元素实际显示的文字（content 为单个字符串且伪元素未隐藏时），否则 null。 */
  function generatedText(el, pseudo) {
    const cs = getComputedStyle(el, pseudo);
    if (cs.display === 'none' || cs.visibility === 'hidden') return null;
    const m = /^"(.*)"$/.exec(cs.content || '');
    return m ? m[1].trim() : null;
  }

  /**
   * 拆分价：元素的可见子元素恰为「币种符号 / 整数 / 两位分位」三段，且分位明显更小（字号更小或为 sup），
   * 例如 `$` `17` `99`（无可见小数点）→ $17.99。若同一元素内有读屏副本金额，必须与之相同，否则不认（防过期副本）。
   * 不把 $1799 当成 17.99：只有分位是独立的小号元素时才拆。
   */
  function splitMoney(el) {
    if (el.children.length < 3 || el.children.length > 5) return null;
    const parts = [...el.children].filter((c) => isRendered(c));
    if (parts.length !== 3) return null;
    const [sym, whole, cents] = parts.map((c) => R.normalize(c.textContent));
    if (!PSEUDO_SYMBOLS.has(sym) || !/^\d{1,3}(?:,\d{3})*$|^\d+$/.test(whole) || !/^\d{2}$/.test(cents)) return null;
    const wholeSize = parseFloat(getComputedStyle(parts[1]).fontSize);
    const centsSize = parseFloat(getComputedStyle(parts[2]).fontSize);
    if (!(parts[2].matches('sup') || centsSize < wholeSize)) return null;
    const money = R.parseMoney(sym + whole + '.' + cents);
    if (!money) return null;
    // 读屏副本（不可见的子元素）若是完整金额，必须一致。
    for (const c of el.children) {
      if (parts.includes(c)) continue;
      const dup = R.parseMoney(R.normalize(c.textContent));
      if (dup && (dup.minor !== money.minor || dup.currency !== money.currency)) return null;
    }
    return money;
  }

  function collectCandidates() {
    const found = new Map();
    const body = document.body;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (MONEY_HINT.test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    let count = 0;
    for (let n = walker.nextNode(); n && count < MAX_TEXT_NODES; n = walker.nextNode(), count++) {
      let el = n.parentElement;
      for (let depth = 0; el && el !== body && depth < 4; depth++, el = el.parentElement) {
        if (isOwn(el) || el.closest('script,style,noscript,template,textarea')) break;
        const text = R.normalize(el.textContent);
        if (text.length > MAX_PRICE_TEXT) break;
        // 完整金额，或「当前价标签 + 完整金额」（如 Now $469.99、售价 ¥99）同在一个元素内，
        // 或由可见的「币种 / 整数 / 小号分位」三段拼成的拆分价（无可见小数点）。
        const money = R.parseMoney(text) || R.parseLabeledMoney(text) || splitMoney(el);
        if (money) {
          if (isRendered(el) && !inPageLandmark(el)) found.set(el, money);
          break;
        }
      }
    }
    collectPseudoCurrency(body, found);
    for (const el of body.querySelectorAll('[itemprop="price"]')) {
      if (found.has(el) || isOwn(el) || !isRendered(el) || inPageLandmark(el)) continue;
      const scope = el.closest('[itemscope]');
      const cur = scope && scope.querySelector('[itemprop="priceCurrency"]');
      const code = cur ? cur.getAttribute('content') || cur.textContent : '';
      // 只认可见文字，不用 content 属性冒充可见价格。
      const money = R.parseMicrodataMoney(el.textContent, code);
      if (money) found.set(el, money);
    }
    // 去重：同一价格的祖先与后代都命中时只留最深的元素。
    for (const el of [...found.keys()]) {
      for (let a = el.parentElement, d = 0; a && d < 4; a = a.parentElement, d++) found.delete(a);
    }
    return found;
  }

  /**
   * 页面级导航、页眉、页脚地标里的金额（如「满 $25 免运费」）不是商品价。
   * header/footer 只在页面级时算地标（不在 article/aside/main/nav/section 内，与 HTML 地标语义一致）。
   */
  function inPageLandmark(el) {
    if (el.closest('nav,[role="navigation"],[role="banner"],[role="contentinfo"]')) return true;
    const hf = el.closest('header,footer');
    return !!hf && !(hf.parentElement && hf.parentElement.closest('article,aside,main,nav,section'));
  }

  /** 实际渲染给用户看：CSS 可见，且不是 1px 级的读屏专用/裁切文本。aria-hidden 不代表不可见。 */
  function isRendered(el) {
    if (typeof el.checkVisibility === 'function' &&
        !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    // A max-height:0 accordion can leave descendants technically visible when
    // overflow is clipped by a higher ancestor. Never expand that closed panel.
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      if (getComputedStyle(a).maxHeight === '0px') return false;
    }
    const r = el.getBoundingClientRect();
    return r.width >= 4 && r.height >= 6;
  }

  /**
   * 卡片：语义 Product 或通用卡片选择器；否则最近的紧凑祖先，同时含商品图与链接/按钮；
   * 否则（详情页价格区常无图片）最近的、只含一个 h1/h2 标题且文字有限、并有独立商品证据的祖先。
   * 文字量与标题数限制避免吞下整个多商品列表；正文里的金额没有卡片，不会被标注。
   */
  function findCard(el, candidateAncestors) {
    let a = el.parentElement;
    for (let d = 0; a && a !== document.body && d < MAX_CARD_DEPTH; d++, a = a.parentElement) {
      if (CARD_SELECTORS.some((s) => a.matches(s))) return a;
      if (looksLikeCard(a)) return a;
      if (looksLikeDetail(a, el)) return a;
      if (looksLikeNamedDetail(a, el)) return a;
      if (looksLikeBuyPanel(a)) return a;
      if (candidateAncestors && looksLikeRepeatedTile(a, candidateAncestors)) return a;
    }
    return null;
  }

  /**
   * 无链接/按钮的商品块（点击由页面脚本在外层处理）：块内有 ≥32px 商品图、无 h1/h2、渲染文字不超过 MAX_TILE_TEXT，
   * 且同一父元素下至少还有一个同标签名的兄弟块同样含商品图与价格候选（重复商品列表的结构指纹，不依赖类名）。
   * 正文里的金额没有这种重复兄弟结构，不会被当作商品。
   */
  function looksLikeRepeatedTile(a, candidateAncestors) {
    if (!hasProductMedia(a) || renderedTextLength(a) > MAX_TILE_TEXT || a.querySelector('h1,h2')) return false;
    const p = a.parentElement;
    if (!p) return false;
    for (const s of p.children) {
      if (s === a || s.tagName !== a.tagName || !candidateAncestors.has(s)) continue;
      if (hasProductMedia(s) && renderedTextLength(s) <= MAX_TILE_TEXT) return true;
    }
    return false;
  }

  /**
   * 无 h1/h2 的详情区：唯一的商品名元素（class/id 同时含 product|sku|goods|item 与 title|name，或 itemprop=name）
   * 位于价格之前，标题到价格紧凑，且有独立商品证据（大商品图 + 购买动作）。只有标题或只有图都不够。
   */
  /**
   * 价格所在选项的状态：'addon'（复选框/附加服务）、'selected'（已选单选项/选项）、'unselected'（未选），否则 null。
   * 依据 label 关联的 input、role=radio/option/checkbox、aria-checked/aria-selected、<option>；
   * 价格不在这些元素内时，再向上有界寻找只含一个单选/复选控件的小容器（价格与 label 为兄弟的写法）。
   */
  function optionState(el, card) {
    const opt = el.closest('label,option,[role="radio"],[role="option"],[role="menuitemradio"],[role="checkbox"],[aria-checked],[aria-selected]');
    // 只看卡片内部的选项；卡片自身（如轮播里带 aria-selected 的整张卡）不算选项。
    if (!opt || opt === card || !card.contains(opt)) return optionContainerState(el, card);
    const role = opt.getAttribute('role');
    const input = opt.matches('label') ? opt.control || opt.querySelector('input') : null;
    if (role === 'checkbox' || (input && input.type === 'checkbox')) return 'addon';
    if (input && input.type === 'radio') return input.checked ? 'selected' : 'unselected';
    if (opt.matches('option')) return opt.selected ? 'selected' : 'unselected';
    const flag = opt.hasAttribute('aria-checked') ? opt.getAttribute('aria-checked') : opt.getAttribute('aria-selected');
    if (flag != null) return flag === 'true' ? 'selected' : 'unselected';
    return null;
  }

  /**
   * 单个选项容器：从价格向上最多 MAX_OPTION_DEPTH 层（不越过卡片），第一个含单选/复选控件的祖先
   * 若恰好只含一个控件且渲染文字不超过 MAX_OPTION_TEXT，按该控件状态返回；含多个控件（整组）则不是单个选项。
   */
  function optionContainerState(el, card) {
    for (let a = el.parentElement, d = 0; a && a !== card && d < MAX_OPTION_DEPTH; a = a.parentElement, d++) {
      const controls = a.querySelectorAll('input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"]');
      if (controls.length === 0) continue;
      if (controls.length > 1 || renderedTextLength(a) > MAX_OPTION_TEXT) return null;
      // 含商品链接、标题或商品图的是商品卡片的一部分（如列表卡上的「对比」复选框），不是价格选项。
      if (a.querySelector('a[href],h1,h2,h3,h4,h5,h6') || hasProductMedia(a)) return null;
      const c = controls[0];
      const isCheckbox = c.matches('input[type="checkbox"],[role="checkbox"]');
      if (isCheckbox) return 'addon';
      const checked = c.matches('input') ? c.checked : c.getAttribute('aria-checked') === 'true';
      return checked ? 'selected' : 'unselected';
    }
    return null;
  }

  /**
   * 多个有效价格时：只有全部金额（同币种同数值）一致才取其一——优先非选项价，再优先带价格语义
   * （itemprop=price 或 class/id 含 price/current/sale/now/final），再按文档顺序。金额不一致仍判为有歧义，不猜大小。
   */
  function resolveSameAmount(list) {
    const valid = list.map((c, i) => ({ c, i })).filter((x) => !x.c.reject);
    const keys = new Set(valid.map((x) => x.c.money.currency + ':' + x.c.money.minor));
    if (keys.size !== 1) return { reason: 'ambiguous' };
    const score = (x) => (x.c.option ? 0 : 2) + (hasPriceSemantics(x.c.el) ? 1 : 0);
    let best = valid[0];
    for (const x of valid) if (score(x) > score(best)) best = x;
    return { index: best.i };
  }

  /**
   * 购物车单行：卡片内有数量控件（值 ≥ 2），有效金额恰为两种（同币种），且大者 = 小者 × 数量时，
   * 取大者（该行应付小计）。其余情况仍判为有歧义。订单合计在卡片外，并由 total/合计 等前缀排除。
   */
  function quantityOf(card) {
    const values = new Set();
    const add = (value) => {
      const t = R.normalize(value);
      if (/^[1-9]\d{0,2}$/.test(t)) values.add(Number(t));
    };
    for (const el of card.querySelectorAll(QTY_SELECTOR + ',[role="spinbutton"][aria-valuenow]')) {
      if (isRendered(el)) add(el.value || el.getAttribute('aria-valuenow'));
    }
    // Custom steppers: only a small group with an explicitly named increase control.
    for (const button of card.querySelectorAll('button[aria-label]')) {
      if (!/^(?:increase quantity|increment|增加数量|增加商品数量)$/i.test(button.getAttribute('aria-label')) || !isRendered(button)) continue;
      const group = button.parentElement;
      if (!group || group.children.length > 6 || renderedTextLength(group) > 30) continue;
      for (const child of group.children) {
        if (child.matches('button,input,select')) continue;
        if (isRendered(child)) add(child.textContent);
      }
    }
    return values.size === 1 ? [...values][0] : null;
  }

  /**
   * 商品行小计：卡片（商品行）内有数量控件，有效价格只有一种金额（单价 u），且有带「小计」语义前缀
   * （subtotal / item total / 小计）的金额 s = u × 数量时，取 s。小计前缀在其它情况下仍被排除；
   * 订单汇总不在商品卡片内，不受影响。
   */
  function resolveLineSubtotal(list, card, candidates) {
    const q = quantityOf(card);
    if (!q) return null;
    const valid = list.filter((c) => !c.reject);
    const units = new Set(valid.map((c) => c.money.currency + ':' + c.money.minor));
    if (units.size !== 1) return null;
    const u = valid[0].money;
    const subs = list.map((c, i) => ({ c, i })).filter((x) => x.c.reject === 'context' &&
      x.c.money.currency === u.currency && x.c.money.minor === u.minor * q && isSubtotalLabeled(x.c.el, card, candidates));
    if (!subs.length) return null;
    const best = subs.find((x) => hasPriceSemantics(x.c.el)) || subs[0];
    return { index: best.i };
  }

  function isSubtotalLabeled(el, card, candidates) {
    const ctx = localContext(el, card, candidates);
    return SUBTOTAL_RE.test(R.normalize(ctx.prefix).slice(-24));
  }

  function resolveQuantityLine(list, card) {
    const q = quantityOf(card);
    if (!(q >= 2)) return null;
    const valid = list.map((c, i) => ({ c, i })).filter((x) => !x.c.reject);
    const currencies = new Set(valid.map((x) => x.c.money.currency));
    const amounts = [...new Set(valid.map((x) => x.c.money.minor))].sort((a, b) => a - b);
    if (currencies.size !== 1 || amounts.length !== 2 || amounts[1] !== amounts[0] * q) return null;
    const totals = valid.filter((x) => x.c.money.minor === amounts[1]);
    const best = totals.find((x) => hasPriceSemantics(x.c.el)) || totals[0];
    return { index: best.i };
  }

  function removeControls(scope) {
    return [...scope.querySelectorAll('button,[role="button"]')].filter((el) => {
      const label = R.normalize(el.getAttribute('aria-label') || el.textContent);
      return /^(?:remove(?: item| product)?|remove .+ from (?:cart|bag|basket)|删除|移除|删除商品|移除商品)$/i.test(label) && isRendered(el);
    });
  }

  /** A cart price is not automatically a unit price. Use only complete rows
   * (quantity + removal control) and a local explicit subtotal, never checkout
   * totals or recommendation prices. Incomplete/ambiguous carts do not guess. */
  function resolveCartTotals(list, candidates, stats) {
    const rows = list.map((entry) => ({ entry, quantity: quantityOf(entry.card) }))
      .filter((row) => row.quantity && removeControls(row.entry.card).length);
    if (!rows.some((row) => row.quantity > 1 && !row.entry.lineTotal)) return list;
    const summaries = [];
    for (const [el, money] of candidates) {
      if (rows.some((row) => row.entry.card.contains(el))) continue;
      for (let a = el, d = 0; a && a !== document.body && d < 4; a = a.parentElement, d++) {
        if (a.matches('del,s,strike') || getComputedStyle(a).textDecorationLine.includes('line-through')) break;
        const text = R.normalize(a.innerText);
        if (text.length > 100) break;
        const label = /^(?:subtotal|商品小计|商品金额|小计)\s*[:：]?\s*/i.exec(text);
        if (!label) continue;
        const parsed = R.parseMoney(text.slice(label[0].length));
        if (parsed && parsed.currency === money.currency && parsed.minor === money.minor) {
          summaries.push({ el: a, ...money });
          break;
        }
      }
    }
    const resolved = new Map();
    for (const row of rows) {
      if (resolved.has(row.entry)) continue;
      for (let scope = row.entry.card.parentElement, depth = 0;
          scope && scope !== document.body && depth < 12; scope = scope.parentElement, depth++) {
        const localSummaries = summaries.filter((sum) => scope.contains(sum.el));
        if (!localSummaries.length) continue;
        const group = rows.filter((r) => scope.contains(r.entry.card));
        // Every removal control must belong to exactly one recognized row.
        // An unreadable extra cart item must not be silently omitted from the sum.
        if (removeControls(scope).some((el) => group.filter((r) => r.entry.card.contains(el)).length !== 1)) break;
        const totals = new Set(localSummaries.map((sum) => sum.currency + ':' + sum.minor));
        if (totals.size !== 1 || group.some((r) => r.entry.currency !== localSummaries[0].currency)) break;
        const amounts = R.resolveCartAmounts(group.map((r) => ({ minor: r.entry.minor,
          quantity: r.quantity, lineTotal: r.entry.lineTotal })), localSummaries[0].minor);
        if (amounts) group.forEach((r, i) => resolved.set(r.entry, amounts[i]));
        break;
      }
    }
    const unknown = new Set(rows.filter((r) => r.quantity > 1 && !r.entry.lineTotal && !resolved.has(r.entry)).map((r) => r.entry));
    stats.ambiguous += unknown.size;
    return list.filter((entry) => !unknown.has(entry)).map((entry) =>
      resolved.has(entry) ? { ...entry, minor: resolved.get(entry) } : entry);
  }

  function hasPriceSemantics(el) {
    for (let a = el, d = 0; a && d < 4; a = a.parentElement, d++) {
      if (a.getAttribute('itemprop') === 'price') return true;
      if (PRICE_SEMANTIC_RE.test((a.getAttribute('class') || '') + ' ' + (a.id || ''))) return true;
    }
    return false;
  }

  /**
   * 区域内的商品名元素：先按可见、长度 4–300 字、（给定价格时）位于价格之前且不含价格筛选，
   * 再取最外层；强语义（product/sku/goods + title/name，或 itemprop=name）优先，只有没有强语义时才用
   * 弱语义（item + title/name）。价格之后的辅助小标题（如分期项名称）不参与唯一性判断。
   */
  function namedTitles(a, priceEl) {
    const named = [...a.querySelectorAll(TITLE_CANDIDATES)].filter((t) => {
      const sem = (t.getAttribute('class') || '') + ' ' + (t.id || '');
      if (t.getAttribute('itemprop') !== 'name' && !PRODUCT_TITLE_RE.test(sem)) return false;
      const len = R.normalize(t.textContent).length;
      if (len < 4 || len > 300 || !isRendered(t)) return false;
      if (priceEl && (t.contains(priceEl) || !(t.compareDocumentPosition(priceEl) & Node.DOCUMENT_POSITION_FOLLOWING))) return false;
      return true;
    });
    const outer = named.filter((t) => !named.some((o) => o !== t && o.contains(t)));
    const strong = outer.filter((t) => t.getAttribute('itemprop') === 'name' ||
      STRONG_TITLE_RE.test((t.getAttribute('class') || '') + ' ' + (t.id || '')));
    return strong.length ? strong : outer;
  }

  /**
   * 独立购买区（详情页右栏这类）：最近的、渲染文字有限且含真实购买动作（购买动词 + 可点击）的祖先，
   * 商品标题与商品图可以在兄弟列——要求向上有界范围内存在只含一个 h1（或一个商品名元素）且有大商品图的公共祖先。
   * 任意按钮或广告图都不够：必须是购买动词文本。
   */
  function looksLikeBuyPanel(a) {
    if (renderedTextLength(a) > MAX_BUYBOX_TEXT) return false;
    if (!hasPurchaseAction(a)) return false;
    for (let c = a.parentElement, d = 0; c && c !== document.body && d < MAX_PANEL_CONTEXT_DEPTH; c = c.parentElement, d++) {
      const h1s = c.querySelectorAll('h1').length;
      if (h1s > 1) return false;
      const titled = h1s === 1 || namedTitles(c).length === 1;
      if (titled && hasProductMedia(c)) return true;
    }
    return false;
  }

  function looksLikeNamedDetail(a, priceEl) {
    const outer = namedTitles(a, priceEl);
    if (outer.length !== 1) return false;
    const t = outer[0];
    if (!titleToPriceCompact(a, t, priceEl)) return false;
    return hasCommerceEvidence(a);
  }

  /**
   * 购买动作：可见的短文本恰为购买动词（中英），且所在元素可点击（按钮/链接/role=button，或计算样式 cursor:pointer）。
   * 有界扫描文本节点；单次扫描内缓存。
   */
  let purchaseCache = new Map();
  function hasPurchaseAction(el) {
    let ok = purchaseCache.get(el);
    if (ok != null) return ok;
    ok = false;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let count = 0;
    for (let n = walker.nextNode(); n && count < MAX_PURCHASE_SCAN; n = walker.nextNode(), count++) {
      if (!PURCHASE_TEXT.test(R.normalize(n.data))) continue;
      const p = n.parentElement;
      if (!p || isOwn(p) || !isRendered(p)) continue;
      if (p.closest(PURCHASE + ',a[href]') || getComputedStyle(p).cursor === 'pointer') {
        ok = true;
        break;
      }
    }
    purchaseCache.set(el, ok);
    return ok;
  }

  /**
   * 含真正的商品图：可见、尺寸至少 MIN_MEDIA_PX × MIN_MEDIA_PX 的图片类元素。
   * 小图标、评分星、会员/配送徽标不算。检查全部图片类元素（有界），不只看第一个。单次扫描内缓存。
   */
  let mediaCache = new Map();
  function hasProductMedia(el) {
    let ok = mediaCache.get(el);
    if (ok != null) return ok;
    ok = false;
    const list = el.querySelectorAll(MEDIA + ',[role="img"]');
    for (let i = 0; i < list.length && i < MAX_MEDIA_CHECK; i++) {
      const m = list[i];
      if (typeof m.checkVisibility === 'function' &&
          !m.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      const r = m.getBoundingClientRect();
      if (r.width >= MIN_MEDIA_PX && r.height >= MIN_MEDIA_PX) {
        ok = true;
        break;
      }
    }
    mediaCache.set(el, ok);
    return ok;
  }

  function looksLikeCard(a) {
    if (!hasProductMedia(a)) return false;
    if (!a.querySelector('a[href],button,[role="button"]')) return false;
    return renderedTextLength(a) <= MAX_CARD_TEXT;
  }

  /**
   * 卡片文字量按渲染出来的文字计（innerText），不计内联 style/script、未渲染内容和本扩展的提醒文字；
   * 单次扫描内缓存，避免对大区域重复计算。
   */
  let textLengthCache = new Map();
  function renderedTextLength(el) {
    let n = textLengthCache.get(el);
    if (n == null) {
      n = R.normalize(String(el.innerText).replace(OWN_TEXT, '')).length;
      textLengthCache.set(el, n);
    }
    return n;
  }

  /**
   * 详情页价格区：只含一个 h1/h2 标题（在价格之前）、文字有限，且有独立的商品证据
   * （位于 schema Product 内，或自身/最多四层祖先同时含商品图与购买控件）。只有标题的正文区块不算。
   */
  function looksLikeDetail(a, priceEl) {
    const h1s = a.querySelectorAll('h1');
    if (h1s.length > 1) return false;
    if (h1s.length === 1) return titledDetail(a, h1s[0], priceEl);
    const headings = a.querySelectorAll('h1,h2');
    if (headings.length !== 1) return false;
    const h = headings[0];
    if (!R.normalize(h.textContent)) return false;
    // 标题须在价格之前（商品标题在上、价格在下）。
    if (!(h.compareDocumentPosition(priceEl) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
    if (renderedTextLength(a) > MAX_DETAIL_TEXT) return false;
    return hasCommerceEvidence(a);
  }

  /**
   * 带唯一 h1 商品标题的详情区：不看整块文字量（价格之后的规格、说明、评论可以很长），
   * 只要求标题到价格之间这一段紧凑——可见文字不超过 MAX_TITLE_TO_PRICE_TEXT，且中间没有另起小节的标题；
   * 再要求独立商品证据。
   */
  function titledDetail(a, h, priceEl) {
    if (!R.normalize(h.textContent)) return false;
    if (!(h.compareDocumentPosition(priceEl) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
    if (!titleToPriceCompact(a, h, priceEl)) return false;
    return hasCommerceEvidence(a);
  }

  function titleToPriceCompact(a, h, priceEl) {
    const walker = document.createTreeWalker(a, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && NON_TEXT_ELEMENTS.has(n.nodeName)
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    walker.currentNode = h;
    let chars = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (h.contains(n)) continue;
      if (n === priceEl || n.contains(priceEl)) {
        if (n === priceEl) return true;
        continue;
      }
      if (n.nodeType === Node.ELEMENT_NODE) {
        // 标题与价格之间另起小节；隐藏的标题（弹窗/响应式模板）不算分界。
        if (/^H[1-6]$/.test(n.nodeName) && isVisibleHeading(n)) return false;
        continue;
      }
      if (!isOwn(n) && isRenderedText(n)) {
        chars += R.normalize(n.data).length;
        if (chars > MAX_TITLE_TO_PRICE_TEXT) return false;
      }
    }
    return false;
  }

  /** 实际显示的标题：CSS 可见且有尺寸（display:none、visibility:hidden 的模板/弹窗标题不算）。 */
  function isVisibleHeading(h) {
    if (typeof h.checkVisibility === 'function' &&
        !h.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = h.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function isRenderedText(n) {
    const p = n.parentElement;
    return !!p && (typeof p.checkVisibility !== 'function' ||
      p.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  }

  /** 卡片内唯一 h1 之后、候选之前出现另起小节的标题（h2–h6）：候选不在商品标题所在小节，不作主价。 */
  function outsideTitleSection(card, el) {
    const h1s = card.querySelectorAll('h1');
    if (h1s.length !== 1) return false;
    const h = h1s[0];
    if (!(h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
    for (const hd of card.querySelectorAll('h2,h3,h4,h5,h6')) {
      if (!isVisibleHeading(hd)) continue;
      if ((h.compareDocumentPosition(hd) & Node.DOCUMENT_POSITION_FOLLOWING) &&
          (hd.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) return true;
    }
    return false;
  }

  function hasCommerceEvidence(a) {
    if (a.closest(SCHEMA_CARD)) return true;
    for (let c = a, d = 0; c && c !== document.body && d < MAX_EVIDENCE_DEPTH; c = c.parentElement, d++) {
      // 不越过含多个 h1 的范围（可能已是整页或多商品区域）。
      if (c.querySelectorAll('h1').length > 1) return false;
      if ((c.querySelector(PURCHASE) || hasPurchaseAction(c)) && hasProductMedia(c)) return true;
    }
    return false;
  }

  /** 外层区域唯一的 h1/h2 位于内层卡片中：两者属于同一商品。 */
  function sharesProductHeading(outer, inner) {
    const headings = outer.querySelectorAll('h1,h2');
    return headings.length === 1 && inner.contains(headings[0]);
  }

  function rejectReason(el, card, candidates) {
    // 配送选项可能包含卡车图标，结构类似商品卡。选中的运费仍不是商品售价。
    const option = el.closest('label,[role="radio"]');
    if (option && (option.matches('[role="radio"]') ||
        option.querySelector('input[type="radio"]') || option.control?.type === 'radio')) {
      const text = option.innerText || '';
      if (text.length <= MAX_OPTION_TEXT &&
          /\b(?:shipping|delivery|postage|freight)\b|运费|配送|快递|邮费/i.test(text)) return 'fee';
    }
    for (let a = el; a; a = a.parentElement) {
      if (a.matches('del,s,strike')) return 'struck';
      if (getComputedStyle(a).textDecorationLine.includes('line-through')) return 'struck';
      if (a === card) break;
    }
    const ctx = localContext(el, card, candidates);
    return R.localContextReason(ctx.prefix, ctx.suffix);
  }

  /**
   * 价格前后紧邻文字，限定在价格所在的「行」：最近的块级祖先（行内与 inline-block 的纯价格包装都算同一行），
   * 不越过卡片，最多 MAX_LINE_DEPTH 层。行内嵌套的其它块（上一行/下一行）不计入：之前的块清空前缀，之后的块截止后缀。
   * 包含其它价格候选的子树与本扩展宿主不计入。规则只取前后缀紧邻的约 24 字（见 rules.localContextReason）。
   */
  function localContext(el, card, candidates) {
    let scope = null;
    for (let a = el.parentElement, d = 0; a && a !== card && d < MAX_LINE_DEPTH; a = a.parentElement, d++) {
      scope = a;
      if (isBlockLevel(a)) break;
    }
    if (!scope) return { prefix: '', suffix: '' };
    let prefix = '';
    let suffix = '';
    let after = false;
    // 只遍历可见内容：隐藏子树（display:none / visibility:hidden 的弹窗、比较面板模板）与 script/style 整棵跳过，
    // 所以行容器的源码再长也不会清空上下文。遍历节点数与收集长度有界。
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        if (n === el || n.contains(el)) return NodeFilter.FILTER_SKIP;
        if (NON_TEXT_ELEMENTS.has(n.nodeName) || isOwn(n)) return NodeFilter.FILTER_REJECT;
        if (typeof n.checkVisibility === 'function' &&
            !n.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      },
    });
    let visited = 0;
    for (let n = walker.nextNode(); n && visited < MAX_LINE_NODES; n = walker.nextNode(), visited++) {
      if (el.contains(n)) {
        after = true;
        continue;
      }
      if (insideOtherCandidate(n, el, scope, candidates)) continue;
      const nested = nestedBlockKind(n, scope, el);
      if (nested === 'skip') continue;
      if (nested === 'block') {
        if (after) break;
        prefix = '';
        continue;
      }
      if (after) {
        suffix += n.data;
        if (suffix.length > MAX_CONTEXT_COLLECT) break;
      } else {
        prefix = (prefix + n.data).slice(-MAX_CONTEXT_COLLECT);
      }
    }
    return { prefix, suffix };
  }

  function isBlockLevel(el) {
    return BLOCK_DISPLAYS.has(getComputedStyle(el).display);
  }

  /**
   * 文本在行容器内的归属：'skip' 脱离文档流（绝对/固定定位，如读屏专用重复文本），不计入也不算换行；
   * 'block' 位于另一个不含价格的块级元素中（上一行/下一行）；false 同一行。
   */
  function nestedBlockKind(n, scope, el) {
    for (let a = n.parentElement; a && a !== scope; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.position === 'absolute' || cs.position === 'fixed') return 'skip';
      if (!a.contains(el) && BLOCK_DISPLAYS.has(cs.display)) {
        // flex 的直接子元素计算为 block，但横排且与价格垂直重叠时仍是同一行。
        const parent = a.parentElement;
        const layout = parent && getComputedStyle(parent);
        const ar = a.getBoundingClientRect(), er = el.getBoundingClientRect();
        const sameFlexRow = parent && parent.contains(el) &&
          (layout.display === 'flex' || layout.display === 'inline-flex') &&
          layout.flexDirection.startsWith('row') && Math.min(ar.bottom, er.bottom) > Math.max(ar.top, er.top);
        if (!sameFlexRow) return 'block';
      }
    }
    return false;
  }

  function insideOtherCandidate(node, self, scope, candidates) {
    for (let a = node.parentElement; a && a !== scope; a = a.parentElement) {
      if (a !== self && candidates.has(a)) return true;
    }
    return false;
  }

  /**
   * 提醒插入位置：从价格元素向上取最高的「纯价格组」——不越过卡片，不含标题、控件、图片类元素，
   * 渲染文字不超过 MAX_ROW_TEXT。这样原价与旁边的单价仍在同一原始行，提醒插在整行下面，
   * 而不会插到含图片/标题的整个商品容器之后。
   */
  function priceRow(el, card) {
    let row = el;
    for (let a = el.parentElement, d = 0; a && a !== card && d < MAX_ROW_DEPTH; a = a.parentElement, d++) {
      if (a.querySelector(NOT_PRICE_GROUP)) break;
      if (renderedTextLength(a) > MAX_ROW_TEXT) break;
      row = a;
    }
    return row;
  }

  // ---------- 渲染（文档流内独立一行，按价格元素复用） ----------

  function render() {
    rafId = 0;
    if (!running) return;
    const stats = emptyRenderStats();
    const live = new Set();
    const positionedRows = new Set();
    for (const e of entries) {
      if (!isEntryValid(e)) continue;
      const label = R.moneyLabel(e.minor, milli, e.currency);
      if (!label) continue;
      live.add(e.el);
      const b = ensureBadge(e.el);
      updateBadge(b, label, e.currency);
      const anchor = placementAnchor(e.row, e.card);
      normalizeFloatingPrice(anchor);
      positionedRows.add(anchor);
      placeBadge(b, anchor);
      const r = e.el.getBoundingClientRect();
      let state = 'shown';
      if (r.width <= 0 || r.height <= 0) {
        state = 'gone';
      } else if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) {
        stats.offscreen++;
      } else if (isOccluded(e, r)) {
        // 价格被弹窗/浮层盖住：保留占位避免页面跳动，只隐藏提醒。
        state = 'hidden';
        stats.occluded++;
      } else {
        stats.labeled++;
      }
      applyState(b, state);
    }
    for (const [el, b] of badges) {
      if (!live.has(el)) {
        b.host.remove();
        badges.delete(el);
      }
    }
    for (const [a, fix] of positionFixes) if (!positionedRows.has(a)) restorePosition(a, fix);
    fixClipping();
    renderStats = stats;
  }

  // ---------- 因插入提醒造成的裁切：临时提高有界 overflow:hidden/clip 祖先的 min-height ----------

  // 提醒宿主到轮播视口这类裁切容器之间常有卡片内外多层包装。
  const MAX_CLIP_DEPTH = 12;
  const HOST_MARGIN_PX = 10; // :host 上下 margin 4 + 6
  // 已调整的商家元素 -> { orig, prio, applied, cap }
  const clipFixes = new Map();
  const positionFixes = new Map();

  // 竖排紧凑商品卡的底部绝对定位价格不占高度，会与新提醒重叠。
  // 仅将无变换或纯水平居中的价格行恢复为文档流；停用时恢复原样式。
  function normalizeFloatingPrice(row) {
    if (positionFixes.has(row)) return;
    const p = row.parentElement;
    if (!p) return;
    const s = getComputedStyle(row), layout = getComputedStyle(p);
    const matrix = /^matrix\(1, 0, 0, 1, (-?[\d.]+), 0\)$/.exec(s.transform);
    const centered = matrix && layout.alignItems === 'center' &&
      Math.abs(Number(matrix[1]) + row.getBoundingClientRect().width / 2) <= 1;
    if (s.position !== 'absolute' || (s.transform !== 'none' && !centered) ||
        !layout.display.includes('flex') || layout.flexDirection !== 'column') return;
    positionFixes.set(row, {
      orig: row.style.getPropertyValue('position'), prio: row.style.getPropertyPriority('position'),
      transform: row.style.getPropertyValue('transform'), transformPrio: row.style.getPropertyPriority('transform'), centered,
    });
    row.style.setProperty('position', 'static', 'important');
    if (centered) row.style.setProperty('transform', 'none', 'important');
  }

  function restorePosition(row, fix) {
    positionFixes.delete(row);
    if (row.style.getPropertyValue('position') !== 'static' || row.style.getPropertyPriority('position') !== 'important') return;
    restoredStyles.add(row);
    if (fix.orig) row.style.setProperty('position', fix.orig, fix.prio);
    else row.style.removeProperty('position');
    if (fix.centered && row.style.getPropertyValue('transform') === 'none' && row.style.getPropertyPriority('transform') === 'important') {
      if (fix.transform) row.style.setProperty('transform', fix.transform, fix.transformPrio);
      else row.style.removeProperty('transform');
    }
  }

  /**
   * 对每条显示中的提醒，向上（有界）检查 overflow-y 为 hidden/clip 的祖先：
   * 若内容被裁且超出部分不大于其内提醒的总高度（即由提醒造成），把 min-height 提到内容高度。
   * 不处理 auto/scroll 滚动区域，不改 width/overflow；超过「原高度 + 提醒总高」的上限不再增长。
   */
  function fixClipping() {
    for (const b of badges.values()) {
      if (b.state === 'gone' || !b.host.isConnected) continue;
      for (let a = b.host.parentElement, d = 0; a && a !== document.body && d < MAX_CLIP_DEPTH; a = a.parentElement, d++) {
        const cs = getComputedStyle(a);
        if (cs.overflowY !== 'hidden' && cs.overflowY !== 'clip') continue;
        const overflow = a.scrollHeight - a.clientHeight;
        if (overflow <= 1) continue;
        const own = ownHeightWithin(a);
        if (overflow > own + 2) continue; // 不是（仅）由提醒造成的裁切，不处理。
        let fix = clipFixes.get(a);
        if (!fix) {
          fix = {
            orig: a.style.getPropertyValue('min-height'),
            prio: a.style.getPropertyPriority('min-height'),
            applied: '',
            cap: a.clientHeight + own + 4,
          };
          clipFixes.set(a, fix);
        }
        const padV = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
        const borderV = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
        const content = Math.min(a.scrollHeight, fix.cap);
        const need = Math.ceil(cs.boxSizing === 'border-box' ? content + borderV : content - padV);
        const value = need + 'px';
        if (a.style.getPropertyValue('min-height') === value) continue;
        fix.applied = value;
        a.style.setProperty('min-height', value, fix.prio);
      }
    }
    // 不再含提醒的容器恢复原值；商家已自行改过 min-height 的不覆盖，只忘记。
    for (const [a, fix] of clipFixes) {
      if (a.isConnected && a.querySelector(HOST_TAG)) continue;
      restoreClipFix(a, fix);
    }
  }

  function ownHeightWithin(a) {
    let h = 0;
    for (const host of a.querySelectorAll(HOST_TAG)) {
      if (host.style.display === 'none') continue;
      h += host.getBoundingClientRect().height + HOST_MARGIN_PX;
    }
    // 原先脱离文档流的价格恢复后，也增加了真实内容高度。
    for (const row of positionFixes.keys()) {
      if (!a.contains(row)) continue;
      const cs = getComputedStyle(row);
      h += row.getBoundingClientRect().height + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
    }
    return h;
  }

  function restoreClipFix(a, fix) {
    clipFixes.delete(a);
    if (a.style.getPropertyValue('min-height') !== fix.applied) return;
    restoredStyles.add(a);
    if (fix.orig) a.style.setProperty('min-height', fix.orig, fix.prio);
    else a.style.removeProperty('min-height');
  }

  /** 本扩展设置/恢复 min-height 引起的 style 变化。 */
  function isOwnStyleMutation(m) {
    if (m.type !== 'attributes' || m.attributeName !== 'style') return false;
    if (positionFixes.has(m.target) && m.target.style.getPropertyValue('position') === 'static') return true;
    const fix = clipFixes.get(m.target);
    if (fix) return m.target.style.getPropertyValue('min-height') === fix.applied;
    return restoredStyles.delete(m.target);
  }
  // 刚由本扩展恢复 min-height 的元素（用于忽略恢复引起的一次 style 变化）。
  const restoredStyles = new WeakSet();

  function ensureBadge(el) {
    let b = badges.get(el);
    if (b) return b;
    const host = document.createElement(HOST_TAG);
    host.setAttribute('aria-hidden', 'true');
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const badge = document.createElement('div');
    badge.className = 'badge';
    const lead = document.createElement('span');
    lead.className = 'lead';
    lead.textContent = LEAD_TEXT;
    const amt = document.createElement('span');
    amt.className = 'amt';
    badge.append(lead, amt);
    shadow.append(style, badge);
    b = { host, badge, amt, key: '', state: '' };
    badges.set(el, b);
    return b;
  }

  /** 由 moneyLabel 的旧返回（「10年≈$7」「10年≈150」「10年≈EUR 7」）组成可见文案；只有金额加粗放大。 */
  function updateBadge(b, label, currency) {
    const key = label + '|' + milli;
    if (b.key === key) return;
    b.key = key;
    let amount = label.replace(/^10年≈/, '');
    if (currency === 'CNY') amount = '¥' + amount;
    b.amt.textContent = amount;
    b.badge.title = '假设这笔钱不花，按 ' + R.formatMultiplier(milli) +
      ' 倍估算 10 年后约值多少（含本金，按今天购买力理解）。不是折扣，也不是收益承诺。';
  }

  /**
   * 插入锚点：价格组的父元素若是不换行的横向 flex（如「价格 + 价格历史按钮」一行），提醒放进去会排在右侧并被裁切；
   * 改为向上取这一整行作为锚点，提醒插在整行之后（不越过卡片，最多 MAX_ANCHOR_DEPTH 层），不改商家 flex 布局。
   */
  function placementAnchor(row, card) {
    let a = row;
    for (let d = 0; d < MAX_ANCHOR_DEPTH; d++) {
      const p = a.parentElement;
      if (!p || p === card || p === document.body) break;
      const cs = getComputedStyle(p);
      if (!(cs.display.includes('flex') && cs.flexDirection.startsWith('row') && cs.flexWrap === 'nowrap')) break;
      a = p;
    }
    return a;
  }

  /** 插在价格组之后（同一父元素内）；表格/列表等父元素下改为价格组内部末尾。只在位置不对时移动。 */
  function placeBadge(b, row) {
    const parent = row.parentElement;
    if (!parent || APPEND_INSIDE_PARENTS.has(parent.nodeName)) {
      if (b.host.parentNode !== row || row.lastChild !== b.host) row.append(b.host);
    } else if (row.nextSibling !== b.host) {
      row.after(b.host);
    }
    // 只在横向、可换行的 flex 父元素中独占一行；宿主属性变化会被 MutationObserver 忽略。
    const p = b.host.parentElement;
    let basis = '';
    if (p) {
      const cs = getComputedStyle(p);
      if (cs.display.includes('flex') && cs.flexDirection.startsWith('row') && cs.flexWrap !== 'nowrap') basis = '100%';
    }
    if (b.host.style.flexBasis !== basis) b.host.style.flexBasis = basis;
  }

  function applyState(b, state) {
    if (b.state === state) return;
    b.state = state;
    b.host.style.display = state === 'gone' ? 'none' : '';
    b.host.style.visibility = state === 'hidden' ? 'hidden' : '';
  }

  /** 价格本身被其它元素（弹窗、遮罩、浮层）盖住；采样点最上层必须是价格自身。 */
  function isOccluded(e, r) {
    const pts = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + r.width * 0.2, r.top + r.height * 0.3],
      [r.right - r.width * 0.2, r.bottom - r.height * 0.3],
    ];
    for (const [x, y] of pts) {
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      const top = document.elementFromPoint(x, y);
      if (!top || !(top === e.el || e.el.contains(top) || top.contains(e.el))) return true;
    }
    return false;
  }

  // ---------- 扩展通信（仅本扩展） ----------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !msg) return false;
    if (msg.type === 'fp:status') {
      sendResponse(status());
    } else if (msg.type === 'fp:stop') {
      stop();
      sendResponse(status());
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.sites || changes.milli)) sync();
  });

  globalThis[KEY] = { sync, stop, status };
  sync();
})();
