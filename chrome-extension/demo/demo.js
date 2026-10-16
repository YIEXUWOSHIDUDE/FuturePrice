/* 合成测试商店：只用 DOM API 生成内容，不用 innerHTML。 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let clicks = 0;
  let inserted = 0;

  /** priceParts: 节点描述数组，[tag, text, className?]，组成价格行。 */
  function card(title, priceParts) {
    const c = document.createElement('div');
    c.className = 'card';
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.setAttribute('role', 'img');
    thumb.setAttribute('aria-label', '商品图');
    const a = document.createElement('a');
    a.className = 'title';
    a.href = '#' + encodeURIComponent(title);
    a.textContent = title;
    const price = document.createElement('div');
    price.className = 'price';
    for (const [tag, text, cls] of priceParts) {
      if (tag === '#text') {
        price.append(document.createTextNode(text));
        continue;
      }
      const el = document.createElement(tag);
      el.textContent = text;
      if (cls) el.className = cls;
      price.append(el);
    }
    const space = document.createElement('div');
    space.className = 'space';
    const buy = document.createElement('button');
    buy.className = 'buy';
    buy.textContent = '加入购物车';
    c.append(thumb, a, price, space, buy);
    return c;
  }

  const positives = $('positives');
  // A：币种与整数拆在不同元素中。
  const a = card('合成商品 A 保温杯', [['span', '¥', 'cur'], ['span', '100', 'int']]);
  a.id = 'card-a';
  positives.append(
    a,
    // B：划线价 + 主价，只标主价。
    card('合成商品 B 帆布包', [['del', '¥129'], ['span', '¥80']]),
    card('合成商品 C 耳机', [['span', '¥199.00']]),
    card('合成商品 D 毛巾', [['span', '¥', 'cur'], ['span', '49'], ['span', '.90']]),
    card('合成商品 F 雨伞', [['span', '59.90元']]),
    card('合成商品 G 收纳盒', [['span', '¥1,299']]),
  );

  $('negatives').append(
    card('负例 券后价', [['span', '券后', 'tip'], ['span', '¥79']]),
    card('负例 价格区间', [['span', '¥59'], ['#text', '-'], ['span', '¥99']]),
    card('负例 月供', [['span', '月供', 'tip'], ['span', '¥33']]),
    card('负例 只有划线价', [['del', '¥199']]),
    card('负例 两个同级价格', [['span', '¥30'], ['#text', ' '], ['span', '¥40']]),
    card('负例 无币种数字', [['span', '128']]),
  );

  document.addEventListener('click', (ev) => {
    if (ev.target instanceof HTMLElement && ev.target.classList.contains('buy')) {
      clicks++;
      $('clicks').textContent = '商品按钮点击：' + clicks;
    }
  });

  $('change-price').addEventListener('click', () => {
    const int = document.querySelector('#card-a .int');
    if (int) int.textContent = '101';
  });

  $('insert').addEventListener('click', () => {
    inserted++;
    const c = card('插入商品 ' + inserted, [['span', '¥' + (60 + inserted * 6)]]);
    c.dataset.inserted = '1';
    positives.prepend(c);
  });

  $('remove').addEventListener('click', () => {
    const c = positives.querySelector('[data-inserted="1"]');
    if (c) c.remove();
  });

  $('open-modal').addEventListener('click', () => { $('modal').hidden = false; });
  $('close-modal').addEventListener('click', () => { $('modal').hidden = true; });
})();
