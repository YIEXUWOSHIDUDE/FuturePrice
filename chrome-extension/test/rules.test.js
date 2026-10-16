'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/rules.js');

test('完整人民币金额', () => {
  assert.equal(R.parsePriceText('¥99.90'), 9990);
  assert.equal(R.parsePriceText('￥100'), 10000);
  assert.equal(R.parsePriceText(' ¥ 12.5 '), 1250);
  assert.equal(R.parsePriceText('¥1,299.00'), 129900);
  assert.equal(R.parsePriceText('58元'), 5800);
  assert.equal(R.parsePriceText('¥ 49'), 4900);
});

test('非完整金额拒绝', () => {
  for (const t of ['', '99.90', '$99', '¥99.999', '¥0', '券后¥79', '¥59-¥99', '¥59起', '月供¥33', 'Y100', '¥10000000.01', '¥99999999999']) {
    assert.equal(R.parsePriceText(t), null, t);
  }
  assert.equal(R.parsePriceText('¥10000000'), 1000000000);
});

test('结构化纯数字金额', () => {
  assert.equal(R.parseBareAmount('128'), 12800);
  assert.equal(R.parseBareAmount('¥128'), null);
  assert.equal(R.parseBareAmount('abc'), null);
});

test('上下文拒绝', () => {
  assert.equal(R.contextReason('¥59-¥99'), 'range');
  assert.equal(R.contextReason('¥59 ~ 99'), 'range');
  for (const t of ['券后¥79', '月供¥33', '会员价 ¥88', '运费¥8', '合计¥300', '月销1000+', '¥33×12期', '¥59起']) {
    assert.equal(R.contextReason(t), 'context', t);
  }
  assert.equal(R.contextReason('¥129 ¥80'), null);
  assert.equal(R.contextReason('¥99.90'), null);
});

test('倍数解析与定点', () => {
  assert.equal(R.parseMultiplier('1.5'), 1500);
  assert.equal(R.parseMultiplier('1.48'), 1480);
  assert.equal(R.parseMultiplier('10'), 10000);
  for (const t of ['', '0', '0.999', '10.001', '1.2345', 'NaN', 'abc', '-1', '1e1', ' ']) {
    assert.equal(R.parseMultiplier(t), null, t);
  }
  assert.equal(R.formatMultiplier(1500), '1.5');
  assert.equal(R.formatMultiplier(2000), '2');
  assert.equal(R.formatMultiplier(10000), '10');
  assert.equal(R.formatMultiplier(0), '');
});

test('10年标签', () => {
  assert.equal(R.label(9990, 1500), '10年≈150');
  assert.equal(R.label(10000, 1500), '10年≈150');
  assert.equal(R.label(10100, 1500), '10年≈152');
  assert.equal(R.label(19900, 1500), '10年≈299');
  assert.equal(R.label(4990, 1500), '10年≈75');
  assert.equal(R.futureYuan(99, 1500), 1);
  assert.equal(R.futureYuan(100, 1500), 2);
  assert.equal(R.futureYuan(1000000000, 10000), 100000000);
  assert.equal(R.label(0, 1500), null);
  assert.equal(R.label(9990, 999), null);
  assert.equal(R.label(9990, 1500.5), null);
  assert.equal(R.label(NaN, 1500), null);
});

test('每张卡片一个明确主价', () => {
  assert.deepEqual(R.pickMainPrice([{ reject: 'struck' }, { reject: null }]), { index: 1 });
  assert.deepEqual(R.pickMainPrice([{ reject: null }, { reject: null }]), { reason: 'ambiguous' });
  assert.deepEqual(R.pickMainPrice([{ reject: 'range' }, { reject: 'range' }]), { reason: 'rejected' });
  assert.deepEqual(R.pickMainPrice([]), { reason: 'none' });
});

test('美元只在显式传入 USD 时解析', () => {
  assert.equal(R.parsePriceText('$3.69', 'USD'), 369);
  assert.equal(R.parsePriceText('$ 4.90', 'USD'), 490);
  assert.equal(R.parsePriceText('$1,299.99', 'USD'), 129999);
  // 默认 CNY 不把 $ 当价格；USD 不接受人民币写法；未知币种拒绝。
  assert.equal(R.parsePriceText('$3.69'), null);
  assert.equal(R.parsePriceText('¥3.69', 'USD'), null);
  assert.equal(R.parsePriceText('3.69元', 'USD'), null);
  assert.equal(R.parsePriceText('$3.69', 'EUR'), null);
  for (const t of ['3.69', '$3.699', '$0', '$3.69/each', 'est. $4.90', '$1.23 - $4.56', 'US$3']) {
    assert.equal(R.parsePriceText(t, 'USD'), null, t);
  }
});

test('美元标签按整单位四舍五入', () => {
  assert.equal(R.label(369, 1500, 'USD'), '10年≈$6');
  assert.equal(R.label(490, 1500, 'USD'), '10年≈$7');
  assert.equal(R.label(369, 1500), '10年≈6');
  assert.equal(R.label(369, 1500, 'CNY'), '10年≈6');
  assert.equal(R.label(369, 1500, 'EUR'), null);
  assert.equal(R.label(0, 1500, 'USD'), null);
});

test('美元上下文拒绝', () => {
  assert.equal(R.contextReason('est.  /each', 'USD'), 'context');
  assert.equal(R.contextReason('($1.23/count)', 'USD'), 'context');
  assert.equal(R.contextReason('List Price:', 'USD'), 'context');
  assert.equal(R.contextReason('FREE delivery', 'USD'), 'context');
  assert.equal(R.contextReason('Get a $150 Gift Card', 'USD'), 'context');
  assert.equal(R.contextReason('$5.99/mo for 12 months', 'USD'), 'context');
  assert.equal(R.contextReason('$1.23 - $4.56', 'USD'), 'range');
  assert.equal(R.contextReason('$1.23 to $4.56', 'USD'), 'range');
  assert.equal(R.contextReason('', 'USD'), null);
  assert.equal(R.contextReason('-15%', 'USD'), null);
  // 默认 CNY 上下文规则不变。
  assert.equal(R.contextReason('券后¥79'), 'context');
});

test('通用金额：保留符号/代码，不推断国家', () => {
  assert.deepEqual(R.parseMoney('$3.69'), { minor: 369, currency: '$' });
  assert.deepEqual(R.parseMoney('¥99.90'), { minor: 9990, currency: 'CNY' });
  assert.deepEqual(R.parseMoney('￥100'), { minor: 10000, currency: 'CNY' });
  assert.deepEqual(R.parseMoney('58元'), { minor: 5800, currency: 'CNY' });
  assert.deepEqual(R.parseMoney('€12.50'), { minor: 1250, currency: '€' });
  assert.deepEqual(R.parseMoney('£ 7'), { minor: 700, currency: '£' });
  assert.deepEqual(R.parseMoney('USD 4.90'), { minor: 490, currency: 'USD' });
  assert.deepEqual(R.parseMoney('4.90 EUR'), { minor: 490, currency: 'EUR' });
  assert.deepEqual(R.parseMoney('RMB 20'), { minor: 2000, currency: 'CNY' });
  for (const t of ['3.69', '$3.699', '$0', 'XYZ 4', '1.299,00 €', '$3.69/each', 'est. $4.90', '$1 - $2', 'ZZ$3', '¥59起']) {
    assert.equal(R.parseMoney(t), null, t);
  }
});

test('microdata 纯数字须有有效货币代码', () => {
  assert.deepEqual(R.parseMicrodataMoney('128', 'CNY'), { minor: 12800, currency: 'CNY' });
  assert.deepEqual(R.parseMicrodataMoney('4.90', 'usd'), { minor: 490, currency: 'USD' });
  assert.equal(R.parseMicrodataMoney('128', ''), null);
  assert.equal(R.parseMicrodataMoney('128', 'XYZ'), null);
  assert.equal(R.parseMicrodataMoney('¥128', 'CNY'), null);
});

test('通用标签：同币种倍数，不换汇', () => {
  assert.equal(R.moneyLabel(9990, 1500, 'CNY'), '10年≈150');
  assert.equal(R.moneyLabel(369, 1500, '$'), '10年≈$6');
  assert.equal(R.moneyLabel(490, 1500, '$'), '10年≈$7');
  assert.equal(R.moneyLabel(148, 1500, '$'), '10年≈$2');
  assert.equal(R.moneyLabel(569, 1500, '$'), '10年≈$9');
  assert.equal(R.moneyLabel(1250, 1500, '€'), '10年≈€19');
  assert.equal(R.moneyLabel(490, 1500, 'EUR'), '10年≈EUR 7');
  assert.equal(R.moneyLabel(490, 1500, 'XYZ'), null);
  assert.equal(R.moneyLabel(0, 1500, '$'), null);
});

test('局部上下文：邻近单价注释不影响主价', () => {
  // 主价后紧跟括号内单价：截到左括号前，主价不被拒。
  assert.equal(R.localContextReason('', '($0.62 / count)'), null);
  assert.equal(R.localContextReason('$4.90', ''), null);
  assert.equal(R.localContextReason('', '（¥1.23/件）'), null);
  // 单价本身：后缀紧跟斜杠或 per/each/每。
  assert.equal(R.localContextReason('(', ' / count)'), 'unit');
  assert.equal(R.localContextReason('', '/each'), 'unit');
  assert.equal(R.localContextReason('', ' per lb'), 'unit');
  assert.equal(R.localContextReason('', '/件'), 'unit');
  // 区间：另一端价格已被剔除时只剩连接符。
  assert.equal(R.localContextReason('', '-'), 'range');
  assert.equal(R.localContextReason('-', ''), 'range');
  assert.equal(R.localContextReason('', ' - $4.56'), 'range');
  assert.equal(R.localContextReason('', ' to $4.56'), 'range');
  assert.equal(R.localContextReason('¥59-', ''), 'range');
  // 估价、订阅、优惠券、原价、运费、分期（中英）。
  for (const [p, s] of [['est. ', ''], ['Subscribe & Save ', ''], ['Coupon ', ''], ['List Price: ', ''],
    ['Was ', ''], ['From ', ''], ['', '/mo for 12 months'], ['', ' x 12 monthly payments'], ['券后', ''],
    ['月供', ''], ['会员价', ''], ['运费', ''], ['', '起'], ['', '×12期'], ['原价', '']]) {
    assert.notEqual(R.localContextReason(p, s), null, p + '|' + s);
  }
  // 促销金额：礼品卡/信用卡/优惠券/返现/积分，不论词在前缀还是后缀。
  for (const [p, s] of [['Get a ', ' Amazon Gift Card instantly upon approval.'], ['', ' gift card'],
    ['', ' statement credit'], ['', ' coupon'], ['', ' in rewards'], ['', ' cashback'], ['', ' bonus points'],
    ['Gift card ', ''], ['Reward ', '']]) {
    assert.equal(R.localContextReason(p, s), 'context', p + '|' + s);
  }
  // 普通前缀不误拒。
  assert.equal(R.localContextReason('Get a ', ''), null);
  assert.equal(R.localContextReason('-15% ', ''), null);
  assert.equal(R.localContextReason('Price: ', ''), null);
  assert.equal(R.localContextReason('售价', ''), null);
});

test('站点匹配模式', () => {
  assert.deepEqual(R.sitePatternFor('https://shop.example.com/a?b=1'),
    { ok: true, pattern: 'https://shop.example.com/*', hostname: 'shop.example.com' });
  assert.equal(R.sitePatternFor('http://localhost:8765/demo/').pattern, 'http://localhost/*');
  for (const u of ['chrome://extensions', 'about:blank', 'file:///tmp/a.html', 'chrome-extension://abc/popup.html',
    'https://chromewebstore.google.com/detail/x', 'https://chrome.google.com/webstore/detail/x', 'ftp://a.com/', 'not a url']) {
    const r = R.sitePatternFor(u);
    assert.equal(r.ok, false, u);
    assert.ok(r.reason, u);
  }
  assert.equal(R.sitePatternFor('https://chrome.google.com/search').ok, true);
});

test('整段当前售价标签，不抽取句中或非售价金额', () => {
  for (const text of ['Now $469.99', 'NOW: $469.99', 'Sale price $469.99', 'Current price: $469.99', 'Price $469.99']) {
    assert.deepEqual(R.parseLabeledMoney(text), {minor:46999,currency:'$'}, text);
  }
  for (const text of ['售价 ¥99', '现价：￥99', '活动价 99元']) {
    assert.deepEqual(R.parseLabeledMoney(text), {minor:9900,currency:'CNY'}, text);
  }
  for (const text of ['Was $469.99', 'You save $469.99', 'From $469.99', 'Now $43/mo', 'Now $469.99 with credit approval', 'The price $469.99 was mentioned', 'Sale price $10 - $20', 'Now $10 $20', '月供 ¥99', '优惠券 ¥99']) {
    assert.equal(R.parseLabeledMoney(text), null, text);
  }
  assert.equal(R.parsePriceText('Now $469.99','USD'),null);
});

test('显式国家加货币符号，保留声明币种', () => {
  assert.deepEqual(R.parseMoney('US $493.99'), {minor:49399,currency:'USD'});
  assert.deepEqual(R.parseMoney('US$493.99'), {minor:49399,currency:'USD'});
  assert.deepEqual(R.parseMoney('AU $50'), {minor:5000,currency:'AUD'});
  assert.equal(R.parseMoney('Pay US $493.99'), null);
  assert.equal(R.parseMoney('US $10 - $20'), null);
});
