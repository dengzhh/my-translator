/* 我的翻译 · 弹窗面板 */
(function () {
  const $ = (id) => document.getElementById(id);
  const LANGS = window.QT_LANGS || [['zh-CN', '简体中文'], ['en', '英语']];

  function send(msg) {
    return new Promise((r) => chrome.runtime.sendMessage(msg, r));
  }

  function setConfig(patch) {
    return send({ type: 'qt:setConfig', patch });
  }

  (async function init() {
    $('targetLang').innerHTML = LANGS.map(
      ([c, n]) => `<option value="${c}">${n}</option>`
    ).join('');

    const res = await send({ type: 'qt:getConfig' });
    const cfg = (res && res.config) || {};
    $('enabled').checked = !!cfg.enabled;
    $('targetLang').value = cfg.targetLang || 'zh-CN';

    const names = {
      local: '本地服务',
      openai: 'OpenAI 兼容',
      deepl: 'DeepL',
      google: 'Google',
      custom: '自定义'
    };
    const keyOf = { openai: cfg.apiKey, deepl: cfg.deeplKey, google: cfg.googleKey }[cfg.provider];
    // 本地服务与自定义接口不需要 API Key
    const hasKey = cfg.provider === 'custom' || cfg.provider === 'local' ? true : !!(keyOf || '').trim();
    $('state').textContent = hasKey
      ? `${names[cfg.provider] || cfg.provider} · 已配置`
      : `${names[cfg.provider] || cfg.provider} · 未填密钥`;
    $('meta').textContent = cfg.provider === 'custom' || cfg.provider === 'openai' ? cfg.endpoint || '' : '';

    $('enabled').addEventListener('change', async (e) => {
      await setConfig({ enabled: e.target.checked });
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'qt:reload-config' }).catch(() => {});
      });
    });

    /* 暂停 / 恢复划词浮窗（临时关闭自动弹出） */
    function renderPause(paused) {
      const el = $('pauseState');
      el.className = 'state' + (paused ? ' paused' : '');
      el.textContent = paused ? '划词浮窗：已暂停' : '划词浮窗：开启';
      $('btnPause').textContent = paused ? '恢复' : '暂停';
    }
    renderPause(!!cfg.paused);

    $('btnPause').addEventListener('click', async () => {
      const next = !(cfg && cfg.paused);
      const res = await setConfig({ paused: next });
      if (res && res.config) cfg.paused = res.config.paused;
      else cfg.paused = next;
      renderPause(next);
    });

    $('targetLang').addEventListener('change', async (e) => {
      await setConfig({ targetLang: e.target.value });
    });

    /* 探测当前页面是否已注入内容脚本 */
    const tabs = await new Promise((r) => chrome.tabs.query({ active: true, currentWindow: true }, r));
    const tab = tabs && tabs[0];
    const el = $('pageState');
    const btn = $('btnInject');

    const ping = () =>
      new Promise((r) => {
        try {
          chrome.tabs.sendMessage(tab.id, { type: 'qt:ping' }, (res) => {
            void chrome.runtime.lastError;
            r(res);
          });
        } catch (e) {
          r(null);
        }
      });

    // activeTab 权限下能拿到当前页 url；拿不到时也先试 ping，别误判成不支持
    const isSupported = !!tab && (!tab.url || /^https?:/.test(tab.url));

    async function refreshPageState() {
      if (!isSupported) {
        el.className = 'state bad';
        el.textContent = '当前是浏览器内置页面，扩展无法注入';
        btn.hidden = true;
        return false;
      }
      const res = await ping();
      if (res && res.ok) {
        el.className = 'state ok';
        el.textContent = '✓ 本页已就绪，可直接划词';
        btn.hidden = true;
        return true;
      }
      el.className = 'state bad';
      el.textContent = '✗ 本页未加载脚本（装插件前打开的页面）';
      btn.hidden = false;
      return false;
    }

    await refreshPageState();

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '注入中…';
      const r = await new Promise((res) => chrome.runtime.sendMessage({ type: 'qt:injectTab', tabId: tab.id }, res));
      await refreshPageState();
      btn.disabled = false;
      btn.textContent = '注入本页';
      if (!r || !r.ok) {
        el.className = 'state bad';
        el.textContent = '注入失败，请刷新页面试试';
      }
    });

    /* 打开设置：直接在当前页面里的浮窗设置面板展开，绝不导航走用户的网页 */
    $('btnOptions').addEventListener('click', async () => {
      if (!tab || !tab.id) {
        window.close();
        return;
      }
      // 页面可能还没注入内容脚本（装插件前打开的页），先补注入再发消息
      let ok = await new Promise((r) => {
        chrome.tabs.sendMessage(tab.id, { type: 'qt:openSettings' }, (res) => {
          void chrome.runtime.lastError;
          r(!!res);
        });
      });
      if (!ok) {
        await new Promise((res) => chrome.runtime.sendMessage({ type: 'qt:injectTab', tabId: tab.id }, res));
        await new Promise((r) => setTimeout(r, 120));
        ok = await new Promise((r) => {
          chrome.tabs.sendMessage(tab.id, { type: 'qt:openSettings' }, (res) => {
            void chrome.runtime.lastError;
            r(!!res);
          });
        });
      }
      window.close();
    });
  })();
})();
