/* 我的翻译 · 设置页逻辑 */
(function () {
  const $ = (id) => document.getElementById(id);
  const LANGS = window.QT_LANGS || [['zh-CN', '简体中文'], ['en', '英语']];

  const PRESETS = {
    zhipu: { endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-flash', doc: 'https://open.bigmodel.cn/' },
    deepseek: { endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat', doc: 'https://platform.deepseek.com/' },
    siliconflow: { endpoint: 'https://api.siliconflow.cn/v1/chat/completions', model: 'Qwen/Qwen2.5-7B-Instruct', doc: 'https://cloud.siliconflow.cn/' },
    openai: { endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', doc: 'https://platform.openai.com/' },
    moonshot: { endpoint: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k', doc: 'https://platform.moonshot.cn/' },
    ollama: { endpoint: 'http://localhost:11434/v1/chat/completions', model: 'qwen2.5:7b', doc: 'http://localhost:11434' }
  };

  let cfg = null;

  function send(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (res) => resolve(res));
    });
  }

  function fillLangs() {
    const t = $('targetLang');
    const s = $('sourceLang');
    t.innerHTML = LANGS.map(([c, n]) => `<option value="${c}">${n}</option>`).join('');
    const base = `<option value="auto">自动检测</option>`;
    s.innerHTML = base + LANGS.map(([c, n]) => `<option value="${c}">${n}</option>`).join('');
  }

  function apply(c) {
    cfg = c;
    $('enabled').checked = !!c.enabled;
    $('provider').value = c.provider || 'local';
    $('localEndpoint').value = c.localEndpoint || 'http://127.0.0.1:8090/api/v1/translate';
    $('localEngine').value = c.localEngine || 'baidu';
    $('endpoint').value = c.endpoint || '';
    $('apiKey').value = c.apiKey || '';
    $('model').value = c.model || '';
    $('temperature').value = c.temperature == null ? 0.2 : c.temperature;
    $('systemPrompt').value = c.systemPrompt || '';
    $('deeplPlan').value = c.deeplPlan || 'free';
    $('deeplKey').value = c.deeplKey || '';
    $('googleKey').value = c.googleKey || '';
    $('customMethod').value = c.customMethod || 'POST';
    $('customPath').value = c.customPath || '';
    $('customEndpoint').value = c.customEndpoint || c.endpoint || '';
    $('customHeaders').value = c.customHeaders || '';
    $('customBody').value = c.customBody || '';
    $('targetLang').value = c.targetLang || 'zh-CN';
    $('sourceLang').value = c.sourceLang || 'auto';
    $('maxChars').value = c.maxChars || 4000;
    $('showBubble').checked = !!c.showBubble;
    $('paused').checked = !!c.paused;
    $('autoCopy').checked = !!c.autoCopy;
    $('cacheEnabled').checked = !!c.cacheEnabled;
    switchProvider();
  }

  function switchProvider() {
    const p = $('provider').value;
    document.querySelectorAll('.group[data-provider]').forEach((g) => {
      g.classList.toggle('hidden', g.dataset.provider !== p);
    });
    updatePerm();
  }

  function currentUrl() {
    const p = $('provider').value;
    if (p === 'local') return $('localEndpoint').value.trim();
    if (p === 'deepl') {
      return $('deeplPlan').value === 'pro'
        ? 'https://api.deepl.com/v2/translate'
        : 'https://api-free.deepl.com/v2/translate';
    }
    if (p === 'google') return 'https://translation.googleapis.com/language/translate/v2';
    if (p === 'custom') return $('customEndpoint').value.trim();
    return $('endpoint').value.trim();
  }

  function originOf(url) {
    try {
      return new URL(url).origin + '/*';
    } catch (e) {
      return null;
    }
  }

  async function updatePerm() {
    const url = currentUrl();
    const box = $('permBox');
    const btn = $('btnPerm');
    const origin = originOf(url);
    if (!origin) {
      box.className = 'perm bad';
      box.textContent = '接口地址不是合法的 URL';
      btn.classList.add('hidden');
      return;
    }
    btn.classList.remove('hidden');
    const has = await new Promise((r) => chrome.permissions.contains({ origins: [origin] }, r));
    box.className = 'perm ' + (has ? 'ok' : 'bad');
    box.textContent = has ? `已授权访问 ${origin}` : `尚未授权 ${origin}（调用时会被浏览器拦截）`;
    btn.textContent = has ? '已授权' : '授权该接口域名';
    btn.disabled = has;
  }

  function collect() {
    const provider = $('provider').value;
    const patch = {
      enabled: $('enabled').checked,
      provider,
      targetLang: $('targetLang').value,
      sourceLang: $('sourceLang').value,
      maxChars: Number($('maxChars').value) || 4000,
      showBubble: $('showBubble').checked,
      paused: $('paused').checked,
      autoCopy: $('autoCopy').checked,
      cacheEnabled: $('cacheEnabled').checked,
      temperature: Number($('temperature').value) || 0,
      systemPrompt: $('systemPrompt').value,
      customMethod: $('customMethod').value,
      customPath: $('customPath').value.trim(),
      customHeaders: $('customHeaders').value,
      customBody: $('customBody').value,
      customEndpoint: $('customEndpoint').value.trim(),
      deeplPlan: $('deeplPlan').value,
      googleKey: $('googleKey').value.trim()
    };
    if (provider === 'local') {
      patch.localEndpoint = $('localEndpoint').value.trim();
      patch.localEngine = $('localEngine').value.trim() || 'baidu';
    } else if (provider === 'openai') {
      patch.endpoint = $('endpoint').value.trim();
      patch.apiKey = $('apiKey').value.trim();
      patch.model = $('model').value.trim();
    } else if (provider === 'deepl') {
      patch.deeplKey = $('deeplKey').value.trim();
    } else if (provider === 'custom') {
      patch.endpoint = $('customEndpoint').value.trim();
    }
    return patch;
  }

  async function save(silent) {
    const patch = collect();
    const origin = originOf(currentUrl());
    // 权限申请必须在用户手势的有效期内发起，不能被 await 打断，所以放在最前面
    const permReq = origin
      ? new Promise((r) =>
          chrome.permissions.request({ origins: [origin] }, (ok) => {
            void chrome.runtime.lastError;
            r(!!ok);
          })
        )
      : Promise.resolve(false);
    const res = await send({ type: 'qt:setConfig', patch });
    if (res && res.ok) cfg = res.config;
    await permReq;
    updatePerm();
    if (!silent) {
      const tip = $('savedTip');
      tip.textContent = '已保存 ✓';
      setTimeout(() => (tip.textContent = ''), 2000);
    }
    return true;
  }

  async function test() {
    const btn = $('btnTest');
    const out = $('testResult');
    btn.disabled = true;
    btn.textContent = '翻译中…';
    out.className = 'result';
    out.textContent = '';
    await save(true);
    const res = await send({
      type: 'qt:translate',
      text: $('testText').value || 'Hello world',
      target: $('targetLang').value,
      source: $('sourceLang').value,
      force: true
    });
    btn.disabled = false;
    btn.textContent = '测试翻译';
    if (!res) {
      out.className = 'result bad';
      out.textContent = '无响应，请重试';
      return;
    }
    if (res.ok) {
      out.className = 'result ok';
      out.textContent = res.text + (res.ms ? `\n(${res.ms}ms${res.cached ? ' · 缓存' : ''})` : '');
    } else if (res.needPermission) {
      out.className = 'result bad';
      out.textContent = '缺少域名授权：' + res.origin;
    } else {
      out.className = 'result bad';
      out.textContent = '失败：' + res.error;
    }
  }

  function bind() {
    $('provider').addEventListener('change', switchProvider);
    $('preset').addEventListener('change', () => {
      const p = PRESETS[$('preset').value];
      if (!p) return;
      $('endpoint').value = p.endpoint;
      $('model').value = p.model;
      updatePerm();
    });
    ['endpoint', 'customEndpoint', 'deeplPlan'].forEach((id) =>
      $(id).addEventListener('change', updatePerm)
    );
    $('btnPerm').addEventListener('click', async () => {
      const origin = originOf(currentUrl());
      if (!origin) return;
      await new Promise((r) => chrome.permissions.request({ origins: [origin] }, r));
      updatePerm();
    });
    $('btnSave').addEventListener('click', () => save(false));
    $('btnTest').addEventListener('click', test);
    $('btnClearCache').addEventListener('click', async () => {
      await send({ type: 'qt:clearCache' });
      const tip = $('savedTip');
      tip.textContent = '缓存已清除 ✓';
      setTimeout(() => (tip.textContent = ''), 2000);
    });
    $('btnExport').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(collect(), null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'quick-translate-config.json';
      a.click();
      URL.revokeObjectURL(a.href);
    });
    $('btnImport').addEventListener('click', () => $('fileImport').click());
    $('fileImport').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        const obj = JSON.parse(await f.text());
        await send({ type: 'qt:setConfig', patch: obj });
        const res = await send({ type: 'qt:getConfig' });
        apply(res.config);
        $('savedTip').textContent = '已导入 ✓';
        setTimeout(() => ($('savedTip').textContent = ''), 2000);
      } catch (err) {
        $('savedTip').textContent = '导入失败：文件格式不正确';
      }
    });
  }

  (async function init() {
    fillLangs();
    const res = await send({ type: 'qt:getConfig' });
    apply((res && res.config) || {});
    bind();
    updatePerm();
  })();
})();
