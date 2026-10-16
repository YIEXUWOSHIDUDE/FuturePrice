/*
 * 纯规则：金额解析（人民币及通用符号/代码）、倍数定点计算、上下文拒绝、主价选择、站点匹配模式。
 * 内容脚本、popup、后台与 node 测试共用；不访问 DOM 或网络。
 */
(function (root) {
  'use strict';

  const MAX_CENTS = 1000000000; // ¥10,000,000.00
  const MIN_MILLI = 1000;
  const MAX_MILLI = 10000;
  const DEFAULT_MILLI = 1500;

  const NUM = '((?:\\d{1,3}(?:,\\d{3})+)|\\d+)(?:\\.(\\d{1,2}))?';
  const PREFIXED = new RegExp('^[¥￥] ?' + NUM + '$');
  const SUFFIXED = new RegExp('^' + NUM + ' ?元$');
  const BARE = new RegExp('^' + NUM + '$');
  // 旧 API：parsePriceText(text, 'USD') 只接受「$金额」；内容脚本改用通用 parseMoney。
  const USD_PREFIXED = new RegExp('^\\$ ?' + NUM + '$');
  const RANGE = /\d\s*[-~～—–至到]\s*[¥￥]?\s*\d/;
  const USD_RANGE = /\d\s*(?:[-~—–]|\bto\b)\s*\$?\s*\d/i;
  // 美元价格附近的估价、单价、划线/原价、运费、优惠、信用卡、订阅、分期等词。
  const USD_WORDS = /\b(?:est|estimated|each|count|per|unit|list|was|typical|shipping|delivery|save|coupon|credit|card|gift|subscribe|subscription|monthly|month|mo|installments?|payments?|from|starting)\b/i;
  // 价格附近出现这些词时，不能确定是商品主价（券后、会员、分期、销量、运费、合计、划线等）。
  const CONTEXT_WORDS = [
    '月供', '/月', '每月', '分期', '期', '券', '优惠', '立减', '减', '省', '折', '返', '会员', 'PLUS', 'plus',
    '到手', '起', '满', '运费', '邮费', '总计', '合计', '小计', '原价', '划线', '月销', '已售', '销量', '定金',
  ];

  // ---- 通用金额：保留页面上的符号/代码，不推断国家，不做汇率换算 ----
  const CODES = ['CNY', 'RMB', 'USD', 'EUR', 'GBP', 'HKD', 'CAD', 'AUD'];
  const SYMBOL_MONEY = new RegExp('^([¥￥$€£]) ?' + NUM + '$');
  const CODE_PREFIX = new RegExp('^(' + CODES.join('|') + ') ?' + NUM + '$');
  const CODE_SUFFIX = new RegExp('^' + NUM + ' ?(' + CODES.join('|') + ')$');
  const QUALIFIED_DOLLAR = new RegExp('^(US|CA|AU|HK) ?\\$ ?' + NUM + '$');
  const DOLLAR_CODES = { US: 'USD', CA: 'CAD', AU: 'AUD', HK: 'HKD' };
  // 当前售价标签（与金额同在一个文字节点时使用）。
  // 较长的标签在前，避免「Sale price」被「Sale」先匹配。
  const CURRENT_LABEL = /^(?:(?:sale price|our price|your price|current price|price|sale|now)\s*:?|(?:促销价|活动价|售价|现价|价格)\s*[:：]?)\s*(\S.*)$/i;
  // 价格紧邻前后缀（不跨括号）：单价、区间、估价、划线/原价、优惠、订阅、分期、运费等。
  const UNIT_START = /^\s*(?:\/|per\b|each\b|每|起)/i;
  // 区间：后缀以连接符开头（其后是数字或已被剔除的另一个价格），或前缀以连接符结尾。
  const RANGE_START = /^\s*(?:[-~～—–至到]|to\b)\s*(?:[¥￥$€£]?\s*\d|$)/i;
  const RANGE_END = /(?:^|\d)\s*(?:[-~～—–至到]|\bto)\s*$/i;
  const EN_PREFIX = /\b(?:est|estimated|list|was|typical|from|starting|save|coupon|subscribe|subscription|members?|deposit|shipping|delivery|financing|credit|gift|rewards?|approval|visa|mastercard|amex|subtotal|total|tax|taxes)\b/i;
  // 后缀同样排除礼品卡、信用卡、优惠券、返现/积分等促销金额（如「$150 Gift Card」）。
  const EN_SUFFIX = /\b(?:mo|month|monthly|installments?|payments?|shipping|delivery|off|gift|card|credit|coupons?|rewards?|cashback|points|approval|visa|mastercard|amex|apr|members?)\b/i;
  // 「$599 or $49.92/mo」：前后缀在「or / 或」处截断，另一种付款方式的说明不影响本价格。
  const ALT_SPLIT = /\bor\b|或/i;

  function normalize(text) {
    return String(text == null ? '' : text).replace(/[\s ]+/g, ' ').trim();
  }

  function toCents(intPart, fracPart) {
    const digits = intPart.replace(/,/g, '');
    if (digits.length > 8) return null;
    const cents = Number(digits) * 100 + Number((fracPart || '').padEnd(2, '0'));
    return Number.isSafeInteger(cents) && cents >= 1 && cents <= MAX_CENTS ? cents : null;
  }

  /**
   * 整段文字恰为完整金额时返回分（最小货币单位），否则 null。
   * currency 默认 'CNY'（「¥/￥金额」或「金额元」）；'USD' 只接受「$金额」。其它币种返回 null。
   */
  function parsePriceText(text, currency) {
    const t = normalize(text);
    const cur = currency || 'CNY';
    let m = null;
    if (cur === 'CNY') m = PREFIXED.exec(t) || SUFFIXED.exec(t);
    else if (cur === 'USD') m = USD_PREFIXED.exec(t);
    return m ? toCents(m[1], m[2]) : null;
  }

  function canonicalCode(code) {
    return code === 'RMB' ? 'CNY' : code;
  }

  function isCurrencyCode(code) {
    return CODES.includes(normalize(code).toUpperCase());
  }

  /**
   * 通用金额：整段文字恰为「符号+金额」「金额元」「代码+金额」「金额+代码」时返回
   * { minor, currency }。currency 为 'CNY'（¥/￥/元/CNY/RMB）、页面符号（'$' '€' '£'）或货币代码。
   * '$' 只表示页面显示的符号，不推断是哪国货币。不支持逗号作小数点的写法。
   */
  function parseMoney(text) {
    const t = normalize(text);
    const qualified = QUALIFIED_DOLLAR.exec(t);
    if (qualified) {
      const minor = toCents(qualified[2], qualified[3]);
      return minor == null ? null : { minor, currency: DOLLAR_CODES[qualified[1]] };
    }
    let m = SYMBOL_MONEY.exec(t);
    if (m) {
      const minor = toCents(m[2], m[3]);
      return minor == null ? null : { minor, currency: m[1] === '¥' || m[1] === '￥' ? 'CNY' : m[1] };
    }
    m = SUFFIXED.exec(t);
    if (m) {
      const minor = toCents(m[1], m[2]);
      return minor == null ? null : { minor, currency: 'CNY' };
    }
    m = CODE_PREFIX.exec(t);
    if (m) {
      const minor = toCents(m[2], m[3]);
      return minor == null ? null : { minor, currency: canonicalCode(m[1]) };
    }
    m = CODE_SUFFIX.exec(t);
    if (m) {
      const minor = toCents(m[1], m[2]);
      return minor == null ? null : { minor, currency: canonicalCode(m[3]) };
    }
    return null;
  }

  /**
   * 带「当前价」标签的完整金额：整段文字恰为「标签 + 完整金额」，如「Now $469.99」「Sale price: $1,299」
   * 「售价 ¥99」「现价：￥49.90」。标签只限少数表示当前售价的词；Was/List/You save/起/到手/券后、月供等
   * 不在其中，仍不解析。金额部分沿用 parseMoney 的严格整段规则。旧 parsePriceText 不受影响。
   */
  function parseLabeledMoney(text) {
    const m = CURRENT_LABEL.exec(normalize(text));
    return m ? parseMoney(m[1]) : null;
  }

  /** 结构化标记（microdata）：纯数字金额 + 有效货币代码。 */
  function parseMicrodataMoney(amountText, code) {
    if (!isCurrencyCode(code || '')) return null;
    const minor = parseBareAmount(amountText);
    return minor == null ? null : { minor, currency: canonicalCode(normalize(code).toUpperCase()) };
  }

  /**
   * 通用标签：同币种按倍数换算，不换汇。CNY 保持「10年≈150」；符号币种「10年≈$6」；代码「10年≈EUR 6」。
   */
  function moneyLabel(minor, milli, currency) {
    const units = futureYuan(minor, milli);
    if (units == null) return null;
    if (currency === 'CNY') return '10年≈' + units;
    if (currency === '$' || currency === '€' || currency === '£') return '10年≈' + currency + units;
    if (CODES.includes(currency)) return '10年≈' + currency + ' ' + units;
    return null;
  }

  /**
   * 价格紧邻上下文的拒绝原因：'range' | 'unit' | 'context' | null。
   * prefix/suffix 为价格前后同一小容器内的文字；前缀截到最后一个右括号之后，后缀截到第一个左括号之前，
   * 这样相邻的「(¥1.23/件)」类单价注释不会让主价被拒。
   */
  function localContextReason(prefix, suffix) {
    let p = normalize(prefix);
    const cut = Math.max(p.lastIndexOf(')'), p.lastIndexOf('）'));
    if (cut >= 0) p = p.slice(cut + 1);
    const alts = p.split(ALT_SPLIT);
    p = alts[alts.length - 1];
    p = p.slice(-24);
    let s = normalize(suffix);
    const open = s.search(/[(（]/);
    if (open >= 0) s = s.slice(0, open);
    s = s.split(ALT_SPLIT)[0];
    s = s.slice(0, 24);
    if (RANGE_END.test(p) || RANGE_START.test(s)) return 'range';
    if (UNIT_START.test(s)) return 'unit';
    if (EN_PREFIX.test(p) || EN_SUFFIX.test(s)) return 'context';
    for (const w of CONTEXT_WORDS) if (p.includes(w) || s.includes(w)) return 'context';
    return null;
  }

  /** 纯数字金额（仅用于结构化标记已声明货币代码的价格）。 */
  function parseBareAmount(text) {
    const m = BARE.exec(normalize(text));
    return m ? toCents(m[1], m[2]) : null;
  }

  /** 附近文字的拒绝原因：'range' | 'context' | null。currency 默认 'CNY'。 */
  function contextReason(text, currency) {
    const t = normalize(text);
    if ((currency || 'CNY') === 'USD') {
      if (USD_RANGE.test(t)) return 'range';
      if (t.includes('/') || USD_WORDS.test(t)) return 'context';
      return null;
    }
    if (RANGE.test(t)) return 'range';
    for (const w of CONTEXT_WORDS) if (t.includes(w)) return 'context';
    return null;
  }

  function isValidMilli(milli) {
    return Number.isInteger(milli) && milli >= MIN_MILLI && milli <= MAX_MILLI;
  }

  /** "1.5" -> 1500；1 到 10，最多三位小数，否则 null。 */
  function parseMultiplier(text) {
    const m = /^(\d{1,2})(?:\.(\d{1,3}))?$/.exec(normalize(text));
    if (!m) return null;
    const milli = Number(m[1]) * 1000 + Number((m[2] || '').padEnd(3, '0'));
    return isValidMilli(milli) ? milli : null;
  }

  function formatMultiplier(milli) {
    if (!isValidMilli(milli)) return '';
    const s = Math.floor(milli / 1000) + '.' + String(milli % 1000).padStart(3, '0');
    return s.replace(/0+$/, '').replace(/\.$/, '');
  }

  /** 定点计算：分 × 千分倍数，四舍五入到整元；参数无效返回 null。 */
  function futureYuan(cents, milli) {
    if (!Number.isInteger(cents) || cents < 1 || cents > MAX_CENTS || !isValidMilli(milli)) return null;
    return Math.floor((cents * milli + 50000) / 100000);
  }

  /** 「10年≈150」；USD 为「10年≈$6」。按整单位四舍五入。 */
  function label(cents, milli, currency) {
    const units = futureYuan(cents, milli);
    if (units == null) return null;
    const cur = currency || 'CNY';
    if (cur === 'CNY') return '10年≈' + units;
    if (cur === 'USD') return '10年≈$' + units;
    return null;
  }

  /**
   * 每张商品卡片只取一个明确主价。candidates: [{ reject: string|null }]
   * 返回 { index } 或 { reason: 'none' | 'rejected' | 'ambiguous' }。
   */
  function pickMainPrice(candidates) {
    const valid = [];
    candidates.forEach((c, i) => { if (!c.reject) valid.push(i); });
    if (valid.length === 1) return { index: valid[0] };
    if (valid.length === 0) return { reason: candidates.length ? 'rejected' : 'none' };
    return { reason: 'ambiguous' };
  }

  /**
   * 当前页面对应的站点权限匹配模式：scheme://hostname/*（匹配模式不含端口，会覆盖该主机所有端口）。
   * 不支持的页面返回中文原因。
   */
  function sitePatternFor(url) {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return { ok: false, reason: '无法识别当前页面地址' };
    }
    if (['chrome:', 'edge:', 'about:', 'chrome-extension:', 'devtools:', 'view-source:'].includes(u.protocol)) {
      return { ok: false, reason: '浏览器内部页面不允许扩展运行' };
    }
    if (u.protocol === 'file:') return { ok: false, reason: '本地文件页面暂不支持，请通过本地 http 服务打开' };
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: '该类型的页面不支持' };
    if (!u.hostname) return { ok: false, reason: '无法识别当前网站' };
    if (u.hostname === 'chromewebstore.google.com' ||
        (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore'))) {
      return { ok: false, reason: 'Chrome 网上应用店页面禁止扩展运行' };
    }
    return { ok: true, pattern: u.protocol + '//' + u.hostname + '/*', hostname: u.hostname };
  }

  /** Resolve displayed unit/line prices against an explicit merchandise subtotal.
   * Return one amount per row only when exactly one assignment matches. Bounded
   * sparse sums avoid exponential work; mismatches/discounts remain unknown. */
  function resolveCartAmounts(rows, subtotal) {
    if (!Array.isArray(rows) || !rows.length || rows.length > 40 ||
        !Number.isSafeInteger(subtotal) || subtotal < 1 || subtotal > MAX_CENTS) return null;
    let sums = new Map([[0, { count: 1, amounts: [] }]]);
    for (const row of rows) {
      const { minor, quantity } = row;
      if (!Number.isSafeInteger(minor) || minor < 1 || minor > MAX_CENTS ||
          !Number.isInteger(quantity) || quantity < 1 || quantity > 999) return null;
      const choices = [...new Set(row.lineTotal ? [minor] : [minor, minor * quantity])];
      const next = new Map();
      for (const [sum, state] of sums) for (const amount of choices) {
        const value = sum + amount;
        if (value > subtotal || amount > MAX_CENTS) continue;
        const prior = next.get(value);
        next.set(value, { count: Math.min(2, (prior?.count || 0) + state.count),
          amounts: prior ? prior.amounts : [...state.amounts, amount] });
        if (next.size > 4096) return null;
      }
      sums = next;
    }
    const match = sums.get(subtotal);
    return match?.count === 1 ? match.amounts : null;
  }

  const api = {
    MAX_CENTS, MIN_MILLI, MAX_MILLI, DEFAULT_MILLI,
    normalize, parsePriceText, parseBareAmount, contextReason,
    parseMoney, parseLabeledMoney, parseMicrodataMoney, isCurrencyCode, moneyLabel, localContextReason,
    isValidMilli, parseMultiplier, formatMultiplier, futureYuan, label,
    pickMainPrice, sitePatternFor, resolveCartAmounts,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FPRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
