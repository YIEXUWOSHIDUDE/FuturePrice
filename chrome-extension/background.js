/*
 * 后台：按站点持久启用。只接受本扩展 popup 的消息；所有存储/注册/权限操作串行执行，避免开关竞态。
 * 站点状态存于 chrome.storage.local：{ milli, sites: { "https://host/*": true } }。
 */
importScripts('lib/rules.js');
const R = self.FPRules;

const FILES = ['lib/rules.js', 'content.js'];
const ID_PREFIX = 'fp-site:';
const scriptId = (pattern) => ID_PREFIX + pattern;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function readState() {
  const s = await chrome.storage.local.get({ milli: R.DEFAULT_MILLI, sites: {} });
  return { milli: R.isValidMilli(s.milli) ? s.milli : R.DEFAULT_MILLI, sites: s.sites || {} };
}

async function ensureRegistered(pattern) {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [scriptId(pattern)] });
  if (existing.length) return;
  await chrome.scripting.registerContentScripts([{
    id: scriptId(pattern),
    matches: [pattern],
    js: FILES,
    runAt: 'document_idle',
    persistAcrossSessions: true,
  }]);
}

/** 询问标签页内容脚本状态；requireRunning 时重试直到 running 或次数用尽。 */
async function askStatus(tabId, tries, requireRunning) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      last = await chrome.tabs.sendMessage(tabId, { type: 'fp:status' });
      if (last && (!requireRunning || last.running)) return last;
    } catch (e) {
      last = null;
    }
    if (i < tries - 1) await sleep(150);
  }
  return last;
}

/** 停用站点：移除记录、注销持久脚本、通知已打开标签清除，可选撤回权限。 */
async function disableSite(pattern, removePermission) {
  const { sites } = await readState();
  if (pattern in sites) {
    const next = { ...sites };
    delete next[pattern];
    await chrome.storage.local.set({ sites: next });
  }
  await chrome.scripting.unregisterContentScripts({ ids: [scriptId(pattern)] }).catch(() => {});
  const tabs = await chrome.tabs.query({ url: pattern }).catch(() => []);
  await Promise.all(tabs.map((t) => chrome.tabs.sendMessage(t.id, { type: 'fp:stop' }).catch(() => {})));
  if (removePermission) await chrome.permissions.remove({ origins: [pattern] }).catch(() => false);
}

/** 启动/重启/撤权后对齐：无权限的站点停用，已启用站点确保脚本已注册，多余注册注销。 */
async function reconcile() {
  const { sites } = await readState();
  const next = { ...sites };
  let changed = false;
  for (const pattern of Object.keys(sites)) {
    const granted = await chrome.permissions.contains({ origins: [pattern] }).catch(() => false);
    if (!granted) {
      delete next[pattern];
      changed = true;
      continue;
    }
    await ensureRegistered(pattern).catch(() => {});
  }
  if (changed) await chrome.storage.local.set({ sites: next });
  const registered = await chrome.scripting.getRegisteredContentScripts().catch(() => []);
  const stale = registered.filter((s) => s.id.startsWith(ID_PREFIX) && !next[s.id.slice(ID_PREFIX.length)]);
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale.map((s) => s.id) }).catch(() => {});
}

const handlers = {
  async 'popup:state'(msg) {
    const { milli, sites } = await readState();
    const site = R.sitePatternFor(msg.url || '');
    if (!site.ok) return { supported: false, reason: site.reason, milli };
    const granted = await chrome.permissions.contains({ origins: [site.pattern] }).catch(() => false);
    const enabled = !!sites[site.pattern] && granted;
    const content = enabled ? await askStatus(msg.tabId, 2, false) : null;
    return { supported: true, pattern: site.pattern, enabled, granted, milli, content };
  },

  async 'popup:enable'(msg) {
    const site = R.sitePatternFor(msg.url || '');
    if (!site.ok) return { ok: false, reason: site.reason };
    const granted = await chrome.permissions.contains({ origins: [site.pattern] }).catch(() => false);
    if (!granted) return { ok: false, reason: '未获得该网站权限，提醒未开启' };
    const tab = await chrome.tabs.get(msg.tabId).catch(() => null);
    const now = tab ? R.sitePatternFor(tab.url || '') : null;
    if (!now || !now.ok || now.pattern !== site.pattern) return { ok: false, reason: '当前标签页已离开该网站，提醒未开启' };

    const { sites } = await readState();
    await chrome.storage.local.set({ sites: { ...sites, [site.pattern]: true } });
    try {
      await ensureRegistered(site.pattern);
      await chrome.scripting.executeScript({ target: { tabId: msg.tabId }, files: FILES });
      const st = await askStatus(msg.tabId, 8, true);
      if (!st || !st.running) throw new Error('页面中的提醒脚本没有运行');
      return { ok: true, content: st };
    } catch (e) {
      await disableSite(site.pattern, true);
      return { ok: false, reason: '开启失败：' + (e && e.message ? e.message : String(e)) };
    }
  },

  async 'popup:disable'(msg) {
    const site = R.sitePatternFor(msg.url || '');
    if (!site.ok) return { ok: false, reason: site.reason };
    await disableSite(site.pattern, true);
    return { ok: true };
  },

  async 'popup:multiplier'(msg) {
    if (!R.isValidMilli(msg.milli)) return { ok: false, reason: '倍数无效' };
    await chrome.storage.local.set({ milli: msg.milli });
    return { ok: true, milli: msg.milli };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 只接受本扩展页面（popup）；内容脚本与网页不能控制权限或站点开关。
  if (sender.id !== chrome.runtime.id || sender.tab || !msg) return false;
  if (msg.type === 'popup:request-enable') {
    const site = R.sitePatternFor(msg.url || '');
    if (!site.ok || !Number.isInteger(msg.tabId)) {
      sendResponse({ ok: false, reason: '无法在此页面开启' });
      return false;
    }
    // 保持 runtime 消息传来的点击手势：申请权限之前不能 await 或进入异步队列。
    // 权限弹窗可能销毁 popup，授权完成后仍由后台执行注册和注入。
    chrome.permissions.request({ origins: [site.pattern] }).then((granted) => {
      if (!granted) return { ok: false, reason: '未获得该网站权限，提醒未开启' };
      return serial(() => handlers['popup:enable'](msg));
    }).then(sendResponse, (e) => sendResponse({ ok: false, reason: '开启失败：' + String(e.message || e) }));
    return true;
  }
  const handler = handlers[msg.type];
  if (!handler) return false;
  serial(() => handler(msg)).then(
    (res) => sendResponse(res),
    (e) => sendResponse({ ok: false, reason: String(e && e.message ? e.message : e) }),
  );
  return true;
});

chrome.permissions.onRemoved.addListener((perms) => {
  serial(async () => {
    for (const origin of perms.origins || []) await disableSite(origin, false);
    await reconcile();
  });
});

chrome.runtime.onStartup.addListener(() => serial(reconcile));
chrome.runtime.onInstalled.addListener(() => serial(reconcile));
// 后台被唤醒时也对齐一次（外部撤权可能发生在休眠期间）。
serial(reconcile);
