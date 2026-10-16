/* popup：站点开关（首次启用在用户点击中申请该站点权限）、倍数设置、内容脚本状态显示。 */
(() => {
  'use strict';
  const R = window.FPRules;
  const $ = (id) => document.getElementById(id);
  let tab = null;
  let site = null;
  let state = null;
  let busy = false;

  const send = (msg) => chrome.runtime.sendMessage(msg);

  function setBusy(b) {
    busy = b;
    $('toggle').disabled = b || !site || !site.ok || !state;
    $('save').disabled = b;
  }

  function showStatus(text) {
    $('status').textContent = text;
  }

  function scenarioText(milli) {
    return milli === R.DEFAULT_MILLI
      ? '默认10年情景：约等于年化实际回报 4% 持续 10 年（1.04^10≈1.48），仅为假设。'
      : '自定10年情景：倍数 ' + R.formatMultiplier(milli) + '，仅为假设。';
  }

  function describe(c) {
    if (!c) return '提醒已开启，但页面脚本未响应（可刷新页面后再看）';
    if (!c.running) return '页面脚本未运行';
    const head = c.labeled > 0
      ? '已标注 ' + c.labeled + ' 个商品'
      : (c.cards === 0 ? '未找到明确价格' : '没有可标注的商品');
    const extra = [];
    if (c.offscreen) extra.push('不在视野 ' + c.offscreen);
    if (c.occluded) extra.push('被遮挡 ' + c.occluded);
    if (c.noRoom) extra.push('放不下 ' + c.noRoom);
    if (c.ambiguous) extra.push('多个价格无法确定 ' + c.ambiguous);
    if (c.rejected) extra.push('已排除（券后/划线/区间等） ' + c.rejected);
    return extra.length ? head + '；' + extra.join('，') : head;
  }

  async function refresh(updateStatus) {
    try {
      state = await send({ type: 'popup:state', tabId: tab && tab.id, url: (tab && tab.url) || '' });
    } catch (e) {
      state = null;
    }
    const milli = state && R.isValidMilli(state.milli) ? state.milli : R.DEFAULT_MILLI;
    if (document.activeElement !== $('multiplier')) $('multiplier').value = R.formatMultiplier(milli);
    $('scenario').textContent = scenarioText(milli);

    if (!site || !site.ok) {
      $('site').textContent = '—';
      $('toggle').textContent = '无法在此页面使用';
      if (updateStatus) showStatus(site ? site.reason : '无法读取当前标签页');
    } else if (!state) {
      $('site').textContent = site.hostname;
      $('toggle').textContent = '暂不可用';
      if (updateStatus) showStatus('无法读取扩展状态');
    } else {
      $('site').textContent = site.hostname;
      $('toggle').textContent = state.enabled ? '在此网站停用' : '在此网站开启';
      if (updateStatus) showStatus(state.enabled ? describe(state.content) : '此网站未开启');
    }
    setBusy(busy);
  }

  $('toggle').addEventListener('click', async () => {
    if (busy || !site || !site.ok || !state) return;
    const enabling = !state.enabled;
    setBusy(true);
    try {
      if (enabling) {
        showStatus('正在开启…');
        // 直接转交点击：后台持有整个授权/启用流程，popup 关闭不会截断后半段。
        const res = await send({ type: 'popup:request-enable', tabId: tab.id, url: tab.url });
        showStatus(res && res.ok ? describe(res.content) : ((res && res.reason) || '开启失败'));
      } else {
        const res = await send({ type: 'popup:disable', url: tab.url });
        showStatus(res && res.ok ? '已在此网站停用，页面标签已清除' : ((res && res.reason) || '停用失败'));
      }
    } catch (e) {
      showStatus((enabling ? '开启失败：' : '停用失败：') + (e && e.message ? e.message : String(e)));
    } finally {
      busy = false;
      await refresh(false);
    }
  });

  $('save').addEventListener('click', async () => {
    if (busy) return;
    const milli = R.parseMultiplier($('multiplier').value);
    if (milli == null) {
      $('mhint').textContent = '请输入 1 到 10 之间、最多三位小数的倍数';
      return;
    }
    setBusy(true);
    try {
      const res = await send({ type: 'popup:multiplier', milli });
      $('mhint').textContent = res && res.ok ? '已保存，已开启的页面会自动更新' : ((res && res.reason) || '保存失败');
      $('multiplier').value = R.formatMultiplier(milli);
      $('scenario').textContent = scenarioText(milli);
    } catch (e) {
      $('mhint').textContent = '保存失败';
    } finally {
      setBusy(false);
    }
  });

  (async () => {
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch (e) {
      tab = null;
    }
    site = tab ? R.sitePatternFor(tab.url || '') : null;
    await refresh(true);
  })();
})();
